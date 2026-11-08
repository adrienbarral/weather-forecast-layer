import type { Forecast, FieldRequest, WindField, WindForecastProvider } from '../core/types.js';
import { decodeGfsComponent, type GribComponent, type GribDecoder } from './grib/decode.js';
import { fetchIndex, fetchMessage, type MessageRange } from './grib/sources.js';

export class OfficialGribProvider implements WindForecastProvider {
  private forecast?: Forecast;
  private ranges = new Map<number, [MessageRange, MessageRange]>();
  private fields = new Map<number, { u: GribComponent; v: GribComponent }>();
  private decoder?: GribDecoder;
  private readonly request: typeof fetch;

  readonly model = 'gfs';

  constructor(options: { fetch?: typeof fetch; decoder?: GribDecoder; now?: () => number } = {}) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.decoder = options.decoder;
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  async getForecast(signal: AbortSignal): Promise<Forecast> {
    const now = new Date(this.now());
    const latestCycle = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(now.getUTCHours() / 6) * 6);
    for (let offset = 0; offset < 8; offset++) {
      const runTime = latestCycle - offset * 21_600_000;
      const endStep = 72;
      try {
        const range = await fetchIndex(runTime, endStep, signal, this.request);
        const run = new Date(runTime).toISOString().replaceAll(':', '').replaceAll('-', '');
        const forecast: Forecast = {
          id: `${this.model}/${run}`, model: this.model, runTime, height: 10,
          times: Array.from({ length: 73 }, (_, index) => runTime + index * 3_600_000),
          attribution: 'NOAA GFS. GRIB data retrieved directly from NOAA; no NOAA endorsement.',
        };
        if (this.forecast?.id !== forecast.id) {
          this.ranges.clear();
          this.fields.clear();
        }
        this.forecast = forecast;
        this.ranges.set(forecast.times.at(-1)!, range);
        return forecast;
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof Error) || !/index HTTP 404/.test(error.message)) throw error;
      }
    }
    throw new Error(`${this.model.toUpperCase()} has no published 72-hour forecast cycle`);
  }

  async loadField(request: FieldRequest): Promise<WindField> {
    request.signal.throwIfAborted();
    const forecast = this.forecast;
    if (!forecast || request.forecast.id !== forecast.id || request.forecast.model !== this.model || request.forecast.runTime !== forecast.runTime) {
      throw new Error('Unknown or incompatible pinned official forecast');
    }
    if (!forecast.times.includes(request.time)) throw new RangeError('Official GRIB frames require a native forecast time');
    const key = request.time;
    let pair = this.fields.get(key);
    if (!pair) {
      pair = await this.loadPair(forecast, request.time, request.signal);
      request.signal.throwIfAborted();
      this.fields.set(key, pair);
      if (this.fields.size > 2) this.fields.delete(this.fields.keys().next().value!);
    }
    const { u, v } = pair;
    request.signal.throwIfAborted();
    if (u.width !== v.width || u.height !== v.height || u.extent.some((value, index) => value !== v.extent[index])) {
      throw new Error('GRIB U and V components use different grids');
    }
    const [west, south, east, north] = request.extent;
    if (!request.extent.every(Number.isFinite) || east <= west || east - west > 360.001 || north <= south || south < -90 || north > 90 ||
      !Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 1 || request.height < 1 || request.width > 1024 || request.height > 1024) {
      throw new RangeError('Invalid wind field extent or dimensions');
    }
    const width = request.width;
    const height = request.height;
    const field: WindField = { forecast, time: request.time, extent: [...request.extent], width, height,
      eastward: new Float32Array(width * height), northward: new Float32Array(width * height), valid: new Uint8Array(width * height) };
    const [sourceWest, sourceSouth, sourceEast, sourceNorth] = u.extent;
    for (let row = 0; row < height; row++) {
      request.signal.throwIfAborted();
      const latitude = north - (row + 0.5) / height * (north - south);
      if (latitude < sourceSouth || latitude > sourceNorth) continue;
      for (let column = 0; column < width; column++) {
        const longitude = west + (column + 0.5) / width * (east - west);
        const shifted = longitude + 360 * Math.round(((sourceWest + sourceEast) / 2 - longitude) / 360);
        if (shifted < sourceWest || shifted > sourceEast) continue;
        const sourceX = Math.max(0, Math.min(u.width - 1, (shifted - sourceWest) / (sourceEast - sourceWest) * u.width - 0.5));
        const sourceY = Math.max(0, Math.min(u.height - 1, (sourceNorth - latitude) / (sourceNorth - sourceSouth) * u.height - 0.5));
        const x0 = Math.floor(sourceX), y0 = Math.floor(sourceY);
        const x1 = Math.min(x0 + 1, u.width - 1), y1 = Math.min(y0 + 1, u.height - 1);
        const fractionX = sourceX - x0, fractionY = sourceY - y0;
        const indices = [y0 * u.width + x0, y0 * u.width + x1, y1 * u.width + x0, y1 * u.width + x1];
        const weights = [(1 - fractionX) * (1 - fractionY), fractionX * (1 - fractionY), (1 - fractionX) * fractionY, fractionX * fractionY];
        if (indices.some((index, item) => weights[item] > 0 && (!u.valid[index] || !v.valid[index]))) continue;
        const index = row * width + column;
        for (let item = 0; item < indices.length; item++) {
          field.eastward[index] += u.values[indices[item]] * weights[item];
          field.northward[index] += v.values[indices[item]] * weights[item];
        }
        field.valid[index] = 1;
      }
    }
    return field;
  }

  dispose(): void {
    this.decoder?.dispose();
    this.ranges.clear();
    this.fields.clear();
  }

  private async loadPair(forecast: Forecast, time: number, signal: AbortSignal): Promise<{ u: GribComponent; v: GribComponent }> {
    let ranges = this.ranges.get(time);
    if (!ranges) {
      ranges = await fetchIndex(forecast.runTime, (time - forecast.runTime) / 3_600_000, signal, this.request);
      signal.throwIfAborted();
      this.ranges.set(time, ranges);
      if (this.ranges.size > 74) this.ranges.delete(this.ranges.keys().next().value!);
    }
    const [uRange, vRange] = ranges;
    signal.throwIfAborted();
    const [uBytes, vBytes] = await Promise.all([
      fetchMessage(forecast.runTime, (time - forecast.runTime) / 3_600_000, uRange, signal, this.request),
      fetchMessage(forecast.runTime, (time - forecast.runTime) / 3_600_000, vRange, signal, this.request),
    ]);
    return { u: await this.decode(uBytes, forecast, time, 'u', signal), v: await this.decode(vBytes, forecast, time, 'v', signal) };
  }

  private async decode(bytes: Uint8Array, forecast: Forecast, time: number, component: 'u' | 'v', signal: AbortSignal): Promise<GribComponent> {
    signal.throwIfAborted();
    const field = this.decoder
      ? await this.decoder.decode(bytes, forecast, time, component, signal)
      : decodeGfsComponent(bytes, forecast, time, component);
    signal.throwIfAborted();
    return field;
  }
}