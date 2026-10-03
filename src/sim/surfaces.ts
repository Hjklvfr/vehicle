import { lerp } from './math.ts';

/**
 * Surface material database.
 *
 * The world stores, per terrain cell, weights of LAYERS (a splatmap, same concept as
 * Unity TerrainLayers/alphamaps) plus a wetness value and a standing-water depth.
 * Each layer has a dry and a wet parameter set; the tire contact patch blends them.
 */

export const LAYERS = ['tarmac', 'sand', 'mud', 'grass'] as const;
export type LayerName = (typeof LAYERS)[number];
export const LAYER_COUNT = LAYERS.length;
export const TARMAC = 0, SAND = 1, MUD = 2, GRASS = 3;

export interface SurfaceParams {
  /** Peak friction coefficient against the reference tire at reference load. */
  mu: number;
  /** Friction remaining at full slide as a fraction of peak (shape of the force curve past the peak). */
  slideRatio: number;
  /** Friction loss per m/s of sliding speed (wet tarmac loses grip with speed; soft soils don't). */
  speedSensitivity: number;
  /** Scales tire slip stiffness: deformable ground shears before the tread does, so the curve is wider. */
  stiffnessScale: number;
  /** Rolling resistance coefficient (moment arm / radius). */
  rollingResistance: number;
  /** Equilibrium sinkage (m) under the reference wheel load when rolling freely. */
  sinkage: number;
  /** Extra sinkage (m) per metre of slip distance — spinning wheels dig. */
  digRate: number;
  /** Max depth (m) the wheel can dig to. */
  maxDepth: number;
  /** Compaction/bulldozing resistance (N per N of load per m of fresh sinkage). */
  bulldozing: number;
  /** Multiplier on tire relaxation lengths (soft ground delays force build-up). */
  relaxationScale: number;
  /** Micro roughness amplitude (m) and wavelength (m), sampled as height noise. */
  roughness: number;
  roughnessWavelength: number;
  /** How quickly the surface coats the tread (per metre rolled); mud = high. */
  coating: number;
  /** 1 = rigid paved surface, 0 = loose. Controls how much tread contamination hurts grip. */
  hardness: number;
}

/** Field list shared by blending and lerp so new params can't be silently skipped. */
const FIELDS: (keyof SurfaceParams)[] = [
  'mu', 'slideRatio', 'speedSensitivity', 'stiffnessScale', 'rollingResistance', 'sinkage', 'digRate',
  'maxDepth', 'bulldozing', 'relaxationScale', 'roughness', 'roughnessWavelength', 'coating', 'hardness',
];

export interface LayerDef {
  name: LayerName;
  dry: SurfaceParams;
  wet: SurfaceParams;
}

/**
 * Values are engineering estimates for a 165/80 R13 tire (VAZ-2106 stock size),
 * cross-checked against published ranges: dry asphalt mu 0.9–1.0, wet 0.5–0.7,
 * loose sand 0.5–0.6 with flat post-peak curve, wet clay mud 0.25–0.4,
 * rolling resistance 0.010–0.015 paved, 0.04–0.3 on soft soils.
 */
export const SURFACE_LAYERS: LayerDef[] = [
  {
    name: 'tarmac',
    dry: {
      mu: 0.9, slideRatio: 0.75, speedSensitivity: 0.002, stiffnessScale: 1.0, rollingResistance: 0.012,
      sinkage: 0, digRate: 0, maxDepth: 0, bulldozing: 0, relaxationScale: 1.0,
      roughness: 0.0015, roughnessWavelength: 0.9, coating: 0, hardness: 1,
    },
    wet: {
      mu: 0.65, slideRatio: 0.62, speedSensitivity: 0.008, stiffnessScale: 0.95, rollingResistance: 0.014,
      sinkage: 0, digRate: 0, maxDepth: 0, bulldozing: 0, relaxationScale: 1.0,
      roughness: 0.0015, roughnessWavelength: 0.9, coating: 0, hardness: 1,
    },
  },
  {
    name: 'sand',
    dry: {
      mu: 0.6, slideRatio: 0.96, speedSensitivity: 0, stiffnessScale: 0.35, rollingResistance: 0.05,
      sinkage: 0.055, digRate: 0.045, maxDepth: 0.22, bulldozing: 2.0, relaxationScale: 1.8,
      roughness: 0.012, roughnessWavelength: 1.4, coating: 0.002, hardness: 0,
    },
    wet: {
      // Damp/packed sand near water is firmer than dry sand.
      mu: 0.68, slideRatio: 0.9, speedSensitivity: 0.001, stiffnessScale: 0.55, rollingResistance: 0.03,
      sinkage: 0.025, digRate: 0.025, maxDepth: 0.12, bulldozing: 1.4, relaxationScale: 1.4,
      roughness: 0.006, roughnessWavelength: 1.1, coating: 0.01, hardness: 0.2,
    },
  },
  {
    name: 'mud',
    dry: {
      // Drying clay: crusty, decent grip, moderate sinkage.
      mu: 0.55, slideRatio: 0.8, speedSensitivity: 0.002, stiffnessScale: 0.5, rollingResistance: 0.04,
      sinkage: 0.03, digRate: 0.03, maxDepth: 0.12, bulldozing: 1.5, relaxationScale: 1.4,
      roughness: 0.02, roughnessWavelength: 0.8, coating: 0.04, hardness: 0.2,
    },
    wet: {
      // Saturated clay slurry: very low grip, deep ruts, sticky.
      mu: 0.32, slideRatio: 0.8, speedSensitivity: 0.004, stiffnessScale: 0.4, rollingResistance: 0.06,
      sinkage: 0.07, digRate: 0.05, maxDepth: 0.26, bulldozing: 1.8, relaxationScale: 1.6,
      roughness: 0.025, roughnessWavelength: 0.7, coating: 0.12, hardness: 0,
    },
  },
  {
    name: 'grass',
    dry: {
      mu: 0.58, slideRatio: 0.75, speedSensitivity: 0.003, stiffnessScale: 0.6, rollingResistance: 0.035,
      sinkage: 0.012, digRate: 0.015, maxDepth: 0.06, bulldozing: 1.0, relaxationScale: 1.2,
      roughness: 0.02, roughnessWavelength: 2.5, coating: 0.004, hardness: 0.4,
    },
    wet: {
      // Wet grass is notoriously slippery: leaves + water film over soil.
      mu: 0.32, slideRatio: 0.62, speedSensitivity: 0.006, stiffnessScale: 0.55, rollingResistance: 0.045,
      sinkage: 0.03, digRate: 0.04, maxDepth: 0.12, bulldozing: 1.4, relaxationScale: 1.3,
      roughness: 0.02, roughnessWavelength: 2.5, coating: 0.01, hardness: 0.3,
    },
  },
];

export function createSurfaceParams(): SurfaceParams {
  return {
    mu: 0, slideRatio: 0, speedSensitivity: 0, stiffnessScale: 0, rollingResistance: 0, sinkage: 0,
    digRate: 0, maxDepth: 0, bulldozing: 0, relaxationScale: 0, roughness: 0, roughnessWavelength: 0,
    coating: 0, hardness: 0,
  };
}

/** Raw per-point terrain data (output of Terrain.sample). */
export interface SurfaceSample {
  weights: Float32Array; // LAYER_COUNT, sums to 1
  wetness: number; // 0..1
  water: number; // standing water depth (m)
  mudFilm: number; // 0..1 mud deposited on top of the surface by tires
  rut: number; // existing rut depth (m), already subtracted from the returned height
}

export function createSurfaceSample(): SurfaceSample {
  return { weights: new Float32Array(LAYER_COUNT), wetness: 0, water: 0, mudFilm: 0, rut: 0 };
}
/**
 * Accumulate `weight` * (layer params at this wetness) into `out`.
 * The contact patch calls this for every sample point, so a tire straddling a
 * boundary gets an area-weighted blend instead of a binary switch.
 */
export function accumulateSurface(sample: SurfaceSample, weight: number, out: SurfaceParams): void {
  const wet = sample.wetness;
  for (let l = 0; l < LAYER_COUNT; l++) {
    const w = sample.weights[l] * weight;
    if (w <= 0) continue;
    const { dry, wet: wetP } = SURFACE_LAYERS[l];
    for (const f of FIELDS) out[f] += w * lerp(dry[f], wetP[f], wet);
  }
}

export function resetSurfaceParams(out: SurfaceParams): void {
  for (const f of FIELDS) out[f] = 0;
}
