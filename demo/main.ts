import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import OSM from 'ol/source/OSM.js';
import Draw from 'ol/interaction/Draw.js';
import LineString from 'ol/geom/LineString.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { createIcons, ChevronLeft, ChevronRight, RefreshCw, Route, Trash2, X } from 'lucide';
import { OfficialGribProvider, TrajectoryExtrapolationLayer, WindLayer, jet, KNOTS_PER_MS, type WindLayerState } from '../src/index';
import './style.css';

const element = <ElementType extends HTMLElement>(id: string) => document.getElementById(id) as ElementType;
const date = element<HTMLInputElement>('time');
const timeline = element<HTMLInputElement>('timeline');
const previous = element<HTMLButtonElement>('previous');
const next = element<HTMLButtonElement>('next');
const refresh = element<HTMLButtonElement>('refresh');
const drawTrajectoryButton = element<HTMLButtonElement>('trajectory-draw');
const cancelTrajectoryButton = element<HTMLButtonElement>('trajectory-cancel');
const removeTrajectoryButton = element<HTMLButtonElement>('trajectory-remove');
const status = element<HTMLDivElement>('map-status');
const map = new Map({ target: 'map', layers: [new TileLayer({ source: new OSM() })], view: new View({ center: fromLonLat([-5, 46]), zoom: 3 }) });
const currentTime = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const wind = new WindLayer({ provider: new OfficialGribProvider(), time: currentTime });
const trajectorySpeed = 6 / KNOTS_PER_MS;
let trajectory: TrajectoryExtrapolationLayer | undefined;
let drawInteraction: Draw | undefined;
let drawLayer: VectorLayer<VectorSource> | undefined;
createIcons({ icons: { ChevronLeft, ChevronRight, RefreshCw, Route, Trash2, X } });

const formatDate = (time: number) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(time);
let selected: number[] | undefined;
function updateReading(): void {
  if (!selected) return;
  const [longitude, latitude] = selected;
  const sample = wind.sample(longitude, latitude);
  element('coordinates').textContent = `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`;
  element('speed').textContent = sample ? (sample.speed * KNOTS_PER_MS).toFixed(1) : '--';
  element('direction').textContent = sample ? sample.direction === null ? 'Calme' : `${Math.round(sample.direction)}°` : '--';
}

function updateTrajectoryReading(state = wind.getWindState()): void {
  const reading = element<HTMLDivElement>('trajectory-reading');
  if (!trajectory) {
    reading.dataset.state = 'empty';
    element('trajectory-speed').textContent = '--';
    element('trajectory-direction').textContent = '--';
    element('trajectory-position').textContent = '--';
    return;
  }
  trajectory.setTime(new Date(state.time));
  const [longitude, latitude] = trajectory.getCurrentPosition();
  element('trajectory-position').textContent = `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`;
  if (state.status !== 'ready') {
    reading.dataset.state = state.status;
    element('trajectory-speed').textContent = '--';
    element('trajectory-direction').textContent = state.status === 'error' ? 'Indisponible' : 'Chargement';
    return;
  }
  const sample = wind.sample(longitude, latitude);
  reading.dataset.state = sample ? 'ready' : 'outside';
  element('trajectory-speed').textContent = sample ? (sample.speed * KNOTS_PER_MS).toFixed(1) : '--';
  element('trajectory-direction').textContent = sample ? sample.direction === null ? 'Calme' : `${Math.round(sample.direction)}°` : '--';
}

function stopDrawing(): void {
  if (drawInteraction) map.removeInteraction(drawInteraction);
  if (drawLayer) map.removeLayer(drawLayer);
  drawInteraction = undefined;
  drawLayer = undefined;
  cancelTrajectoryButton.hidden = true;
  drawTrajectoryButton.disabled = false;
}

function beginDrawing(): void {
  const source = new VectorSource();
  drawLayer = new VectorLayer({ source, style: new Style({ stroke: new Stroke({ color: '#dc6231', width: 3, lineDash: [8, 5] }) }) });
  map.addLayer(drawLayer);
  drawInteraction = new Draw({ source, type: 'LineString', minPoints: 2 });
  drawInteraction.on('drawend', event => {
    const geometry = event.feature.getGeometry();
    if (!(geometry instanceof LineString) || geometry.getCoordinates().length < 2) return;
    const coordinates = geometry.getCoordinates();
    const trajectoryCoordinates = coordinates.map(coordinate => toLonLat(coordinate, map.getView().getProjection()));
    stopDrawing();
    try {
      const nextTrajectory = new TrajectoryExtrapolationLayer({
        trajectory: trajectoryCoordinates,
        speed: trajectorySpeed,
        currentPosition: trajectoryCoordinates[0],
        time: wind.getTime(),
      });
      trajectory?.dispose();
      nextTrajectory.attach(map);
      trajectory = nextTrajectory;
      removeTrajectoryButton.hidden = false;
      updateTrajectoryReading();
    } catch (error) {
      report(error);
    }
  });
  map.addInteraction(drawInteraction);
  drawTrajectoryButton.disabled = true;
  cancelTrajectoryButton.hidden = false;
}

function update(state: WindLayerState): void {
  updateTrajectoryReading(state);
  status.dataset.status = state.status;
  status.textContent = state.status === 'error' ? state.error?.message ?? 'Prévision indisponible' : 'Chargement des prévisions';
  date.value = new Date(state.time).toISOString().slice(0, 16);
  const times = state.forecast?.times ?? [];
  if (times.length) {
    const start = Math.ceil(times[0] / 60_000);
    const end = Math.floor(times[times.length - 1] / 60_000);
    timeline.min = String(start);
    timeline.max = String(end);
    timeline.value = String(Math.round(state.time / 60_000));
    date.min = new Date(start * 60_000).toISOString().slice(0, 16);
    date.max = new Date(end * 60_000).toISOString().slice(0, 16);
    element('run').textContent = formatDate(state.forecast!.runTime);
    element('start').textContent = formatDate(times[0]);
    element('end').textContent = formatDate(times[times.length - 1]);
  }
  previous.disabled = !times.some(time => time < state.time);
  next.disabled = !times.some(time => time > state.time);
  timeline.disabled = !times.length;
  element('forecast-status').textContent = state.status === 'ready' ? state.bracket?.before === state.bracket?.after ? 'Échéance native' : 'Prévision interpolée' : state.status === 'error' ? 'Indisponible' : 'Chargement';
  element('source-times').textContent = state.bracket ? `${formatDate(state.bracket.before)} → ${formatDate(state.bracket.after)} UTC` : '--';
  updateReading();
}

function report(error: unknown): void {
  status.dataset.status = 'error';
  status.textContent = error instanceof Error ? error.message : String(error);
}
async function chooseTime(time: Date): Promise<void> {
  try { await wind.setTime(time); } catch (error) { report(error); }
}
wind.subscribe(update);
drawTrajectoryButton.addEventListener('click', beginDrawing);
cancelTrajectoryButton.addEventListener('click', stopDrawing);
removeTrajectoryButton.addEventListener('click', () => {
  trajectory?.dispose();
  trajectory = undefined;
  removeTrajectoryButton.hidden = true;
  updateTrajectoryReading();
});
date.addEventListener('change', () => { void chooseTime(new Date(`${date.value}:00Z`)); });
timeline.addEventListener('input', () => { void chooseTime(new Date(Number(timeline.value) * 60_000)); });
previous.addEventListener('click', () => {
  const time = wind.getAvailableTimes().filter(value => value.getTime() < wind.getTime().getTime()).pop();
  if (time) void chooseTime(time);
});
next.addEventListener('click', () => {
  const time = wind.getAvailableTimes().find(value => value.getTime() > wind.getTime().getTime());
  if (time) void chooseTime(time);
});
refresh.addEventListener('click', () => { void wind.reloadForecast().catch(report); });
element<HTMLInputElement>('texture').addEventListener('change', event => wind.textureLayer.setVisible((event.target as HTMLInputElement).checked));
element<HTMLInputElement>('barbs').addEventListener('change', event => wind.barbsLayer.setVisible((event.target as HTMLInputElement).checked));
element<HTMLInputElement>('opacity').addEventListener('input', event => {
  const opacity = Number((event.target as HTMLInputElement).value);
  wind.textureLayer.setOpacity(opacity / 100);
  element('opacity-value').textContent = `${opacity} %`;
});
map.on('singleclick', event => { selected = toLonLat(event.coordinate); updateReading(); });
const legend = element<HTMLCanvasElement>('legend');
const context = legend.getContext('2d')!;
for (let column = 0; column < legend.width; column++) {
  context.fillStyle = `rgb(${jet(column / (legend.width - 1) * 60).join(',')})`;
  context.fillRect(column, 0, 1, legend.height);
}
void wind.attach(map).catch(report);
window.addEventListener('pagehide', () => { stopDrawing(); wind.dispose(); trajectory?.dispose(); map.dispose(); }, { once: true });
export { map, wind, trajectory };