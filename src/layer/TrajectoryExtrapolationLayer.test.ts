import { describe, expect, it } from 'vitest';
import { TrajectoryExtrapolationLayer } from './TrajectoryExtrapolationLayer.js';

const time = new Date('2026-11-08T12:00:00Z');
const route: [number, number][] = [[0, 0], [0.01, 0], [0.01, 0.01]];

describe('TrajectoryExtrapolationLayer', () => {
  it('anchors off-route position and advances at the configured metres per second', () => {
    const position: [number, number] = [0.005, 0.001];
    const layer = new TrajectoryExtrapolationLayer({ trajectory: route, speed: 10, currentPosition: position, time });
    layer.setTime(time);
    expect(layer.getCurrentPosition()).toEqual(position);
    layer.advanceTime(10);
    const moved = layer.getCurrentPosition();
    expect(moved[0]).toBeGreaterThan(position[0]);
    expect(moved[1]).toBeCloseTo(0, 4);
    expect(layer.getTime().getTime()).toBe(time.getTime() + 10_000);
    layer.setTime(time);
    expect(layer.getCurrentPosition()).toEqual(position);
    layer.dispose();
  });

  it('re-anchors after setCurrentPosition and clamps at trajectory endpoints', () => {
    const layer = new TrajectoryExtrapolationLayer({ trajectory: route, speed: 100, currentPosition: route[0], time });
    const reset: [number, number] = [0.008, 0.001];
    const resetTime = new Date(time.getTime() + 20_000);
    layer.setCurrentPosition(reset, resetTime);
    expect(layer.getCurrentPosition()).toEqual(reset);
    layer.advanceTime(3_600);
    expect(layer.getCurrentPosition()[0]).toBeCloseTo(route[route.length - 1][0]);
    expect(layer.getCurrentPosition()[1]).toBeCloseTo(route[route.length - 1][1]);
    layer.setTime(new Date(resetTime.getTime() - 3_600_000));
    expect(layer.getCurrentPosition()[0]).toBeCloseTo(route[0][0]);
    expect(layer.getCurrentPosition()[1]).toBeCloseTo(route[0][1]);
    layer.dispose();
  });

  it('validates trajectory, speed, and position inputs', () => {
    expect(() => new TrajectoryExtrapolationLayer({ trajectory: [[0, 0]], speed: 1, currentPosition: [0, 0] })).toThrow();
    expect(() => new TrajectoryExtrapolationLayer({ trajectory: route, speed: -1, currentPosition: [0, 0] })).toThrow();
    const layer = new TrajectoryExtrapolationLayer({ trajectory: route, speed: 0, currentPosition: [0, 0] });
    expect(() => layer.setCurrentPosition([181, 0])).toThrow();
    expect(() => layer.setTime(new Date(Number.NaN))).toThrow();
    layer.dispose();
  });
});