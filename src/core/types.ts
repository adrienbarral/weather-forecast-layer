export type Extent = [number, number, number, number];

export interface Forecast {
  id: string;
  model: string;
  runTime: number;
  times: number[];
  attribution: string;
  height: number;
}

export interface FieldRequest {
  forecast: Forecast;
  time: number;
  extent: Extent;
  width: number;
  height: number;
  signal: AbortSignal;
}

export interface WindField {
  forecast: Forecast;
  time: number;
  extent: Extent;
  width: number;
  height: number;
  eastward: Float32Array;
  northward: Float32Array;
  valid: Uint8Array;
}

export interface WindForecastProvider {
  getForecast(signal: AbortSignal): Promise<Forecast>;
  loadField(request: FieldRequest): Promise<WindField>;
}

export interface WindSample {
  speed: number;
  direction: number | null;
  eastward: number;
  northward: number;
}

export interface TimeBracket { before: number; after: number; alpha: number }