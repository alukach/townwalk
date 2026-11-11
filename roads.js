// Roads drawn by the ground itself. OSM says *what* a road is; ROAD_STYLE says how we draw it.
//
// Per tile, the GPU bakes a road field: for every texel, the signed distance to the nearest road edge (min over all
// roads, so junctions merge), that road's style id, the distance along it and from its centre line. The ground
// material reads the field and paints asphalt, kerbs, sidewalks, centre dashes and rails, so roads are draped on the
// terrain exactly, never z-fight, and stay sharp up close (a distance field interpolates edges linearly).
import * as THREE from "three";

// id -> look. width/walk in metres; dash: centre-line colour or null; rail: draw rails + sleepers.
export const ROAD_STYLE = [
  null, // 0: no road
  { name: "highway", width: 14, asphalt: "#5e6370", walk: 0, dash: "#ffd166" },
  { name: "major", width: 10, asphalt: "#6b6f7a", walk: 2.5, dash: "#ffd166" },
  { name: "residential", width: 7, asphalt: "#787c86", walk: 2, dash: null },
  { name: "rural", width: 6, asphalt: "#7f838c", walk: 0, dash: "#f4f1ea" },
  { name: "service", width: 4.5, asphalt: "#8a8d94", walk: 0, dash: null },
  { name: "path", width: 1.8, asphalt: "#e3c48f", walk: 0, dash: null, soft: true },
  { name: "sidewalk", width: 2.2, asphalt: "#d9d4c7", walk: 0, dash: null, soft: true },
  { name: "steps", width: 2, asphalt: "#c9b18a", walk: 0, dash: null, soft: true },
  { name: "pier", width: 3, asphalt: "#b98a5a", walk: 0, dash: null, soft: true },
  { name: "rail", width: 3.2, asphalt: "#a39e94", walk: 0, dash: null, rail: true, soft: true },
  { name: "tram", width: 1.6, asphalt: null, walk: 0, dash: null, rail: true }, // rails only, laid in the street
  { name: "runway", width: 30, asphalt: "#8f9196", walk: 0, dash: "#ffffff" },
  // a zebra crossing: a short segment laid *across* a road at an OSM crossing point (main.js); width = its depth
  // along the road. It always wins over the road under it, and stripes run along it, so bars lie parallel to the road.
  { name: "zebra", width: 3, asphalt: "#6b6f7a", walk: 0, dash: "#f4f1ea", zebra: true },
];
const ID = Object.fromEntries(ROAD_STYLE.map((s, i) => [s?.name, i]));
export const ZEBRA = ID.zebra;
export const SIDEWALK = "#d9d4c7", KERB = "#55545c";

// Protomaps v4 road properties -> style id (0 = don't draw)
export function roadStyleId(p) {
  if (p.is_tunnel || p.is_bridge) return 0; // bridges are decks of their own
  const d = p.kind_detail;
  if (p.kind === "highway") return ID.highway;
  if (p.kind === "major_road") return ID.major;
  if (p.kind === "minor_road") return d === "service" ? ID.service : d === "unclassified" ? ID.rural : ID.residential;
  if (p.kind === "path") return d === "sidewalk" || d === "crossing" ? ID.sidewalk : d === "steps" ? ID.steps : d === "pier" ? ID.pier : ID.path;
  if (p.kind === "rail") return d === "tram" ? ID.tram : d === "disused" || d === "abandoned" ? 0 : ID.rail;
  if (p.kind === "aeroway") return ID.runway;
  return 0;
}

const RANGE = 16; // metres of signed distance the field holds either side of an edge
const bakeMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    attribute vec2 a; attribute vec2 b; attribute vec3 info; // info: half width, style id, distance along at a
    varying vec2 vP; varying vec2 vA; varying vec2 vB; varying vec3 vInfo;
    void main() { vP = position.xy; vA = a; vB = b; vInfo = info; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    varying vec2 vP; varying vec2 vA; varying vec2 vB; varying vec3 vInfo;
    void main() {
      vec2 pa = vP - vA, ba = vB - vA;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float cd = length(pa - ba * h), sd = cd - vInfo.x;
      if (int(vInfo.y + 0.5) == ${ROAD_STYLE.findIndex((s) => s?.zebra)}) { if (sd > 0.0) discard; sd = -${RANGE.toFixed(1)} + 0.01; } // zebra: wins inside
      if (sd > ${RANGE.toFixed(1)}) discard;
      float n = (sd + ${RANGE.toFixed(1)}) / ${(2 * RANGE).toFixed(1)};
      gl_FragDepth = n; // the depth test keeps the smallest signed distance: the union of all roads
      float side = ba.x * pa.y - ba.y * pa.x < 0.0 ? -1.0 : 1.0; // signed, so it stays linear across the centre line
      gl_FragColor = vec4(1.0 - n, vInfo.y, mod(vInfo.z + h * length(ba), 15.0), cd * side); // .r flipped: all-zero texel = no road
    }`,
  depthTest: true, depthWrite: true,
});

// segments: [{ax, ay, bx, by, hw, id, along}] in metres within a w x h (metres) tile, y up (north).
export function bakeRoads(renderer, segments, w, h, size) {
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  const pos = [], a = [], b = [], info = [];
  for (const s of segments) {
    const dx = s.bx - s.ax, dy = s.by - s.ay, len = Math.hypot(dx, dy) || 1e-3, ux = dx / len, uy = dy / len, e = s.hw + RANGE;
    const c = [[-e, -e], [len + e, -e], [len + e, e], [-e, -e], [len + e, e], [-e, e]]; // a quad around the capsule
    for (const [t, n] of c) { pos.push(s.ax + ux * t - uy * n, s.ay + uy * t + ux * n, 0); a.push(s.ax, s.ay); b.push(s.bx, s.by); info.push(s.hw, s.id, s.along); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("a", new THREE.Float32BufferAttribute(a, 2));
  g.setAttribute("b", new THREE.Float32BufferAttribute(b, 2));
  g.setAttribute("info", new THREE.Float32BufferAttribute(info, 3));
  const scene = new THREE.Scene(), mesh = new THREE.Mesh(g, bakeMat);
  mesh.frustumCulled = false; scene.add(mesh);
  const cam = new THREE.OrthographicCamera(0, w, h, 0, -1, 1);
  const prev = renderer.getRenderTarget(), prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0); // zero = no road within RANGE (see the flipped .r)
  renderer.clear();
  if (segments.length) renderer.render(scene, cam);
  renderer.setRenderTarget(prev); renderer.setClearColor(prevColor, prevAlpha);
  g.dispose();
  rt.texture.userData.rt = rt; // so whoever disposes the texture can free the target
  return rt.texture;
}

// Uniform tables for the ground shader (colours converted to the working colour space).
const lin = (hex) => new THREE.Color(hex ?? "#000000");
const U = {
  uAsphalt: { value: ROAD_STYLE.map((s) => lin(s?.asphalt)) },
  uDash: { value: ROAD_STYLE.map((s) => lin(s?.dash)) },
  // x: half width of the sidewalk band, y: has dash, z: rail, w: has asphalt / soft edge (no kerb) flag
  uParam: { value: ROAD_STYLE.map((s) => new THREE.Vector4(s?.walk ?? 0, s?.zebra ? 2 : s?.dash ? 1 : 0, s?.rail ? 1 : 0, !s ? 0 : s.asphalt === null ? 0 : s.soft ? 2 : 1)) },
  uSidewalk: { value: lin(SIDEWALK) }, uKerb: { value: lin(KERB) },
  uSteel: { value: lin("#8d9199") }, uSleeper: { value: lin("#6b4f3a") },
};

// A toon material for the ground whose colour is the land-use texture with the roads painted over it.
export function groundMaterial(gradientMap, map, roadTex) {
  const m = new THREE.MeshToonMaterial({ gradientMap, map });
  m.userData.roadTex = roadTex; // freed with the tile
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { roadTex: { value: roadTex } });
    const n = ROAD_STYLE.length;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform sampler2D roadTex; uniform vec3 uAsphalt[${n}]; uniform vec3 uDash[${n}]; uniform vec4 uParam[${n}];
        uniform vec3 uSidewalk; uniform vec3 uKerb; uniform vec3 uSteel; uniform vec3 uSleeper;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        {
          vec4 r = texture2D(roadTex, vMapUv);
          float sd = (1.0 - r.r) * ${(2 * RANGE).toFixed(1)} - ${RANGE.toFixed(1)};
          int id = int(r.g + 0.5);
          if (id > 0 && sd < ${RANGE.toFixed(1)} - 0.5) {
            vec4 P = uParam[id];
            float aa = fwidth(sd) * 0.8 + 0.01, cd = abs(r.a), ac = fwidth(r.a) * 0.8 + 0.01; // .a: signed distance from the centre line
            vec3 col = diffuseColor.rgb;
            if (P.x > 0.0) col = mix(col, uSidewalk, 1.0 - smoothstep(P.x - aa, P.x + aa, sd));          // sidewalk
            if (P.w > 0.5) col = mix(col, uAsphalt[id], 1.0 - smoothstep(-aa, aa, sd));                // surface
            if (P.w > 0.5 && P.w < 1.5) col = mix(col, uKerb, 1.0 - smoothstep(0.1 - aa, 0.1 + aa, abs(sd))); // kerb
            if (P.y > 0.5 && P.y < 1.5 && fract(r.b / 7.5) < 0.45) col = mix(col, uDash[id], 1.0 - smoothstep(0.12 - ac, 0.12 + ac, cd)); // centre dashes
            if (P.y > 1.5) { float ab = fwidth(r.b) * 0.8 + 0.01, z = fract(r.b / 1.2); // zebra bars
              col = mix(col, uDash[id], smoothstep(0.0, ab, z) * (1.0 - smoothstep(0.5 - ab, 0.5 + ab, z))); }
            if (P.z > 0.5) {
              float sleeper = step(fract(r.b / 0.75), 0.35) * (1.0 - smoothstep(1.25 - ac, 1.25 + ac, cd));
              if (P.w > 0.5) col = mix(col, uSleeper, sleeper);
              col = mix(col, uSteel, 1.0 - smoothstep(0.07 - ac, 0.07 + ac, abs(cd - 0.72)));        // two rails
            }
            diffuseColor.rgb = col;
          }
        }`);
  };
  return m;
}
