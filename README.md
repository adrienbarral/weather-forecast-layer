# Weather Forecast Layer

TypeScript library for displaying NOAA GFS 10-metre wind forecasts in OpenLayers: a georeferenced jet-colour texture, wind barbs, and temporal interpolation.

The library downloads the required GRIB2 messages directly. No ingestion tool, preprocessed data directory, weather server, or external account is required.

## Getting Started

Requirements: Node 22 LTS >= 22.12, npm, and an Internet connection to NOAA GFS.

```sh
nvm use
npm install
npm run dev
```

Open http://127.0.0.1:5173. The demo automatically selects the latest complete GFS cycle and requests wind messages for the visible map area.

## GitHub Pages

The GitHub Actions workflow deploys the demo from `main` to https://adrienbarral.github.io/weather-forecast-layer/. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. Each push to `main` publishes a new demo; the workflow can also be started manually.

Downloads use HTTP Range requests: two U/V messages per forecast time, and only the native forecast times needed. GFS provides hourly steps for the first 72 hours. The texture and wind barbs use the same interpolated field.

## Usage

The library ships as an ESM package with TypeScript declarations. OpenLayers is a `peerDependency` and remains external to the bundle.

```ts
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import OSM from 'ol/source/OSM.js';
import 'ol/ol.css';
import { OfficialGribProvider, TrajectoryExtrapolationLayer, WindLayer } from 'weather-forecast-layer';

const map = new Map({
  target: 'map',
  view: new View({ center: [0, 0], zoom: 2 }),
  layers: [new TileLayer({ source: new OSM() })],
});

const wind = new WindLayer({
  provider: new OfficialGribProvider(),
  time: new Date(),
  texture: true,
  particles: true,
  barbs: true,
  opacity: 0.65,
  maximumKnots: 60,
  barbSpacing: 60,
});
const trajectory = new TrajectoryExtrapolationLayer({
  trajectory: [[-2, 46], [2, 44], [7, 43]],
  speed: 12,
  currentPosition: [-1.5, 45.5],
  time: wind.getTime(),
});

wind.subscribe(state => {
  if (state.status === 'error') console.error(state.error);
});

await wind.attach(map);
trajectory.attach(map);
await wind.setTime(new Date('2026-11-07T12:30:00Z'));
trajectory.setTime(wind.getTime());
const nativeTimes = wind.getAvailableTimes();
const reading = wind.sample(-4, 48);

wind.dispose();
trajectory.dispose();
```

The requested time must fall within the loaded GFS cycle. The date in the example illustrates the API; it is not a permanent forecast.

## Extrapolated Trajectory

`TrajectoryExtrapolationLayer` takes a polyline and a current position in WGS84 coordinates `[longitude, latitude]`. Speed is in metres per second. Segment lengths are geodesic; WGS84 coordinates are reprojected for display.

On creation, the layer anchors the position at the supplied time or the current time. `setCurrentPosition(position, time)` places the arrow exactly at the given position, even slightly off the trajectory, then anchors the moving object to the nearest point on the path. `setTime(time)` extrapolates the position from that anchor; time can move forward or backward, with motion clamped at either endpoint. `advanceTime(seconds)` shifts simulation time relative to its current value.

In the demo, the `WindLayer` callback passes every selected time to `TrajectoryExtrapolationLayer.setTime()`. Both layers therefore display the same instant.

`attach(map)` adds the group if needed and installs event listeners. `detach()` cancels requests. `dispose()` releases the sublayers and provider. The provider pins one forecast cycle and never mixes runs. `reloadForecast()` looks for a new cycle.

## Architecture

```text
NOAA GFS .idx index
  -> strict selection of UGRD/VGRD at 10 m
  -> HTTP Range requests for both GRIB2 messages
  -> TypeScript GRIB2 decoder on the main thread
  -> shared U/V grid in m/s
  -> temporal interpolation
    -> WindLayer (LayerGroup)
         -> ImageLayer / ImageCanvasSource : jet texture
         -> VectorLayer : wind barbs
```

- [src/core/types.ts](src/core/types.ts) defines the provider contract and wind field.
- [src/core/sampling.ts](src/core/sampling.ts) interpolates wind components and computes speed and direction.
- [src/providers/OfficialGribProvider.ts](src/providers/OfficialGribProvider.ts) discovers NOAA cycles and loads fields on demand.
- [src/providers/grib](src/providers/grib) validates GRIB messages and decodes wind on the main thread.
- [src/layer/WindLayer.ts](src/layer/WindLayer.ts) handles lifecycle, time, and OpenLayers rendering.
- [src/render/wind.ts](src/render/wind.ts) defines the colour map and wind-barb symbols.
- [demo/main.ts](demo/main.ts) is the demonstration application.

`OfficialGribProvider` implements `WindForecastProvider`. Other implementations can provide their own fields, but this version reads NOAA GFS only.

## GFS Decoding

The provider checks recent six-hour cycles until it finds an index published through forecast hour +72. It then pins that cycle. NOAA indexes identify UGRD and VGRD at 10 m above ground; pressure-level fields are rejected.

Each request validates the HTTP `206` status, expected response length, and GRIB markers. Before decoding, the parser validates the NOAA centre, run, forecast time, level, regular grid, and scanning mode. The full global GRIB file is never downloaded.

The TypeScript parser supports the verified GFS messages: GRIB2 on a global 0.25° latitude/longitude grid, 10 m wind, and packing supported by the decoder. Unknown packing or grids produce an explicit error. The NOAA API must allow CORS and Range requests; both were verified against its public indexes and messages.

## Interpolation and Units

Between hourly steps in the same GFS cycle, the library interpolates U and V in m/s using their exact timestamps. It then recomputes speed, direction, colour, and wind barbs. It does not interpolate angles or colours, and it does not extrapolate beyond the available time range.

An exact forecast time loads one field; an intermediate time loads its two neighbouring fields. The field cache is bounded. Stale responses are cancelled or ignored. A component remains invalid if its value is missing at either bounding time.

Vector interpolation smooths the display; it does not simulate a new forecast. Opposing winds can produce an intermediate calm.

Components use the convention U positive eastward and V positive northward. The texture uses a fixed jet scale from 0 to 60 knots, saturated at the limits. Wind barbs round to the nearest 5 knots, with flags at 50 knots. Their size remains constant on screen.

## Rendering and Limitations

The optional particle layer is enabled by default. Each particle leaves a fading trail capped at 25 CSS pixels and expires after four simulated seconds, regardless of distance travelled. Initial particle ages are staggered randomly by up to one second to avoid synchronized respawns. On expiry, a particle and its trail disappear and a new particle spawns at a random viewport position. The 4 px head is the trail endpoint, not a circle. Trail direction and relative speed follow the wind vector. Motion is visually time-scaled to remain visible across zoom levels; it is not a literal elapsed-time simulation. Toggle it with `wind.particlesLayer.setVisible(false)`.

Each texture pixel is transformed from the map projection to EPSG:4326; a latitude/longitude image is not simply stretched over Mercator. EPSG:3857 and EPSG:4326 views, world copies, and the antimeridian are supported.

The provider resamples the global 0.25° grid to a display grid capped at 1024 × 1024. Model resolution limits local detail. Mercator does not cover the poles; high latitudes require an EPSG:4326 view.

## Data and Licensing

GFS forecasts are published by [NOAA](https://registry.opendata.aws/noaa-gfs-bdp-pds/) and can be reused commercially. The attribution credits NOAA and states that NOAA does not endorse this library.

The data is free. Visitors' bandwidth is used to retrieve it directly from NOAA. Provider limits or access changes may affect the application; GRIB messages are fetched on demand and held in a bounded in-memory cache, with no persistent storage.

OSM basemaps are subject to their own usage policy; choose a tile service suited to production traffic.

## Verification

```sh
npm run typecheck
npm test
npm run test:grib
npm run build
npm run test:package
npm run build:demo
npx playwright install chromium
npm run test:e2e
```

`npm run test:grib` downloads both GFS wind fields at forecast hour +3 and verifies decoding. To test the demo against the live NOAA feed:

```sh
WIND_LIVE=1 npm run test:e2e
```

The default Chromium tests verify interpolation, rendering, the antimeridian, lifecycle, cancellation, and desktop/mobile controls with a simulated decoder.

Out of scope for this version: other models, archives, ensembles, gusts, other altitudes, custom projections, and dedicated WebGL rendering. Safari/iOS and Firefox have not been tested.