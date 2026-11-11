import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { stats, dem, getVT } from "./data.js";
import { paintTile, tileMPerPx, STYLE } from "./paint.js";
import { setupMaps } from "./map.js";
import * as geo from "./geo.js";

// ---- where -----------------------------------------------------------------------------------------------------
const q = new URLSearchParams(location.search);
const START = [+(q.get("lon") ?? -117.2913), +(q.get("lat") ?? 49.4936)]; // default: Baker St, Nelson BC
const frame = geo.localFrame(...START);
const BUILD_Z = 15, DEM_Z = 12; // z15 vector tiles (~0.8 km here), z12 elevation (~6 km, 512 px)
const BUILD_R = 700, DEM_R = 1500; // metres of data kept loaded around the walker
const TERRAIN_DROP = 2; // far terrain sits this far under the painted ground, so the ground always wins
let base = null; // elevation at the start, so y stays near 0

// ---- scene -----------------------------------------------------------------------------------------------------
const SKY = 0xa8d8ff;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 400, 1400);
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 5000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b8f5a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(300, 600, 200);
scene.add(sun);
const resize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
addEventListener("resize", resize); resize();

const buildingMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const bridgeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const player = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.1, 4, 12), new THREE.MeshLambertMaterial({ color: 0xe4572e }));
scene.add(player);

// ---- terrain: z12 elevation tiles as height grids + meshes ------------------------------------------------------
const N = 257; // grid verts per side (every other pixel of a 512 px tile)
const demTiles = new Map(); // "x/y" -> Promise<{grid, mesh}|null>
const demReady = new Map(); // "x/y" -> grid, for synchronous height lookups

async function loadDem(x, y) {
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

  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), c = new THREE.Color();
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
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, terrainMat);
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

const G = 65; // ground patch verts per side (~12 m apart)
const GROUND_PX = 2048; // ~0.4 m per pixel. ponytail: ~22 MB of GPU per tile; paint far tiles smaller if memory bites
const tiles = new Map(); // "x/y" -> Promise<tile|null>
const ready = new Map(); // "x/y" -> {foots, water, bridges}, for synchronous collision

async function loadTile(x, y) {
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
  paintTile(cv.getContext("2d"), vt, GROUND_PX, tileMPerPx(BUILD_Z, geo.tileYToLat(y + 0.5, BUILD_Z), GROUND_PX));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  objects.push(new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ map: tex })));

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
      // extrude along +z, stand up: (sx, sy, d) -> (sx, d, -sy) = (x, up, z)
      const g = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false });
      g.rotateX(-Math.PI / 2).translate(0, bottom - base, 0);
      geoms.push(tint(g, rampColor(height, c)));
      if (minH < 2) foots.push({ ring: outer, ...bounds([outer]) }); // raised parts don't block the street
    }
  });
  if (geoms.length) { objects.push(new THREE.Mesh(mergeGeometries(geoms), buildingMat)); geoms.forEach((g) => g.dispose()); }

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
  if (decks.length) { objects.push(new THREE.Mesh(mergeGeometries(decks), bridgeMat)); decks.forEach((g) => g.dispose()); }

  objects.forEach((o) => scene.add(o));
  return { objects, foots, water, bridges };
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
  for (const [k, p] of tiles) if (!keep.has(k)) {
    tiles.delete(k); ready.delete(k);
    p.then((t) => t?.objects.forEach((o) => {
      scene.remove(o); o.geometry.dispose();
      if (o.material.map) { o.material.map.dispose(); o.material.dispose(); }
    }));
  }
  const keepDem = near(DEM_Z, DEM_R);
  for (const k of keepDem) if (!demTiles.has(k)) demTile(...k.split("/").map(Number));
  for (const [k, p] of demTiles) if (!keepDem.has(k)) {
    demTiles.delete(k); demReady.delete(k);
    p.then((d) => { if (d) { scene.remove(d.mesh); d.mesh.geometry.dispose(); } });
  }
}

// ---- walking -----------------------------------------------------------------------------------------------------
const walker = { x: 0, z: 0, y: NaN, yaw: 0 };
const keys = new Set();
addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());
const held = (...k) => k.some((x) => keys.has(x));
const RADIUS = 0.4;

// The start (or a jump) is often inside a building or in a lake: once its tile is in, spiral out to free ground.
let placed = false;
function place() {
  const [lon, lat] = frame.toLonLat(walker.x, walker.z);
  if (!ready.has(`${Math.floor(geo.lonToTileX(lon, BUILD_Z))}/${Math.floor(geo.latToTileY(lat, BUILD_Z))}`)) return;
  placed = true;
  const solid = (x, z) => inBuilding(x, z) || inWater(x, z);
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
  if (inBuilding(px, pz) || inWater(px, pz)) return NaN;
  return g;
}

function step(dt) {
  if (!placed) return place();
  walker.yaw += ((held("a", "arrowleft") ? 1 : 0) - (held("d", "arrowright") ? 1 : 0)) * 2.2 * dt;
  const v = ((held("w", "arrowup") ? 1 : 0) - (held("s", "arrowdown") ? 1 : 0)) * (held("shift") ? 15 : 4.5) * dt;
  const dx = -Math.sin(walker.yaw) * v, dz = -Math.cos(walker.yaw) * v;
  let y = standAt(walker.x + dx, walker.z); // per axis, so walls slide
  if (Number.isFinite(y)) { walker.x += dx; walker.y = y; }
  y = standAt(walker.x, walker.z + dz);
  if (Number.isFinite(y)) { walker.z += dz; walker.y = y; }
  if (!v) walker.y = standAt(walker.x, walker.z) || walker.y;
}

function teleport(lon, lat) {
  const [x, z] = frame.toLocal(lon, lat);
  // ponytail: far jumps reload around the new spot (the local frame is flat-earth, good to ~10 km)
  if (Math.hypot(x, z) > 8000) { location.search = `?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`; return; }
  Object.assign(walker, { x, z, y: NaN }); placed = false; camPos.set(0, 0, 0);
}

// ---- loop --------------------------------------------------------------------------------------------------------
const hud = document.getElementById("hud");
const ray = new THREE.Raycaster();
const camPos = new THREE.Vector3(), camGoal = new THREE.Vector3(), look = new THREE.Vector3();
const maps = setupMaps({ player: () => { const [lon, lat] = frame.toLonLat(walker.x, walker.z); return { lon, lat, yaw: walker.yaw }; }, teleport });
let last = performance.now(), lastStream = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (now - lastStream > 500) { stream(); lastStream = now; }
  if (!maps.open) step(dt);
  if (!Number.isFinite(walker.y)) walker.y = groundAt(walker.x, walker.z);
  const py = Number.isFinite(walker.y) ? walker.y - base : 0;
  player.position.set(walker.x, py + 0.9, walker.z);
  player.rotation.y = walker.yaw;
  const cx = walker.x + Math.sin(walker.yaw) * 9, cz = walker.z + Math.cos(walker.yaw) * 9, cg = groundAt(cx, cz);
  camGoal.set(cx, Math.max(py + 4, Number.isFinite(cg) ? cg - base + 1.5 : py + 4), cz);
  // keep a wall from coming between camera and walker: pull the camera in to the first building hit
  look.set(walker.x, py + 1.4, walker.z);
  ray.set(look, camGoal.clone().sub(look).normalize());
  ray.far = camGoal.distanceTo(look);
  const hit = ray.intersectObjects(scene.children.filter((m) => m.material === buildingMat), false)[0];
  if (hit) camGoal.copy(look).addScaledVector(ray.ray.direction, Math.max(0.5, hit.distance - 0.4));
  camPos.lerp(camGoal, camPos.lengthSq() && !hit ? 1 - Math.exp(-6 * dt) : 1);
  camera.position.copy(camPos);
  camera.lookAt(look);
  if (q.has("aerial")) { camera.position.set(walker.x, py + +q.get("aerial"), walker.z + +q.get("aerial") * 0.6); camera.lookAt(look); } // debug
  renderer.render(scene, camera);
  maps.draw();
  const [lon, lat] = frame.toLonLat(walker.x, walker.z);
  hud.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${Number.isFinite(walker.y) ? Math.round(walker.y) + " m" : "loading…"}
${ready.size} tiles, ${demReady.size} terrain · ${stats.requests} range requests, ${(stats.bytes / 1024).toFixed(0)} KB`;
});
window.townwalk = { walker, stats, keys, teleport }; // for poking from devtools
