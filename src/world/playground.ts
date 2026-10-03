import { clamp, smoothstep } from '../sim/math.ts';
import { fbm, noise2 } from '../sim/noise.ts';
import { GRASS, LAYER_COUNT, MUD, SAND, TARMAC } from '../sim/surfaces.ts';
import { Terrain, WATER_SCALE } from '../sim/terrain.ts';

/**
 * Procedural test playground. Layout (x = east, z = south, metres):
 *
 *   - Skid pad (centre): dry tarmac west half / wet tarmac with puddles east half → split-mu tests.
 *   - Transition lane (north of pad): tarmac → dry sand → tarmac → (diagonal edge) wet mud →
 *     wet tarmac → wet grass → tarmac, with raised tarmac lips at every hard/soft boundary.
 *   - Shoulder lane: tarmac with a 6 cm drop-off onto sand / wet mud shoulder (wheels-off tests).
 *   - Mud pit (west) reached by a tarmac spur whose end is contaminated with tracked-out mud.
 *   - Sand dunes and a lake with a wet-sand beach (east).
 *   - Ring road (rounded square) with sand, mud and grass shoulders, a wet northern half with
 *     puddles (one-sided and full-width), and two speed bumps on the southern straight.
 *   - Wet grass meadow (south-west), dry grass elsewhere.
 */

export const PLAYGROUND = {
  size: 256,
  res: 1024,
  defRes: 2048,
  waterLevel: -0.9,
};

/** Teleport spots (keys 1–6); the first is the spawn. heading: 0 = north (-Z), + = clockwise. */
export const PLACES: { name: string; x: number; z: number; heading: number }[] = [
  { name: 'Skid pad — dry west half | wet east half with puddles', x: -8, z: 40, heading: 0 },
  { name: 'Transition lane — tarmac › sand › tarmac › diagonal edge › wet mud › wet tarmac › wet grass', x: 0, z: 10, heading: 0 },
  { name: 'Shoulder lane — 6 cm drop-off onto sand, then wet mud (keep right wheels on the edge)', x: -16.9, z: 10, heading: 0 },
  { name: 'Mud pit via tarmac spur (mud tracked onto the asphalt)', x: -36, z: 20, heading: -Math.PI / 2 },
  { name: 'Wet beach, dunes and lake', x: 46, z: -28, heading: Math.PI / 4 },
  { name: 'Ring road, wet north side — one-sided and full-width puddles', x: -75, z: -95, heading: Math.PI / 2 },
];

const ROAD_HALF_WIDTH = 3.6;
const LOOP_HALF = 95;
const LOOP_CORNER = 30;
const TARMAC_LIP = 0.04;
const LANE_X0 = -4, LANE_X1 = 4, LANE_Z0 = -92, LANE_Z1 = 0.5;
const SHOULDER_X0 = -24, SHOULDER_EDGE = -16, SHOULDER_X1 = -11;
const LAKE = { x: 66, z: -48, r: 17 };
const SAND_AREA = { x: 60, z: -45, r: 38 };
const MUD_PIT = { x: -70, z: 20, r: 22 };

/** Signed distance to an axis-aligned box (negative inside). */
function sdBox(x: number, z: number, cx: number, cz: number, hx: number, hz: number): number {
  const dx = Math.abs(x - cx) - hx;
  const dz = Math.abs(z - cz) - hz;
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
}

/** Signed distance to a rounded square outline centred at the origin. */
function sdRoundSquare(x: number, z: number, half: number, r: number): number {
  return sdBox(x, z, 0, 0, half - r, half - r) - r;
}

/** Transition-lane material for a point inside the lane. Boundaries are deliberately varied. */
function laneSegment(x: number, z: number): { layer: number; wet: number } {
  const n = noise2(x * 0.7, z * 0.7, 7) * 0.6;
  // Diagonal tarmac→mud edge: left wheels reach the mud before the right ones.
  const diag = -40 + 0.45 * x;
  if (z > -15 + n) return { layer: TARMAC, wet: 0 };
  if (z > -27 + n) return { layer: SAND, wet: 0 };
  if (z > diag + n * 0.3) return { layer: TARMAC, wet: 0 };
  if (z > -52 + n) return { layer: MUD, wet: 1 };
  if (z > -64 + n) return { layer: TARMAC, wet: 1 };
  if (z > -76 + n) return { layer: GRASS, wet: 1 };
  return { layer: TARMAC, wet: 0 };
}

export function generatePlayground(): Terrain {
  const P = PLAYGROUND;
  const t = new Terrain(P.size, P.res, P.defRes, P.waterLevel);
  const v = t.verts;
  const half = P.size / 2;
  const w = new Float32Array(LAYER_COUNT);

  for (let iz = 0; iz < v; iz++) {
    const z = -half + iz * t.cell;
    for (let ix = 0; ix < v; ix++) {
      const x = -half + ix * t.cell;
      const i = iz * v + ix;

      // ---------- Base landform ----------
      let h = 1.2 + fbm(x / 140, z / 140, 3, 1) * 2.2;
      const rough = fbm(x / 14, z / 14, 3, 2) * 0.22 + fbm(x / 3, z / 3, 2, 3) * 0.035;
      let wet = 0;
      let puddle = 0;
      w.fill(0);
      w[GRASS] = 1;

      // ---------- Hard surfaces (distance fields, negative inside) ----------
      const dLoop = Math.abs(sdRoundSquare(x, z, LOOP_HALF, LOOP_CORNER)) - ROAD_HALF_WIDTH;
      const dPad = sdBox(x, z, 0, 30, 35, 30);
      const dLane = sdBox(x, z, (LANE_X0 + LANE_X1) / 2, (LANE_Z0 + LANE_Z1) / 2, (LANE_X1 - LANE_X0) / 2, (LANE_Z1 - LANE_Z0) / 2);
      const dShoulderRoad = sdBox(x, z, (SHOULDER_X0 + SHOULDER_EDGE) / 2, (LANE_Z0 + LANE_Z1) / 2, (SHOULDER_EDGE - SHOULDER_X0) / 2, (LANE_Z1 - LANE_Z0) / 2);
      const dShoulder = sdBox(x, z, (SHOULDER_EDGE + SHOULDER_X1) / 2, (LANE_Z0 + LANE_Z1) / 2, (SHOULDER_X1 - SHOULDER_EDGE) / 2, (LANE_Z1 - LANE_Z0) / 2);
      const dSpur = sdBox(x, z, -42, 20, 8, 4);

      // Crumbly asphalt edge: +-8 cm of noise, ~12 cm blend.
      const edge = noise2(x * 2.3, z * 2.3, 11) * 0.08;
      const hardDist = Math.min(dLoop, dPad, dShoulderRoad, dSpur);
      let tarmac = 1 - smoothstep(-0.06, 0.06, hardDist + edge);
      let laneLayer = -1;
      if (dLane < 0) {
        const seg = laneSegment(x, z);
        laneLayer = seg.layer;
        wet = seg.wet;
        if (seg.layer === TARMAC) tarmac = Math.max(tarmac, 1 - smoothstep(-0.06, 0.06, dLane + edge));
      }

      // ---------- Soft regions ----------
      const sandD = Math.hypot(x - SAND_AREA.x, z - SAND_AREA.z) - SAND_AREA.r + fbm(x / 9, z / 9, 2, 4) * 6;
      const sand = 1 - smoothstep(-2, 1.5, sandD);
      const mudD = Math.hypot(x - MUD_PIT.x, z - MUD_PIT.z) - MUD_PIT.r + fbm(x / 7, z / 7, 2, 5) * 5;
      const mud = 1 - smoothstep(-1.5, 1.0, mudD);

      // Road shoulders: east = sand, north = wet mud, else grass.
      const shoulder = 1 - smoothstep(0, 2.5, dLoop + edge);
      if (shoulder > 0 && tarmac < 1) {
        if (x > LOOP_HALF - 12) w[SAND] += shoulder * 2;
        else if (z < -LOOP_HALF + 12) { w[MUD] += shoulder * 2; wet = Math.max(wet, shoulder * 0.8); }
      }
      w[SAND] += sand * 3;
      w[MUD] += mud * 3;

      if (laneLayer >= 0 && laneLayer !== TARMAC) {
        const laneSoft = 1 - smoothstep(-0.3, 0.3, dLane);
        w[laneLayer] += laneSoft * 10;
      }
      if (dShoulder < 0.5) {
        const sh = 1 - smoothstep(-0.2, 0.5, dShoulder);
        if (z > -45) w[SAND] += sh * 10;
        else { w[MUD] += sh * 10; wet = Math.max(wet, sh); }
      }

      // ---------- Height features ----------
      // Smooth landform under paved areas; full roughness off-road.
      const nearHard = smoothstep(0.5, 6, hardDist);
      h += rough * nearHard;

      // Dunes in the sand area (ridged noise), flattened toward the lake.
      const lakeD = Math.hypot(x - LAKE.x, z - LAKE.z);
      if (sand > 0) {
        const ridge = 1 - Math.abs(noise2(x / 16 + noise2(x / 30, z / 30, 9) * 0.6, z / 11, 8));
        const dune = ridge * ridge * 2.4 * smoothstep(LAKE.r + 4, LAKE.r + 18, lakeD);
        h += dune * sand * nearHard;
      }
      // Lake basin with a beach slope.
      if (lakeD < LAKE.r + 14) {
        const k = smoothstep(LAKE.r + 14, LAKE.r - 6, lakeD);
        h = h * (1 - k) + (P.waterLevel - 1.6) * k;
        w[SAND] += k * 6;
      }
      // Mud pit: shallow bowl, saturated centre, baked-in ruts from previous traffic.
      const pitD = Math.hypot(x - MUD_PIT.x, z - MUD_PIT.z);
      if (pitD < MUD_PIT.r + 4) {
        const bowl = smoothstep(MUD_PIT.r + 4, MUD_PIT.r * 0.3, pitD);
        h -= bowl * 0.45;
        wet = Math.max(wet, 1 - smoothstep(MUD_PIT.r * 0.45, MUD_PIT.r * 0.95, pitD));
        // Two rut pairs (1.3 m apart = 2106 track) curving through the pit.
        const zc = MUD_PIT.z + Math.sin((x - MUD_PIT.x) / 9) * 3;
        for (const off of [-0.66, 0.66, 5.34, 6.66]) {
          const d = Math.abs(z - zc - off);
          h -= (1 - smoothstep(0.05, 0.22, d)) * 0.09 * bowl;
        }
        // Puddles in the deepest part.
        const pn = fbm(x / 4, z / 4, 2, 13);
        if (pn > 0.15 && pitD < MUD_PIT.r * 0.7) puddle = Math.max(puddle, (pn - 0.15) * 0.12);
      }
      if (tarmac > 0) {
        // Paving covers whatever soft ground is underneath: soft weights share (1 - tarmac).
        let soft = 0;
        for (let l = 0; l < LAYER_COUNT; l++) if (l !== TARMAC) soft += w[l];
        for (let l = 0; l < LAYER_COUNT; l++) if (l !== TARMAC) w[l] *= (1 - tarmac) / soft;
        w[TARMAC] = tarmac;
        // Raised asphalt with a slight crown on the ring road.
        h += TARMAC_LIP * tarmac;
        if (dLoop < 0) h += Math.min(0.06, -dLoop * 0.02) * tarmac;
      }
      // Shoulder drop-off: soft shoulder sits 6 cm below the lane.
      if (dShoulder < 0) h -= 0.06 * (1 - smoothstep(-0.2, 0, dShoulder));

      // Speed bumps on the southern straight.
      if (z > LOOP_HALF - ROAD_HALF_WIDTH - 0.5 && z < LOOP_HALF + ROAD_HALF_WIDTH + 0.5) {
        for (const bx of [-25, 25]) {
          const d = Math.abs(x - bx);
          if (d < 0.5) h += 0.07 * Math.cos((d / 0.5) * (Math.PI / 2)) ** 2;
        }
      }

      // ---------- Wetness & puddles ----------
      // Skid pad east half wet, with an irregular drying line.
      if (dPad < 1) {
        const line = x + noise2(x * 0.4, z * 0.4, 14) * 0.8;
        wet = Math.max(wet, smoothstep(-0.4, 0.4, line) * (1 - smoothstep(0, 1, dPad)));
        for (const [px, pz, r] of [[12, 18, 3.2], [24, 44, 4.5], [8, 52, 2.4], [28, 12, 2.0]]) {
          const d = Math.hypot((x - px) * 1.3, z - pz) + noise2(x * 0.8, z * 0.8, 15) * 0.6;
          if (d < r) puddle = Math.max(puddle, 0.035 * Math.sqrt(1 - d / r));
        }
      }
      // Ring road: northern half wet with a drying gradient.
      if (dLoop < 2) {
        wet = Math.max(wet, 1 - smoothstep(-20, -5, -z + noise2(x * 0.1, z * 0.1, 16) * 6));
        // One-sided puddle (left wheel track only) and a full-width puddle.
        for (const [px, pz, r] of [[-30, -LOOP_HALF - 1.8, 2.6], [40, -LOOP_HALF, 4.2], [-LOOP_HALF, -40, 3]]) {
          const d = Math.hypot(x - px, (z - pz) * 1.4) + noise2(x, z, 17) * 0.4;
          if (d < r) puddle = Math.max(puddle, 0.04 * Math.sqrt(1 - d / r));
        }
      }
      // Lake beach: sand is wet up to ~0.5 m above the waterline.
      const aboveWater = h - P.waterLevel;
      if (lakeD < LAKE.r + 16) wet = Math.max(wet, 1 - smoothstep(0.1, 0.6, aboveWater));
      // Wet meadow south-west.
      const meadow = 1 - smoothstep(-3, 3, sdBox(x, z, -66, 70, 28, 18) + fbm(x / 8, z / 8, 2, 18) * 4);
      wet = Math.max(wet, meadow);

      // Only the lake basin may dip below the water level (the water plane is global).
      if (lakeD > LAKE.r + 10) h = Math.max(h, P.waterLevel + 0.35);
      // Puddles sit in slight depressions so the water surface is flat.
      h -= puddle * 0.8;

      t.height[i] = h;
      // Splat: normalise to bytes summing to 255.
      let sum = 0;
      for (let l = 0; l < LAYER_COUNT; l++) sum += w[l];
      let acc = 0, maxL = 0;
      for (let l = 0; l < LAYER_COUNT; l++) {
        const b = Math.round((w[l] / sum) * 255);
        t.splat[i * 4 + l] = b;
        acc += b;
        if (w[l] > w[maxL]) maxL = l;
      }
      t.splat[i * 4 + maxL] += 255 - acc;
      t.env[i * 4] = Math.round(clamp(wet, 0, 1) * 255);
      t.env[i * 4 + 1] = Math.round(clamp(puddle / WATER_SCALE, 0, 1) * 255);
    }
  }

  seedMudSpill(t);
  return t;
}

/** Mud tracked out of the pit onto the end of the tarmac spur (decays away from the pit). */
function seedMudSpill(t: Terrain): void {
  const n = t.defRes, c = t.defCell, half = t.size / 2;
  for (let tz = 0; tz < n; tz++) {
    const z = (tz + 0.5) * c - half;
    if (z < 15 || z > 25) continue;
    for (let tx = 0; tx < n; tx++) {
      const x = (tx + 0.5) * c - half;
      if (x < -52 || x > -36) continue;
      const fade = 1 - smoothstep(-50, -38, x);
      const streaks = 0.5 + 0.5 * noise2(x * 0.6, z * 3, 19);
      t.deform[(tz * n + tx) * 4 + 2] = Math.round(clamp(fade * streaks * 1.2, 0, 1) * 255);
    }
  }
}
