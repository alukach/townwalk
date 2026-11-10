// Walk a town built from open data (media/<town>.json, made by fetch_town.py).
import { AbsoluteFill, Composition, registerRoot, useGameState, type FrameInput } from "raea";
import { crossSection, manifold } from "raea/3d";
import { StandardMaterial } from "raea/pbr";
import { Capsule3d, Cuboid, Mesh3d } from "raea/mesh";
import { AmbientLight, DirectionalLight } from "raea/light";
import { Quat, Transform } from "raea/transform";
import { Camera3d } from "raea/camera";
import town from "./media/nelson.json" with { type: "json" };

type Pt = [number, number]; // [x east, z south], metres
const buildings = town.buildings as { h: number; pts: Pt[] }[];

// --- geometry, built once -------------------------------------------------------------------------------------
const area = (r: Pt[]) => r.reduce((a, [x1, z1], i) => { const [x2, z2] = r[(i + 1) % r.length]; return a + x1 * z2 - x2 * z1; }, 0);
// extrude along z then stand up: polygon (px, py) lands at world (px, y, -py), so feed py = -z; keep rings CCW
const solids = buildings.map((b) => {
  let ring = b.pts.map(([x, z]) => [x, -z] as Pt);
  if (area(ring) < 0) ring = ring.reverse();
  return crossSection.polygon(ring).extrude(b.h);
});
const CITY = manifold.compose(...solids).rotate(-90, 0, 0);

// --- collision: point in any footprint (ponytail: brute force over all rings, grid it if towns get big) ----------
function inside([px, pz]: Pt, r: Pt[]) {
  let hit = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
const blocked = (p: Pt) => buildings.some((b) => inside(p, b.pts));

// --- game -------------------------------------------------------------------------------------------------------
interface Walker { x: number; z: number; yaw: number }
const START: Walker = { x: -94, z: 44, yaw: 0 }; // Baker St, downtown Nelson
const SPEED = 0.15, TURN = 0.05, RADIUS = 0.4;
const autopilot = (f: number) => (f % 120 < 90 ? ["w"] : ["w", "a"]); // ponytail: so a keyless render still walks

export function step(s: Walker, input: FrameInput, frame: number): Walker {
  const keys = input.keys.length ? input.keys : autopilot(frame);
  const has = (...k: string[]) => k.some((x) => keys.includes(x));
  const yaw = s.yaw + (has("a", "ArrowLeft") ? TURN : 0) - (has("d", "ArrowRight") ? TURN : 0);
  const v = (has("w", "ArrowUp") ? SPEED : 0) - (has("s", "ArrowDown") ? SPEED : 0);
  const dx = -Math.sin(yaw) * v, dz = -Math.cos(yaw) * v;
  const ahead = (x: number, z: number): Pt => [x + Math.sign(dx) * RADIUS, z + Math.sign(dz) * RADIUS];
  // slide along walls: try each axis on its own
  const x = blocked(ahead(s.x + dx, s.z)) ? s.x : s.x + dx;
  const z = blocked(ahead(x, s.z + dz)) ? s.z : s.z + dz;
  return { x, z, yaw };
}

function Walk() {
  const p = useGameState(START, step);
  const back = 9, up = 5;
  return <Scene p={p} cam={Transform.fromXyz(p.x + Math.sin(p.yaw) * back, up, p.z + Math.cos(p.yaw) * back).lookingAt([p.x, 1.2, p.z])} />;
}

// debug: the whole town from above, north up
const Overview = () => <Scene p={START} cam={Transform.fromXyz(0, 900, 1).lookingAt([0, 0, 0])} />;

function Scene({ p, cam }: { p: Walker; cam: Transform }) {
  return (
    <AbsoluteFill style={{ background: "#9fd3ff" }}>
      <Camera3d transform={cam} projection={{ Perspective: { fov: (60 * Math.PI) / 180 } }} />
      <AmbientLight brightness={150} />
      <DirectionalLight transform={Transform.fromXyz(200, 400, 100).lookingAt([0, 0, 0])} illuminance={6000} shadow_maps_enabled />
      <Mesh3d name="ground" transform={Transform.fromXyz(0, -0.05, 0)}>
        <Cuboid half_size={[900, 0.05, 900]} />
        <StandardMaterial base_color="#7cc36b" perceptual_roughness={1} />
      </Mesh3d>
      <Mesh3d name="city" shape={CITY}>
        <StandardMaterial base_color="#f2b880" perceptual_roughness={0.8} />
      </Mesh3d>
      <Mesh3d name="player" transform={Transform.fromXyz(p.x, 0.9, p.z).withRotation(Quat.fromEuler("XYZ", 0, p.yaw, 0))}>
        <Capsule3d radius={0.35} half_length={0.55} />
        <StandardMaterial base_color="#e4572e" perceptual_roughness={0.5} />
      </Mesh3d>
    </AbsoluteFill>
  );
}

registerRoot(() => (
  <>
    <Composition id="walk" component={Walk} width={1280} height={720} fps={30} durationInFrames={300} />
    <Composition id="overview" component={Overview} width={1280} height={1152} fps={30} durationInFrames={1} />
  </>
));
