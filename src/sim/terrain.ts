import { clamp } from './math.ts';
import { noise2 } from './noise.ts';
import { LAYER_COUNT, SURFACE_LAYERS, type SurfaceSample } from './surfaces.ts';

/** Standing water depth encoded in env.G: depth = G / 255 * WATER_SCALE. */
export const WATER_SCALE = 0.08;
/** Rut depth encoded in deform.R: depth = R / 255 * RUT_SCALE. */
export const RUT_SCALE = 0.4;

export interface DirtyRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Per-layer softness capacity (max dig depth) blended dry→wet, precomputed for the hot path. */
const MAX_DEPTH_DRY = SURFACE_LAYERS.map((l) => l.dry.maxDepth);
const MAX_DEPTH_WET = SURFACE_LAYERS.map((l) => l.wet.maxDepth);
const ROUGH_DRY = SURFACE_LAYERS.map((l) => l.dry.roughness);
const ROUGH_WET = SURFACE_LAYERS.map((l) => l.wet.roughness);
const ROUGH_WAVE = SURFACE_LAYERS.map((l) => l.dry.roughnessWavelength);

/**
 * Heightfield terrain with a material splatmap, wetness/water map and a dynamic
 * deformation map (ruts, rubber, mud film). Layout is square and centred on the origin.
 *
 * Grids are row-major: index = iz * stride + ix, with x/z mapped from [-size/2, size/2].
 * Unity port: height -> TerrainData.SetHeights, splat -> alphamaps (4 TerrainLayers),
 * env/deform -> extra Texture2D sampled by the physics + terrain shader.
 */
export class Terrain {
  readonly verts: number;
  readonly cell: number;
  /** Base height (m), verts². */
  readonly height: Float32Array;
  /** RGBA8 layer weights (tarmac, sand, mud, grass), verts². */
  readonly splat: Uint8Array;
  /** RGBA8: R wetness, G standing water depth (WATER_SCALE), B/A reserved. verts². */
  readonly env: Uint8Array;

  readonly defCell: number;
  /** RGBA8 deformation: R rut depth (RUT_SCALE), G rubber marks, B mud film, A = 255. defRes². */
  readonly deform: Uint8Array;
  /** Texel region of `deform` modified since the renderer last consumed it. */
  dirty: DirtyRect | null = null;

  constructor(
    readonly size: number,
    readonly res: number,
    readonly defRes: number,
    /** Lake surface height; any ground below it is under deep water. */
    readonly waterLevel: number,
  ) {
    this.verts = res + 1;
    this.cell = size / res;
    this.height = new Float32Array(this.verts * this.verts);
    this.splat = new Uint8Array(this.verts * this.verts * 4);
    this.env = new Uint8Array(this.verts * this.verts * 4);
    this.defCell = size / defRes;
    this.deform = new Uint8Array(defRes * defRes * 4);
    for (let i = 3; i < this.deform.length; i += 4) this.deform[i] = 255;
  }

  /** Bilinear base height without ruts or micro roughness (rendering, camera, spawning). */
  baseHeight(x: number, z: number): number {
    const v = this.verts;
    const gx = clamp((x + this.size / 2) / this.cell, 0, this.res - 1e-6);
    const gz = clamp((z + this.size / 2) / this.cell, 0, this.res - 1e-6);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const i = iz * v + ix;
    const h = this.height;
    return (h[i] * (1 - fx) + h[i + 1] * fx) * (1 - fz) + (h[i + v] * (1 - fx) + h[i + v + 1] * fx) * fz;
  }

  /** Bilinear rut depth (m) from the deformation map. */
  rutDepth(x: number, z: number): number {
    const n = this.defRes;
    const gx = clamp((x + this.size / 2) / this.defCell - 0.5, 0, n - 1 - 1e-6);
    const gz = clamp((z + this.size / 2) / this.defCell - 0.5, 0, n - 1 - 1e-6);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const i = (iz * n + ix) * 4;
    const d = this.deform, row = n * 4;
    const r = (d[i] * (1 - fx) + d[i + 4] * fx) * (1 - fz) + (d[i + row] * (1 - fx) + d[i + row + 4] * fx) * fz;
    return (r / 255) * RUT_SCALE;
  }

  /**
   * Full physics query: fills `out` with blended surface data and returns the effective
   * ground height (base - rut + material micro-roughness).
   */
  sample(x: number, z: number, out: SurfaceSample): number {
    const v = this.verts;
    const gx = clamp((x + this.size / 2) / this.cell, 0, this.res - 1e-6);
    const gz = clamp((z + this.size / 2) / this.cell, 0, this.res - 1e-6);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    const i00 = iz * v + ix, i10 = i00 + 1, i01 = i00 + v, i11 = i01 + 1;

    const h = this.height;
    const base = h[i00] * w00 + h[i10] * w10 + h[i01] * w01 + h[i11] * w11;

    const s = this.splat, e = this.env;
    let sum = 0;
    for (let l = 0; l < LAYER_COUNT; l++) {
      const w = s[i00 * 4 + l] * w00 + s[i10 * 4 + l] * w10 + s[i01 * 4 + l] * w01 + s[i11 * 4 + l] * w11;
      out.weights[l] = w;
      sum += w;
    }
    for (let l = 0; l < LAYER_COUNT; l++) out.weights[l] /= sum;
    out.wetness = (e[i00 * 4] * w00 + e[i10 * 4] * w10 + e[i01 * 4] * w01 + e[i11 * 4] * w11) / 255;
    const puddle = ((e[i00 * 4 + 1] * w00 + e[i10 * 4 + 1] * w10 + e[i01 * 4 + 1] * w01 + e[i11 * 4 + 1] * w11) / 255) * WATER_SCALE;
    out.water = Math.max(puddle, this.waterLevel - base);

    // Deformation map (nearest texel is enough for films; ruts use bilinear for smooth contact).
    const n = this.defRes;
    const dx = clamp(Math.floor((x + this.size / 2) / this.defCell), 0, n - 1);
    const dz = clamp(Math.floor((z + this.size / 2) / this.defCell), 0, n - 1);
    out.mudFilm = this.deform[(dz * n + dx) * 4 + 2] / 255;

    let rough = 0;
    for (let l = 0; l < LAYER_COUNT; l++) {
      const w = out.weights[l];
      if (w < 0.01) continue;
      const amp = ROUGH_DRY[l] + (ROUGH_WET[l] - ROUGH_DRY[l]) * out.wetness;
      const k = 1 / ROUGH_WAVE[l];
      rough += w * amp * noise2(x * k, z * k, 101 + l);
    }
    out.rut = this.rutDepth(x, z);
    return base - out.rut + rough;
  }

  /** Soft-ground capacity (max dig depth, m) from already-sampled weights. */
  static softCapacity(sample: SurfaceSample): number {
    let c = 0;
    for (let l = 0; l < LAYER_COUNT; l++) {
      c += sample.weights[l] * (MAX_DEPTH_DRY[l] + (MAX_DEPTH_WET[l] - MAX_DEPTH_DRY[l]) * sample.wetness);
    }
    return c;
  }

  /** Soft-ground capacity at a deformation texel (uses nearest height-grid vertex). */
  private texelCapacity(tx: number, tz: number): number {
    const ix = Math.round(((tx + 0.5) * this.defCell) / this.cell);
    const iz = Math.round(((tz + 0.5) * this.defCell) / this.cell);
    const i = (Math.min(iz, this.res) * this.verts + Math.min(ix, this.res)) * 4;
    const wet = this.env[i] / 255;
    let c = 0, sum = 0;
    for (let l = 0; l < LAYER_COUNT; l++) {
      const w = this.splat[i + l];
      sum += w;
      c += w * (MAX_DEPTH_DRY[l] + (MAX_DEPTH_WET[l] - MAX_DEPTH_DRY[l]) * wet);
    }
    return c / sum;
  }

  /**
   * Stamp a tire footprint (oriented rectangle) into the deformation map.
   * Ruts only deepen (soil stays compacted) and never exceed local soft capacity,
   * so a rut written across a tarmac edge stops exactly at the edge.
   */
  stampFootprint(
    x: number, z: number, dirX: number, dirZ: number, halfLength: number, halfWidth: number,
    rut: number, rubber: number, mud: number,
  ): void {
    const n = this.defRes, c = this.defCell, half = this.size / 2;
    const ext = Math.max(halfLength, halfWidth) + c;
    const tx0 = clamp(Math.floor((x - ext + half) / c), 0, n - 1);
    const tx1 = clamp(Math.floor((x + ext + half) / c), 0, n - 1);
    const tz0 = clamp(Math.floor((z - ext + half) / c), 0, n - 1);
    const tz1 = clamp(Math.floor((z + ext + half) / c), 0, n - 1);
    const rutByte = (rut / RUT_SCALE) * 255;
    let touched = false;
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const px = (tx + 0.5) * c - half - x;
        const pz = (tz + 0.5) * c - half - z;
        const along = px * dirX + pz * dirZ;
        const across = -px * dirZ + pz * dirX;
        if (Math.abs(along) > halfLength || Math.abs(across) > halfWidth) continue;
        const i = (tz * n + tx) * 4;
        const d = this.deform;
        if (rutByte > d[i]) {
          const cap = (this.texelCapacity(tx, tz) / RUT_SCALE) * 255;
          const target = Math.min(rutByte, cap);
          if (target > d[i] + 0.5) { d[i] = target; touched = true; }
        }
        if (rubber > 0 && d[i + 1] < 255) { d[i + 1] = Math.min(255, d[i + 1] + rubber * 255 + 0.5); touched = true; }
        if (mud > 0 && d[i + 2] < 255) { d[i + 2] = Math.min(255, d[i + 2] + mud * 255 + 0.5); touched = true; }
      }
    }
    if (!touched) return;
    const r = this.dirty;
    if (r === null) this.dirty = { x0: tx0, z0: tz0, x1: tx1, z1: tz1 };
    else {
      r.x0 = Math.min(r.x0, tx0); r.z0 = Math.min(r.z0, tz0);
      r.x1 = Math.max(r.x1, tx1); r.z1 = Math.max(r.z1, tz1);
    }
  }
}
