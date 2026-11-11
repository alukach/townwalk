# townwalk

Walk a cartoon version of a real town in the browser, streamed from open data on [source.coop](https://source.coop)
with HTTP range requests: only the tiles near the walker are fetched. Starting with Nelson, BC; any town by
`?lat=…&lon=…`.

**Play:** https://alukach.github.io/raea-townwalk/ · another town: `?lat=51.1784&lon=-115.5708` (Banff)

## Run locally

```sh
python3 -m http.server 8765   # then open http://localhost:8765/
node --test                   # geo math tests
```

No build step: `index.html` loads three.js, pmtiles, vector-tile and pbf from jsDelivr through an import map.
`?aerial=600` puts the camera 600 m up (debugging).

## Data (all range-read from source.coop, nothing pre-downloaded)

| Layer | Source | Tiles |
|---|---|---|
| Buildings (next: roads, water, land use) | Protomaps OSM basemap v4, `protomaps/openstreetmap/v4.pmtiles` | z15 MVT, ~16 KB, kept within 700 m |
| Elevation | NASADEM terrain-RGB, `smartmaps/gel/gel.pmtiles` | z12 WebP, ~80 KB, kept within 1.5 km |

Why not Overture GeoParquet: the `fused/overture` row groups span ~6° of longitude, so the smallest range read
for one town is megabytes. Overture can come back if a finer-partitioned copy shows up.

## Steps

Each step is a commit you can check out.

- [x] **0. Walker** (raea, desktop). Capsule, chase camera, WASD.
- [x] **1. Real buildings** (raea). Overture footprints, extruded, with collision.
- [x] **2. Browser + terrain + streaming.** three.js; buildings and elevation streamed by range request around the
  walker; buildings seated on the slope; walker follows the ground; camera pulls in past walls.
  ![](docs/step2-aerial.png) ![](docs/step2-hill.png)
- [ ] **3. Streets and water.** Road ribbons by kind, lake and river polygons, parks (all in the same z15 tiles).
- [ ] **4. Cartoon look.** Toon shading and outlines, roofs, trees, colour by building kind.
- [ ] **5. Any town.** Place search, re-origin when far from start, terrain seams, loading by view direction.
