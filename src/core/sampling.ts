import type { TimeBracket, WindField, WindSample } from './types.js';

export const KNOTS_PER_MS = 1.9438444924406;

export function bracketTime(times: number[], time: number): TimeBracket {
  if (!times.length || !times.every((value, index) => Number.isFinite(value) && (!index || value > times[index - 1]))) {
    throw new Error('Forecast times must be finite, sorted and unique');
  }
  if (!Number.isFinite(time) || time < times[0] || time > times[times.length - 1]) {
    throw new RangeError('Time is outside the available forecast');
  }
  const afterIndex = times.findIndex(value => value >= time);
  const after = times[afterIndex];
  const before = after === time ? after : times[afterIndex - 1];
  return { before, after, alpha: before === after ? 0 : (time - before) / (after - before) };
}

export function interpolateFields(before: WindField, after: WindField, time: number): WindField {
  for (const field of [before, after]) {
    const size = field.width * field.height;
    if (!Number.isInteger(field.width) || !Number.isInteger(field.height) || field.width < 1 || field.height < 1 ||
      field.extent.length !== 4 || !field.extent.every(Number.isFinite) || field.extent[2] <= field.extent[0] || field.extent[3] <= field.extent[1] ||
      field.eastward.length !== size || field.northward.length !== size || field.valid.length !== size) {
      throw new Error('Invalid wind field dimensions or georeferencing');
    }
  }
  if (before.forecast.id !== after.forecast.id || before.forecast.model !== after.forecast.model ||
    before.forecast.runTime !== after.forecast.runTime || before.forecast.height !== after.forecast.height ||
    before.width !== after.width || before.height !== after.height ||
    before.extent.some((value, index) => value !== after.extent[index])) {
    throw new Error('Cannot interpolate different forecasts or grids');
  }
  const { alpha } = bracketTime(before.time === after.time ? [before.time] : [before.time, after.time], time);
  if (time === before.time) return before;
  if (time === after.time) return after;
  const size = before.width * before.height;
  const result: WindField = { ...before, time, eastward: new Float32Array(size), northward: new Float32Array(size), valid: new Uint8Array(size) };
  for (let index = 0; index < size; index++) {
    if (!before.valid[index] || !after.valid[index]) continue;
    result.eastward[index] = before.eastward[index] * (1 - alpha) + after.eastward[index] * alpha;
    result.northward[index] = before.northward[index] * (1 - alpha) + after.northward[index] * alpha;
    result.valid[index] = Number.isFinite(result.eastward[index]) && Number.isFinite(result.northward[index]) ? 1 : 0;
  }
  return result;
}

export function windSample(eastward: number, northward: number): WindSample {
  const speed = Math.hypot(eastward, northward);
  return { eastward, northward, speed, direction: speed < 1e-6 ? null : (Math.atan2(-eastward, -northward) * 180 / Math.PI + 360) % 360 };
}

export function sampleField(field: WindField, longitude: number, latitude: number): WindSample | null {
  const [west, south, east, north] = field.extent;
  longitude += 360 * Math.round(((west + east) / 2 - longitude) / 360);
  if (longitude < west || longitude > east || latitude < south || latitude > north) return null;
  const column = Math.max(0, Math.min(field.width - 1, (longitude - west) / (east - west) * field.width - 0.5));
  const row = Math.max(0, Math.min(field.height - 1, (north - latitude) / (north - south) * field.height - 0.5));
  const left = Math.floor(column);
  const top = Math.floor(row);
  const right = Math.min(left + 1, field.width - 1);
  const bottom = Math.min(top + 1, field.height - 1);
  const fractionX = column - left;
  const fractionY = row - top;
  const indices = [top * field.width + left, top * field.width + right, bottom * field.width + left, bottom * field.width + right];
  const weights = [(1 - fractionX) * (1 - fractionY), fractionX * (1 - fractionY), (1 - fractionX) * fractionY, fractionX * fractionY];
  let eastward = 0;
  let northward = 0;
  for (let index = 0; index < 4; index++) {
    if (weights[index] === 0) continue;
    const cell = indices[index];
    if (!field.valid[cell]) return null;
    eastward += field.eastward[cell] * weights[index];
    northward += field.northward[cell] * weights[index];
  }
  return Number.isFinite(eastward) && Number.isFinite(northward) ? windSample(eastward, northward) : null;
}