// Procedural façades: windows per storey and bay, shopfronts with striped awnings, and a door on the street-facing
// wall, drawn per pixel by the building material from each wall's façade coordinates (main.js paintBuilding):
//   facade = (u: metres along the wall's footprint edge, v: metres above the ground at that edge, edge length, wall height)
//   fmeta  = (style id, a random per building, door position along this edge or -1, unused)
// Style ids: 0 house, 1 shop, 2 church, 3 brick, 4 civic, 5 industrial, 6 tower. Edges are anti-aliased with fwidth,
// so they stay sharp up close and don't shimmer far away.
import * as THREE from "three";

const lin = (hex) => new THREE.Color(hex);
const U = {
  uGlassLo: { value: lin("#3d6384") }, uGlassHi: { value: lin("#a9cfe6") }, uFrame: { value: lin("#f4f1ea") },
  uDoor: { value: lin("#7a4b2a") }, uSteel: { value: lin("#8a929b") }, uDark: { value: lin("#2d2a32") },
  uAwning: { value: ["#e4572e", "#2e86ab", "#3bb273", "#f2a541", "#8e5ea2", "#d64161"].map(lin) },
};

const GLSL = /* glsl */ `
  // a box [a0,a1] x [b0,b1] in cell coordinates (s, t), anti-aliased by the pixel footprint (ds, dt)
  float box(float s, float t, float a0, float a1, float b0, float b1, float ds, float dt) {
    return smoothstep(a0 - ds, a0 + ds, s) * (1.0 - smoothstep(a1 - ds, a1 + ds, s))
         * smoothstep(b0 - dt, b0 + dt, t) * (1.0 - smoothstep(b1 - dt, b1 + dt, t));
  }
  vec3 glass(float t) { return mix(uGlassLo, uGlassHi, smoothstep(0.1, 1.0, t)); } // sky reflected toward the top

  vec3 facade(vec3 wall, vec4 F, vec4 M) {
    float u = F.x, v = F.y, len = F.z, wallH = F.w;
    int st = int(M.x + 0.5); float rnd = M.y, door = M.z;
    if (v < 0.0) return wall; // below the ground at this edge (slopes)
    float storey = st == 0 ? 2.9 : st == 6 ? 3.6 : st == 5 ? 6.0 : 3.4;
    float bayW = st == 6 ? 1.6 : st == 5 ? 7.0 : st == 2 ? 4.5 : st == 4 ? 3.8 : 3.2;
    float bays = max(1.0, floor(len / bayW + 0.5));
    float cu = u / len * bays, s = fract(cu), cv = v / storey, t = fract(cv), fl = floor(cv);
    float ds = fwidth(cu) * 0.75 + 1e-4, dt = fwidth(cv) * 0.75 + 1e-4;
    float floors = floor(wallH / storey + 0.15); // whole storeys; the rest is parapet / eaves
    vec3 col = wall;
    bool narrow = len < bayW * 0.6;

    if (st == 6) { // tower: a curtain wall of glass and mullions
      float mull = max(1.0 - box(s, t, 0.06, 0.94, 0.1, 1.0, ds, dt), 0.0);
      col = mix(glass(t), mix(wall, uFrame, 0.4), mull);
    } else if (st == 2) { // church: tall pointed windows through the whole wall
      float tw = box(s, v, 0.38, 0.62, 2.0, max(2.5, wallH - 2.0), ds, fwidth(v) * 0.75);
      col = mix(col, glass(v / wallH), tw * (narrow ? 0.0 : 1.0));
    } else if (!narrow && fl < floors && !(fl < 0.5 && door >= 0.0 && abs(u - door) < len / bays * 0.6 && st != 1)) {
      bool ground = fl < 0.5; // (the ground-floor bay with the door has no window)
      if (st == 1 && ground) { // shop: a glass front and a striped awning over it
        col = mix(col, glass(t), box(s, t, 0.04, 0.96, 0.06, 0.74, ds, dt));
        float stripe = step(0.5, fract(cu * 4.0));
        vec3 aw = mix(uAwning[int(rnd * 5.99)], uFrame, stripe * 0.8);
        col = mix(col, aw, box(s, t, 0.0, 1.0, 0.76, 0.97, ds, dt));
      } else if (st == 5) { // industrial: a high strip of windows on each storey
        col = mix(col, glass(t), box(s, t, 0.06, 0.94, 0.62, 0.86, ds, dt));
      } else { // house / brick / civic: framed windows with a sill
        float w0 = st == 3 ? 0.22 : st == 4 ? 0.33 : 0.3, w1 = 1.0 - w0;
        float h0 = st == 4 ? 0.22 : 0.3, h1 = st == 4 ? 0.86 : 0.8;
        col = mix(col, uFrame, box(s, t, w0 - 0.05, w1 + 0.05, h0 - 0.06, h1 + 0.04, ds, dt)); // frame + sill
        col = mix(col, glass(t), box(s, t, w0, w1, h0, h1, ds, dt));
        col = mix(col, uFrame, box(s, t, 0.485, 0.515, h0, h1, ds, dt)); // glazing bar
      }
    }
    if (st == 3) col *= 1.0 - 0.08 * step(0.9, fract(v / 0.32)); // brick courses
    if (st == 4 && v > wallH - 0.9) col *= 0.85; // cornice

    if (door >= 0.0) { // the door, on the wall facing the street
      float dw = st == 5 ? 2.2 : st == 6 ? 1.6 : st == 0 ? 0.55 : 0.9;   // half widths
      float dh = st == 5 ? 4.2 : st == 6 ? 3.0 : st == 0 ? 2.15 : 2.6;
      float du = fwidth(u) * 0.75 + 1e-4, dv = fwidth(v) * 0.75 + 1e-4;
      vec3 leaf = st == 5 ? uSteel : st == 6 || st == 1 ? glass(v / dh) : uDoor;
      col = mix(col, uDark, box(u, v, door - dw - 0.12, door + dw + 0.12, 0.0, dh + 0.12, du, dv)); // frame
      col = mix(col, leaf, box(u, v, door - dw, door + dw, 0.0, dh, du, dv));
      if (st == 5) col *= 1.0 - 0.12 * step(0.85, fract(v / 0.3)) * box(u, v, door - dw, door + dw, 0.0, dh, du, dv); // roller slats
      if (st != 5 && st != 6) col = mix(col, uDark, box(u, v, door + dw * 0.55, door + dw * 0.75, 0.95, 1.1, du, dv)); // handle
    }
    return col;
  }`;

export function addFacades(material) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 facade; attribute vec4 fmeta; varying vec4 vFacade; varying vec4 vMeta;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFacade = facade; vMeta = fmeta;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec4 vFacade; varying vec4 vMeta;
        uniform vec3 uGlassLo; uniform vec3 uGlassHi; uniform vec3 uFrame; uniform vec3 uDoor; uniform vec3 uSteel; uniform vec3 uDark;
        uniform vec3 uAwning[6];
        ${GLSL}`)
      .replace("#include <color_fragment>", "#include <color_fragment>\nif (vFacade.z > 0.5) diffuseColor.rgb = facade(diffuseColor.rgb, vFacade, vMeta);");
  };
}
