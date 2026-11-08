import { KNOTS_PER_MS } from '../core/sampling.js';

export function jet(speed: number, maximum = 60): [number, number, number] {
  if (!Number.isFinite(maximum) || maximum <= 0) throw new RangeError('Color maximum must be positive');
  const normalized = Math.max(0, Math.min(1, speed / maximum));
  return [3, 2, 1].map(center => Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * normalized - center))))) as [number, number, number];
}

export function trailOpacity(distanceFromHead: number): number {
  return 0.12 + 0.68 * (1 - Math.max(0, Math.min(1, distanceFromHead)));
}

export function barbParts(speed: number): { flags: number; full: number; half: number } {
  const knots = Math.max(0, Math.min(500, Math.round(speed * KNOTS_PER_MS / 5) * 5));
  return { flags: Math.floor(knots / 50), full: Math.floor(knots % 50 / 10), half: knots % 10 >= 5 ? 1 : 0 };
}

export function barbCanvas(speed: number, southern: boolean, pixelRatio: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 52 * pixelRatio;
  canvas.height = 64 * pixelRatio;
  const context = canvas.getContext('2d')!;
  context.scale(pixelRatio, pixelRatio);
  context.strokeStyle = '#17201d';
  context.fillStyle = '#17201d';
  context.lineWidth = 1.6;
  context.lineCap = 'round';
  context.shadowColor = '#ffffff';
  context.shadowBlur = 2;
  const { flags, full, half } = barbParts(speed);
  context.beginPath();
  if (!flags && !full && !half) {
    context.arc(26, 48, 3.5, 0, Math.PI * 2);
    context.stroke();
    return canvas;
  }
  context.moveTo(26, 48);
  context.lineTo(26, 8);
  context.stroke();
  const side = southern ? -1 : 1;
  let position = 8;
  for (let index = 0; index < flags; index++) {
    context.beginPath();
    context.moveTo(26, position);
    context.lineTo(26 + side * 13, position - 4);
    context.lineTo(26, position + 7);
    context.closePath();
    context.fill();
    position += 9;
  }
  context.beginPath();
  for (let index = 0; index < full; index++) {
    context.moveTo(26, position);
    context.lineTo(26 + side * 13, position - 5);
    position += 5;
  }
  if (half) {
    if (!flags && !full) position += 5;
    context.moveTo(26, position);
    context.lineTo(26 + side * 7, position - 3);
  }
  context.stroke();
  return canvas;
}