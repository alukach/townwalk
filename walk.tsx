// Step 0: a capsule you can walk around a flat ground with a few boxes. Proves controls + chase camera.
import { AbsoluteFill, Composition, registerRoot, useGameState, type FrameInput } from "raea";
import { StandardMaterial } from "raea/pbr";
import { Capsule3d, Cuboid, Mesh3d } from "raea/mesh";
import { AmbientLight, DirectionalLight } from "raea/light";
import { Quat, Transform } from "raea/transform";
import { Camera3d } from "raea/camera";

interface Walker { x: number; z: number; yaw: number }
const START: Walker = { x: 0, z: 0, yaw: 0 };
const SPEED = 0.15; // m per frame (~4.5 m/s at 30 fps)
const TURN = 0.05; // rad per frame

// ponytail: autopilot so a render with no keys still shows walking
const autopilot = (f: number) => (f % 120 < 90 ? ["w"] : ["w", "a"]);

export function step(s: Walker, input: FrameInput, frame: number): Walker {
  const keys = input.keys.length ? input.keys : autopilot(frame);
  const has = (...k: string[]) => k.some((x) => keys.includes(x));
  const yaw = s.yaw + (has("a", "ArrowLeft") ? TURN : 0) - (has("d", "ArrowRight") ? TURN : 0);
  const v = (has("w", "ArrowUp") ? SPEED : 0) - (has("s", "ArrowDown") ? SPEED : 0);
  // facing -z at yaw 0
  return { x: s.x - Math.sin(yaw) * v, z: s.z - Math.cos(yaw) * v, yaw };
}

const BOXES = [[-6, -10], [5, -14], [-3, -24], [8, -30], [0, -40]];

function Walk() {
  const p = useGameState(START, step);
  const back = 8, up = 4;
  const cam = Transform.fromXyz(p.x + Math.sin(p.yaw) * back, up, p.z + Math.cos(p.yaw) * back).lookingAt([p.x, 1, p.z]);
  return (
    <AbsoluteFill style={{ background: "#9fd3ff" }}>
      <Camera3d transform={cam} projection={{ Perspective: { fov: (60 * Math.PI) / 180 } }} />
      <AmbientLight brightness={300} />
      <DirectionalLight transform={Transform.fromXyz(20, 40, 10).lookingAt([0, 0, 0])} illuminance={10000} shadow_maps_enabled />
      <Mesh3d name="ground" transform={Transform.fromXyz(0, -0.05, 0)}>
        <Cuboid half_size={[100, 0.05, 100]} />
        <StandardMaterial base_color="#7cc36b" perceptual_roughness={1} />
      </Mesh3d>
      {BOXES.map(([x, z], i) => (
        <Mesh3d key={i} name={`box-${i}`} transform={Transform.fromXyz(x, 2, z)}>
          <Cuboid half_size={[2, 2, 2]} />
          <StandardMaterial base_color="#f2b880" perceptual_roughness={0.8} />
        </Mesh3d>
      ))}
      <Mesh3d name="player" transform={Transform.fromXyz(p.x, 0.9, p.z).withRotation(Quat.fromEuler("XYZ", 0, p.yaw, 0))}>
        <Capsule3d radius={0.35} half_length={0.55} />
        <StandardMaterial base_color="#e4572e" perceptual_roughness={0.5} />
      </Mesh3d>
    </AbsoluteFill>
  );
}

registerRoot(() => <Composition id="walk" component={Walk} width={1280} height={720} fps={30} durationInFrames={300} />);
