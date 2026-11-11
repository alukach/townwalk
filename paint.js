// One cartoon style for OSM vector tiles, painted to a canvas: the 3D ground texture, the minimap and the full map.

export const STYLE = {
  water: "#4fb3e8", shore: "#2f86c2", land: "#a8d672",
  landuse: {
    park: "#86cc62", grass: "#8fd16a", garden: "#8fd16a", golf_course: "#86cc62", pitch: "#7cc46a", playground: "#9bd67a",
    cemetery: "#a3c98c", recreation_ground: "#8fd16a", wood: "#5fae57", forest: "#5fae57", nature_reserve: "#6fb85e",
    scrub: "#9cc46b", meadow: "#a2d27a", farmland: "#c6dc8f", orchard: "#97cc6c", vineyard: "#a8c873",
    commercial: "#ead7b7", retail: "#ead7b7", industrial: "#d8cdc2", railway: "#d8cdc2", college: "#f1dcc8",
    school: "#f1dcc8", university: "#f1dcc8", hospital: "#f4d4d0", aerodrome: "#d9d9cc", pier: "#c9a27a",
    bare_rock: "#bdb5a6", sand: "#f2e0a6", beach: "#f2e0a6", glacier: "#f4fbff", parking: "#d6d2cc",
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
  building: "#f2b880", buildingEdge: "#9a6440",
};

const rank = (f) => f.properties.sort_rank ?? 0;

function features(layer) {
  if (!layer) return [];
  const out = [];
  for (let i = 0; i < layer.length; i++) out.push(layer.feature(i));
  return out.sort((a, b) => rank(a) - rank(b));
}

// Paint tile `vt` into ctx's [0, size] square. mPerPx: metres per canvas pixel (sets line widths).
// opts.buildings: draw footprints (maps). opts.bridges: draw bridge roads (off for the 3D ground, which has decks).
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
  for (const f of features(L.earth)) if (f.type === 3) { path(f); ctx.fill("evenodd"); }
  for (const f of features(L.landuse)) {
    const c = f.type === 3 && STYLE.landuse[f.properties.kind];
    if (c) { ctx.fillStyle = c; path(f); ctx.fill("evenodd"); }
  }
  for (const f of features(L.water)) {
    if (f.type === 3) {
      path(f); ctx.fillStyle = STYLE.water; ctx.fill("evenodd");
      ctx.strokeStyle = STYLE.shore; ctx.lineWidth = px(1.5, 1); ctx.stroke();
    } else if (f.type === 2) {
      ctx.strokeStyle = STYLE.water; ctx.lineWidth = px(STYLE.river[f.properties.kind] ?? 3, 1); path(f); ctx.stroke();
    }
  }
  const roads = features(L.roads).filter((f) => f.type === 2 && !f.properties.is_tunnel && (opts.bridges || !f.properties.is_bridge));
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
      path(f); ctx.fillStyle = STYLE.building; ctx.fill("evenodd");
      ctx.strokeStyle = STYLE.buildingEdge; ctx.lineWidth = Math.max(0.6, 0.8 / mPerPx); ctx.stroke();
    }
  ctx.restore();
}

// metres per pixel of a `size`-px tile at zoom z, latitude lat
export const tileMPerPx = (z, lat, size) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z / size;
