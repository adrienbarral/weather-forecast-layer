import { decodeGfsComponent } from '../src/providers/grib/decode.js';
import { OfficialGribProvider } from '../src/providers/OfficialGribProvider.js';

const provider = new OfficialGribProvider({ decoder: {
  async decode(bytes, forecast, time, component) {
    return decodeGfsComponent(bytes, forecast, time, component);
  },
  dispose() {},
} });
try {
  const signal = new AbortController().signal;
  const forecast = await provider.getForecast(signal);
  const field = await provider.loadField({ forecast, time: forecast.times[3], extent: [-6, 45, -2, 50], width: 16, height: 16, signal });
  const valid = field.valid.reduce((sum, value) => sum + value, 0);
  if (!valid || !field.eastward.every(Number.isFinite) || !field.northward.every(Number.isFinite)) throw new Error('NOAA GFS wind field is empty or invalid');
  console.log(`NOAA GFS ${new Date(forecast.runTime).toISOString()} +3h: decoded ${valid}/256 valid wind samples`);
} finally { provider.dispose(); }