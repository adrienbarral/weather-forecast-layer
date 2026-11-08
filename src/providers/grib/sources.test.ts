import { describe, expect, it } from 'vitest';
import { parseIndex, sourceUrl } from './sources';

const run = Date.UTC(2026, 10, 7);
describe('official GRIB indexes', () => {
  it('selects NOAA 10 m fields rather than pressure level', () => {
    const index = '1:0:d=2026110700:UGRD:10 mb:3 hour fcst:\n2:20:d=2026110700:UGRD:10 m above ground:3 hour fcst:\n3:40:d=2026110700:VGRD:10 m above ground:3 hour fcst:\n4:60:d=2026110700:TMP:2 m above ground:3 hour fcst:';
    expect(parseIndex(index, run, 3)).toEqual([{ start: 20, length: 20 }, { start: 40, length: 20 }]);
    expect(() => parseIndex(index, run, 6)).toThrow();
  });
  it('constructs the NOAA global GRIB2 URL', () => {
    expect(sourceUrl(run, 3)).toContain('gfs.20261107/00/atmos/gfs.t00z.pgrb2.0p25.f003');
  });
});