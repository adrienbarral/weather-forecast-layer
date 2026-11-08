import { describe, expect, it } from 'vitest';
import { bracketTime, interpolateFields, sampleField, windSample } from './sampling';
import type { WindField } from './types';

const field = (time: number, eastward = 0, northward = -10): WindField => ({
  forecast: { id: 'gfs/run', model: 'gfs', runTime: 0, times: [0, 3], height: 10, attribution: 'NOAA' },
  time, extent: [-180, -90, 180, 90], width: 2, height: 2,
  eastward: new Float32Array(4).fill(eastward), northward: new Float32Array(4).fill(northward), valid: new Uint8Array(4).fill(1),
});

describe('wind interpolation', () => {
  it('uses actual time intervals and rejects extrapolation', () => {
    expect(bracketTime([0, 3, 9], 6)).toEqual({ before: 3, after: 9, alpha: 0.5 });
    expect(bracketTime([0, 3], 3)).toEqual({ before: 3, after: 3, alpha: 0 });
    expect(() => bracketTime([0, 3], 4)).toThrow(RangeError);
    expect(() => bracketTime([0, 0], 0)).toThrow();
  });
  it('crosses north rather than interpolating angles through south', () => {
    const before = field(0, 1.7364818, -9.848078);
    const after = field(3, -1.7364818, -9.848078);
    const result = interpolateFields(before, after, 1.5);
    expect(sampleField(result, 0, 0)?.direction).toBeCloseTo(0);
    expect(result.time).toBe(1.5);
    expect(interpolateFields(before, after, 0)).toBe(before);
  });
  it('handles calm, cardinal directions and missing values', () => {
    expect(windSample(0, 0).direction).toBeNull();
    expect(windSample(-10, 0).direction).toBe(90);
    expect(sampleField(interpolateFields(field(0, 10), field(3, -10, 10), 1.5), 0, 0)?.speed).toBe(0);
    const missing = field(3);
    missing.valid.fill(0);
    expect(sampleField(interpolateFields(field(0), missing, 1.5), 0, 0)).toBeNull();
  });
  it('never blends models, runs or grids', () => {
    const other = field(3);
    other.forecast = { ...other.forecast, model: 'ecmwf' };
    expect(() => interpolateFields(field(0), other, 1)).toThrow('different forecasts');
    other.forecast = field(0).forecast;
    other.extent = [0, 0, 10, 10];
    expect(() => interpolateFields(field(0), other, 1)).toThrow('grids');
  });
  it('wraps world copies and samples cell centres without shifting', () => {
    const data = field(0);
    data.eastward.set([1, 2, 3, 4]);
    expect(sampleField(data, -90, 45)?.eastward).toBe(1);
    expect(sampleField(data, 270, 45)?.eastward).toBe(1);
    expect(sampleField(data, 0, 0)?.eastward).toBe(2.5);
  });
  it('rejects malformed provider arrays even at an exact forecast time', () => {
    const malformed = field(0);
    malformed.eastward = new Float32Array(1);
    expect(() => interpolateFields(malformed, malformed, 0)).toThrow('dimensions');
  });
});