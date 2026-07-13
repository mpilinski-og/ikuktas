#!/usr/bin/env python3

import json
import logging
import os
import requests
import time

session = requests.Session()

CONFIG_FILE = "config.json"

TEMPERATURE_QUEUE_FILE = "temperature_queue.jsonl"
LOG_QUEUE_FILE = "logs_queue.jsonl"


# Network retry configuration
UPLOAD_RETRIES = 3
RETRY_DELAY = 2


def post_with_retry(url, **kwargs):
    """
    HTTP POST wrapper with retries.
    Raises the last exception after retries are exhausted.
    """

    last_error = None

    for attempt in range(UPLOAD_RETRIES):
        try:
            response = session.post(
                url,
                **kwargs
            )

            return response

        except Exception as e:
            last_error = e

            if attempt < UPLOAD_RETRIES - 1:
                time.sleep(
                    RETRY_DELAY * (attempt + 1)
                )

    raise last_error


class ApiLogHandler(logging.Handler):
    """
    Writes Python logging records to a local queue.
    Uploading is handled separately by flush_log_queue().
    """

    def __init__(self, api_url, api_key, source="temperature-uploader"):
        super().__init__()

        self.api_url = api_url
        self.api_key = api_key
        self.source = source

    def emit(self, record):
        payload = {
            "timestamp": int(time.time()),
            "level": record.levelname,
            "source": self.source,
            "message": self.format(record),
        }

        try:
            with open(LOG_QUEUE_FILE, "a") as f:
                f.write(json.dumps(payload))
                f.write("\n")

        except Exception:
            pass


def load_config():
    with open(CONFIG_FILE) as f:
        return json.load(f)

    return None


config = load_config()

API_URL = config["api_url"]
LOGS_API_URL = config["logs_api_url"]
API_KEY = config["api_key"]

INTERVAL = config.get(
    "interval",
    60
)

SENSORS = config["sensors"]

HEADERS = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY
}


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)


api_log_handler = ApiLogHandler(
    api_url=LOGS_API_URL,
    api_key=API_KEY,
    source="temperature-uploader"
)

api_log_handler.setLevel(
    logging.INFO
)

api_log_handler.setFormatter(
    logging.Formatter("%(message)s")
)

logging.getLogger().addHandler(
    api_log_handler
)

def read_sensor(sensor_id):
    path = f"/sys/bus/1wire/devices/{sensor_id}/w1_slave"

    with open(path) as f:
        lines = f.readlines()

    if not lines[0].strip().endswith("YES"):
        raise RuntimeError(
            f"CRC check failed for {sensor_id}"
        )

    value = lines[1].split("t=")[1]

    return round(
        int(value) / 1000.0,
        2
    )


def read_temperatures():
    payload = {
        "timestamp": int(time.time())
    }

    for sensor_id, field in SENSORS.items():
        payload[field] = read_sensor(sensor_id)

    return payload


def send(payload):
    response = post_with_retry(
        API_URL,
        headers=HEADERS,
        json=payload,
        timeout=10,
    )

    if response.status_code in (200, 201):
        return

    if response.status_code == 409:
        logging.info(
            "Duplicate timestamp %s",
            payload["timestamp"]
        )
        return

    response.raise_for_status()


def queue_temperature(payload):
    with open(TEMPERATURE_QUEUE_FILE, "a") as f:
        f.write(json.dumps(payload))
        f.write("\n")


def load_queue(queue_file):
    if not os.path.exists(queue_file):
        return []

    items = []

    with open(queue_file) as f:
        for line in f:
            line = line.strip()

            if line:
                items.append(
                    json.loads(line)
                )

    return items


def load_temperature_queue():
    return load_queue(
        TEMPERATURE_QUEUE_FILE
    )


def load_log_queue():
    return load_queue(
        LOG_QUEUE_FILE
    )


def save_queue(items, queue_file):
    if not items:
        if os.path.exists(queue_file):
            os.remove(queue_file)

        return

    with open(queue_file, "w") as f:
        for item in items:
            f.write(
                json.dumps(item)
            )
            f.write("\n")


def save_temperature_queue(items):
    save_queue(
        items,
        TEMPERATURE_QUEUE_FILE
    )


def save_log_queue(items):
    save_queue(
        items,
        LOG_QUEUE_FILE
    )

    def flush_temperature_queue():
    queue_items = load_temperature_queue()

    if not queue_items:
        return

    logging.info(
        "Found %d queued measurements",
        len(queue_items)
    )

    remaining = []

    for index, item in enumerate(queue_items):
        try:
            send(item)

            logging.info(
                "Uploaded queued measurement %s",
                item["timestamp"]
            )

        except Exception as e:
            logging.warning(
                "Still offline: %s",
                e
            )

            remaining = queue_items[index:]
            break

    save_temperature_queue(
        remaining
    )


def flush_log_queue():
    logs = load_log_queue()

    if not logs:
        return

    logging.info(
        "Found %d queued logs",
        len(logs)
    )

    remaining = []

    for index, item in enumerate(logs):
        try:
            send_log(item)

            # Do not use logging.info here.
            # It would create another queued log while flushing.
            print(
                f"Uploaded queued log: {item['message']}"
            )

        except Exception as e:
            print(
                f"Still unable to upload logs: {e}"
            )

            remaining = logs[index:]
            break

    save_log_queue(
        remaining
    )


def send_log(payload):
    response = post_with_retry(
        LOGS_API_URL,
        headers={
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
        },
        json=payload,
        timeout=5,
    )

    if response.status_code in (200, 201, 409):
        return

    response.raise_for_status()


def main():
    logging.info(
        "Temperature uploader started"
    )

    while True:
        try:
            payload = read_temperatures()

            try:
                send(payload)

                logging.info(
                    "Uploaded %s",
                    payload
                )

            except Exception as e:
                logging.warning(
                    "Upload failed (%s). Saving locally.",
                    e
                )

                queue_temperature(
                    payload
                )


            # Upload queued logs once per interval
            flush_log_queue()

            # Upload queued temperatures
            flush_temperature_queue()


        except Exception:
            logging.exception(
                "Measurement failed"
            )

        time.sleep(
            INTERVAL
        )

if __name__ == "__main__":
    main()