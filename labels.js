// Annotations from OSM: floating POI labels, the current street + area (GTA-style), and a title card per new area.
import * as THREE from "three";
export { POI_ICON } from "./paint.js";

const MAX_LABELS = 24, RANGE = 140; // metres

export function setupLabels(camera) {
  const root = document.getElementById("labels"), where = document.getElementById("where"), banner = document.getElementById("banner");
  const pool = Array.from({ length: MAX_LABELS }, () => root.appendChild(Object.assign(document.createElement("div"), { className: "poi" })));
  const v = new THREE.Vector3();
  let area = null;

  return {
    // pois: [{x, y, z, name, icon}] in world coords; walker: {x, z}
    update(pois, walker) {
      const near = [];
      for (const p of pois) { const d = Math.hypot(p.x - walker.x, p.z - walker.z); if (d < RANGE) near.push([d, p]); }
      near.sort((a, b) => a[0] - b[0]);
      const seen = new Set(); // a POI near a tile edge is in both tiles (and OSM often has a node + an area): once each
      const uniq = near.filter(([, p]) => !seen.has(p.name) && seen.add(p.name));
      const W = innerWidth, H = innerHeight;
      const placed = []; // screen boxes taken so far, nearest labels first: an overlapping one is skipped
      let next = 0;
      pool.forEach((el) => {
        let d, p, sx, sy;
        for (; next < uniq.length; next++) {
          [d, p] = uniq[next];
          v.set(p.x, p.y, p.z).project(camera);
          if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue; // behind / off screen
          sx = ((v.x + 1) / 2) * W; sy = ((1 - v.y) / 2) * H;
          const w = 9 * p.name.length + 40; // ponytail: estimated width, no layout read per frame
          if (placed.some((b) => Math.abs(b[0] - sx) < (b[2] + w) / 2 && Math.abs(b[1] - sy) < 26)) continue;
          placed.push([sx, sy, w]); next++; break;
        }
        if (!placed.length || placed.at(-1)[0] !== sx) return (el.style.display = "none");
        if (el._key !== p.key) { el._key = p.key; el.textContent = ""; el.append(p.icon, Object.assign(document.createElement("span"), { textContent: p.name })); }
        el.style.display = "";
        el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%) scale(${Math.max(0.75, 1.25 - d / RANGE)})`;
        el.style.opacity = d > RANGE * 0.8 ? (RANGE - d) / (RANGE * 0.2) : 1;
      });
    },
    // street: {name, ref} | null; place: {name} | null
    where(street, place) {
      const s = street ? [street.ref && `[${street.ref}]`, street.name].filter(Boolean).join(" ") : "";
      where.innerHTML = "";
      where.append(Object.assign(document.createElement("b"), { textContent: s }), Object.assign(document.createElement("span"), { textContent: place?.name ?? "" }));
      if (place && place.name !== area) {
        area = place.name;
        banner.textContent = place.name;
        banner.classList.remove("show"); void banner.offsetWidth; banner.classList.add("show"); // restart the animation
      }
    },
  };
}
