// Pure geo math: web-mercator tiles <-> lon/lat <-> local metres. No DOM, so node can test it.

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
export const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tileYToLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// Local frame: x east, z south (metres), origin at [lon0, lat0].
// ponytail: equirectangular around the origin, fine within ~20 km; re-origin when walking further
export function localFrame(lon0, lat0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110540;
  return {
    toLocal: (lon, lat) => [(lon - lon0) * kx, (lat0 - lat) * kz],
    toLonLat: (x, z) => [lon0 + x / kx, lat0 - z / kz],
  };
}

// Tiles [z, x, y] whose square lies within r metres of a point (by tile centre distance, padded by half a tile).
export function tilesAround(lon, lat, z, r, frame) {
  const tx = Math.floor(lonToTileX(lon, z)), ty = Math.floor(latToTileY(lat, z));
  const [px, pz] = frame.toLocal(lon, lat);
  const out = [];
  for (let dx = -4; dx <= 4; dx++)
    for (let dy = -4; dy <= 4; dy++) {
      const x = tx + dx, y = ty + dy;
      const [ax, az] = frame.toLocal(tileXToLon(x, z), tileYToLat(y, z));
      const [bx, bz] = frame.toLocal(tileXToLon(x + 1, z), tileYToLat(y + 1, z));
      const cx = Math.max(ax, Math.min(px, bx)), cz = Math.max(az, Math.min(pz, bz)); // nearest point of the tile
      if (Math.hypot(cx - px, cz - pz) <= r) out.push([z, x, y]);
    }
  return out;
}

// Shoelace area; in tile coords (y down) MVT outer rings come out positive.
export const ringArea = (r) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

export function pointInRing(px, pz, r) {
  let hit = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

// Point in a polygon given as rings, by winding: outer rings have positive ringArea (y/z down), holes negative.
// Overlapping outers stay filled (unlike even-odd).
export const inPolygon = (x, z, rings) => rings.reduce((w, r) => w + (pointInRing(x, z, r) ? Math.sign(ringArea(r)) : 0), 0) > 0;

// Medians of dual carriageways: pairs of one-way segments of the same street, running opposite ways, 4-30 m apart and
// overlapping by 5+ m. Segments are {ax, az, bx, bz, name} in any units; k converts units to metres. Returns quads
// [a, b, b', a'] (a, b on one carriageway, the primes their projections on the other) and the median's width (m).
export function medianQuads(segs, k = 1, minW = 4, maxW = 30) {
  const out = [];
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i], B = segs[j];
      if (!A.name || A.name !== B.name) continue;
      const ax = A.bx - A.ax, az = A.bz - A.az, bx = B.bx - B.ax, bz = B.bz - B.az;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (!la || !lb || (ax * bx + az * bz) / (la * lb) > -0.9) continue; // must run opposite ways
      const proj = (px, pz) => { const t = Math.max(0, Math.min(1, ((px - B.ax) * bx + (pz - B.az) * bz) / (lb * lb))); return [B.ax + t * bx, B.az + t * bz, t]; };
      const p0 = proj(A.ax, A.az), p1 = proj(A.bx, A.bz);
      if (Math.abs(p1[2] - p0[2]) * lb * k < 5) continue; // too little overlap
      const w = (Math.abs((((A.ax + A.bx) / 2 - B.ax) * bz - ((A.az + A.bz) / 2 - B.az) * bx)) / lb) * k; // A's middle to B's line
      if (w < minW || w > maxW) continue;
      out.push({ quad: [[A.ax, A.az], [A.bx, A.bz], [p1[0], p1[1]], [p0[0], p0[1]]], width: w });
    }
  return out;
}

// Mapbox terrain-RGB, as smartmaps/gel packs it.
export const rgbToHeight = (r, g, b) => -10000 + (r * 65536 + g * 256 + b) * 0.1;
