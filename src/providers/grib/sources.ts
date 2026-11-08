export interface MessageRange { start: number; length: number }

export function sourceUrl(run: number, step: number): string {
  const date = new Date(run).toISOString().slice(0, 10).replaceAll('-', '');
  const hour = new Date(run).toISOString().slice(11, 13);
  return `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.${date}/${hour}/atmos/gfs.t${hour}z.pgrb2.0p25.f${String(step).padStart(3, '0')}`;
}

export function parseIndex(text: string, run: number, step: number): [MessageRange, MessageRange] {
  if (text.length > 2_000_000) throw new Error('Oversized forecast index');
  const date = new Date(run).toISOString().slice(0, 10).replaceAll('-', '');
  const hour = new Date(run).toISOString().slice(11, 13);
  const records = text.trim().split(/\r?\n/).filter(Boolean);
  const matches: MessageRange[][] = [[], []];
  const parsed = records.map(line => line.split(':'));
  for (let index = 0; index < parsed.length; index++) {
    const record = parsed[index];
    const component = record[3] === 'UGRD' ? 0 : record[3] === 'VGRD' ? 1 : -1;
    if (component < 0 || record[2] !== `d=${date}${hour}` || record[4] !== '10 m above ground' ||
      record[5] !== (step === 0 ? 'anl' : `${step} hour fcst`)) continue;
    const start = Number(record[1]);
    matches[component].push({ start, length: Number(parsed[index + 1]?.[1]) - start });
  }
  if (matches.some(component => component.length !== 1)) throw new Error('Index must contain exactly one U/V pair at 10 m for this run and step');
  const ranges = matches.map(component => component[0]) as [MessageRange, MessageRange];
  if (ranges.some(range => !Number.isSafeInteger(range.start) || range.start < 0 ||
    !Number.isSafeInteger(range.length) || range.length <= 0 || range.length > 10_000_000)) throw new Error('Invalid or oversized GRIB message range');
  return ranges;
}

export async function fetchIndex(run: number, step: number, signal: AbortSignal, request: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<[MessageRange, MessageRange]> {
  const indexUrl = `${sourceUrl(run, step)}.idx`;
  let response = await request(indexUrl, { signal, cache: 'no-cache' });
  if (!response.ok && response.status >= 500) response = await request(indexUrl, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`NOAA GFS index HTTP ${response.status}: ${indexUrl}`);
  return parseIndex(await response.text(), run, step);
}

export async function fetchMessage(run: number, step: number, range: MessageRange, signal: AbortSignal, request: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<Uint8Array> {
  const url = sourceUrl(run, step);
  const response = await request(url, { signal, headers: { Range: `bytes=${range.start}-${range.start + range.length - 1}` } });
  if (response.status !== 206) throw new Error(`NOAA GFS server ignored GRIB byte range (${response.status})`);
  const contentRange = response.headers.get('content-range');
  if (contentRange && !contentRange.startsWith(`bytes ${range.start}-${range.start + range.length - 1}/`)) throw new Error('GRIB Content-Range does not match the index');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== range.length) throw new Error('GRIB response length does not match its index');
  return bytes;
}