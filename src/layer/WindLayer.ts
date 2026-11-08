import Map from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LayerGroup from 'ol/layer/Group.js';
import ImageLayer from 'ol/layer/Image.js';
import VectorLayer from 'ol/layer/Vector.js';
import ImageCanvasSource from 'ol/source/ImageCanvas.js';
import VectorSource from 'ol/source/Vector.js';
import Icon from 'ol/style/Icon.js';
import Style from 'ol/style/Style.js';
import { transform, transformExtent } from 'ol/proj.js';
import { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';
import type { ProjectionLike } from 'ol/proj.js';
import { bracketTime, interpolateFields, KNOTS_PER_MS, sampleField } from '../core/sampling.js';
import type { Extent, Forecast, TimeBracket, WindField, WindForecastProvider, WindSample } from '../core/types.js';
import { barbCanvas, jet } from '../render/wind.js';
import { WindParticleLayer } from './WindParticleLayer.js';

export interface WindLayerOptions {
  provider: WindForecastProvider;
  time?: Date;
  texture?: boolean;
  barbs?: boolean;
  particles?: boolean;
  opacity?: number;
  maximumKnots?: number;
  barbSpacing?: number;
}

export interface WindLayerState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  time: number;
  forecast?: Forecast;
  bracket?: TimeBracket;
  error?: Error;
}

export class WindLayer extends LayerGroup {
  readonly textureLayer: ImageLayer<ImageCanvasSource>;
  readonly particlesLayer: WindParticleLayer;
  readonly barbsLayer: VectorLayer<VectorSource<Feature<Point>>>;
  private provider: WindForecastProvider;
  private time: number;
  private maximum: number;
  private spacing: number;
  private map?: Map;
  private addedToMap = false;
  private listeners: EventsKey[] = [];
  private subscribers = new Set<(state: WindLayerState) => void>();
  private controller?: AbortController;
  private revision = 0;
  private forecast?: Forecast;
  private field?: WindField;
  private state: WindLayerState;
  private iconCache = new globalThis.Map<string, HTMLCanvasElement>();

  constructor(options: WindLayerOptions) {
    const textureLayer = new ImageLayer({ source: new ImageCanvasSource({}), visible: options.texture ?? true, opacity: options.opacity ?? 0.65 });
    const particlesLayer = new WindParticleLayer({ visible: options.particles ?? true });
    const barbsLayer = new VectorLayer({ source: new VectorSource<Feature<Point>>(), visible: options.barbs ?? true });
    super({ layers: [textureLayer, particlesLayer, barbsLayer] });
    this.textureLayer = textureLayer;
    this.particlesLayer = particlesLayer;
    this.barbsLayer = barbsLayer;
    this.on('change:visible', () => this.particlesLayer.setActive(Boolean(this.map && this.getVisible())));
    this.provider = options.provider;
    this.time = options.time?.getTime() ?? Date.now();
    this.maximum = options.maximumKnots ?? 60;
    this.spacing = options.barbSpacing ?? 60;
    if (!Number.isFinite(this.time) || !Number.isFinite(this.maximum) || this.maximum <= 0 || !Number.isFinite(this.spacing) || this.spacing < 24) {
      throw new RangeError('Invalid wind time, color domain or barb spacing');
    }
    this.state = { status: 'idle', time: this.time };
  }

  async attach(map: Map): Promise<void> {
    this.detach();
    const projection = map.getView().getProjection().getCode();
    if (projection !== 'EPSG:3857' && projection !== 'EPSG:4326') throw new Error('WindLayer supports EPSG:3857 and EPSG:4326 views');
    this.map = map;
    this.particlesLayer.setActive(this.getVisible());
    this.addedToMap = !map.getLayers().getArray().includes(this);
    if (this.addedToMap) map.addLayer(this);
    this.configureTexture();
    const update = () => { void this.refresh().catch(() => undefined); };
    this.listeners = [map.on('moveend', update), map.on('change:size', update), map.on('change:view', () => {
      this.configureTexture();
      update();
    })];
    await this.refresh();
  }

  detach(): void {
    this.controller?.abort();
    this.revision++;
    unByKey(this.listeners);
    this.listeners = [];
    if (this.map && this.addedToMap) this.map.removeLayer(this);
    this.map = undefined;
    this.addedToMap = false;
    this.particlesLayer.setActive(false);
    this.clearField();
    this.publish({ status: 'idle', time: this.time, forecast: this.forecast });
  }

  protected override disposeInternal(): void {
    this.detach();
    this.subscribers.clear();
    this.iconCache.clear();
    this.textureLayer.dispose();
    this.particlesLayer.dispose();
    this.barbsLayer.dispose();
    super.disposeInternal();
  }

  getTime(): Date { return new Date(this.time); }
  getAvailableTimes(): Date[] { return this.forecast?.times.map(time => new Date(time)) ?? []; }
  getWindState(): WindLayerState { return this.state; }

  subscribe(listener: (state: WindLayerState) => void): () => void {
    this.subscribers.add(listener);
    listener(this.state);
    return () => { this.subscribers.delete(listener); };
  }

  async setTime(time: Date): Promise<void> {
    const value = time.getTime();
    if (!Number.isFinite(value)) throw new RangeError('Invalid forecast date');
    if (this.forecast) bracketTime(this.forecast.times, value);
    this.time = value;
    this.clearField();
    await this.refresh();
  }

  async setProvider(provider: WindForecastProvider): Promise<void> {
    this.provider = provider;
    this.forecast = undefined;
    this.clearField();
    await this.refresh();
  }

  async reloadForecast(): Promise<void> {
    this.forecast = undefined;
    this.clearField();
    await this.refresh();
  }

  setMaximumKnots(maximum: number): void {
    if (!Number.isFinite(maximum) || maximum <= 0) throw new RangeError('Color maximum must be positive');
    this.maximum = maximum;
    this.textureLayer.getSource()?.changed();
  }

  sample(longitude: number, latitude: number): WindSample | null {
    return this.field ? sampleField(this.field, longitude, latitude) : null;
  }

  private publish(state: WindLayerState): void {
    this.state = state;
    for (const listener of this.subscribers) listener(state);
  }

  private clearField(): void {
    this.field = undefined;
    this.particlesLayer.setField(undefined);
    this.textureLayer.getSource()?.changed();
    this.barbsLayer.getSource()?.clear();
  }

  private async refresh(): Promise<void> {
    this.controller?.abort();
    const revision = ++this.revision;
    if (!this.map) { this.publish({ status: 'idle', time: this.time }); return; }
    const controller = this.controller = new AbortController();
    const { signal } = controller;
    const time = this.time;
    this.publish({ status: 'loading', time, forecast: this.forecast });
    try {
      const forecast = this.forecast ?? await this.provider.getForecast(signal);
      signal.throwIfAborted();
      if (revision !== this.revision) return;
      this.forecast = forecast;
      const bracket = bracketTime(forecast.times, time);
      const map = this.map;
      const view = map.getView();
      const projection = view.getProjection().getCode();
      if (projection !== 'EPSG:3857' && projection !== 'EPSG:4326') throw new Error('Unsupported wind view projection');
      const bounds = transformExtent(view.calculateExtent(map.getSize()), projection, 'EPSG:4326', 16);
      const centre = (bounds[0] + bounds[2]) / 2;
      const span = Math.min(360, bounds[2] - bounds[0]);
      const extent: Extent = [centre - span / 2, Math.max(-90, bounds[1]), centre + span / 2, Math.min(90, bounds[3])];
      if (extent[3] <= extent[1]) { this.clearField(); this.publish({ status: 'ready', time, forecast, bracket }); return; }
      const width = 512;
      const height = 256;
      const request = { forecast, extent, width, height, signal };
      const beforePromise = this.provider.loadField({ ...request, time: bracket.before });
      const afterPromise = bracket.after === bracket.before ? beforePromise : this.provider.loadField({ ...request, time: bracket.after });
      const [before, after] = await Promise.all([beforePromise, afterPromise]);
      signal.throwIfAborted();
      if (revision !== this.revision) return;
      if (before.time !== bracket.before || after.time !== bracket.after || before.forecast.id !== forecast.id ||
        before.forecast.model !== forecast.model || before.forecast.runTime !== forecast.runTime) throw new Error('Provider returned the wrong forecast frame');
      this.field = interpolateFields(before, after, time);
      this.particlesLayer.setField(this.field);
      this.textureLayer.getSource()?.setAttributions(forecast.attribution);
      this.textureLayer.getSource()?.changed();
      this.updateBarbs();
      this.publish({ status: 'ready', time, forecast, bracket });
    } catch (reason) {
      if (signal.aborted || revision !== this.revision) return;
      this.clearField();
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.publish({ status: 'error', time, forecast: this.forecast, error });
      throw error;
    }
  }

  private configureTexture(): void {
    const projection = this.map!.getView().getProjection();
    const previous = this.textureLayer.getSource();
    this.textureLayer.setSource(new ImageCanvasSource({
      projection, ratio: 1,
      canvasFunction: (extent, _resolution, _pixelRatio, size) => this.drawTexture(extent, size, projection),
    }));
    previous?.dispose();
  }

  private drawTexture(extent: number[], size: number[], projection: ProjectionLike): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size[0]));
    canvas.height = Math.max(1, Math.round(size[1]));
    if (!this.field) return canvas;
    const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height));
    const working = document.createElement('canvas');
    working.width = Math.max(1, Math.round(canvas.width * scale));
    working.height = Math.max(1, Math.round(canvas.height * scale));
    const context = working.getContext('2d')!;
    const image = context.createImageData(working.width, working.height);
    const longitudes = Array.from({ length: working.width }, (_, column) => transform([extent[0] + (column + 0.5) / working.width * (extent[2] - extent[0]), 0], projection, 'EPSG:4326')[0]);
    const latitudes = Array.from({ length: working.height }, (_, row) => transform([0, extent[3] - (row + 0.5) / working.height * (extent[3] - extent[1])], projection, 'EPSG:4326')[1]);
    for (let row = 0; row < working.height; row++) {
      for (let column = 0; column < working.width; column++) {
        const sample = sampleField(this.field, longitudes[column], latitudes[row]);
        if (!sample) continue;
        const offset = (row * working.width + column) * 4;
        image.data.set(jet(sample.speed * KNOTS_PER_MS, this.maximum), offset);
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    canvas.getContext('2d')!.drawImage(working, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  private updateBarbs(): void {
    const map = this.map;
    const field = this.field;
    const size = map?.getSize();
    if (!map || !field || !size) return;
    const features: Feature<Point>[] = [];
    const projection = map.getView().getProjection();
    const pixelRatio = Math.min(3, globalThis.devicePixelRatio || 1);
    for (let row = this.spacing / 2; row < size[1]; row += this.spacing) {
      for (let column = this.spacing / 2; column < size[0]; column += this.spacing) {
        const coordinate = map.getCoordinateFromPixel([column, row]);
        if (!coordinate) continue;
        const [longitude, latitude] = transform(coordinate, projection, 'EPSG:4326');
        const sample = sampleField(field, longitude, latitude);
        if (!sample) continue;
        const quantized = Math.min(500, Math.round(sample.speed * KNOTS_PER_MS / 5) * 5);
        const key = `${quantized}/${latitude < 0}/${pixelRatio}`;
        let canvas = this.iconCache.get(key);
        if (!canvas) {
          canvas = barbCanvas(quantized / KNOTS_PER_MS, latitude < 0, pixelRatio);
          this.iconCache.set(key, canvas);
          if (this.iconCache.size > 256) this.iconCache.delete(this.iconCache.keys().next().value!);
        }
        const feature = new Feature(new Point(coordinate));
        feature.setStyle(new Style({ image: new Icon({ img: canvas, anchor: [0.5, 0.75], scale: 1 / pixelRatio,
          rotation: (sample.direction ?? 0) * Math.PI / 180, rotateWithView: true }) }));
        features.push(feature);
      }
    }
    this.barbsLayer.getSource()!.clear();
    this.barbsLayer.getSource()!.addFeatures(features);
  }
}