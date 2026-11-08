import ImageLayer from 'ol/layer/Image.js';
import ImageCanvasSource from 'ol/source/ImageCanvas.js';
import type { Extent } from 'ol/extent.js';
import { transform, transformExtent } from 'ol/proj.js';
import type Projection from 'ol/proj/Projection.js';
import type { Size } from 'ol/size.js';
import type { WindField } from '../core/types.js';
import { sampleField } from '../core/sampling.js';
import { trailOpacity } from '../render/wind.js';

const earthRadius = 6_371_008.8;
const referenceSpeed = 12;
const targetPixelsPerSecond = 16;
const particleCount = 360;
const particleLifetimeSeconds = 4;
const particleSpawnOffsetSeconds = 1;

interface Particle {
  longitude: number;
  latitude: number;
  position?: [number, number];
  trail: [number, number][];
  trailLength: number;
  ageSeconds: number;
  generation: number;
}

export class WindParticleLayer extends ImageLayer<ImageCanvasSource> {
  private readonly canvas: HTMLCanvasElement;
  private field?: WindField;
  private particles: Particle[] = [];
  private animationFrame = 0;
  private active = false;
  private viewportKey = '';
  private lastFrameTime?: number;
  private randomState = 1;

  constructor(options: { visible?: boolean } = {}) {
    const canvas = document.createElement('canvas');
    let renderFrame = (_extent: Extent, _resolution: number, _pixelRatio: number, _size: Size, _projection: Projection) => canvas;
    const source = new ImageCanvasSource({ ratio: 1, canvasFunction: (extent, resolution, pixelRatio, size, projection) =>
      renderFrame(extent, resolution, pixelRatio, size, projection) });
    super({ source, visible: options.visible ?? true });
    this.canvas = canvas;
    this.on('change:visible', () => this.updateAnimation());
    this.sourceReady = source;
    renderFrame = (extent, resolution, pixelRatio, size, projection) => this.renderFrame(extent, resolution, pixelRatio, size, projection);
  }

  private readonly sourceReady: ImageCanvasSource;

  setField(field?: WindField): void {
    this.field = field;
    this.viewportKey = '';
    this.lastFrameTime = undefined;
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.sourceReady.changed();
    this.updateAnimation();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.updateAnimation();
  }

  protected override disposeInternal(): void {
    this.active = false;
    this.updateAnimation();
    this.particles = [];
    super.disposeInternal();
  }

  private updateAnimation(): void {
    const shouldAnimate = this.active && this.getVisible() && Boolean(this.field);
    if (shouldAnimate && !this.animationFrame) this.animationFrame = requestAnimationFrame(this.animate);
    if (!shouldAnimate && this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }

  private animate = (): void => {
    this.animationFrame = 0;
    if (!this.active || !this.getVisible() || !this.field) return;
    this.sourceReady.changed();
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private renderFrame(extent: Extent, resolution: number, pixelRatio: number, size: Size, projection: Projection): HTMLCanvasElement {
    const width = Math.max(1, Math.round(size[0]));
    const height = Math.max(1, Math.round(size[1]));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.canvas.getContext('2d');
    if (!context) return this.canvas;
    if (!this.field) {
      context.clearRect(0, 0, width, height);
      return this.canvas;
    }
    const key = `${extent.join(',')}/${resolution}/${width}/${height}/${projection.getCode()}`;
    const geographicExtent = transformExtent(extent, projection, 'EPSG:4326', 8) as [number, number, number, number];
    if (key !== this.viewportKey) {
      context.clearRect(0, 0, width, height);
      this.viewportKey = key;
      this.seedParticles(geographicExtent);
      this.lastFrameTime = undefined;
    }
    const now = performance.now();
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - (this.lastFrameTime ?? now)) / 1000));
    this.lastFrameTime = now;
    context.clearRect(0, 0, width, height);
    const [geographicWest, geographicSouth, geographicEast, geographicNorth] = geographicExtent;
    const trails: [number, number, number, number][][] = Array.from({ length: 8 }, () => []);
    const maximumTrailLength = 25 * pixelRatio;
    const minimumPointSpacing = 0.75 * pixelRatio;
    for (const particle of this.particles) {
      const sample = sampleField(this.field, particle.longitude, particle.latitude);
      if (!sample) {
        this.respawn(particle, extent);
        continue;
      }
      const latitudeRadians = particle.latitude * Math.PI / 180;
      const metresPerPixel = projection.getCode() === 'EPSG:4326'
        ? resolution * Math.PI / 180 * earthRadius * Math.max(0.05, Math.cos(latitudeRadians))
        : resolution;
      const simulatedSeconds = deltaSeconds * metresPerPixel * targetPixelsPerSecond / referenceSpeed;
      const latitude = particle.latitude + sample.northward * simulatedSeconds / earthRadius * 180 / Math.PI;
      const longitude = particle.longitude + sample.eastward * simulatedSeconds / (earthRadius * Math.max(0.05, Math.cos(latitudeRadians))) * 180 / Math.PI;
      particle.ageSeconds += deltaSeconds;
      const centreLongitude = (this.field.extent[0] + this.field.extent[2]) / 2;
      particle.longitude = longitude + 360 * Math.round((centreLongitude - longitude) / 360);
      particle.latitude = latitude;
      if (particle.latitude < geographicSouth || particle.latitude > geographicNorth || particle.longitude < geographicWest || particle.longitude > geographicEast) {
        this.respawn(particle, extent);
        continue;
      }
      const projected = transform([particle.longitude, particle.latitude], 'EPSG:4326', projection);
      const [west, south, east, north] = extent;
      const pixel: [number, number] = [
        (projected[0] - west) / (east - west) * width,
        (north - projected[1]) / (north - south) * height,
      ];
      particle.position = pixel;
      if (particle.ageSeconds >= particleLifetimeSeconds) {
        this.respawn(particle, geographicExtent);
        continue;
      }
      this.appendTrail(particle, pixel, maximumTrailLength, minimumPointSpacing);
      let distanceFromHead = 0;
      for (let index = particle.trail.length - 1; index > 0; index--) {
        const from = particle.trail[index - 1];
        const to = particle.trail[index];
        const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
        const middleDistance = distanceFromHead + length / 2;
        const bucket = Math.min(7, Math.floor(middleDistance / maximumTrailLength * 8));
        trails[bucket].push([from[0], from[1], to[0], to[1]]);
        distanceFromHead += length;
      }
    }
    context.lineWidth = Math.max(1, pixelRatio);
    context.lineCap = 'round';
    for (let bucket = 0; bucket < trails.length; bucket++) {
      if (!trails[bucket].length) continue;
      context.beginPath();
      for (const [fromX, fromY, toX, toY] of trails[bucket]) {
        context.moveTo(fromX, fromY);
        context.lineTo(toX, toY);
      }
      context.strokeStyle = `rgba(255,255,255,${trailOpacity((bucket + 0.5) / trails.length)})`;
      context.stroke();
    }
    context.lineWidth = Math.max(1.25, 1.5 * pixelRatio);
    context.strokeStyle = 'rgba(255,255,255,0.98)';
    for (const particle of this.particles) {
      if (particle.trail.length < 2) continue;
      const end = particle.trail.at(-1)!;
      const previous = particle.trail.at(-2)!;
      const segmentLength = Math.hypot(end[0] - previous[0], end[1] - previous[1]);
      if (segmentLength === 0) continue;
      const headLength = Math.min(4 * pixelRatio, segmentLength);
      const startX = end[0] - (end[0] - previous[0]) / segmentLength * headLength;
      const startY = end[1] - (end[1] - previous[1]) / segmentLength * headLength;
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(end[0], end[1]);
      context.stroke();
    }
    return this.canvas;
  }

  private appendTrail(particle: Particle, pixel: [number, number], maximumLength: number, minimumSpacing: number): void {
    const previous = particle.trail.at(-1);
    if (!previous) {
      particle.trail.push(pixel);
      return;
    }
    const nextLength = Math.hypot(pixel[0] - previous[0], pixel[1] - previous[1]);
    if (nextLength >= minimumSpacing) {
      particle.trail.push(pixel);
      particle.trailLength += nextLength;
    }
    while (particle.trail.length > 1 && particle.trailLength > maximumLength) {
      const first = particle.trail[0];
      const second = particle.trail[1];
      const firstSegmentLength = Math.hypot(second[0] - first[0], second[1] - first[1]);
      const excess = particle.trailLength - maximumLength;
      if (excess >= firstSegmentLength) {
        particle.trail.shift();
        particle.trailLength -= firstSegmentLength;
      } else {
        const fraction = excess / firstSegmentLength;
        particle.trail[0] = [first[0] + (second[0] - first[0]) * fraction, first[1] + (second[1] - first[1]) * fraction];
        particle.trailLength = maximumLength;
      }
    }
  }

  private seedParticles(extent: number[]): void {
    this.randomState = ((this.field?.time ?? 1) ^ Math.round(extent[0] * 1e5) ^ Math.round(extent[1] * 1e5)) >>> 0 || 1;
    this.particles = Array.from({ length: particleCount }, () => {
      const longitude = extent[0] + this.random() * (extent[2] - extent[0]);
      const latitude = extent[1] + this.random() * (extent[3] - extent[1]);
      return { longitude, latitude, trail: [], trailLength: 0, ageSeconds: this.random() * particleSpawnOffsetSeconds, generation: 0 };
    });
  }

  private respawn(particle: Particle, extent: number[]): void {
    particle.longitude = extent[0] + this.random() * (extent[2] - extent[0]);
    particle.latitude = extent[1] + this.random() * (extent[3] - extent[1]);
    particle.trail = [];
    particle.trailLength = 0;
    particle.ageSeconds = 0;
    particle.generation++;
    particle.position = undefined;
  }

  private random(): number {
    this.randomState = (1664525 * this.randomState + 1013904223) >>> 0;
    return this.randomState / 0x1_0000_0000;
  }
}