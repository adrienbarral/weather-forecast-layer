import { decodeFieldValues, parseFields, parseGrid, parseProduct, splitMessages } from '@azohra/meteo.grib';
import type { Forecast, WindField } from '../../core/types.js';

export interface GribComponent {
  width: number;
  height: number;
  extent: WindField['extent'];
  values: Float32Array;
  valid: Uint8Array;
}

export interface GribDecoder {
  decode(bytes: Uint8Array, forecast: Forecast, time: number, component: 'u' | 'v', signal: AbortSignal): Promise<GribComponent>;
  dispose(): void;
}

export function decodeGfsComponent(bytes: Uint8Array, forecast: Forecast, time: number, component: 'u' | 'v'): GribComponent {
  const messages = splitMessages(bytes);
  if (messages.length !== 1) throw new Error('Expected exactly one NOAA GRIB2 message');
  const fields = parseFields(messages[0]);
  if (fields.length !== 1) throw new Error('Expected exactly one wind field in the NOAA GRIB2 message');
  const field = fields[0];
  const grid = parseGrid(field.section3);
  const product = parseProduct(field.section4);
  const reference = field.identification;
  const runTime = Date.UTC(reference.year, reference.month - 1, reference.day, reference.hour, reference.minute, reference.second);
  if (forecast.model !== 'gfs' || field.discipline !== 0 || reference.centre !== 7 || reference.typeOfProcessedData !== 1 ||
    runTime !== forecast.runTime || product.parameterCategory !== 2 || product.parameterNumber !== (component === 'u' ? 2 : 3) ||
    product.indicatorOfUnitOfTimeRange !== 1 || product.forecastTime !== (time - runTime) / 3_600_000 ||
    product.typeOfFirstFixedSurface !== 103 || product.scaleFactorOfFirstFixedSurface !== 0 || product.scaledValueOfFirstFixedSurface !== 10 ||
    grid.kind !== 'latlon' || grid.gridDefinitionTemplateNumber !== 0 || grid.ni !== 1440 || grid.nj !== 721 ||
    grid.iDirectionIncrement !== 0.25 || grid.jDirectionIncrement !== 0.25 || grid.latitudeOfFirstGridPoint !== 90 ||
    grid.iScansNegatively || grid.jScansPositively || grid.jPointsAreConsecutive || grid.alternativeRowScanning || grid.uvRelativeToGrid) {
    throw new Error('NOAA GRIB component, model, date, level or grid is incompatible');
  }
  const decoded = decodeFieldValues(field);
  const values = Float32Array.from(decoded.values);
  const valid = Uint8Array.from(values, (_value, index) => !decoded.missingMask?.[index] && Number.isFinite(decoded.values[index]) ? 1 : 0);
  return {
    width: grid.ni,
    height: grid.nj,
    values,
    valid,
    extent: [grid.longitudeOfFirstGridPoint - grid.iDirectionIncrement / 2,
      grid.latitudeOfFirstGridPoint - (grid.nj - 0.5) * grid.jDirectionIncrement,
      grid.longitudeOfFirstGridPoint + (grid.ni - 0.5) * grid.iDirectionIncrement,
      grid.latitudeOfFirstGridPoint + grid.jDirectionIncrement / 2],
  };
}