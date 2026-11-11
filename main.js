import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import * as geo from "./geo.js";

// ---- where -----------------------------------------------------------------------------------------------------
const q = new URLSearchParams(location.search);
const START = [+(q.get("lon") ?? -117.2913), +(q.get("lat") ?? 49.4936)]; // default: Baker St, Nelson BC
const frame = geo.localFrame(...START);
const BUILD_Z = 15, DEM_Z = 12; // z15 vector tiles (~0.8 km here), z12 elevation (~6 km, 512 px)
const BUILD_R = 700, DEM_R = 1500; // metres of data kept loaded around the walker
let base = null; // elevation at the start, so y stays near 0

// ---- range-request sources (counts every byte fetched) ---------------------------------------------------------
const stats = { requests: 0, bytes: 0 };
class RangeSource {
  constructor(url) { this.url = url; }
  getKey() { return this.url; }
  async getBytes(offset, length, signal) {
    const r = await fetch(this.url, { signal, headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!r.ok) throw new Error(`${r.status} ${this.url}`);
    const data = await r.arrayBuffer();
    stats.requests++; stats.bytes += data.byteLength;
    return { data, etag: r.headers.get("ETag") ?? undefined };
  }
}
const osm = new PMTiles(new RangeSource("https://data.source.coop/protomaps/openstreetmap/v4.pmtiles"));
const dem = new PMTiles(new RangeSource("https://data.source.coop/smartmaps/gel/gel.pmtiles"));

// ---- scene -----------------------------------------------------------------------------------------------------
const SKY = 0xa8d8ff;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);
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

const buildingMat = new THREE.MeshLambertMaterial({ color: 0xf2b880 });
const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const player = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.1, 4, 12), new THREE.MeshLambertMaterial({ color: 0xe4572e }));
scene.add(player);

// ---- terrain: z12 elevation tiles as height grids + meshes ------------------------------------------------------
const N = 257; // grid verts per side (every other pixel of a 512 px tile)
const demTiles = new Map(); // "x/y" -> Promise<{grid, mesh}|null>

async function loadDem(x, y) {
  const t = await dem.getZxy(DEM_Z, x, y);
  if (!t) return null;
  const bmp = await createImageBitmap(new Blob([t.data]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const W = bmp.width, px = ctx.getImageData(0, 0, W, W).data;
  const h = (i, j) => { const k = (Math.min(j, W - 1) * W + Math.min(i, W - 1)) * 4; return geo.rgbToHeight(px[k], px[k + 1], px[k + 2]); };
  const grid = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) grid[j * N + i] = h(Math.round((i / (N - 1)) * (W - 1)), Math.round((j / (N - 1)) * (W - 1)));
  base ??= grid[(N >> 1) * N + (N >> 1)];

  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), c = new THREE.Color();
  for (let j = 0; j < N; j++) {
    const lat = geo.tileYToLat(y + j / (N - 1), DEM_Z);
    for (let i = 0; i < N; i++) {
      const k = j * N + i, e = grid[k];
      const [lx, lz] = frame.toLocal(geo.tileXToLon(x + i / (N - 1), DEM_Z), lat);
      pos.set([lx, e - base, lz], k * 3);
      // ponytail: colour by elevation; lake = flat SRTM water near 530 m. Real water polygons come in step 3.
      c.set(e < 531.5 ? 0x4aa3df : e < 900 ? 0x8cc56b : e < 1500 ? 0x5f9e4f : 0xb8b0a0);
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
  const mesh = new THREE.Mesh(g, terrainMat); // ponytail: tiny seams between tiles; add skirts if they show
  scene.add(mesh);
  return { grid, mesh };
}
const demTile = (x, y) => { const k = `${x}/${y}`; if (!demTiles.has(k)) demTiles.set(k, loadDem(x, y)); return demTiles.get(k); };
const demReady = new Map(); // "x/y" -> grid, for synchronous height lookups

// Ground height (absolute metres) under a local point, bilinear on the same grid the mesh draws; NaN if not loaded.
function groundAt(x, z) {
  const [lon, lat] = frame.toLonLat(x, z);
  const fx = geo.lonToTileX(lon, DEM_Z), fy = geo.latToTileY(lat, DEM_Z);
  const tx = Math.floor(fx), ty = Math.floor(fy), grid = demReady.get(`${tx}/${ty}`);
  if (!grid) return NaN;
  const u = (fx - tx) * (N - 1), v = (fy - ty) * (N - 1), i = Math.min(Math.floor(u), N - 2), j = Math.min(Math.floor(v), N - 2);
  const a = u - i, b = v - j, G = (ii, jj) => grid[jj * N + ii];
  return (G(i, j) * (1 - a) + G(i + 1, j) * a) * (1 - b) + (G(i, j + 1) * (1 - a) + G(i + 1, j + 1) * a) * b;
}

// ---- buildings: z15 vector tiles -> one merged mesh per tile + footprints for collision --------------------------
const buildTiles = new Map(); // "x/y" -> Promise<{mesh, foots}|null>

async function loadBuildings(x, y) {
  const d = await demTile(x >> 3, y >> 3); // the z12 tile this z15 tile sits in
  if (d) demReady.set(`${x >> 3}/${y >> 3}`, d.grid);
  const t = await osm.getZxy(BUILD_Z, x, y);
  const layer = t && new VectorTile(new Pbf(new Uint8Array(t.data))).layers.buildings;
  if (!layer || !d) return null;
  const E = layer.extent, geoms = [], foots = [];
  const toLocal = (p) => frame.toLocal(geo.tileXToLon(x + p.x / E, BUILD_Z), geo.tileYToLat(y + p.y / E, BUILD_Z));
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const height = +f.properties.height || 5 + (i % 4) * 1.5; // ponytail: OSM rarely has height; vary 5-9.5 m so it reads
    const polys = [];
    for (const ring of f.loadGeometry()) {
      const pts = ring.slice(0, -1).map(toLocal);
      if (pts.length < 3) continue;
      if (geo.ringArea(ring.map((p) => [p.x, p.y])) > 0) polys.push([pts]); // outer ring (MVT: positive, y down)
      else polys.at(-1)?.push(pts); // hole of the last outer
    }
    for (const [outer, ...holes] of polys) {
      const gs = outer.map(([px, pz]) => groundAt(px, pz)).filter(Number.isFinite);
      if (!gs.length) continue;
      const lo = Math.min(...gs), hi = Math.max(...gs);
      const shape = new THREE.Shape(outer.map(([px, pz]) => new THREE.Vector2(px, -pz)));
      shape.holes = holes.map((h) => new THREE.Path(h.map(([px, pz]) => new THREE.Vector2(px, -pz))));
      // extrude along +z, stand up: (sx, sy, d) -> (sx, d, -sy) = (x, up, z); sunk to the lowest corner on slopes
      const g = new THREE.ExtrudeGeometry(shape, { depth: hi - lo + height, bevelEnabled: false });
      g.rotateX(-Math.PI / 2).translate(0, lo - base, 0);
      geoms.push(g);
      const xs = outer.map((p) => p[0]), zs = outer.map((p) => p[1]);
      foots.push({ ring: outer, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) });
    }
  }
  if (!geoms.length) return { mesh: null, foots };
  const mesh = new THREE.Mesh(mergeGeometries(geoms), buildingMat);
  geoms.forEach((g) => g.dispose());
  scene.add(mesh);
  return { mesh, foots };
}

const loadedFoots = new Map(); // "x/y" -> foots, for synchronous collision
function blocked(x, z) {
  for (const foots of loadedFoots.values())
    for (const f of foots) if (x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1 && geo.pointInRing(x, z, f.ring)) return true;
  return false;
}

// ---- streaming: load what's near, drop what's far ---------------------------------------------------------------
function stream() {
  const [lon, lat] = frame.toLonLat(walker.x, walker.z);
  const want = new Set(geo.tilesAround(lon, lat, BUILD_Z, BUILD_R, frame).map(([, x, y]) => `${x}/${y}`));
  for (const k of want) if (!buildTiles.has(k)) {
    const [x, y] = k.split("/").map(Number);
    buildTiles.set(k, loadBuildings(x, y).then((r) => { if (r && buildTiles.has(k)) loadedFoots.set(k, r.foots); return r; }));
  }
  const keep = new Set(geo.tilesAround(lon, lat, BUILD_Z, BUILD_R * 1.5, frame).map(([, x, y]) => `${x}/${y}`));
  for (const [k, p] of buildTiles) if (!keep.has(k)) {
    buildTiles.delete(k); loadedFoots.delete(k);
    p.then((r) => { if (r?.mesh) { scene.remove(r.mesh); r.mesh.geometry.dispose(); } });
  }
  const keepDem = new Set(geo.tilesAround(lon, lat, DEM_Z, DEM_R, frame).map(([, x, y]) => `${x}/${y}`));
  for (const k of keepDem) if (!demTiles.has(k)) { const [x, y] = k.split("/").map(Number); demTile(x, y).then((d) => d && demReady.set(k, d.grid)); }
  for (const [k, p] of demTiles) if (!keepDem.has(k)) {
    demTiles.delete(k); demReady.delete(k);
    p.then((d) => { if (d) { scene.remove(d.mesh); d.mesh.geometry.dispose(); } });
  }
}

// ---- walking -----------------------------------------------------------------------------------------------------
const walker = { x: 0, z: 0, yaw: 0 };
const keys = new Set();
addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
const held = (...k) => k.some((x) => keys.has(x));
const RADIUS = 0.4;

// The start point is often inside a building: once its tile is in, spiral out to the nearest free ground.
let placed = false;
function place() {
  const [lon, lat] = frame.toLonLat(walker.x, walker.z);
  const k = `${Math.floor(geo.lonToTileX(lon, BUILD_Z))}/${Math.floor(geo.latToTileY(lat, BUILD_Z))}`;
  if (!loadedFoots.has(k)) return;
  placed = true;
  for (let r = 0; r < 100; r += 1.5)
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) {
      const x = walker.x + r * Math.cos(a), z = walker.z + r * Math.sin(a);
      if (!blocked(x, z) && !blocked(x + RADIUS, z) && !blocked(x - RADIUS, z) && !blocked(x, z + RADIUS) && !blocked(x, z - RADIUS)) {
        walker.x = x; walker.z = z; return;
      }
    }
}

function step(dt) {
  if (!placed) return place();
  walker.yaw += ((held("a", "arrowleft") ? 1 : 0) - (held("d", "arrowright") ? 1 : 0)) * 2.2 * dt;
  const v = ((held("w", "arrowup") ? 1 : 0) - (held("s", "arrowdown") ? 1 : 0)) * (held("shift") ? 15 : 4.5) * dt;
  const dx = -Math.sin(walker.yaw) * v, dz = -Math.cos(walker.yaw) * v;
  const free = (x, z) => Number.isFinite(groundAt(x, z)) && !blocked(x + Math.sign(dx) * RADIUS, z + Math.sign(dz) * RADIUS);
  if (free(walker.x + dx, walker.z)) walker.x += dx; // per-axis, so walls slide
  if (free(walker.x, walker.z + dz)) walker.z += dz;
}

// ---- loop --------------------------------------------------------------------------------------------------------
const hud = document.getElementById("hud");
const ray = new THREE.Raycaster();
const camPos = new THREE.Vector3(), camGoal = new THREE.Vector3(), look = new THREE.Vector3();
let last = performance.now(), lastStream = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (now - lastStream > 500) { stream(); lastStream = now; }
  step(dt);
  const g = groundAt(walker.x, walker.z), py = Number.isFinite(g) ? g - base : 0;
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
  camera.lookAt(look.set(walker.x, py + 1.4, walker.z));
  if (q.has("aerial")) { camera.position.set(walker.x, py + +q.get("aerial"), walker.z + +q.get("aerial") * 0.6); camera.lookAt(look); } // debug
  renderer.render(scene, camera);
  const [lon, lat] = frame.toLonLat(walker.x, walker.z);
  hud.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${Number.isFinite(g) ? Math.round(g) + " m" : "loading…"}
tiles: ${loadedFoots.size} buildings, ${demReady.size} terrain · ${stats.requests} range requests, ${(stats.bytes / 1024).toFixed(0)} KB`;
});
window.townwalk = { walker, stats, keys }; // for poking from devtools
