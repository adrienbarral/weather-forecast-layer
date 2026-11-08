import { describe, expect, it } from 'vitest';
import { OfficialGribProvider } from './OfficialGribProvider';
import type { GribComponent, GribDecoder } from './grib/decode';

const run = Date.UTC(2026, 10, 7);

const message = () => {
  const bytes = new Uint8Array(20);
  bytes.set([71, 82, 73, 66]);
  bytes.set([55, 55, 55, 55], 16);
  return bytes;
};

function decoder(): GribDecoder {
  return {
    async decode(_bytes, forecast, time, component): Promise<GribComponent> {
      const values = new Float32Array(8).fill(component === 'u' ? (time === run + 3_600_000 ? 10 : 30) : -5);
      return { width: 4, height: 2, extent: [-180, -90, 180, 90], values, valid: new Uint8Array(8).fill(1) };
    },
    dispose() {},
  };
}

function source() {
  let latestRunChecks = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const step = Number(/\.f(\d{3})(?:\.idx)?$/.exec(url.pathname)?.[1]);
    if (url.pathname.endsWith('.idx')) {
      latestRunChecks++;
      const forecast = step === 0 ? 'anl' : `${step} hour fcst`;
      const body = `1:0:d=2026110700:UGRD:10 m above ground:${forecast}:\n2:20:d=2026110700:VGRD:10 m above ground:${forecast}:\n3:40:d=2026110700:TMP:2 m above ground:${forecast}:`;
      return new Response(body, { status: 200 });
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
    if (!range) return new Response(null, { status: 400 });
    const start = Number(range[1]);
    const bytes = message().subarray(0, Number(range[2]) - start + 1);
    return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes ${start}-${range[2]}/40` } });
  };
  return { request, count: () => latestRunChecks };
}

describe('OfficialGribProvider', () => {
  it('discovers GFS, loads native components over HTTP Range and supports global copies', async () => {
    const server = source();
    const provider = new OfficialGribProvider({ fetch: server.request, decoder: decoder(), now: () => run + 2 * 3_600_000 });
    const signal = new AbortController().signal;
    const forecast = await provider.getForecast(signal);
    expect(forecast.model).toBe('gfs');
    expect(forecast.times).toHaveLength(73);
    expect(server.count()).toBe(1);
    const field = await provider.loadField({ forecast, time: run + 3_600_000, extent: [170, -10, 190, 10], width: 8, height: 4, signal });
    expect([...field.valid]).toEqual(new Array(32).fill(1));
    expect(field.eastward.every(value => value === 10)).toBe(true);
    provider.dispose();
  });

  it('refuses another forecast or non-native time', async () => {
    const provider = new OfficialGribProvider({ fetch: source().request, decoder: decoder(), now: () => run + 2 * 3_600_000 });
    const signal = new AbortController().signal;
    const forecast = await provider.getForecast(signal);
    await expect(provider.loadField({ forecast: { ...forecast, model: 'other' }, time: forecast.times[1], extent: [-10, -5, 10, 5], width: 4, height: 2, signal })).rejects.toThrow('incompatible');
    await expect(provider.loadField({ forecast, time: run + 30 * 60_000, extent: [-10, -5, 10, 5], width: 4, height: 2, signal })).rejects.toThrow('native');
    provider.dispose();
  });
});