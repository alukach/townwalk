// Tile sources on source.coop, read with HTTP range requests. Every byte fetched is counted in `stats`.
import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

export const stats = { requests: 0, bytes: 0 };

class RangeSource {
  constructor(url) { this.url = url; }
  getKey() { return this.url; }
  async getBytes(offset, length, signal) {
    // no-store: Chrome's HTTP cache locks per URL, so parallel ranges of one .pmtiles file queue behind each other
    // ("Stalled" in devtools; 20 parallel reads took ~3-5 s cached vs ~0.4-0.6 s with no-store). Tiles are cached
    // decoded in getVT instead.
    const r = await fetch(this.url, { signal, cache: "no-store", headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!r.ok) throw new Error(`${r.status} ${this.url}`);
    const data = await r.arrayBuffer();
    stats.requests++; stats.bytes += data.byteLength;
    return { data, etag: r.headers.get("ETag") ?? undefined };
  }
}

export const osm = new PMTiles(new RangeSource("https://data.source.coop/protomaps/openstreetmap/v4.pmtiles"));
export const dem = new PMTiles(new RangeSource("https://data.source.coop/smartmaps/gel/gel.pmtiles"));
export const OSM_MAX_Z = 15;

// Decoded vector tiles, shared by the 3D ground, the minimap and the full map. ponytail: LRU by insertion order.
const vts = new Map();
export function getVT(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (vts.has(k)) { const v = vts.get(k); vts.delete(k); vts.set(k, v); return v; }
  const p = osm.getZxy(z, x, y).then((t) => (t ? new VectorTile(new Pbf(new Uint8Array(t.data))) : null)).catch(() => null);
  vts.set(k, p);
  if (vts.size > 400) vts.delete(vts.keys().next().value);
  return p;
}
