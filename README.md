# Weather Forecast Layer

Bibliothèque TypeScript pour afficher dans OpenLayers le vent à 10 mètres des prévisions NOAA GFS : texture jet géoréférencée, barbules et navigation temporelle interpolée.

La bibliothèque télécharge directement les messages GRIB2 nécessaires. Aucun outil d’ingestion, répertoire de données préparées, serveur météo ou compte externe n’est requis.

## Démarrage

Prérequis : Node 22 LTS >= 22.12, npm et une connexion Internet vers NOAA GFS.

```sh
nvm use
npm install
npm run dev
```

Ouvrir http://127.0.0.1:5173. La démo choisit automatiquement le dernier cycle GFS complet et demande les messages du vent de la zone affichée.

Le téléchargement se fait en HTTP Range : deux messages U/V par échéance, et uniquement les échéances natives nécessaires. GFS fournit des échéances horaires sur les 72 premières heures. La texture et les barbules utilisent le même champ interpolé.

## Utilisation

La bibliothèque publie un paquet ESM avec ses déclarations TypeScript. OpenLayers est une `peerDependency` et reste externe au bundle.

```ts
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import OSM from 'ol/source/OSM.js';
import 'ol/ol.css';
import { OfficialGribProvider, WindLayer } from 'weather-forecast-layer';

const map = new Map({
  target: 'map',
  view: new View({ center: [0, 0], zoom: 2 }),
  layers: [new TileLayer({ source: new OSM() })],
});

const wind = new WindLayer({
  provider: new OfficialGribProvider(),
  time: new Date(),
  texture: true,
  barbs: true,
  opacity: 0.65,
  maximumKnots: 60,
  barbSpacing: 60,
});

wind.subscribe(state => {
  if (state.status === 'error') console.error(state.error);
});

await wind.attach(map);
await wind.setTime(new Date('2026-11-07T12:30:00Z'));
const nativeTimes = wind.getAvailableTimes();
const reading = wind.sample(-4, 48);

wind.dispose();
```

La date doit appartenir au cycle GFS chargé. La date de l’exemple décrit l’API ; elle ne constitue pas une prévision permanente.

`attach(map)` ajoute le groupe si nécessaire et installe les écouteurs. `detach()` annule les requêtes. `dispose()` libère les sous-couches et le fournisseur. Le fournisseur confirme un seul cycle, sans mélanger des runs. `reloadForecast()` recherche un nouveau cycle.

## Architecture

```text
Index NOAA GFS .idx
    -> sélection stricte de UGRD/VGRD à 10 m
    -> HTTP Range des deux messages GRIB2
    -> décodeur GRIB2 TypeScript dans le thread principal
    -> grille commune U/V en m/s
    -> interpolation temporelle
    -> WindLayer (LayerGroup)
         -> ImageLayer / ImageCanvasSource : texture jet
         -> VectorLayer : barbules
```

- [src/core/types.ts](src/core/types.ts) définit le contrat du fournisseur et le champ du vent.
- [src/core/sampling.ts](src/core/sampling.ts) interpole les composantes et calcule vitesse/direction.
- [src/providers/OfficialGribProvider.ts](src/providers/OfficialGribProvider.ts) découvre les cycles NOAA et charge les champs à la demande.
- [src/providers/grib](src/providers/grib) valide les messages et décode le vent dans le thread principal.
- [src/layer/WindLayer.ts](src/layer/WindLayer.ts) assure le cycle de vie, les dates et le rendu OpenLayers.
- [src/render/wind.ts](src/render/wind.ts) définit la colormap et les symboles de barbules.
- [demo/main.ts](demo/main.ts) est l’application de démonstration.

`OfficialGribProvider` implémente `WindForecastProvider`. Les autres implémentations peuvent fournir leurs propres champs, mais cette version ne lit que NOAA GFS.

## Décodage GFS

Le fournisseur essaie les cycles de six heures récents, jusqu’à trouver un index publié pour l’échéance +72 h. Il épingle ensuite ce cycle. Les index NOAA identifient UGRD et VGRD à 10 m au-dessus du sol ; les niveaux de pression sont rejetés.

Chaque requête vérifie HTTP `206`, la taille attendue et les marqueurs GRIB. Le décodeur valide le centre NOAA, le run, l’échéance, le niveau, la projection régulière et le mode de balayage avant de décoder. Aucun GRIB global n’est téléchargé en entier.

Le parseur TypeScript couvre les messages GFS vérifiés : GRIB2 sur grille globale lat/lon 0,25°, vent 10 m et packing natif accepté par le décodeur. Un packing ou une grille inconnus produit une erreur explicite. L’API NOAA doit autoriser CORS et les requêtes Range ; cela a été vérifié sur les index et messages publics.

## Interpolation et unités

Entre échéances horaires du même cycle GFS, la bibliothèque interpole U et V en m/s selon les horodatages exacts. Elle recalcule ensuite vitesse, direction, couleur et barbules. Elle n’interpole pas les angles ou les couleurs, et n’extrapole pas hors de la plage.

Une échéance exacte ne charge qu’un champ ; un instant intermédiaire charge les deux champs voisins. Le cache des champs est borné. Les réponses périmées sont annulées ou ignorées. Les composantes restent invalides si une valeur manque à l’une des échéances.

L’interpolation vectorielle lisse l’affichage ; elle ne simule pas une nouvelle prévision. Deux vents opposés peuvent produire un calme intermédiaire.

Les composantes suivent la convention U positif vers l’est, V positif vers le nord. La texture utilise une échelle jet fixe de 0 à 60 nœuds, saturée aux bornes. Les barbules s’arrondissent aux 5 nœuds les plus proches ; fanions à 50 nœuds. Leur taille reste constante à l’écran.

## Rendu et limites

La texture transforme chaque pixel depuis la projection de la carte vers EPSG:4326 ; elle n’étire pas une image lat/lon sur Mercator. Les vues EPSG:3857 et EPSG:4326, les copies du monde et l’antiméridien sont pris en charge.

Le fournisseur rééchantillonne une grille globale 0,25° vers une grille d’affichage plafonnée à 1024 × 1024. La résolution du modèle limite les détails locaux. Mercator ne couvre pas les pôles ; les hautes latitudes nécessitent une vue EPSG:4326.

## Données et licence

Les prévisions GFS sont publiées par [NOAA](https://registry.opendata.aws/noaa-gfs-bdp-pds/) et réutilisables commercialement. L’interface d’attribution crédite NOAA et précise que la NOAA n’approuve pas la bibliothèque.

Les données sont gratuites. La bande passante du visiteur est utilisée directement auprès de NOAA. Les limites ou changements d’accès du fournisseur peuvent affecter l’application ; les messages GRIB sont récupérés à chaque besoin et conservés dans un cache mémoire borné, sans stockage permanent.

Les fonds OSM sont soumis à leur propre politique d’utilisation ; choisir un service de tuiles adapté au trafic de production.

## Vérification

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

`npm run test:grib` télécharge les deux champs GFS de l’échéance +3 h et vérifie leur décodage. Pour tester la démo contre le flux NOAA réel :

```sh
WIND_LIVE=1 npm run test:e2e
```

Les tests Chromium par défaut vérifient l’interpolation, le rendu, l’antiméridien, le cycle de vie, l’annulation et les contrôles desktop/mobile avec un décodeur simulé.

Hors de cette version : autres modèles, archives, ensembles, rafales, altitude différente, projections personnalisées et WebGL dédié. Safari/iOS et Firefox n’ont pas encore été certifiés.