// GTA-style maps: a round minimap that turns with the walker, and a full map (M) to pan, zoom and double-click to jump.
import { getVT, OSM_MAX_Z } from "./data.js";
import { paintTile, tileMPerPx } from "./paint.js";
import * as geo from "./geo.js";

const TILE = 256; // css px per tile at an integer zoom
const dpr = Math.min(2, devicePixelRatio);

// painted tiles (with buildings), shared by both maps. ponytail: LRU by insertion order, 160 x 1 MB at most
const painted = new Map();
function paintedTile(z, x, y) {
  const n = 2 ** z; x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const k = `${z}/${x}/${y}`;
  if (painted.has(k)) { const c = painted.get(k); painted.delete(k); painted.set(k, c); return c.ready ? c : null; }
  const c = document.createElement("canvas");
  c.width = c.height = TILE * dpr;
  painted.set(k, c);
  if (painted.size > 160) painted.delete(painted.keys().next().value);
  getVT(z, x, y).then((vt) => {
    if (vt) paintTile(c.getContext("2d"), vt, c.width, tileMPerPx(z, geo.tileYToLat(y + 0.5, z), c.width), { buildings: true, bridges: true, labels: z >= 15 });
    c.ready = true;
  });
  return null;
}

// Draw the map centred on lon/lat at fractional zoom Z into ctx (css px), rotated by `rot` radians.
// Missing tiles fall back to a parent tile, scaled, so zooming never shows holes.
function drawMap(ctx, w, h, lon, lat, Z, rot = 0) {
  const tz = Math.max(0, Math.min(OSM_MAX_Z, Math.floor(Z))), scale = 2 ** (Z - tz), T = TILE * scale;
  const cx = geo.lonToTileX(lon, tz), cy = geo.latToTileY(lat, tz);
  const reach = Math.hypot(w, h) / 2 / T + 1;
  ctx.save();
  ctx.translate(w / 2, h / 2); ctx.rotate(rot);
  for (let x = Math.floor(cx - reach); x <= Math.floor(cx + reach); x++)
    for (let y = Math.floor(cy - reach); y <= Math.floor(cy + reach); y++) {
      const sx = (x - cx) * T, sy = (y - cy) * T;
      const c = paintedTile(tz, x, y);
      if (c) { ctx.drawImage(c, sx, sy, T + 1, T + 1); continue; }
      for (let up = 1; up <= 4 && tz - up >= 0; up++) { // parent fallback
        const p = painted.get(`${tz - up}/${x >> up}/${y >> up}`);
        if (p?.ready) {
          const f = 2 ** up, s = p.width / f;
          ctx.drawImage(p, (x % f) * s, (y % f) * s, s, s, sx, sy, T + 1, T + 1);
          break;
        }
      }
    }
  ctx.restore();
}

function arrow(ctx, x, y, rot, r) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.75, r * 0.8); ctx.lineTo(0, r * 0.4); ctx.lineTo(-r * 0.75, r * 0.8); ctx.closePath();
  ctx.fillStyle = "#e4572e"; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
  ctx.restore();
}

function canvas(el) {
  const ctx = el.getContext("2d");
  const fit = () => { el.width = el.clientWidth * dpr; el.height = el.clientHeight * dpr; };
  new ResizeObserver(fit).observe(el); fit();
  return ctx;
}

// player(): {lon, lat, yaw}; teleport(lon, lat)
export function setupMaps({ player, teleport }) {
  const mini = document.getElementById("minimap"), big = document.getElementById("bigmap"), bigWrap = document.getElementById("map");
  const mctx = canvas(mini), bctx = canvas(big);
  const view = { lon: 0, lat: 0, z: 15 }; // full map view
  let open = false;

  const toggle = (on = !open) => {
    open = on; bigWrap.hidden = !open;
    if (open) { const p = player(); Object.assign(view, { lon: p.lon, lat: p.lat, z: 15 }); }
  };
  addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggle();
    else if (e.key === "Escape" && open) toggle(false);
  });
  document.getElementById("mapbtn").onclick = () => toggle();

  // screen point (css px) on the full map -> lon/lat
  const at = (mx, my) => {
    const tz = Math.max(0, Math.min(OSM_MAX_Z, Math.floor(view.z))), T = TILE * 2 ** (view.z - tz);
    const tx = geo.lonToTileX(view.lon, tz) + (mx - big.clientWidth / 2) / T, ty = geo.latToTileY(view.lat, tz) + (my - big.clientHeight / 2) / T;
    return [geo.tileXToLon(tx, tz), geo.tileYToLat(ty, tz)];
  };
  // zoom by dz keeping the point under (mx, my) fixed
  const zoomAbout = (mx, my, dz) => {
    const [lon, lat] = at(mx, my);
    view.z = Math.max(3, Math.min(18, view.z + dz));
    const [lon2, lat2] = at(mx, my);
    view.lon += lon - lon2; view.lat += lat - lat2;
  };
  const jump = (mx, my) => { teleport(...at(mx, my)); toggle(false); };

  // pointers: one drags, two pinch-zoom; a double tap (touch) or double click (mouse) jumps
  const pts = new Map(); // pointerId -> [x, y] (canvas css px)
  let pinch = null, lastTap = null, touchedAt = -1e9;
  const local = (e) => { const r = big.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  big.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, local(e)); pinch = null;
    try { big.setPointerCapture(e.pointerId); } catch {} // keep the drag when the pointer leaves the map
    if (e.pointerType === "touch") touchedAt = performance.now();
  });
  big.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = local(e);
    pts.set(e.pointerId, cur);
    if (pts.size === 1) {
      const [lon, lat] = at(big.clientWidth / 2 - (cur[0] - prev[0]), big.clientHeight / 2 - (cur[1] - prev[1]));
      Object.assign(view, { lon, lat });
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) zoomAbout((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.log2(d / pinch));
      pinch = d;
    }
  });
  const up = (e) => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (e.pointerType !== "touch" || !p || e.type !== "pointerup") return;
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(p[0] - lastTap.p[0], p[1] - lastTap.p[1]) < 30) { lastTap = null; jump(...p); }
    else lastTap = { t: now, p };
  };
  big.addEventListener("pointerup", up);
  big.addEventListener("pointercancel", up);
  big.addEventListener("wheel", (e) => { e.preventDefault(); zoomAbout(...local(e), -e.deltaY * 0.0025); }, { passive: false });
  big.addEventListener("dblclick", (e) => { if (performance.now() - touchedAt > 800) jump(...local(e)); }); // mouse; touch jumps on double tap above

  return {
    get open() { return open; },
    draw() {
      const p = player();
      // minimap: heading up, ~400 m across
      const w = mini.clientWidth, h = mini.clientHeight;
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, w, h);
      drawMap(mctx, w, h, p.lon, p.lat, 16.4, p.yaw);
      arrow(mctx, w / 2, h / 2, 0, 9);
      if (!open) return; // ponytail: redrawn every frame while open (~100 drawImage), no dirty tracking
      const W = big.clientWidth, H = big.clientHeight;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.fillStyle = "#4fb3e8"; bctx.fillRect(0, 0, W, H);
      drawMap(bctx, W, H, view.lon, view.lat, view.z);
      const tz = Math.max(0, Math.min(OSM_MAX_Z, Math.floor(view.z))), T = TILE * 2 ** (view.z - tz);
      arrow(bctx, W / 2 + (geo.lonToTileX(p.lon, tz) - geo.lonToTileX(view.lon, tz)) * T,
        H / 2 + (geo.latToTileY(p.lat, tz) - geo.latToTileY(view.lat, tz)) * T, -p.yaw, 12);
    },
  };
}
