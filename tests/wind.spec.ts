import { expect, test, type Page } from '@playwright/test';

const run = Date.UTC(2026, 10, 7);

async function renderedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    let colors = 0;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>('#map .ol-layer canvas')) {
      const context = canvas.getContext('2d');
      if (!context) continue;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 16) {
        if (data[index + 3] > 0 && Math.max(data[index], data[index + 1], data[index + 2]) - Math.min(data[index], data[index + 1], data[index + 2]) > 70) colors++;
      }
    }
    return colors;
  });
}

async function mockGrib(page: Page): Promise<void> {
  await page.route('**/fonts.googleapis.com/**', route => route.abort());
  await page.route('**/tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==', 'base64') }));
  await page.route('**/src/providers/grib/decode.ts*', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export function decodeGfsComponent(_bytes, _forecast, time, component) {
      const count = 1440 * 721;
      const values = new Float32Array(count).fill(component === 'v' ? -5 : time === ${run + 3_600_000} ? 10 : 30);
      return { width: 1440, height: 721, extent: [-0.125, -90.125, 359.875, 90.125], values, valid: new Uint8Array(count).fill(1) };
    }`,
  }));
  await page.route('**noaa-gfs-bdp-pds.s3.amazonaws.com/**', async route => {
    const url = new URL(route.request().url());
    const step = Number(/\.f(\d{3})(?:\.idx)?$/.exec(url.pathname)?.[1]);
    if (url.pathname.endsWith('.idx')) {
      const lead = step === 0 ? 'anl' : `${step} hour fcst`;
      await route.fulfill({ body: `1:0:d=2026110700:UGRD:10 m above ground:${lead}:\n2:20:d=2026110700:VGRD:10 m above ground:${lead}:\n3:40:d=2026110700:TMP:2 m above ground:${lead}:` });
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? '');
    expect(range).not.toBeNull();
    const start = Number(range![1]);
    const bytes = new Uint8Array(Number(range![2]) - start + 1);
    bytes.set([71, 82, 73, 66]);
    bytes.set([55, 55, 55, 55], bytes.length - 4);
    await route.fulfill({ status: 206, headers: { 'Content-Range': `bytes ${start}-${range![2]}/40` }, body: Buffer.from(bytes) });
  });
}

test('NOAA GRIB layer, temporal interpolation and controls', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date(run + 90 * 60_000));
  await mockGrib(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#map-status')).toHaveAttribute('data-status', 'ready');
  await expect(page.locator('#forecast-status')).toHaveText('Prévision interpolée');
  await expect.poll(() => renderedPixels(page)).toBeGreaterThan(100);
  const sample = await page.evaluate(async () => {
    const path = document.querySelector<HTMLScriptElement>('script[src*="/main.ts"]')!.src;
    return (await import(path)).wind.sample(-4, 48);
  });
  expect(sample.eastward).toBeCloseTo(20);
  expect(sample.northward).toBeCloseTo(-5);
  await expect(page.locator('#trajectory-speed')).toHaveText('--');
  await page.getByRole('button', { name: 'Tracer une trajectoire' }).click();
  const drawPixels = await page.evaluate(async () => {
    const path = document.querySelector<HTMLScriptElement>('script[src*="/main.ts"]')!.src;
    const { map } = await import(path);
    const [width, height] = map.getSize();
    return [[width * 0.3, height * 0.42], [width * 0.45, height * 0.48], [width * 0.6, height * 0.45]];
  });
  await page.mouse.click(drawPixels[0][0], drawPixels[0][1]);
  await page.mouse.click(drawPixels[1][0], drawPixels[1][1]);
  await page.mouse.dblclick(drawPixels[2][0], drawPixels[2][1]);
  await expect(page.getByRole('button', { name: 'Effacer la trajectoire' })).toBeVisible();
  const initialTrajectoryPosition = await page.evaluate(async () => {
    const path = document.querySelector<HTMLScriptElement>('script[src*="/main.ts"]')!.src;
    const { trajectory, wind } = await import(path);
    return { time: trajectory.getTime().getTime(), forecastTime: wind.getTime().getTime(), position: trajectory.getCurrentPosition() };
  });
  expect(initialTrajectoryPosition.time).toBe(initialTrajectoryPosition.forecastTime);

  const lifecycle = await page.evaluate(async () => {
    const path = document.querySelector<HTMLScriptElement>('script[src*="/main.ts"]')!.src;
    const { map, wind } = await import(path);
    const forecast = wind.getWindState().forecast;
    const start = forecast.times[0];
    const layer = new wind.constructor({ time: new Date(start), provider: {
      getForecast: async () => forecast,
      loadField: async (request: { forecast: typeof forecast; time: number; extent: number[]; width: number; height: number }) => {
        await new Promise(resolve => setTimeout(resolve, request.time === start ? 60 : 5));
        const size = request.width * request.height;
        return { ...request, eastward: new Float32Array(size).fill(request.time === start ? 1 : 9), northward: new Float32Array(size), valid: new Uint8Array(size).fill(1) };
      },
    } });
    const originalCount = map.getLayers().getLength();
    await layer.attach(map);
    const slow = layer.setTime(new Date(start));
    const fast = layer.setTime(new Date(forecast.times[1]));
    await Promise.all([slow, fast]);
    const latest = layer.sample(-4, 48)?.eastward;
    const pending = layer.setTime(new Date(start));
    layer.detach();
    await pending;
    const detached = layer.getWindState().status;
    layer.dispose();
    return { latest, detached, originalCount, finalCount: map.getLayers().getLength() };
  });
  expect(lifecycle.latest).toBe(9);
  expect(lifecycle.detached).toBe('idle');
  expect(lifecycle.finalCount).toBe(lifecycle.originalCount);

  await page.locator('#time').fill('2026-11-07T02:00');
  await page.locator('#time').dispatchEvent('change');
  await expect(page.locator('#map-status')).toHaveAttribute('data-status', 'ready');
  const movedTrajectoryPosition = await page.evaluate(async () => {
    const path = document.querySelector<HTMLScriptElement>('script[src*="/main.ts"]')!.src;
    const { trajectory, wind } = await import(path);
    return { time: trajectory.getTime().getTime(), forecastTime: wind.getTime().getTime(), position: trajectory.getCurrentPosition() };
  });
  expect(movedTrajectoryPosition.time).toBe(movedTrajectoryPosition.forecastTime);
  expect(movedTrajectoryPosition.position).not.toEqual(initialTrajectoryPosition.position);
  const [startLongitude, startLatitude] = initialTrajectoryPosition.position;
  const [endLongitude, endLatitude] = movedTrajectoryPosition.position;
  const latitudeDelta = (endLatitude - startLatitude) * Math.PI / 180;
  const longitudeDelta = (endLongitude - startLongitude) * Math.PI / 180;
  const haversine = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(startLatitude * Math.PI / 180) * Math.cos(endLatitude * Math.PI / 180) * Math.sin(longitudeDelta / 2) ** 2;
  const travelledMeters = 6 / 1.9438444924406 * 1800;
  expect(2 * 6_371_008.8 * Math.asin(Math.sqrt(haversine))).toBeCloseTo(travelledMeters, -1);
  await expect(page.locator('#trajectory-speed')).not.toHaveText('--');
  await expect(page.locator('#trajectory-direction')).not.toHaveText('--');
  await page.getByRole('button', { name: 'Effacer la trajectoire' }).click();
  await expect(page.locator('#trajectory-speed')).toHaveText('--');
  await page.locator('#barbs').uncheck();
  await page.locator('#barbs').check();
  await page.getByRole('button', { name: 'Échéance suivante' }).click();
  await expect(page.locator('#time')).toHaveValue('2026-11-07T03:00');
  await expect(page.locator('#forecast-status')).toHaveText('Échéance native');
  await page.evaluate(async () => {
    const path = document.querySelector<HTMLScriptElement>('script[src*="/main.ts"]')!.src;
    const { map } = await import(path);
    map.getView().setCenter([20037508.342789244, 0]);
    map.getView().setRotation(Math.PI / 6);
  });
  await expect.poll(() => renderedPixels(page)).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('wind.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('official NOAA GRIB messages render in browser @live', async ({ page }, testInfo) => {
  test.skip(!process.env.WIND_LIVE, 'Run WIND_LIVE=1 to fetch official NOAA GRIB messages');
  await page.route('**/fonts.googleapis.com/**', route => route.abort());
  const errors: string[] = [];
  const statuses: number[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/\.pgrb2\.0p25\.f\d{3}$/.test(new URL(response.url()).pathname)) statuses.push(response.status());
  });
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#map-status')?.getAttribute('data-status') !== 'loading', { timeout: 30_000 });
  if (await page.locator('#map-status').getAttribute('data-status') !== 'ready') {
    throw new Error(await page.locator('#map-status').textContent() ?? 'NOAA GFS failed');
  }
  await expect.poll(() => renderedPixels(page), { timeout: 120_000 }).toBeGreaterThan(100);
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every(status => status === 206)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('wind-live.png'), fullPage: true });
  expect(errors).toEqual([]);
});