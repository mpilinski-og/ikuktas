import { SummaryModel } from './models/summary.model';
import { SensorSummaryModel } from './models/sensor-summary.model';
import { Component, OnInit } from '@angular/core';
import { interval } from 'rxjs';
import { Subscription } from 'rxjs/internal/Subscription';
import { filter, map, startWith } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { GraphModel } from './models/graph.model';
import { IAppConfig } from './models/app-config.interface';
import { Label } from 'ng2-charts'; 
import { ChartDataSets, ChartOptions, Chart } from 'chart.js';

const predictionSeparatorPlugin = {
  id: 'predictionSeparator',
  afterDraw: (chart: any) => {
    const component = chart.config.options.plugins.predictionSeparator;

    if (!component?.index) {
      return;
    }

    const xScale = chart.scales['x-axis-0'];
    const x = xScale.getPixelForValue(component.index);

    const ctx = chart.chart.ctx;
    const chartArea = chart.chartArea;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'gray';
    ctx.stroke();
    ctx.restore();
  }
};

Chart.plugins.register(predictionSeparatorPlugin);

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  settings: IAppConfig;

  title = 'iKuktasClient';
  stillError = false;
  playingSubscription: Subscription;

  data: SummaryModel;
  graphDataMonth: GraphModel = null;
  graphDataDay: GraphModel = null;
  
  chartMonthData: {
    labels: Label[];
    datasets: ChartDataSets[];
  } = {
    labels: [],
    datasets: []
  };   
  chartDayData: {
    labels: Label[];
    datasets: ChartDataSets[];
  } = {
    labels: [],
    datasets: []
  };
  chartType = 'line';

  chartOptions: ChartOptions = {
    responsive: true,
    scales: {
      xAxes: [{
        ticks: {
          autoSkip: true,
          maxTicksLimit: 10
        }
      }]
    },
    animation: {
      duration: 0
    },
    legend: { 
      labels: {
        filter: (legendItem: any, chartData: any) => {

          if (
            !chartData ||
            !chartData.datasets ||
            legendItem.datasetIndex == null
          ) {
            return true;
          }

          const dataset = chartData.datasets[legendItem.datasetIndex];

          if (!dataset || !dataset.label) {
            return true;
          }

          return !dataset.label.startsWith('Prediction-');
        }
      }
    },
    plugins: {
      predictionSeparator: {
        index: 250
      }
    }
  };
  
  constructor(private http: HttpClient) {
  }

  ngOnInit() {
    this.loadSettings().then(() => {
      this.initHttpRequests();
      this.initAudio();
    });
  }

  loadSettings() {
      const jsonFile = `assets/config.json`;
      return new Promise<void>((resolve, reject) => {
          this.http.get(jsonFile).toPromise().then((response : IAppConfig) => {
              this.settings = response;
              resolve();
          }).catch((response: any) => {
              reject(`Could not load file '${jsonFile}': ${JSON.stringify(response)}`);
          });
      });
  }


  mapToSummaryModel(source: any): SummaryModel {
    const mapSensor = (sensor: any): SensorSummaryModel => ({
        timeStamp: new Date(source.timestamp * 1000),
        temperature: sensor.temperature,
        hourAverage: sensor.previousHourAverage,
        hourPrediction: sensor.nextHourPrediction
    });

    return {
        rightTopTemp: mapSensor(source.temp1),
        rightMiddleTemp: mapSensor(source.temp2),
        rightBottomTemp: mapSensor(source.temp3),
        leftMiddleTemp: mapSensor(source.temp4),
        leftTopTemp: mapSensor(source.temp5)
    };
  }

  mapToGraphModel(source: any): GraphModel {
    return {
        timeStamps: source.map(item => new Date(item.timestamp * 1000)),
        rightTopTemps: source.map(item => item.temp1),
        rightMiddleTemps: source.map(item => item.temp2),
        rightBottomTemps: source.map(item => item.temp3),
        leftMiddleTemps: source.map(item => item.temp4),
        leftTopTemps: source.map(item => item.temp5)
    };
  }
setPreditionData() {
  this.http.get<any>(
    this.settings.baseUrl + '/api/prediction',
    {
      params: {
        hours: '8',
        points: '85'
      },
      headers: {
        'X-Viewer-Key': '62df462c-cf07-48f8-a8c1-45e3c48529ea'
      }
    }
  ).subscribe(request => {
    const prediction = request.prediction;

    // Keep only historical labels
    const historyLabels = this.graphDataDay.timeStamps.map(x =>
      x.toLocaleTimeString('pl-PL', {
        hour: '2-digit',
        minute: '2-digit'
      })
    );

    const predictionLabels = prediction.temp1.map(p =>
      new Date(p.timestamp * 1000).toLocaleTimeString('pl-PL', {
        hour: '2-digit',
        minute: '2-digit'
      })
    );

    this.chartDayData.labels = [
      ...historyLabels,
      ...predictionLabels
    ];

    // Keep only non-prediction datasets
    const historyDatasets = this.chartDayData.datasets.filter(
      dataset => !dataset.label?.startsWith('Prediction-')
    );

    this.chartDayData.datasets = historyDatasets;

    this.addPredictionDataset('Prediction-Zewn-1', prediction.temp5);
    this.addPredictionDataset('Prediction-Wew-1', prediction.temp4);
    this.addPredictionDataset('Prediction-Wew-2', prediction.temp1);
    this.addPredictionDataset('Prediction-Wew-3', prediction.temp2);
    this.addPredictionDataset('Prediction-Wew-4', prediction.temp3);
  });
}

  private addPredictionDataset(
    label: string,
    prediction: any[]
  ) {
    const historyLength =
        this.chartDayData.labels.length -
        prediction.length;

    const data =
        new Array(historyLength).fill(null);
    prediction.forEach(p => data.push(p.value));
    this.chartDayData.datasets.push({
        label,
        data,
        fill: false,
        lineTension: 0.1,
        borderDash: [2, 2],
        pointRadius: 0,
        borderColor: '#999999',
    });
  }

  initHttpRequests() {
    if(!this.settings) return;

    interval(9000).pipe(startWith(0)).subscribe(() => {
      const timestamp = Math.floor(Date.now() / 1000);

      this.http.get<any>(
        this.settings.baseUrl + '/api/data',
        {
          params: {
            timestamp: timestamp.toString()
          },
          headers: {
            'X-Viewer-Key': "62df462c-cf07-48f8-a8c1-45e3c48529ea"
          }
        }
      ).subscribe(data => {
        this.data = this.mapToSummaryModel(data);

        this.setPreditionData()
      });
    });

    interval(90000).pipe(startWith(0)).subscribe(x => {
      this.http.get<GraphModel>(
        this.settings.baseUrl + '/api/last-hours',
        {
          params: {
            n: "720"
          },
          headers: {
            'X-Viewer-Key': "62df462c-cf07-48f8-a8c1-45e3c48529ea"
          }
        }
      ).subscribe(data => {
        console.log(data);
        
        this.graphDataMonth = this.mapToGraphModel(data);

        console.log(this.graphDataMonth);

        let labels: string[] = []
        this.graphDataMonth.timeStamps.forEach(x => {
          labels.push(
          x.toLocaleDateString('pl-PL', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric'
            })
          );
        })
        

        this.chartMonthData = {
          labels: labels,
          datasets: [{
              label: 'Zewn-1',
              data: this.graphDataMonth.leftTopTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-1',
              data: this.graphDataMonth.leftMiddleTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-2',
              data: this.graphDataMonth.rightTopTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-3',
              data: this.graphDataMonth.rightMiddleTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-4',
              data: this.graphDataMonth.rightBottomTemps,
              fill: false,
              lineTension: 0.1   
            }]
        }
      })
    })

    interval(90000).pipe(startWith(0)).subscribe(x => {
      this.http.get<GraphModel>(
        this.settings.baseUrl + '/api/last-hours',
        {
          params: {
            n: "24"
          },
          headers: {
            'X-Viewer-Key': "62df462c-cf07-48f8-a8c1-45e3c48529ea"
          }
        }
      ).subscribe(data => {
        this.graphDataDay = this.mapToGraphModel(data);

        let labels: string[] = []
        this.graphDataDay.timeStamps.forEach(x => {
          labels.push(
            x.toLocaleTimeString('pl-PL', {
              hour: '2-digit',
              minute: '2-digit'
            })
          );
        });

        this.chartDayData = {
          labels: labels,
          datasets: [{
              label: 'Zewn-1',
              data: this.graphDataDay.leftTopTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-1',
              data: this.graphDataDay.leftMiddleTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-2',
              data: this.graphDataDay.rightTopTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-3',
              data: this.graphDataDay.rightMiddleTemps,
              fill: false,
              lineTension: 0.1   
            },{
              label: 'Wew-4',
              data: this.graphDataDay.rightBottomTemps,
              fill: false,
              lineTension: 0.1   
            }]
        }
      })
    })
  }


  
  initAudio() {
    let audio = new Audio();
    audio.src = "assets/alarm.wav";
    audio.load();

    this.playingSubscription = interval(1000).pipe(filter(f => this.stillError)).subscribe(x => {
      audio.play();
    });
  }

  isError() {
    this.stillError = this.data?.rightTopTemp.temperature < 5 ||
    this.data?.rightMiddleTemp.temperature < 5 ||
    this.data?.rightBottomTemp.temperature < 5 ||
    this.data?.leftMiddleTemp.temperature < 5;

    return this.stillError;
  }

  isWarning() {
    if(this.isError()) return false;

    return this.data?.rightTopTemp.hourPrediction < 5 ||
    this.data?.rightMiddleTemp.hourPrediction < 5 ||
    this.data?.rightBottomTemp.hourPrediction < 5 ||
    this.data?.leftMiddleTemp.hourPrediction < 5;
  }
  delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms));
  }
}
