import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { stats, dem, getVT } from "./data.js";
import { paintTile, tileMPerPx, STYLE } from "./paint.js";
import { setupMaps } from "./map.js";
import { bakeRoads, groundMaterial, roadStyleId, ROAD_STYLE } from "./roads.js";
import * as geo from "./geo.js";
import { setupLabels, POI_ICON } from "./labels.js";
import { setupSearch } from "./search.js";

// ---- where -----------------------------------------------------------------------------------------------------
const q = new URLSearchParams(location.search);
const START = [+(q.get("lon") ?? -117.2913), +(q.get("lat") ?? 49.4936)]; // default: Baker St, Nelson BC
let frame = geo.localFrame(...START); // re-made by reorigin() when you jump or walk far
let gen = 0; // bumped by reorigin(); loads that started under an older frame are thrown away
const BUILD_Z = 15, DEM_Z = 12; // z15 vector tiles (~0.8 km here), z12 elevation (~6 km, 512 px)
// Phones and tablets get a lighter profile: less GPU memory, fewer pixels, a smaller world around you.
const MOBILE = matchMedia("(pointer: coarse)").matches || q.has("mobile");
const PROFILE = MOBILE
  ? { dpr: 1.5, groundPx: 512, roadPx: 512, shadowPx: 1024, shadowR: 70, buildR: 450, treeMax: 3500 }
  : { dpr: 2, groundPx: 1024, roadPx: 1024, shadowPx: 2048, shadowR: 90, buildR: 700, treeMax: 9000 };
const BUILD_R = PROFILE.buildR, DEM_R = 1500; // metres of data kept loaded around the walker
const TERRAIN_DROP = 2; // far terrain sits this far under the painted ground, so the ground always wins
let base = null; // elevation at the start, so y stays near 0

// ---- scene -----------------------------------------------------------------------------------------------------
const SKY = 0xa8d8ff;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, PROFILE.dpr));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft edges; walls turned from the sun are unlit anyway (see bands)
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 400, 1400);
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 5000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8aa37a, 1.3));
// The sun casts shadows in a box that follows the walker (moved each frame, below).
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
const SUN_DIR = new THREE.Vector3(300, 600, 200).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(PROFILE.shadowPx, PROFILE.shadowPx);
Object.assign(sun.shadow.camera, { left: -PROFILE.shadowR, right: PROFILE.shadowR, top: PROFILE.shadowR, bottom: -PROFILE.shadowR, near: 10, far: 1500 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.9;
scene.add(sun, sun.target);
const resize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
addEventListener("resize", resize); resize();

// cartoon look: three flat light bands (toon shading) and dark ink lines on building edges
// toon reads the gradient at N·L*0.5+0.5: faces turned from the sun get no sun at all, so they match cast shadows
// exactly (no smeared band where the two meet); lit faces get two bands.
const bands = new THREE.DataTexture(new Uint8Array([0, 0, 170, 255]), 4, 1, THREE.RedFormat);
bands.minFilter = bands.magFilter = THREE.NearestFilter; bands.needsUpdate = true;
const toon = (o = {}) => new THREE.MeshToonMaterial({ gradientMap: bands, ...o });
const buildingMat = toon({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }); // faces back a hair so ink lines win
buildingMat.shadowSide = THREE.BackSide; // closed solids: back faces in the shadow map, so lit walls don't self-shadow (acne)
const inkMat = new THREE.LineBasicMaterial({ color: 0x2d2a32 });
const bridgeMat = toon({ vertexColors: true });
const terrainMat = toon({ vertexColors: true, side: THREE.DoubleSide }); // double: skirts face either way
const treeMat = toon({ vertexColors: true });
const playerGeo = new THREE.CapsuleGeometry(0.35, 1.1, 4, 12);
const player = new THREE.Mesh(playerGeo, toon({ color: 0xe4572e }));
player.castShadow = true;
const hull = new THREE.Mesh(playerGeo, new THREE.MeshBasicMaterial({ color: 0x2d2a32, side: THREE.BackSide })); // ink outline
hull.scale.setScalar(1.12);
player.add(hull);
scene.add(player);

// ---- terrain: z12 elevation tiles as height grids + meshes ------------------------------------------------------
const N = 257; // grid verts per side (every other pixel of a 512 px tile)
const demTiles = new Map(); // "x/y" -> Promise<{grid, mesh}|null>
const demReady = new Map(); // "x/y" -> grid, for synchronous height lookups

async function loadDem(x, y) {
  const myGen = gen;
  const t = await dem.getZxy(DEM_Z, x, y);
  if (!t) return null;
  const bmp = await createImageBitmap(new Blob([t.data]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const W = bmp.width, px = ctx.getImageData(0, 0, W, W).data;
  const h = (i, j) => { const k = (j * W + i) * 4; return geo.rgbToHeight(px[k], px[k + 1], px[k + 2]); };
  const grid = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) grid[j * N + i] = h(Math.round((i / (N - 1)) * (W - 1)), Math.round((j / (N - 1)) * (W - 1)));
  base ??= grid[(N >> 1) * N + (N >> 1)];

  const S = 4 * (N - 1); // skirt verts: one under each edge vertex
  const pos = new Float32Array((N * N + S) * 3), col = new Float32Array((N * N + S) * 3), c = new THREE.Color();
  for (let j = 0; j < N; j++) {
    const lat = geo.tileYToLat(y + j / (N - 1), DEM_Z);
    for (let i = 0; i < N; i++) {
      const k = j * N + i, e = grid[k];
      const [lx, lz] = frame.toLocal(geo.tileXToLon(x + i / (N - 1), DEM_Z), lat);
      pos.set([lx, e - base - TERRAIN_DROP, lz], k * 3);
      // far terrain only (near ground is painted from OSM): colour by elevation, flat SRTM water near the lowest values
      c.set(e < 531.5 ? STYLE.water : e < 900 ? 0x8cc56b : e < 1500 ? 0x5f9e4f : 0xb8b0a0);
      col.set([c.r, c.g, c.b], k * 3);
    }
  }
  const idx = [];
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i; idx.push(a, a + N, a + 1, a + 1, a + N, a + N + 1); }
  // skirts: a 40 m curtain down every edge, so seams between tiles (which sample different pixels) never show sky
  const ring = [];
  for (let i = 0; i < N - 1; i++) ring.push(i); // north edge, west to east
  for (let j = 0; j < N - 1; j++) ring.push(j * N + N - 1); // east, north to south
  for (let i = N - 1; i > 0; i--) ring.push((N - 1) * N + i); // south, east to west
  for (let j = N - 1; j > 0; j--) ring.push(j * N); // west, south to north
  ring.forEach((e, k) => {
    const s = N * N + k;
    pos.set([pos[e * 3], pos[e * 3 + 1] - 40, pos[e * 3 + 2]], s * 3);
    col.set([col[e * 3], col[e * 3 + 1], col[e * 3 + 2]], s * 3);
    const e2 = ring[(k + 1) % ring.length], s2 = N * N + ((k + 1) % ring.length);
    idx.push(e, s, e2, e2, s, s2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (myGen !== gen) { g.dispose(); return null; } // the world was re-centred meanwhile
  const mesh = new THREE.Mesh(g, terrainMat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return { grid, mesh };
}
const demTile = (x, y) => {
  const k = `${x}/${y}`;
  if (!demTiles.has(k)) demTiles.set(k, loadDem(x, y).then((d) => (d && demTiles.has(k) && demReady.set(k, d.grid), d)));
  return demTiles.get(k);
};

// Ground height (absolute metres) under a local point, bilinear on the elevation grid; NaN if not loaded.
function groundAt(x, z) {
  const [lon, lat] = frame.toLonLat(x, z);
  const fx = geo.lonToTileX(lon, DEM_Z), fy = geo.latToTileY(lat, DEM_Z);
  // a point on a tile's west/north edge is also its neighbour's east/south edge: try the neighbour too
  const ex = fx - Math.floor(fx) < 1e-6, ey = fy - Math.floor(fy) < 1e-6;
  const tries = [[0, 0], ex && [1, 0], ey && [0, 1], ex && ey && [1, 1]].filter(Boolean);
  let tx, ty, grid;
  for (const [ox, oy] of tries) {
    tx = Math.floor(fx) - ox; ty = Math.floor(fy) - oy; grid = demReady.get(`${tx}/${ty}`);
    if (grid) break;
  }
  if (!grid) return NaN;
  const u = Math.min(N - 1, (fx - tx) * (N - 1)), v = Math.min(N - 1, (fy - ty) * (N - 1)), i = Math.min(Math.floor(u), N - 2), j = Math.min(Math.floor(v), N - 2);
  const a = u - i, b = v - j, G = (ii, jj) => grid[jj * N + ii];
  return (G(i, j) * (1 - a) + G(i + 1, j) * a) * (1 - b) + (G(i, j + 1) * (1 - a) + G(i + 1, j + 1) * a) * b;
}

// ---- z15 tiles: painted ground, buildings, bridges, water --------------------------------------------------------
// Buildings as MapLibre's fill-extrusion does them: from min_height to height, coloured by height
// (lightgray 0 m -> royalblue 200 m -> lightblue 400 m).
const RAMP = [[0, new THREE.Color("lightgray")], [200, new THREE.Color("royalblue")], [400, new THREE.Color("lightblue")]];
function rampColor(h, out) {
  const i = RAMP.findIndex(([s]) => h < s);
  if (i === -1) return out.copy(RAMP.at(-1)[1]);
  if (i === 0) return out.copy(RAMP[0][1]);
  const [s0, c0] = RAMP[i - 1], [s1, c1] = RAMP[i];
  return out.copy(c0).lerp(c1, (h - s0) / (s1 - s0));
}
// Cartoon buildings, styled by what OSM says is in or under them (POIs inside the footprint, land use beneath):
// houses in pastels with pitched roofs; shops with an awning band on the ground floor; churches white with a steeple;
// schools/hospitals brick; civic buildings stone; industry metal. Taller buildings get window bands and drift into
// MapLibre's height ramp. Colour is per triangle (the extrusion is non-indexed), so bands have hard edges.
const C = (h) => new THREE.Color(h);
const WALLS = ["#f6e7c8", "#f3d6c1", "#e9eef2", "#f7f1e3", "#e8dcc8", "#dfe8d8"].map(C);
const ROOFS = ["#c8553d", "#b5483a", "#6c757d", "#4a6fa5", "#7a9e7e", "#8d5a3b"].map(C);
const AWNINGS = ["#e4572e", "#2e86ab", "#3bb273", "#f2a541", "#8e5ea2", "#d64161"].map(C);
const STYLES = {
  house: { walls: WALLS, roof: null },
  shop: { walls: ["#fff3d6", "#fde2e4", "#e2f0cb", "#dbe7f4"].map(C), roof: C("#b8b2a7"), awning: true },
  church: { walls: [C("#f4efe6")], roof: C("#4a4e69"), steeple: true },
  brick: { walls: ["#c8674a", "#b85c42"].map(C), roof: C("#7d6e63") },
  civic: { walls: [C("#e6dcc4")], roof: C("#6b7a8f") },
  industrial: { walls: ["#9fb0bf", "#aab3a8"].map(C), roof: C("#7f8c96") },
};
const GLASS = C("#9fc3d9"), FLAT_ROOF = C("#b8b2a7");
const SHOP_POI = new Set(["restaurant", "cafe", "fast_food", "bar", "pub", "bakery", "ice_cream", "supermarket", "convenience", "clothes", "books", "hardware", "bicycle", "florist", "bank", "pharmacy", "hotel", "motel", "hostel", "post_office", "cinema", "theatre", "marketplace"]);
const CIVIC_POI = new Set(["townhall", "courthouse", "library", "museum", "arts_centre", "community_centre"]);
const BRICK_POI = new Set(["school", "college", "university", "hospital", "kindergarten", "clinic", "fire_station", "police"]);
function buildingStyle(kinds, landuse) {
  const has = (set) => kinds.some((k) => set.has(k));
  if (kinds.includes("place_of_worship")) return "church";
  if (has(CIVIC_POI)) return "civic";
  if (has(BRICK_POI) || ["school", "college", "university", "hospital"].includes(landuse)) return "brick";
  if (has(SHOP_POI) || landuse === "commercial" || landuse === "retail") return "shop";
  if (landuse === "industrial" || landuse === "railway") return "industrial";
  return "house";
}
// o: {height, pitched, hash, style, y0 (geometry y of the base), row (metres per extrusion step, ~1.6 = half a storey)}
function paintBuilding(g, o) {
  const st = STYLES[o.style], wall = st.walls[o.hash % st.walls.length].clone();
  wall.lerp(rampColor(o.height, new THREE.Color()), Math.min(1, Math.max(0, (o.height - 10) / 60)));
  const roof = o.pitched ? st.roof ?? ROOFS[(o.hash >>> 8) % ROOFS.length] : st.roof ?? FLAT_ROOF;
  const awning = AWNINGS[(o.hash >>> 4) % AWNINGS.length], windows = o.height >= 10 && o.style !== "church";
  const P = g.attributes.position, n = g.attributes.normal, a = new Float32Array(P.count * 3);
  for (let t = 0; t < P.count; t += 3) {
    const ny = (n.getY(t) + n.getY(t + 1) + n.getY(t + 2)) / 3, cy = (P.getY(t) + P.getY(t + 1) + P.getY(t + 2)) / 3 - o.y0;
    const r = Math.floor(cy / o.row); // half-storey row: even = wall, odd = window height
    const col = ny > 0.25 ? roof
      : st.awning && r === 0 ? GLASS // shop window
      : st.awning && r === 1 ? awning // awning over it
      : windows && r >= 1 && r % 2 === 1 ? GLASS : wall;
    for (let k = 0; k < 3; k++) a.set([col.r, col.g, col.b], (t + k) * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

const tint = (g, color) => {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([color.r, color.g, color.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
};

const { inPolygon } = geo;
const bounds = (rings) => {
  const xs = rings.flat().map((p) => p[0]), zs = rings.flat().map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
};

// A cartoon pine: trunk and two cones, coloured per vertex, drawn instanced per tile.
const TREE = (() => {
  const part = (g, hex, dy) => tint(g.translate(0, dy, 0), new THREE.Color(hex));
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.22, 0.3, 2, 6), "#7a5232", 1),
    part(new THREE.ConeGeometry(2.1, 4, 7), "#3f8f4a", 3.6),
    part(new THREE.ConeGeometry(1.5, 3.2, 7), "#4fa457", 5.8),
  ]);
})();
// Street furniture from OSM POI points: one small coloured model per kind, drawn instanced per tile.
const PROP = (() => {
  const part = (g, hex, x = 0, y = 0, z = 0) => tint(g.translate(x, y, z), new THREE.Color(hex));
  const Box = (w, h, d) => new THREE.BoxGeometry(w, h, d), Cyl = (r1, r2, h, s = 8) => new THREE.CylinderGeometry(r1, r2, h, s);
  const Ball = (r) => new THREE.SphereGeometry(r, 8, 6);
  const merge = (...parts) => mergeGeometries(parts);
  return {
    street_lamp: merge(part(Cyl(0.07, 0.1, 4.2, 6), "#3d4a3d", 0, 2.1), part(Ball(0.28), "#ffe08a", 0, 4.3)),
    bench: merge(part(Box(1.6, 0.08, 0.45), "#a0673a", 0, 0.45), part(Box(1.6, 0.4, 0.06), "#a0673a", 0, 0.75, -0.2),
      part(Box(0.08, 0.45, 0.4), "#3d3d3d", -0.7, 0.22), part(Box(0.08, 0.45, 0.4), "#3d3d3d", 0.7, 0.22)),
    picnic_table: merge(part(Box(1.8, 0.06, 0.8), "#b07a45", 0, 0.75), part(Box(1.8, 0.05, 0.3), "#b07a45", 0, 0.45, 0.6),
      part(Box(1.8, 0.05, 0.3), "#b07a45", 0, 0.45, -0.6), part(Box(0.08, 0.75, 1.5), "#8a5a32", 0, 0.37)),
    traffic_signals: merge(part(Cyl(0.08, 0.08, 3.2, 6), "#3d3d3d", 0, 1.6), part(Box(0.35, 0.95, 0.3), "#2b2b2b", 0, 3.3),
      part(Ball(0.1), "#e63946", 0, 3.62, 0.16), part(Ball(0.1), "#f4a261", 0, 3.3, 0.16), part(Ball(0.1), "#2a9d8f", 0, 2.98, 0.16)),
    stop: merge(part(Cyl(0.04, 0.04, 2.2, 6), "#8a8a8a", 0, 1.1), part(Cyl(0.38, 0.38, 0.04, 8).rotateX(Math.PI / 2), "#d62828", 0, 2.3, 0.03)),
    waste_basket: part(Cyl(0.25, 0.22, 0.8, 8), "#3a6b4a", 0, 0.4),
    bicycle_parking: merge(part(Box(1.6, 0.06, 0.06), "#8a8a8a", 0, 0.8), part(Box(0.06, 0.8, 0.06), "#8a8a8a", -0.75, 0.4), part(Box(0.06, 0.8, 0.06), "#8a8a8a", 0.75, 0.4)),
    post_box: merge(part(Box(0.5, 1.1, 0.45), "#c1121f", 0, 0.55), part(Box(0.52, 0.08, 0.47), "#780000", 0, 1.1)),
    drinking_water: merge(part(Cyl(0.15, 0.2, 0.9, 8), "#6c757d", 0, 0.45), part(Ball(0.12), "#4fb3e8", 0, 0.95)),
  };
})();
const PROP_RADIUS = { street_lamp: 0.25, bench: 0.6, picnic_table: 1, traffic_signals: 0.25, stop: 0.2, waste_basket: 0.3, post_box: 0.35, drinking_water: 0.25 };

const MASK_PX = 512; // ~1.6 m per pixel
const TREE_SPACING = 7.3, TREE_MAX = PROFILE.treeMax; // metres between grid cells (woods 1.5x the old 9 m grid); cap per tile
const hexKey = (h) => parseInt(h.slice(1), 16);
const LANDUSE_BY_COLOUR = new Map(Object.entries(STYLE.landuse).map(([k, h]) => [hexKey(h), k])); // first kind per colour
const TREE_DENSITY = { // painted ground colour -> chance of a tree per grid cell
  [hexKey(STYLE.landuse.wood)]: 0.9, [hexKey(STYLE.landuse.nature_reserve)]: 0.7, // denser grid -> 1.5x trees
  [hexKey(STYLE.landuse.park)]: 0.12, [hexKey(STYLE.landuse.scrub)]: 0.1, [hexKey(STYLE.landuse.cemetery)]: 0.067, // unchanged per m²
};

const G = 65; // ground patch verts per side (~12 m apart)
const GROUND_PX = PROFILE.groundPx; // land use + water only (roads are a baked field, below): ~0.8 m per pixel
const tiles = new Map(); // "x/y" -> Promise<tile|null>
const ready = new Map(); // "x/y" -> {foots, water, bridges}, for synchronous collision

async function loadTile(x, y) {
  const myGen = gen;
  const d = await demTile(x >> 3, y >> 3); // the z12 tile this z15 tile sits in
  const vt = await getVT(BUILD_Z, x, y);
  if (!vt || !d) return null;
  const E = 4096, objects = [];
  const fromTile = (px, py) => frame.toLocal(geo.tileXToLon(x + px / E, BUILD_Z), geo.tileYToLat(y + py / E, BUILD_Z));
  const layerFeatures = (name) => { const l = vt.layers[name]; return l ? Array.from({ length: l.length }, (_, i) => l.feature(i)) : []; };

  // water polygons, in tile units (for flattening the ground) and local metres (for collision)
  const waterTile = layerFeatures("water").filter((f) => f.type === 3).map((f) => f.loadGeometry().map((r) => r.map((p) => [p.x * (E / f.extent), p.y * (E / f.extent)])));
  const water = waterTile.map((rings) => { const r = rings.map((ring) => ring.map(([px, py]) => fromTile(px, py))); return { rings: r, ...bounds(r) }; });

  // ground: a patch of the terrain, lakes flattened to their lowest point, painted with roads, water and land use
  const pos = new Float32Array(G * G * 3), uv = new Float32Array(G * G * 2), wet = [];
  let level = Infinity;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const k = j * G + i, u = i / (G - 1), v = j / (G - 1), [lx, lz] = fromTile(u * E, v * E), h = groundAt(lx, lz);
    pos.set([lx, h, lz], k * 3); uv.set([u, 1 - v], k * 2);
    if (waterTile.some((rings) => inPolygon(u * E, v * E, rings))) { wet.push(k); level = Math.min(level, h); }
  }
  for (const k of wet) pos[k * 3 + 1] = level; // ponytail: one level per tile; rivers that drop across a tile get a step
  for (let k = 0; k < G * G; k++) pos[k * 3 + 1] += 0.05 - base;
  const idx = [];
  for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) { const a = j * G + i; idx.push(a, a + G, a + 1, a + 1, a + G, a + G + 1); }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  gg.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  gg.setIndex(idx); gg.computeVertexNormals();
  const cv = document.createElement("canvas"); cv.width = cv.height = GROUND_PX;
  paintTile(cv.getContext("2d"), vt, GROUND_PX, tileMPerPx(BUILD_Z, geo.tileYToLat(y + 0.5, BUILD_Z), GROUND_PX), { roads: false });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // roads: a baked distance field the ground paints from (roads.js), so they drape exactly
  const [x0m, z0m] = fromTile(0, 0), [x1m, z1m] = fromTile(E, E), Wm = x1m - x0m, Hm = z1m - z0m; // tile size, metres
  const segs = [], streets = [];
  for (const f of layerFeatures("roads")) {
    if (f.type !== 2) continue;
    const id = roadStyleId(f.properties);
    for (const line of f.loadGeometry()) {
      const pts = line.map((p) => fromTile(p.x * (E / f.extent), p.y * (E / f.extent)));
      let along = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        if (id) segs.push({ ax: ax - x0m, ay: z1m - az, bx: bx - x0m, by: z1m - bz, hw: ROAD_STYLE[id].width / 2, id, along });
        if (f.properties.name && f.properties.kind !== "path" && f.properties.kind !== "rail")
          streets.push({ ax, az, bx, bz, name: f.properties.name, ref: f.properties.ref });
        along += Math.hypot(bx - ax, bz - az);
      }
    }
  }
  const roadTex = bakeRoads(renderer, segs, Wm, Hm, PROFILE.roadPx);
  objects.push(Object.assign(new THREE.Mesh(gg, groundMaterial(bands, tex, roadTex)), { receiveShadow: true }));
  // where trees may grow: a small paint of the same tile *with* roads, so trees keep off roads and paths
  const mask = new OffscreenCanvas(MASK_PX, MASK_PX).getContext("2d", { willReadFrequently: true });
  paintTile(mask, vt, MASK_PX, tileMPerPx(BUILD_Z, geo.tileYToLat(y + 0.5, BUILD_Z), MASK_PX));
  const groundPx = mask.getImageData(0, 0, MASK_PX, MASK_PX).data;

  // POIs: named ones become labels (and style the building they're in); street furniture becomes props
  const named = [], props = {}, places = [];
  for (const f of layerFeatures("pois")) {
    if (f.type !== 1) continue;
    const p = f.loadGeometry()[0][0], [lx, lz] = fromTile(p.x * (E / f.extent), p.y * (E / f.extent)), k = f.properties.kind;
    if (PROP[k]) (props[k] ??= []).push([lx, lz]);
    else if (f.properties.name) named.push({ x: lx, z: lz, kind: k, name: f.properties.name, icon: POI_ICON[k] ?? "📍", key: `${x}/${y}/${f.id ?? named.length}` });
  }
  for (const f of layerFeatures("places")) {
    if (f.type !== 1 || !f.properties.name) continue;
    const p = f.loadGeometry()[0][0], [lx, lz] = fromTile(p.x * (E / f.extent), p.y * (E / f.extent));
    places.push({ x: lx, z: lz, name: f.properties.name, kind: f.properties.kind });
  }
  const landuseAt = (lx, lz) => { // land use under a local point, read back from the tree mask's colours
    const [lon, lat] = frame.toLonLat(lx, lz);
    const px = Math.min(MASK_PX - 1, Math.max(0, ((geo.lonToTileX(lon, BUILD_Z) - x) * MASK_PX) | 0)), py = Math.min(MASK_PX - 1, Math.max(0, ((geo.latToTileY(lat, BUILD_Z) - y) * MASK_PX) | 0));
    const o = (py * MASK_PX + px) * 4;
    return LANDUSE_BY_COLOUR.get((groundPx[o] << 16) | (groundPx[o + 1] << 8) | groundPx[o + 2]);
  };

  // buildings
  const geoms = [], foots = [], c = new THREE.Color();
  layerFeatures("buildings").forEach((f, i) => {
    if (f.type !== 3) return;
    const height = +f.properties.height || 5 + (i % 4) * 1.5; // ponytail: OSM rarely has height; vary 5-9.5 m so it reads
    const minH = +f.properties.min_height || 0;
    if (height <= minH) return;
    const polys = [];
    for (const ring of f.loadGeometry()) {
      const pts = ring.slice(0, -1).map((p) => fromTile(p.x * (E / f.extent), p.y * (E / f.extent)));
      if (pts.length < 3) continue;
      if (geo.ringArea(ring.map((p) => [p.x, p.y])) > 0) polys.push([pts]); // outer ring (MVT: positive, y down)
      else polys.at(-1)?.push(pts); // hole of the last outer
    }
    for (const [outer, ...holes] of polys) {
      const gs = outer.map(([px, pz]) => groundAt(px, pz)).filter(Number.isFinite);
      if (!gs.length) continue;
      const lo = Math.min(...gs), hi = Math.max(...gs);
      // on a slope: walls reach down to the lowest corner; top and raised bases measure from the highest
      const bottom = minH > 0 ? hi + minH : lo, top = hi + height;
      const shape = new THREE.Shape(outer.map(([px, pz]) => new THREE.Vector2(px, -pz)));
      shape.holes = holes.map((h) => new THREE.Path(h.map(([px, pz]) => new THREE.Vector2(px, -pz))));
      // small, low, simple buildings get a pitched roof: a bevel that insets the top cap, which works for any footprint
      const area = Math.abs(geo.ringArea(outer)), perim = outer.reduce((s, p, k) => s + Math.hypot(p[0] - outer[(k + 1) % outer.length][0], p[1] - outer[(k + 1) % outer.length][1]), 0);
      const pitched = !minH && !holes.length && area < 450 && height < 16;
      const roofH = Math.min(3.5, Math.max(1.2, Math.sqrt(area) * 0.18)), inset = Math.min(roofH, ((2 * area) / perim) * 0.85);
      const b = bounds([outer]), inside = named.filter((p) => within(p.x, p.z, b) && geo.pointInRing(p.x, p.z, outer));
      const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length, cz = outer.reduce((s, p) => s + p[1], 0) / outer.length;
      const style = buildingStyle(inside.map((p) => p.kind), landuseAt(cx, cz));
      const depth = top - bottom, steps = Math.max(1, Math.round(depth / 1.6)); // ~1.6 m bands: awnings, windows
      const g = new THREE.ExtrudeGeometry(shape, pitched
        ? { depth, steps, bevelEnabled: true, bevelThickness: roofH, bevelSize: inset, bevelOffset: -inset, bevelSegments: 1 }
        : { depth, steps, bevelEnabled: false });
      // extrude along +z, stand up: (sx, sy, d) -> (sx, d, -sy) = (x, up, z)
      g.rotateX(-Math.PI / 2).translate(0, bottom - base, 0);
      const hash = (i * 2654435761 + x * 31 + y * 17) >>> 0;
      geoms.push(paintBuilding(g, { height, pitched, hash, style, y0: bottom - base, row: depth / steps }));
      if (STYLES[style].steeple) { // a spire on the roof
        const spire = new THREE.ConeGeometry(Math.min(2.2, Math.sqrt(area) * 0.12), Math.max(7, height * 0.9), 6).toNonIndexed();
        spire.translate(cx, top - base + (pitched ? roofH : 0) + Math.max(7, height * 0.9) / 2 - 0.3, cz);
        geoms.push(tint(spire, STYLES.church.roof));
      }
      const roofTop = top + (pitched ? roofH : 0);
      for (const p of inside) p.y = roofTop - base + 2.5; // labels float over the roof
      if (minH < 2) foots.push({ ring: outer, ...b }); // raised parts don't block the street
    }
  });
  if (geoms.length) {
    const merged = mergeGeometries(geoms);
    geoms.forEach((g) => g.dispose());
    objects.push(Object.assign(new THREE.Mesh(merged, buildingMat), { castShadow: true, receiveShadow: true }), new THREE.LineSegments(new THREE.EdgesGeometry(merged, 25), inkMat));
  }

  // bridges: decks between their ends' ground, never below ground + 0.6 m
  const decks = [], bridges = [];
  for (const f of layerFeatures("roads")) {
    if (f.type !== 2 || !f.properties.is_bridge) continue;
    const st = STYLE.road(f.properties), w = st?.[0] ?? 5;
    c.set(st?.[1] ?? "#dddddd");
    for (const line of f.loadGeometry()) {
      const pts = line.map((p) => fromTile(p.x * (E / f.extent), p.y * (E / f.extent)));
      const len = [0];
      for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const ha = groundAt(...pts[0]), hb = groundAt(...pts.at(-1)), L = len.at(-1) || 1;
      if (!Number.isFinite(ha) || !Number.isFinite(hb)) continue;
      // ponytail: a bridge cut by a tile edge gets its height from the cut end; decks can step at tile seams
      const hs = pts.map((p, i) => Math.max(ha + ((hb - ha) * len[i]) / L, groundAt(...p) + 0.6));
      for (let i = 1; i < pts.length; i++) {
        const a = new THREE.Vector3(pts[i - 1][0], hs[i - 1] - base, pts[i - 1][1]), b = new THREE.Vector3(pts[i][0], hs[i] - base, pts[i][1]);
        const g = new THREE.BoxGeometry(w, 0.8, a.distanceTo(b) + w * 0.5); // overlap a little so bends close
        g.translate(0, -0.4, 0);
        g.applyMatrix4(new THREE.Matrix4().lookAt(b, a, new THREE.Vector3(0, 1, 0)).setPosition(a.clone().lerp(b, 0.5)));
        decks.push(tint(g, c));
        bridges.push({ ax: a.x, az: a.z, ah: hs[i - 1], bx: b.x, bz: b.z, bh: hs[i], w });
      }
    }
  }
  if (decks.length) { objects.push(Object.assign(new THREE.Mesh(mergeGeometries(decks), bridgeMat), { castShadow: true, receiveShadow: true })); decks.forEach((g) => g.dispose()); }

  // labels outside buildings float a little over the ground; props stand on it (and block like trees do)
  for (const p of named) p.y ??= groundAt(p.x, p.z) - base + 3;
  const propCells = new Map();
  for (const [kind, spots] of Object.entries(props)) {
    const inst = new THREE.InstancedMesh(PROP[kind], treeMat, spots.length), mm = new THREE.Matrix4();
    spots.forEach(([px, pz], k) => {
      const gy = groundAt(px, pz), yaw = ((((px * 73856093) ^ (pz * 19349663)) >>> 0) % 628) / 100;
      inst.setMatrixAt(k, mm.makeRotationY(yaw).setPosition(px, (Number.isFinite(gy) ? gy : base) - base, pz));
      const r = PROP_RADIUS[kind];
      if (r) { const cell = `${Math.floor(px / 8)},${Math.floor(pz / 8)}`; (propCells.get(cell) ?? propCells.set(cell, []).get(cell)).push([px, pz, r]); }
    });
    inst.castShadow = inst.receiveShadow = true;
    objects.push(inst);
  }

  // trees: a jittered grid, kept only where the painted ground is wood or park (so never on roads or water)
  const mpp = tileMPerPx(BUILD_Z, geo.tileYToLat(y + 0.5, BUILD_Z), MASK_PX), stepPx = TREE_SPACING / mpp, m = new THREE.Matrix4();
  const spots = [], treeCells = new Map(); // "cx,cz" (8 m cells) -> [[x, z, trunk radius]]
  for (let j = 0; j * stepPx < MASK_PX && spots.length < TREE_MAX; j++) for (let i = 0; i * stepPx < MASK_PX; i++) {
    const h = ((i * 73856093) ^ (j * 19349663) ^ (x * 83492791) ^ y) >>> 0, r = (s) => ((h >>> s) & 255) / 255;
    const px = Math.min(MASK_PX - 1, (i + r(0)) * stepPx) | 0, py = Math.min(MASK_PX - 1, (j + r(8)) * stepPx) | 0, o = (py * MASK_PX + px) * 4;
    const density = TREE_DENSITY[(groundPx[o] << 16) | (groundPx[o + 1] << 8) | groundPx[o + 2]];
    if (!density || r(16) > density) continue;
    const [lx, lz] = fromTile((px / MASK_PX) * E, (py / MASK_PX) * E), gy = groundAt(lx, lz);
    if (!Number.isFinite(gy) || foots.some((f) => within(lx, lz, f, 2) && geo.pointInRing(lx, lz, f.ring))) continue;
    const s = 0.75 + r(24) * 0.9;
    spots.push([lx, gy - base, lz, s, r(4) * 6.28, r(12)]);
    const cell = `${Math.floor(lx / 8)},${Math.floor(lz / 8)}`;
    if (!treeCells.has(cell)) treeCells.set(cell, []);
    treeCells.get(cell).push([lx, lz, 0.45 * s]); // ponytail: trunk + a little; the boughs stay walk-through
  }
  if (spots.length) {
    const trees = new THREE.InstancedMesh(TREE, treeMat, spots.length), tc = new THREE.Color();
    spots.forEach(([tx, ty, tz, s, rot, shade], k) => {
      trees.setMatrixAt(k, m.makeRotationY(rot).scale(new THREE.Vector3(s, s, s)).setPosition(tx, ty, tz));
      trees.setColorAt(k, tc.setHSL(0, 0, 0.8 + shade * 0.35)); // multiplies the vertex colours: lighter/darker pines
    });
    trees.castShadow = trees.receiveShadow = true;
    objects.push(trees);
  }

  for (const [cell, list] of propCells) (treeCells.get(cell) ?? treeCells.set(cell, []).get(cell)).push(...list); // props collide like trunks
  if (myGen !== gen) { disposeObjects(objects); return null; } // the world was re-centred meanwhile
  objects.forEach((o) => scene.add(o));
  return { objects, foots, water, bridges, treeCells, streets, named, places };
}

// ---- collision ---------------------------------------------------------------------------------------------------
const within = (x, z, b, pad = 0) => x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad;
function inBuilding(x, z) {
  for (const t of ready.values()) for (const f of t.foots) if (within(x, z, f) && geo.pointInRing(x, z, f.ring)) return true;
  return false;
}
function inWater(x, z) {
  for (const t of ready.values()) for (const w of t.water) if (within(x, z, w) && inPolygon(x, z, w.rings)) return true;
  return false;
}
function inTree(x, z) {
  const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
  for (const t of ready.values())
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const [tx, tz, r] of t.treeCells.get(`${cx + i},${cz + j}`) ?? []) if (Math.hypot(x - tx, z - tz) < r + RADIUS) return true;
  return false;
}
// deck height under a point, if one is within 1.5 m of height y (so you can walk under a bridge too)
function deckAt(x, z, y) {
  for (const t of ready.values())
    for (const s of t.bridges) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
      const k = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      if (Math.hypot(x - s.ax - k * dx, z - s.az - k * dz) > s.w / 2) continue;
      const h = s.ah + (s.bh - s.ah) * k;
      if (Math.abs(h - y) < 1.5) return h;
    }
  return NaN;
}

// ---- streaming: load what's near, drop what's far ---------------------------------------------------------------
const near = (z, r) => new Set(geo.tilesAround(...frame.toLonLat(walker.x, walker.z), z, r, frame).map(([, x, y]) => `${x}/${y}`));
function stream() {
  for (const k of near(BUILD_Z, BUILD_R)) if (!tiles.has(k)) {
    const [x, y] = k.split("/").map(Number);
    tiles.set(k, loadTile(x, y).then((t) => { if (t && tiles.has(k)) ready.set(k, t); return t; }));
  }
  const keep = near(BUILD_Z, BUILD_R * 1.5);
  for (const k of tiles.keys()) if (!keep.has(k)) dropTile(k);
  const keepDem = near(DEM_Z, DEM_R);
  for (const k of keepDem) if (!demTiles.has(k)) demTile(...k.split("/").map(Number));
  for (const k of demTiles.keys()) if (!keepDem.has(k)) dropDem(k);
}
function disposeObjects(objects) {
  for (const o of objects) {
    scene.remove(o);
    if (o.isInstancedMesh) o.dispose(); else o.geometry.dispose(); // trees and props share their geometry
    if (o.material.map) { o.material.map.dispose(); o.material.dispose(); }
    if (o.material.userData.roadTex) o.material.userData.roadTex.userData.rt.dispose();
  }
}
function dropTile(k) { const p = tiles.get(k); tiles.delete(k); ready.delete(k); p.then((t) => t && disposeObjects(t.objects)); }
function dropDem(k) { const p = demTiles.get(k); demTiles.delete(k); demReady.delete(k); p.then((d) => { if (d) { scene.remove(d.mesh); d.mesh.geometry.dispose(); } }); }

// Re-centre the world on lon/lat: a new local frame, everything rebuilt around it (decoded tiles stay cached, so
// this is quick). Used for far jumps, and when walking far enough that the flat-earth frame would start to drift.
function reorigin(lon, lat) {
  gen++;
  [...tiles.keys()].forEach(dropTile);
  [...demTiles.keys()].forEach(dropDem);
  frame = geo.localFrame(lon, lat); base = null;
  Object.assign(walker, { x: 0, z: 0, y: NaN }); placed = false; camPos.set(0, 0, 0);
  const p = new URLSearchParams(location.search);
  p.set("lat", lat.toFixed(5)); p.set("lon", lon.toFixed(5));
  history.replaceState(null, "", `?${p}`); // the URL is always a link back to here
}

// ---- walking -----------------------------------------------------------------------------------------------------
const walker = { x: 0, z: 0, y: NaN, yaw: 0 };
const keys = new Set();
addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());
const held = (...k) => k.some((x) => keys.has(x));
// touch: a virtual stick (x turns, y walks; pushed to the rim runs)
const stick = { x: 0, y: 0 };
const stickEl = document.getElementById("stick"), knob = stickEl.firstElementChild;
const moveStick = (e) => {
  const r = stickEl.getBoundingClientRect(), R = r.width / 2;
  let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
  const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
  Object.assign(stick, { x: dx, y: dy });
  knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
};
let stickId = null; // the finger on the stick; others (e.g. tapping M) are ignored
stickEl.addEventListener("pointerdown", (e) => {
  stickId = e.pointerId; moveStick(e);
  try { stickEl.setPointerCapture(e.pointerId); } catch {} // keeps the stick when the finger slides off it
});
stickEl.addEventListener("pointermove", (e) => { if (e.pointerId === stickId) moveStick(e); });
const releaseStick = (e) => { if (e.pointerId !== stickId) return; stickId = null; Object.assign(stick, { x: 0, y: 0 }); knob.style.transform = ""; };
stickEl.addEventListener("pointerup", releaseStick);
stickEl.addEventListener("pointercancel", releaseStick);
const RADIUS = 0.4;

// The start (or a jump) is often inside a building or in a lake: once its tile is in, spiral out to free ground.
let placed = false;
function place() {
  const [lon, lat] = frame.toLonLat(walker.x, walker.z);
  if (!ready.has(`${Math.floor(geo.lonToTileX(lon, BUILD_Z))}/${Math.floor(geo.latToTileY(lat, BUILD_Z))}`)) return;
  placed = true;
  const solid = (x, z) => inBuilding(x, z) || inWater(x, z) || inTree(x, z);
  for (let r = 0; r < 300; r += 1.5)
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) {
      const x = walker.x + r * Math.cos(a), z = walker.z + r * Math.sin(a);
      if (!solid(x, z) && !solid(x + RADIUS, z) && !solid(x - RADIUS, z) && !solid(x, z + RADIUS) && !solid(x, z - RADIUS)) {
        Object.assign(walker, { x, z, y: groundAt(x, z) }); return;
      }
    }
}

// where the walker would stand at (x, z), or NaN if it can't go there
function standAt(x, z) {
  const g = groundAt(x, z);
  if (!Number.isFinite(g)) return NaN;
  const deck = deckAt(x, z, walker.y);
  if (Number.isFinite(deck)) return deck;
  const px = x + Math.sign(x - walker.x) * RADIUS, pz = z + Math.sign(z - walker.z) * RADIUS;
  if (inBuilding(px, pz) || inWater(px, pz) || inTree(x, z)) return NaN;
  return g;
}

function step(dt) {
  if (!placed) return place();
  const turn = (held("a", "arrowleft") ? 1 : 0) - (held("d", "arrowright") ? 1 : 0) - stick.x;
  const fwd = (held("w", "arrowup") ? 1 : 0) - (held("s", "arrowdown") ? 1 : 0) - stick.y;
  const run = held("shift") || Math.hypot(stick.x, stick.y) > 0.92;
  walker.yaw += Math.max(-1, Math.min(1, turn)) * 2.2 * dt;
  const v = Math.max(-1, Math.min(1, fwd)) * (run ? 15 : 4.5) * dt;
  const dx = -Math.sin(walker.yaw) * v, dz = -Math.cos(walker.yaw) * v;
  let y = standAt(walker.x + dx, walker.z); // per axis, so walls slide
  if (Number.isFinite(y)) { walker.x += dx; walker.y = y; }
  y = standAt(walker.x, walker.z + dz);
  if (Number.isFinite(y)) { walker.z += dz; walker.y = y; }
  if (!v) walker.y = standAt(walker.x, walker.z) || walker.y;
}

const FAR = 4000; // metres from the frame's origin before we re-centre (flat-earth error stays well under 1 m)
function teleport(lon, lat) {
  const [x, z] = frame.toLocal(lon, lat);
  if (Math.hypot(x, z) > FAR) return reorigin(lon, lat);
  Object.assign(walker, { x, z, y: NaN }); placed = false; camPos.set(0, 0, 0);
}

// Where am I: the nearest named street (within 25 m) from loaded tiles, and the area from the z12 tiles' places
// (a neighbourhood within ~1.5 km, else the nearest town within ~10 km).
function streetAt(x, z) {
  let best = null, bd = 25;
  for (const t of ready.values())
    for (const s of t.streets) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
      const k = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2)), d = Math.hypot(x - s.ax - k * dx, z - s.az - k * dz);
      if (d < bd) { bd = d; best = s; }
    }
  return best;
}
let area = null;
async function findArea() {
  const [lon, lat] = frame.toLonLat(walker.x, walker.z), tx = Math.floor(geo.lonToTileX(lon, 12)), ty = Math.floor(geo.latToTileY(lat, 12));
  let hood = null, town = null;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const vt = await getVT(12, tx + dx, ty + dy), L = vt?.layers.places;
    for (let i = 0; i < (L?.length ?? 0); i++) {
      const f = L.feature(i), p = f.loadGeometry()[0][0], name = f.properties.name, kind = f.properties.kind;
      if (!name) continue;
      const [x, z] = frame.toLocal(geo.tileXToLon(tx + dx + p.x / L.extent, 12), geo.tileYToLat(ty + dy + p.y / L.extent, 12));
      const d = Math.hypot(x - walker.x, z - walker.z);
      if (kind === "neighbourhood" && d < 1500 && (!hood || d < hood.d)) hood = { name, d };
      if (kind === "locality" && d < 10000 && (!town || d < town.d)) town = { name, d };
    }
  }
  area = hood && town ? { name: `${hood.name}, ${town.name}` } : hood ?? town;
}

// ---- loop --------------------------------------------------------------------------------------------------------
const hud = document.getElementById("hud");
const ray = new THREE.Raycaster();
const camPos = new THREE.Vector3(), camGoal = new THREE.Vector3(), look = new THREE.Vector3();
const maps = setupMaps({ player: () => { const [lon, lat] = frame.toLonLat(walker.x, walker.z); return { lon, lat, yaw: walker.yaw }; }, teleport });
const labels = setupLabels(camera);
setupSearch(teleport);
let last = performance.now(), lastStream = 0, lastWhere = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (now - lastStream > 500) { stream(); lastStream = now; }
  if (Math.hypot(walker.x, walker.z) > FAR) reorigin(...frame.toLonLat(walker.x, walker.z)); // keep yaw, rebuild around
  if (!maps.open) step(dt);
  if (!Number.isFinite(walker.y)) walker.y = groundAt(walker.x, walker.z);
  const py = Number.isFinite(walker.y) ? walker.y - base : 0;
  player.position.set(walker.x, py + 0.9, walker.z);
  player.rotation.y = walker.yaw;
  const cx = walker.x + Math.sin(walker.yaw) * 9, cz = walker.z + Math.cos(walker.yaw) * 9, cg = groundAt(cx, cz);
  camGoal.set(cx, Math.max(py + 4, Number.isFinite(cg) ? cg - base + 1.5 : py + 4), cz);
  // keep a wall or a tree from coming between camera and walker: pull the camera in to the first hit
  look.set(walker.x, py + 1.4, walker.z);
  ray.set(look, camGoal.clone().sub(look).normalize());
  ray.far = camGoal.distanceTo(look);
  const hit = ray.intersectObjects(scene.children.filter((m) => m.material === buildingMat || m.material === treeMat), false)[0]; // walls and trees
  if (hit) camGoal.copy(look).addScaledVector(ray.ray.direction, Math.max(0.5, hit.distance - 0.4));
  camPos.lerp(camGoal, camPos.lengthSq() && !hit ? 1 - Math.exp(-6 * dt) : 1);
  camera.position.copy(camPos);
  camera.lookAt(look);
  if (q.has("aerial")) { camera.position.set(walker.x, py + +q.get("aerial"), walker.z + +q.get("aerial") * 0.6); camera.lookAt(look); } // debug
  // shadow box follows the walker, snapped to whole metres so shadow edges don't crawl
  sun.target.position.set(Math.round(walker.x), Math.round(py), Math.round(walker.z));
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 700);
  renderer.render(scene, camera);
  maps.draw();
  labels.update([...ready.values()].flatMap((t) => t.named), walker);
  if (now - lastWhere > 400) { lastWhere = now; labels.where(streetAt(walker.x, walker.z), area); findArea(); }
  const [lon, lat] = frame.toLonLat(walker.x, walker.z);
  hud.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${Number.isFinite(walker.y) ? Math.round(walker.y) + " m" : "loading…"}
${ready.size} tiles, ${demReady.size} terrain · ${stats.requests} range requests, ${(stats.bytes / 1024).toFixed(0)} KB`;
});
window.townwalk = { walker, stats, keys, teleport }; // for poking from devtools
