import { inPolygon, medianQuads } from "./geo.js";

// MVT rings wind clockwise (outer) / counter-clockwise (holes), so fills use nonzero: evenodd cancels where
// clipped rings overlap (whole-tile squares), which punched tile-shaped holes in woods.
// One cartoon style for OSM vector tiles, painted to a canvas: the 3D ground texture, the minimap and the full map.

// POI kind -> icon. Unknown kinds with a name get a pin.
export const POI_ICON = {
  restaurant: "🍽️", cafe: "☕", fast_food: "🍔", bar: "🍺", pub: "🍺", ice_cream: "🍦", bakery: "🥐",
  hotel: "🏨", motel: "🏨", hostel: "🛏️", guest_house: "🏡", camp_site: "⛺",
  supermarket: "🛒", convenience: "🏪", clothes: "👕", books: "📚", hardware: "🔧", bicycle: "🚲", florist: "💐",
  bank: "🏦", atm: "🏧", post_office: "📮", pharmacy: "💊", hospital: "🏥", clinic: "🩺", dentist: "🦷", doctors: "🩺",
  library: "📚", school: "🏫", college: "🎓", university: "🎓", kindergarten: "🧸",
  townhall: "🏛️", courthouse: "⚖️", police: "🚓", fire_station: "🚒", museum: "🏛️", theatre: "🎭", cinema: "🎬",
  arts_centre: "🎨", community_centre: "🏘️", sports_centre: "🏟️", ice_rink: "⛸️", swimming_pool: "🏊", stadium: "🏟️",
  park: "🌳", playground: "🛝", garden: "🌷", viewpoint: "🔭", attraction: "⭐", information: "ℹ️",
  place_of_worship: "⛪", parking: "🅿️", subway_entrance: "🚇", bus_stop: "🚏", fuel: "⛽", aerodrome: "✈️", ferry_terminal: "⛴️", bus_station: "🚌", station: "🚉",
  marina: "⛵", beach: "🏖️", golf_course: "⛳", zoo: "🦁",
};

// Parking lots aren't polygons in the tiles, only POI points ("Costco Parking"). A parking point inside a retail,
// commercial or industrial area, and not inside a building (that would be a garage), makes that area a lot.
const LOT_LANDUSE = new Set(["retail", "commercial", "industrial"]);
export function parkingLots(L) {
  const lots = new Set();
  if (!L.landuse || !L.pois) return lots;
  const pts = [];
  for (let i = 0; i < L.pois.length; i++) {
    const f = L.pois.feature(i);
    if (f.type === 1 && f.properties.kind === "parking") { const p = f.loadGeometry()[0][0]; pts.push([p.x, p.y]); }
  }
  if (!pts.length) return lots;
  const rings = (f) => f.loadGeometry().map((r) => r.map((q) => [q.x, q.y]));
  const inBuilding = (p) => { for (let i = 0; i < (L.buildings?.length ?? 0); i++) { const f = L.buildings.feature(i); if (f.type === 3 && inPolygon(p[0], p[1], rings(f))) return true; } return false; };
  const open = pts.filter((p) => !inBuilding(p));
  for (let i = 0; i < L.landuse.length; i++) {
    const f = L.landuse.feature(i);
    if (f.type === 3 && LOT_LANDUSE.has(f.properties.kind) && open.some((p) => inPolygon(p[0], p[1], rings(f)))) lots.add(i);
  }
  return lots;
}
export const STYLE = {
  water: "#4fb3e8", shore: "#2f86c2", land: "#a8d672",
  landuse: {
    park: "#86cc62", grass: "#8fd16a", garden: "#8fd16a", golf_course: "#86cc62", pitch: "#7cc46a", playground: "#9bd67a",
    cemetery: "#a3c98c", recreation_ground: "#8fd16a", wood: "#5fae57", forest: "#5fae57", nature_reserve: "#6fb85e",
    scrub: "#9cc46b", meadow: "#a2d27a", farmland: "#c6dc8f", orchard: "#97cc6c", vineyard: "#a8c873",
    commercial: "#ead7b7", retail: "#ead7b7", industrial: "#d8cdc2", railway: "#d8cdc2", college: "#f1dcc8",
    school: "#f1dcc8", university: "#f1dcc8", hospital: "#f4d4d0", aerodrome: "#d9d9cc", pier: "#c9a27a",
    bare_rock: "#bdb5a6", sand: "#f2e0a6", beach: "#f2e0a6", glacier: "#f4fbff", parking: "#8f939b", garages: "#b9b4ad",
    pedestrian: "#e6dfd2", platform: "#cfcac2",
  },
  // metres wide, fill, casing (dark outline) or null
  road(p) {
    if (p.kind === "highway") return [14, "#ff9f43", "#7a4a1e"];
    if (p.kind === "major_road") return [10, "#ffd166", "#6b5a2a"];
    if (p.kind === "minor_road") return p.kind_detail === "service" ? [4.5, "#f4f1ea", "#7d7a72"] : [7, "#ffffff", "#6f6f78"];
    if (p.kind === "path") return [1.8, "#e3c48f", null];
    if (p.kind === "rail") return [2.5, "#6f6f78", null];
    if (p.kind === "aeroway") return [30, "#c9c9c9", "#8a8a8a"];
    return null;
  },
  river: { river: 12, canal: 8, stream: 3, ditch: 1.5, drain: 1.5 },
  building: "#f2b880", buildingEdge: "#9a6440", median: "#8cc865",
};

// Land use draws in a fixed order by kind: features often tie on sort_rank (a provincial park over a forest), and a
// tie broken differently per tile showed as tile-shaped patches. Big protected areas first, small things last.
const LANDUSE_ORDER = ["nature_reserve", "park", "national_park", "protected_area", "farmland", "meadow", "grass",
  "scrub", "wood", "forest", "orchard", "vineyard", "bare_rock", "glacier", "sand", "beach", "residential", "commercial",
  "retail", "industrial", "railway", "aerodrome", "college", "university", "school", "hospital", "cemetery",
  "recreation_ground", "golf_course", "garden", "playground", "pitch", "parking", "garages", "pedestrian", "platform", "pier"];
const order = (f) => { const i = LANDUSE_ORDER.indexOf(f.properties.kind); return i === -1 ? LANDUSE_ORDER.length : i; };
const rank = (f) => f.properties.sort_rank ?? 0;

function features(layer, by = rank) {
  if (!layer) return [];
  const out = [];
  for (let i = 0; i < layer.length; i++) out.push(Object.assign(layer.feature(i), { _i: i })); // _i: index in its layer
  return out.sort((a, b) => by(a) - by(b) || rank(a) - rank(b));
}

// Paint tile `vt` into ctx's [0, size] square. mPerPx: metres per canvas pixel (sets line widths).
// opts.buildings: draw footprints (maps). opts.bridges: draw bridge roads (off for the 3D ground, which has decks).
// opts.roads === false: skip roads (the 3D ground draws them as geometry, which stays sharp up close).
// opts.labels: street names along roads and POI icons (maps, at street zooms).
export function paintTile(ctx, vt, size, mPerPx, opts = {}) {
  const L = vt.layers;
  const E = (L.earth ?? L.roads ?? L.water ?? Object.values(L)[0])?.extent ?? 4096, s = size / E;
  const path = (f) => {
    ctx.beginPath();
    for (const ring of f.loadGeometry()) ring.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
  };
  const px = (m, min) => Math.max(min, m / mPerPx);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, size, size); ctx.clip();
  ctx.lineJoin = ctx.lineCap = "round";

  // water is the background; earth is land on top (so coasts work); then land use, water, roads, buildings
  ctx.fillStyle = STYLE.water; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = STYLE.land;
  for (const f of features(L.earth)) if (f.type === 3) { path(f); ctx.fill("nonzero"); }
  ctx.save(); // paving only on land (clip to earth), so waterfront buildings don't pave the sea
  ctx.beginPath();
  for (const f of features(L.earth)) if (f.type === 3) for (const ring of f.loadGeometry()) ring.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
  ctx.clip("nonzero");
  paveDense(ctx, L.buildings, size, mPerPx);
  ctx.restore();
  const lots = parkingLots(L);
  for (const f of features(L.landuse, order)) {
    if (f.type !== 3) continue;
    const lot = lots.has(f._i), c = lot ? STYLE.landuse.parking : STYLE.landuse[f.properties.kind];
    if (c) { ctx.fillStyle = c; path(f); ctx.fill("nonzero"); }
  }
  // medians between dual carriageways: a planted strip (trees are added in 3D)
  const oneways = [];
  for (const f of features(L.roads)) {
    if (f.type !== 2 || !f.properties.oneway || !f.properties.name || f.properties.kind === "highway" || f.properties.is_bridge || f.properties.is_tunnel) continue; // freeways: barriers, not planted
    for (const line of f.loadGeometry()) for (let i = 1; i < line.length; i++)
      oneways.push({ ax: line[i - 1].x, az: line[i - 1].y, bx: line[i].x, bz: line[i].y, name: f.properties.name });
  }
  ctx.fillStyle = STYLE.median;
  for (const { quad } of medianQuads(oneways, mPerPx * s)) {
    ctx.beginPath(); quad.forEach(([qx, qy], i) => (i ? ctx.lineTo(qx * s, qy * s) : ctx.moveTo(qx * s, qy * s))); ctx.fill();
  }
  for (const f of features(L.water)) {
    if (f.type === 3) {
      path(f); ctx.fillStyle = STYLE.water; ctx.fill("nonzero");
      ctx.strokeStyle = STYLE.shore; ctx.lineWidth = px(1.5, 1); ctx.stroke();
    } else if (f.type === 2) {
      ctx.strokeStyle = STYLE.water; ctx.lineWidth = px(STYLE.river[f.properties.kind] ?? 3, 1); path(f); ctx.stroke();
    }
  }
  const roads = opts.roads === false ? [] : features(L.roads).filter((f) => f.type === 2 && !f.properties.is_tunnel && (opts.bridges || !f.properties.is_bridge));
  const outline = px(1.2, 0.8);
  for (const f of roads) { // casings first so crossings merge
    const st = STYLE.road(f.properties);
    if (st?.[2]) { ctx.strokeStyle = st[2]; ctx.lineWidth = px(st[0], 1) + 2 * outline; path(f); ctx.stroke(); }
  }
  for (const f of roads) {
    const st = STYLE.road(f.properties);
    if (!st) continue;
    ctx.setLineDash(f.properties.kind === "rail" ? [px(6, 3), px(4, 2)] : []);
    ctx.strokeStyle = st[1]; ctx.lineWidth = px(st[0], 1); path(f); ctx.stroke();
  }
  ctx.setLineDash([]);
  if (opts.buildings)
    for (const f of features(L.buildings)) if (f.type === 3) {
      path(f); ctx.fillStyle = STYLE.building; ctx.fill("nonzero");
      ctx.strokeStyle = STYLE.buildingEdge; ctx.lineWidth = Math.max(0.6, 0.8 / mPerPx); ctx.stroke();
    }
  if (opts.labels) drawLabels(ctx, L, s, size);
  ctx.restore();
}

// Dense built-up land is paved, not grass: OSM rarely maps the plazas and lots between downtown buildings, so the
// default land colour turned Manhattan's blocks green. Building coverage, blurred over ~30 m, decides: above ~30%
// the ground fades to paving; suburbs (houses on yards, ~15%) stay green. Parks and other land use paint over it.
const PAVE = [216, 210, 198], D = 64; // colour; coverage grid cells per tile side (~12 m at z15)
function paveDense(ctx, layer, size, mPerPx) {
  if (!layer?.length) return;
  const cover = new OffscreenCanvas(D, D), cg = cover.getContext("2d"), k = D / layer.extent;
  cg.fillStyle = "#fff";
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    cg.beginPath();
    for (const ring of f.loadGeometry()) ring.forEach((p, j) => (j ? cg.lineTo(p.x * k, p.y * k) : cg.moveTo(p.x * k, p.y * k)));
    cg.fill("nonzero");
  }
  const cell = (mPerPx * size) / D, blur = new OffscreenCanvas(D, D), bg = blur.getContext("2d", { willReadFrequently: true });
  bg.filter = `blur(${(30 / cell).toFixed(2)}px)`;
  bg.drawImage(cover, 0, 0);
  const img = bg.getImageData(0, 0, D, D), a = img.data;
  for (let i = 0; i < a.length; i += 4) {
    const t = Math.min(1, Math.max(0, (a[i + 3] / 255 - 0.22) / 0.14)); // coverage 22% -> 36%: grass -> paving
    a[i] = PAVE[0]; a[i + 1] = PAVE[1]; a[i + 2] = PAVE[2]; a[i + 3] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  bg.filter = "none"; bg.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(blur, 0, 0, size, size);
}

// Street names on each named road's longest segment (kept upright, skipped if it won't fit), then POI icons.
function drawLabels(ctx, L, s, size) {
  const fs = size / 24; // ~10.7 css px on a 256 px tile
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const seen = new Set();
  for (const f of features(L.roads)) {
    const name = f.properties.name;
    if (f.type !== 2 || !name || seen.has(name)) continue;
    let best = null;
    for (const line of f.loadGeometry())
      for (let i = 1; i < line.length; i++) {
        const ax = line[i - 1].x * s, ay = line[i - 1].y * s, bx = line[i].x * s, by = line[i].y * s, len = Math.hypot(bx - ax, by - ay);
        if (!best || len > best.len) best = { len, mx: (ax + bx) / 2, my: (ay + by) / 2, ang: Math.atan2(by - ay, bx - ax) };
      }
    const w = ctx.measureText(name).width;
    if (!best || best.len < w + fs || best.mx < w / 2 || best.mx > size - w / 2 || best.my < fs || best.my > size - fs) continue;
    seen.add(name); // one label per street per tile
    let a = best.ang; if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI;
    ctx.save(); ctx.translate(best.mx, best.my); ctx.rotate(a);
    ctx.lineWidth = fs * 0.35; ctx.strokeStyle = "#ffffffee"; ctx.strokeText(name, 0, 0);
    ctx.fillStyle = "#3b3b45"; ctx.fillText(name, 0, 0);
    ctx.restore();
  }
  ctx.font = `${fs * 0.5}px system-ui, sans-serif`; // emoji draw large, and the minimap shows z15 tiles ~2.6x up
  for (const f of features(L.pois)) {
    const icon = f.type === 1 && f.properties.name && POI_ICON[f.properties.kind];
    if (!icon) continue;
    const p = f.loadGeometry()[0][0];
    ctx.fillText(icon, p.x * s, p.y * s);
  }
}

// metres per pixel of a `size`-px tile at zoom z, latitude lat
export const tileMPerPx = (z, lat, size) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z / size;
