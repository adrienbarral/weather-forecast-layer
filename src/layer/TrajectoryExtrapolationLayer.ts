import Map from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import LayerGroup from 'ol/layer/Group.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Fill from 'ol/style/Fill.js';
import Icon from 'ol/style/Icon.js';
import Stroke from 'ol/style/Stroke.js';
import Style from 'ol/style/Style.js';
import { getDistance } from 'ol/sphere.js';
import { transform } from 'ol/proj.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { EventsKey } from 'ol/events.js';
import { unByKey } from 'ol/Observable.js';

const earthRadius = 6_371_008.8;
const arrow = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32" viewBox="0 0 28 32"><path d="M14 1 27 30 14 23 1 30Z" fill="#16644c" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>')}`;

export interface TrajectoryExtrapolationLayerOptions {
  trajectory: Coordinate[];
  speed: number;
  currentPosition: Coordinate;
  time?: Date;
}

export class TrajectoryExtrapolationLayer extends LayerGroup {
  readonly trajectoryLayer: VectorLayer<VectorSource<Feature<LineString>>>;
  readonly positionLayer: VectorLayer<VectorSource<Feature<Point>>>;
  private readonly trajectory: Coordinate[];
  private readonly distances: number[];
  private readonly totalDistance: number;
  private readonly speed: number;
  private readonly positionFeature: Feature<Point>;
  private currentPosition: Coordinate;
  private currentTime: number;
  private anchorPosition: Coordinate;
  private anchorDistance: number;
  private anchorTime: number;
  private map?: Map;
  private projection = 'EPSG:3857';
  private addedToMap = false;
  private listeners: EventsKey[] = [];

  constructor(options: TrajectoryExtrapolationLayerOptions) {
    const trajectorySource = new VectorSource<Feature<LineString>>();
    const positionSource = new VectorSource<Feature<Point>>();
    const trajectoryLayer = new VectorLayer({ source: trajectorySource, style: new Style({ stroke: new Stroke({ color: '#dc6231', width: 3 }) }) });
    const positionFeature = new Feature<Point>(new Point([0, 0]));
    const positionLayer = new VectorLayer({ source: positionSource, style: new Style({ image: new Icon({ src: arrow, anchor: [0.5, 0.5], rotateWithView: true }) }) });
    positionSource.addFeature(positionFeature);
    super({ layers: [trajectoryLayer, positionLayer] });
    this.trajectoryLayer = trajectoryLayer;
    this.positionLayer = positionLayer;
    this.positionFeature = positionFeature;

    if (options.trajectory.length < 2 || options.trajectory.some(coordinate => !this.isValidPosition(coordinate))) {
      throw new RangeError('Trajectory needs at least two valid WGS84 coordinates');
    }
    if (!Number.isFinite(options.speed) || options.speed < 0) throw new RangeError('Trajectory speed must be a non-negative number of metres per second');
    this.trajectory = options.trajectory.map(coordinate => [coordinate[0], coordinate[1]]);
    this.speed = options.speed;
    this.distances = [0];
    for (let index = 1; index < this.trajectory.length; index++) {
      const segmentDistance = getDistance(this.trajectory[index - 1], this.trajectory[index]);
      if (!Number.isFinite(segmentDistance) || segmentDistance === 0) throw new RangeError('Trajectory segments must have non-zero length');
      this.distances.push(this.distances[index - 1] + segmentDistance);
    }
    this.totalDistance = this.distances.at(-1)!;
    this.currentTime = options.time?.getTime() ?? Date.now();
    if (!Number.isFinite(this.currentTime)) throw new RangeError('Invalid trajectory time');
    this.anchorTime = this.currentTime;
    this.anchorPosition = [...options.currentPosition];
    this.currentPosition = [...options.currentPosition];
    this.anchorDistance = this.nearestDistance(this.anchorPosition);
    this.updatePosition(this.pointAt(this.anchorDistance).heading);
  }

  attach(map: Map): void {
    this.detach();
    const projection = map.getView().getProjection().getCode();
    if (projection !== 'EPSG:3857' && projection !== 'EPSG:4326') throw new Error('Trajectory layer supports EPSG:3857 and EPSG:4326 views');
    this.map = map;
    this.projection = projection;
    this.addedToMap = !map.getLayers().getArray().includes(this);
    if (this.addedToMap) map.addLayer(this);
    const path = this.trajectory.map(coordinate => transform(coordinate, 'EPSG:4326', projection));
    this.trajectoryLayer.getSource()!.clear(true);
    this.trajectoryLayer.getSource()!.addFeature(new Feature(new LineString(path)));
    this.listeners = [map.on('change:view', () => this.updateGeometry())];
    this.updatePosition();
  }

  detach(): void {
    unByKey(this.listeners);
    this.listeners = [];
    if (this.map && this.addedToMap) this.map.removeLayer(this);
    this.map = undefined;
    this.addedToMap = false;
  }

  protected override disposeInternal(): void {
    this.detach();
    this.trajectoryLayer.dispose();
    this.positionLayer.dispose();
    super.disposeInternal();
  }

  setCurrentPosition(position: Coordinate, time: Date = new Date(this.currentTime)): void {
    if (!this.isValidPosition(position)) throw new RangeError('Current position must be a valid WGS84 coordinate');
    const timestamp = time.getTime();
    if (!Number.isFinite(timestamp)) throw new RangeError('Invalid trajectory time');
    this.currentPosition = [position[0], position[1]];
    this.anchorPosition = [...this.currentPosition];
    this.anchorDistance = this.nearestDistance(position);
    this.anchorTime = timestamp;
    this.currentTime = timestamp;
    this.updatePosition(this.pointAt(this.anchorDistance).heading);
  }

  setTime(time: Date): void {
    const timestamp = time.getTime();
    if (!Number.isFinite(timestamp)) throw new RangeError('Invalid trajectory time');
    if (timestamp === this.anchorTime) {
      this.currentPosition = [...this.anchorPosition];
      this.currentTime = timestamp;
      this.updatePosition(this.pointAt(this.anchorDistance).heading);
      return;
    }
    const distance = this.anchorDistance + this.speed * (timestamp - this.anchorTime) / 1000;
    const point = this.pointAt(Math.max(0, Math.min(this.totalDistance, distance)));
    this.currentPosition = point.position;
    this.currentTime = timestamp;
    this.updatePosition(point.heading + (distance < this.anchorDistance ? Math.PI : 0));
  }

  advanceTime(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new RangeError('Time increment must be finite');
    this.setTime(new Date(this.currentTime + seconds * 1000));
  }

  getTime(): Date { return new Date(this.currentTime); }
  getCurrentPosition(): Coordinate { return [...this.currentPosition]; }

  private isValidPosition(position: Coordinate): boolean {
    return position.length >= 2 && Number.isFinite(position[0]) && Number.isFinite(position[1]) &&
      position[0] >= -180 && position[0] <= 180 && position[1] >= -90 && position[1] <= 90;
  }

  private nearestDistance(position: Coordinate): number {
    const point = transform(position, 'EPSG:4326', 'EPSG:3857');
    let bestDistance = Infinity;
    let bestStation = 0;
    const projected = this.trajectory.map(coordinate => transform(coordinate, 'EPSG:4326', 'EPSG:3857'));
    for (let index = 0; index < projected.length - 1; index++) {
      const start = projected[index];
      const end = projected[index + 1];
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const fraction = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
      const offsetX = point[0] - start[0] - fraction * dx;
      const offsetY = point[1] - start[1] - fraction * dy;
      const distance = offsetX * offsetX + offsetY * offsetY;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestStation = this.distances[index] + fraction * (this.distances[index + 1] - this.distances[index]);
      }
    }
    return bestStation;
  }

  private pointAt(distance: number): { position: Coordinate; heading: number } {
    let segment = this.distances.findIndex((end, index) => index > 0 && distance <= end);
    if (segment < 0) segment = this.trajectory.length - 1;
    const startDistance = this.distances[segment - 1];
    const endDistance = this.distances[segment];
    const fraction = Math.max(0, Math.min(1, (distance - startDistance) / (endDistance - startDistance)));
    const start = this.trajectory[segment - 1];
    const end = this.trajectory[segment];
    const position = this.interpolateGreatCircle(start, end, fraction);
    const latitudeStart = start[1] * Math.PI / 180;
    const latitudeEnd = end[1] * Math.PI / 180;
    const deltaLongitude = ((end[0] - start[0] + 540) % 360 - 180) * Math.PI / 180;
    const heading = Math.atan2(Math.sin(deltaLongitude) * Math.cos(latitudeEnd),
      Math.cos(latitudeStart) * Math.sin(latitudeEnd) - Math.sin(latitudeStart) * Math.cos(latitudeEnd) * Math.cos(deltaLongitude));
    return { position, heading };
  }

  private interpolateGreatCircle(start: Coordinate, end: Coordinate, fraction: number): Coordinate {
    const angularDistance = getDistance(start, end) / earthRadius;
    const sinAngularDistance = Math.sin(angularDistance);
    if (Math.abs(sinAngularDistance) < 1e-12) return [...start];
    const startWeight = Math.sin((1 - fraction) * angularDistance) / sinAngularDistance;
    const endWeight = Math.sin(fraction * angularDistance) / sinAngularDistance;
    const latitudeStart = start[1] * Math.PI / 180;
    const longitudeStart = start[0] * Math.PI / 180;
    const latitudeEnd = end[1] * Math.PI / 180;
    const longitudeEnd = end[0] * Math.PI / 180;
    const x = startWeight * Math.cos(latitudeStart) * Math.cos(longitudeStart) + endWeight * Math.cos(latitudeEnd) * Math.cos(longitudeEnd);
    const y = startWeight * Math.cos(latitudeStart) * Math.sin(longitudeStart) + endWeight * Math.cos(latitudeEnd) * Math.sin(longitudeEnd);
    const z = startWeight * Math.sin(latitudeStart) + endWeight * Math.sin(latitudeEnd);
    return [Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI];
  }

  private updateGeometry(): void {
    if (!this.map) return;
    const path = this.trajectory.map(coordinate => transform(coordinate, 'EPSG:4326', this.projection));
    this.trajectoryLayer.getSource()!.clear(true);
    this.trajectoryLayer.getSource()!.addFeature(new Feature(new LineString(path)));
    this.updatePosition();
  }

  private updatePosition(heading?: number): void {
    const coordinate = transform(this.currentPosition, 'EPSG:4326', this.projection);
    this.positionFeature.getGeometry()!.setCoordinates(coordinate);
    if (heading !== undefined) {
      this.positionFeature.setStyle(new Style({ image: new Icon({ src: arrow, anchor: [0.5, 0.5], rotateWithView: true, rotation: heading }) }));
    }
  }
}