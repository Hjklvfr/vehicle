import * as THREE from 'three';
import { RUT_SCALE, WATER_SCALE, type Terrain } from '../sim/terrain.ts';

/**
 * Renders a sim `Terrain`: chunked LOD heightfield whose vertices are displaced on the GPU
 * from an exact float height texture (plus rut depth), a splat-blended procedural
 * MeshStandardMaterial with wetness/puddles/deformation, and a lake water plane.
 *
 * The root `object` must stay at the identity transform: the shaders derive grid indices
 * from world-space XZ.
 *
 * Unity port: height texture -> TerrainData heights, layer arrays -> TerrainLayers,
 * the fragment block below -> a custom terrain shader sampling env/deform textures.
 */

/** Procedural layer texture resolution (texels per tile). */
const LAYER_TEX = 512;
/** World tile size (m) of each layer texture: tarmac, sand, mud, grass. */
const LAYER_TILE = [2.5, 3.0, 3.0, 2.5] as const;
/** Encoded range of layer height gradients (m/m) stored in the RG channels of layer B. */
const LAYER_GRAD_RANGE = 1.5;
/** How far skirt vertices drop below the surface to hide LOD cracks (m). */
const SKIRT_DEPTH = 0.6;
/** LOD vertex steps (in height-grid cells). */
const LOD_STEPS = [1, 2, 4];

// ---------------------------------------------------------------------------
// Tileable procedural noise (one-time texture generation)
// ---------------------------------------------------------------------------

function hashU(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function wrap(i: number, p: number): number {
  return ((i % p) + p) % p;
}

/** Periodic value noise in [0,1]; (x, y) in lattice units, periods px/py lattice cells. */
function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = wrap(ix, px), x1 = wrap(ix + 1, px), y0 = wrap(iy, py), y1 = wrap(iy + 1, py);
  const a = hashU(x0, y0, seed), b = hashU(x1, y0, seed), c = hashU(x0, y1, seed), d = hashU(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Periodic fBm in [0,1] over tile coords (u, v) in [0,1). */
function fbm(u: number, v: number, period: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(u * p, v * p, p, p, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

let wF1 = 0, wF2 = 0, wId = 0;
/** Periodic Worley noise; results in wF1/wF2 (cell units) and wId (cell hash in [0,1)). */
function worley(u: number, v: number, period: number, seed: number): void {
  const x = u * period, y = v * period;
  const ix = Math.floor(x), iy = Math.floor(y);
  wF1 = 9; wF2 = 9; wId = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const hx = wrap(cx, period), hy = wrap(cy, period);
      const px = cx + hashU(hx, hy, seed), py = cy + hashU(hx, hy, seed + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < wF1) { wF2 = wF1; wF1 = d; wId = hashU(hx, hy, seed + 2); }
      else if (d < wF2) wF2 = d;
    }
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Per-texel output of a layer generator: sRGB albedo, height (m), roughness. */
interface LayerTexel { r: number; g: number; b: number; h: number; rough: number }
type LayerGen = (u: number, v: number, px: number, py: number, out: LayerTexel) => void;

/** Dark grey asphalt: aged binder with packed light/dark aggregate and stains. */
const genTarmac: LayerGen = (u, v, px, py, o) => {
  worley(u, v, 170, 11);
  const stone = smoothstep(0.46, 0.3, wF1);
  const stoneShade = 0.3 + 0.2 * wId;
  const warm = wId > 0.8 ? 0.04 : 0;
  worley(u, v, 420, 14);
  const fine = smoothstep(0.4, 0.2, wF1) * (wId - 0.5);
  const binder = 0.23 + 0.04 * vnoise(u * 256, v * 256, 256, 256, 12) + 0.06 * fine;
  const stain = fbm(u, v, 4, 4, 13);
  const g = (binder + (stoneShade - binder) * stone) * (0.84 + 0.26 * stain) + 0.012 * (hashU(px, py, 15) - 0.5);
  o.r = g + warm; o.g = g + warm * 0.6; o.b = g * 1.02;
  o.h = stone * 0.0012 + fine * 0.0005 + 0.0005 * stain;
  o.rough = 0.9 - 0.1 * stone;
};

/** Warm beige sand with wind ripples and grain speckle. */
const genSand: LayerGen = (u, v, px, py, o) => {
  const warp = fbm(u, v, 3, 4, 21) * 2.2 + fbm(u, v, 6, 3, 22) * 0.6;
  const phase = 2 * Math.PI * (24 * v + 5 * u + warp);
  const rip = Math.pow(0.5 + 0.5 * Math.sin(phase), 1.6);
  const ampMask = 0.25 + 0.75 * smoothstep(0.3, 0.7, fbm(u, v, 2, 3, 25));
  const coarse = fbm(u, v, 8, 4, 24);
  const grain = hashU(px, py, 23);
  let k = (0.88 + 0.14 * rip * ampMask) * (0.88 + 0.22 * coarse) * (0.93 + 0.14 * grain);
  if (grain > 0.975) k *= 0.6;
  o.r = 0.78 * k; o.g = 0.68 * k; o.b = 0.51 * k;
  o.h = rip * ampMask * 0.008 + coarse * 0.004 + grain * 0.0004;
  o.rough = 0.95 - 0.04 * rip;
};

/** Brown clay mud: irregular lumps and tyre-smeared slick patches, a few pebbles. */
const genMud: LayerGen = (u, v, px, py, o) => {
  const big = fbm(u, v, 4, 5, 32);
  const lumps = 1 - Math.abs(2 * fbm(u, v, 20, 4, 31) - 1);
  const fine = fbm(u, v, 64, 3, 33);
  const slick = smoothstep(0.52, 0.68, fbm(u, v, 3, 4, 37));
  const relief = 1 - 0.8 * slick;
  worley(u, v, 90, 34);
  const pebble = wId > 0.9 ? smoothstep(0.22, 0.12, wF1) * relief : 0;
  const k = (0.72 + 0.4 * big) * (0.86 + 0.18 * lumps * relief) * (0.95 + 0.1 * fine) * (1 - 0.12 * slick)
    + 0.02 * (hashU(px, py, 35) - 0.5);
  o.r = 0.43 * k; o.g = 0.32 * k; o.b = 0.22 * k;
  o.r += (0.5 - o.r) * pebble; o.g += (0.46 - o.g) * pebble; o.b += (0.4 - o.b) * pebble;
  o.h = 0.012 * big + relief * (0.005 * lumps + 0.0015 * fine) + 0.003 * pebble;
  o.rough = 0.88 - 0.25 * slick;
};

/** Green-brown grass: blade noise, dry patches, bare dirt spots. */
const genGrass: LayerGen = (u, v, px, py, o) => {
  const dry = fbm(u, v, 3, 4, 41);
  const dirt = smoothstep(0.6, 0.74, fbm(u, v, 5, 4, 42));
  const b1 = vnoise(u * 420, v * 70, 420, 70, 44);
  const b2 = vnoise(u * 70, v * 420, 70, 420, 45);
  const b3 = vnoise(u * 300, v * 300, 300, 300, 46);
  const blade = Math.max(b1, b2) * 0.65 + b3 * 0.35;
  const clumps = fbm(u, v, 32, 3, 43);
  const speck = hashU(px, py, 47);
  const dk = Math.pow(dry, 1.5) * 0.85;
  const shade = (0.55 + 0.65 * blade) * (0.85 + 0.3 * clumps);
  let r = (0.27 + (0.58 - 0.27) * dk) * shade;
  let g = (0.4 + (0.52 - 0.4) * dk) * shade;
  let b = (0.13 + (0.3 - 0.13) * dk) * shade;
  const dirtK = dirt * (1 - 0.5 * blade) * (0.85 + 0.3 * speck);
  r += (0.37 - r) * dirtK; g += (0.29 - g) * dirtK; b += (0.2 - b) * dirtK;
  o.r = r; o.g = g; o.b = b;
  o.h = 0.015 * blade * (1 - dirt) + 0.006 * clumps;
  o.rough = 0.95;
};

const LAYER_GENS: LayerGen[] = [genTarmac, genSand, genMud, genGrass];
/** Baked cavity strength per layer (darkens low texels). */
const LAYER_AO = [0.25, 0.15, 0.35, 0.4];

/**
 * Builds two RGBA8 texture arrays (one slice per layer):
 * A = sRGB albedo + normalized height, B = height gradient (RG) + roughness (B).
 */
function buildLayerTextures(): { a: Uint8Array; b: Uint8Array } {
  const n = LAYER_TEX, px = n * n;
  const a = new Uint8Array(px * 4 * LAYER_GENS.length);
  const b = new Uint8Array(px * 4 * LAYER_GENS.length);
  const col = new Float32Array(px * 3);
  const hgt = new Float32Array(px);
  const rough = new Float32Array(px);
  const t: LayerTexel = { r: 0, g: 0, b: 0, h: 0, rough: 0 };
  for (let l = 0; l < LAYER_GENS.length; l++) {
    const gen = LAYER_GENS[l];
    let hMin = Infinity, hMax = -Infinity;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        gen((x + 0.5) / n, (y + 0.5) / n, x, y, t);
        const i = y * n + x;
        col[i * 3] = t.r; col[i * 3 + 1] = t.g; col[i * 3 + 2] = t.b;
        hgt[i] = t.h; rough[i] = t.rough;
        if (t.h < hMin) hMin = t.h;
        if (t.h > hMax) hMax = t.h;
      }
    }
    const hSpan = Math.max(hMax - hMin, 1e-6);
    const texel = LAYER_TILE[l] / n;
    const base = l * px * 4;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x, o = base + i * 4;
        const hn = (hgt[i] - hMin) / hSpan;
        const ao = 1 - LAYER_AO[l] * (1 - Math.sqrt(hn));
        a[o] = Math.round(Math.min(1, col[i * 3] * ao) * 255);
        a[o + 1] = Math.round(Math.min(1, col[i * 3 + 1] * ao) * 255);
        a[o + 2] = Math.round(Math.min(1, col[i * 3 + 2] * ao) * 255);
        a[o + 3] = Math.round(hn * 255);
        const gx = (hgt[y * n + wrap(x + 1, n)] - hgt[y * n + wrap(x - 1, n)]) / (2 * texel);
        const gz = (hgt[wrap(y + 1, n) * n + x] - hgt[wrap(y - 1, n) * n + x]) / (2 * texel);
        b[o] = Math.round((Math.max(-1, Math.min(1, gx / LAYER_GRAD_RANGE)) * 0.5 + 0.5) * 255);
        b[o + 1] = Math.round((Math.max(-1, Math.min(1, gz / LAYER_GRAD_RANGE)) * 0.5 + 0.5) * 255);
        b[o + 2] = Math.round(Math.min(1, rough[i]) * 255);
        b[o + 3] = 255;
      }
    }
  }
  return { a, b };
}

/** Tileable small-ripple normal map for the lake surface. */
function buildWaterNormals(n: number): Uint8Array {
  const data = new Uint8Array(n * n * 4);
  const h = new Float32Array(n * n);
  const waves: [number, number, number, number][] = [
    [3, 1, 0.5, 0.0], [-2, 3, 0.4, 1.3], [5, -4, 0.25, 2.1], [-7, -2, 0.2, 0.7], [1, 8, 0.15, 4.0],
  ];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let s = 0.35 * fbm(u, v, 16, 3, 71);
      for (const [kx, ky, amp, ph] of waves) s += amp * Math.sin(2 * Math.PI * (kx * u + ky * v) + ph) * 0.1;
      h[y * n + x] = s;
    }
  }
  const k = 6;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (h[y * n + wrap(x + 1, n)] - h[y * n + wrap(x - 1, n)]) * k;
      const dy = (h[wrap(y + 1, n) * n + x] - h[wrap(y - 1, n) * n + x]) * k;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * n + x) * 4;
      data[o] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Chunk geometry
// ---------------------------------------------------------------------------

/**
 * Shared grid for one LOD level: (n+1)² surface vertices with spacing `spacing` plus outward
 * skirts on all four edges. position.y = 0 on the surface, 1 on skirt vertices (the shader
 * drops those by SKIRT_DEPTH); actual heights come from the height texture.
 */
function buildGridLevel(n: number, spacing: number): { position: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  const side = n + 1;
  const surface = side * side;
  const pos = new Float32Array((surface + 4 * side) * 3);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const o = (j * side + i) * 3;
      pos[o] = i * spacing; pos[o + 1] = 0; pos[o + 2] = j * spacing;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i, b = a + side, c = a + 1, d = b + 1;
      idx.push(a, b, c, c, b, d);
    }
  }
  // Edges walked so that the skirt faces outward (outward = Y × walk direction).
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k < side; k++) {
    edges[0].push(k); // z = 0, +X
    edges[1].push(k * side + n); // x = max, +Z
    edges[2].push(n * side + (n - k)); // z = max, -X
    edges[3].push((n - k) * side); // x = 0, -Z
  }
  let next = surface;
  for (const edge of edges) {
    const first = next;
    for (const e of edge) {
      pos[next * 3] = pos[e * 3]; pos[next * 3 + 1] = 1; pos[next * 3 + 2] = pos[e * 3 + 2];
      next++;
    }
    for (let k = 0; k < n; k++) {
      const e0 = edge[k], e1 = edge[k + 1], s0 = first + k, s1 = first + k + 1;
      idx.push(e0, e1, s0, e1, s1, s0);
    }
  }
  const index = next > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  return { position: new THREE.BufferAttribute(pos, 3), index: new THREE.BufferAttribute(index, 1) };
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT_PARS = /* glsl */ `
uniform highp sampler2D tHeight;
uniform sampler2D tGrad;
uniform sampler2D tDeform;
uniform vec4 uTerr; // size, cell, verts, defRes
uniform float uRutScale;
uniform float uSkirt;
vec2 tWorldXZ() { return (modelMatrix * vec4(position.x, 0.0, position.z, 1.0)).xz; }
vec2 tGridUv(vec2 w) { return ((w + 0.5 * uTerr.x) / uTerr.y + 0.5) / uTerr.z; }
float tSurfaceHeight(vec2 w) {
  ivec2 g = clamp(ivec2(floor((w + 0.5 * uTerr.x) / uTerr.y + 0.5)), ivec2(0), ivec2(int(uTerr.z) - 1));
  float h = texelFetch(tHeight, g, 0).r;
  float rut = textureLod(tDeform, (w + 0.5 * uTerr.x) / uTerr.x, 0.0).r * uRutScale;
  return h - rut;
}
`;

const VERT_BEGIN = /* glsl */ `
vec3 transformed = vec3(position.x, tSurfaceHeight(tWXZ) - position.y * uSkirt - modelMatrix[3].y, position.z);
`;

const VERT_NORMAL = /* glsl */ `
vec2 tWXZ = tWorldXZ();
vec2 tGv = textureLod(tGrad, tGridUv(tWXZ), 0.0).rg;
vec3 objectNormal = normalize(vec3(-tGv.x, 1.0, -tGv.y));
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D tSplat;
uniform sampler2D tEnv;
uniform sampler2D tDeform;
uniform sampler2D tGrad;
uniform highp sampler2DArray tLayerA;
uniform highp sampler2DArray tLayerB;
uniform vec4 uTerr; // size, cell, verts, defRes
uniform vec4 uTile;
uniform float uRutScale;
uniform float uWaterScale;
uniform float uGradRange;
varying vec3 vTWorld;
vec3 tNormalW;
vec3 tMacroNormalW;
float tRoughOut;

float tHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const FRAG_MAIN = /* glsl */ `
{
  vec2 tW = vTWorld.xz;
  vec2 tDx = dFdx(tW), tDy = dFdy(tW);
  float tHalf = 0.5 * uTerr.x;
  vec2 tGUv = ((tW + tHalf) / uTerr.y + 0.5) / uTerr.z;

  vec4 tSp = texture(tSplat, tGUv);
  tSp /= max(dot(tSp, vec4(1.0)), 1e-4);
  vec4 tEnvS = texture(tEnv, tGUv);
  float tWet = tEnvS.r;
  float tPud = tEnvS.g * uWaterScale;

  // Deformation: rut depth + gradient (central differences at full texel resolution).
  vec2 tDUv = (tW + tHalf) / uTerr.x;
  float tDt = 1.0 / uTerr.w;
  vec4 tDef = texture(tDeform, tDUv);
  float tRL = texture(tDeform, tDUv - vec2(tDt, 0.0)).r;
  float tRR = texture(tDeform, tDUv + vec2(tDt, 0.0)).r;
  float tRD = texture(tDeform, tDUv - vec2(0.0, tDt)).r;
  float tRU = texture(tDeform, tDUv + vec2(0.0, tDt)).r;
  vec2 tRutGrad = vec2(tRR - tRL, tRU - tRD) * uRutScale / (2.0 * tDt * uTerr.x);
  float tRut = tDef.r * uRutScale;

  // Mud film acts as an extra mud layer on top of whatever is below, broken up by noise.
  float tFilm = clamp(tDef.b * 1.3 - 0.1 + (tNoise(tW * 7.0) - 0.5) * 0.45, 0.0, 1.0);
  tFilm = tFilm < 0.004 ? 0.0 : tFilm;

  // Anti-tiling: two offset lookups per layer, switched by a world-space noise index.
  float tK = tNoise(tW * 0.55) * 0.7 + tNoise(tW * 1.9) * 0.3;
  float tL = tK * 8.0;
  float tIa = floor(tL);
  float tF = fract(tL);
  vec2 tOffA = sin(vec2(3.0, 7.0) * tIa);
  vec2 tOffB = sin(vec2(3.0, 7.0) * (tIa + 1.0));

  vec4 tA[4];
  float tT[4];
  vec4 tH = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    tA[i] = vec4(0.0);
    tT[i] = 0.0;
    if (tSp[i] > 0.004 || (i == 2 && tFilm > 0.0)) {
      float tInv = 1.0 / uTile[i];
      vec2 tUv = tW * tInv;
      vec3 tCa = vec3(tUv + tOffA, float(i));
      vec3 tCb = vec3(tUv + tOffB, float(i));
      vec4 a = textureGrad(tLayerA, tCa, tDx * tInv, tDy * tInv);
      vec4 b = textureGrad(tLayerA, tCb, tDx * tInv, tDy * tInv);
      tT[i] = smoothstep(0.2, 0.8, tF - 0.1 * dot(a.rgb - b.rgb, vec3(1.0)));
      tA[i] = mix(a, b, tT[i]);
      tH[i] = tA[i].a;
    }
  }

  // Height-based splat sharpening with noise so boundaries interlock instead of smearing.
  float tN1 = tNoise(tW * 1.3), tN2 = tNoise(tW * 1.3 + 17.0);
  vec4 tHb = tSp + (tH * 0.5 + vec4(tN1, 1.0 - tN1, tN2, 1.0 - tN2) * 0.25) * min(tSp * 8.0, 1.0);
  float tMax = max(max(tHb.x, tHb.y), max(tHb.z, tHb.w));
  vec4 tB = max(tHb - (tMax - 0.2), 0.0);
  tB /= max(dot(tB, vec4(1.0)), 1e-5);
  tB = mix(tB, vec4(0.0, 0.0, 1.0, 0.0), tFilm * 0.9);

  vec3 tAlb = vec3(0.0);
  vec2 tDG = vec2(0.0);
  float tRgh = 0.0;
  for (int i = 0; i < 4; i++) {
    if (tB[i] > 0.001) {
      float tInv = 1.0 / uTile[i];
      vec2 tUv = tW * tInv;
      vec4 a = textureGrad(tLayerB, vec3(tUv + tOffA, float(i)), tDx * tInv, tDy * tInv);
      vec4 b = textureGrad(tLayerB, vec3(tUv + tOffB, float(i)), tDx * tInv, tDy * tInv);
      vec4 s = mix(a, b, tT[i]);
      tAlb += tA[i].rgb * tB[i];
      tDG += (s.rg * 2.0 - 1.0) * uGradRange * tB[i];
      tRgh += s.b * tB[i];
    }
  }
  float tHloc = dot(tB, tH);

  // Large-scale albedo variation.
  float tMac = tNoise(tW * 0.045) * 0.6 + tNoise(tW * 0.17) * 0.4;
  tAlb *= 0.84 + 0.32 * tMac;

  // Wetness: porous layers darken more; water settles in texture lows first.
  float tWetL = clamp(tWet * 1.25 - (tHloc - 0.5) * 0.35 * tWet, 0.0, 1.0);
  float tPorosity = dot(tB, vec4(0.35, 0.45, 0.42, 0.4));
  tAlb *= 1.0 - tPorosity * tWetL;
  // Wet asphalt is glossy but not a mirror (film is thinner than the aggregate texture);
  // only texture lows hold enough water to sharpen reflections.
  float tRghWet = dot(tB, vec4(0.32, 0.55, 0.3, 0.65));
  tRghWet = mix(tRghWet, tRghWet * 0.6, (1.0 - tHloc) * tB.x);
  tRgh = mix(tRgh, min(tRgh, tRghWet), tWetL);
  tDG *= 1.0 - (0.5 + 0.35 * tB.x) * tWetL;

  // Ruts: compacted, moist soil reads darker and slightly smoother.
  float tRutK = smoothstep(0.0, 0.08, tRut);
  tAlb *= 1.0 - 0.3 * tRutK;
  tRgh *= 1.0 - 0.15 * tRutK;

  // Rubber skid marks.
  float tRub = clamp(tDef.g * 1.15, 0.0, 1.0);
  tAlb = mix(tAlb, vec3(0.018), tRub * 0.85);
  tRgh = mix(tRgh, 0.55, tRub * 0.6);

  // Puddles: flat, near-mirror, muddy-grey water over darkened ground.
  // Depth scaled by noise (never creates water where depth is 0); texture lows fill first.
  float tPM = smoothstep(0.2, 0.6, tPud * 100.0 * (0.7 + 0.6 * tNoise(tW * 3.1)) - (tHloc - 0.5) * 0.3);
  vec3 tWater = mix(tAlb * 0.5, vec3(0.05, 0.047, 0.038), smoothstep(0.0, 0.04, tPud));
  tAlb = mix(tAlb, tWater, tPM);
  tRgh = mix(tRgh, 0.03, tPM);

  vec2 tTG = texture(tGrad, tGUv).rg - tRutGrad;
  vec2 tGrd = mix(tTG + tDG, vec2(0.0), tPM);
  tNormalW = normalize(vec3(-tGrd.x, 1.0, -tGrd.y));
  tMacroNormalW = normalize(vec3(-tTG.x, 1.0, -tTG.y));
  tRoughOut = clamp(tRgh, 0.02, 1.0);
  diffuseColor.rgb *= tAlb;
}
`;

const FRAG_NORMAL = /* glsl */ `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize((viewMatrix * vec4(tNormalW, 0.0)).xyz);
vec3 nonPerturbedNormal = normalize((viewMatrix * vec4(tMacroNormalW, 0.0)).xyz);
`;

type Uniforms = Record<string, THREE.IUniform>;

function patchDepthMaterial(mat: THREE.Material, uniforms: Uniforms): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `vec2 tWXZ = tWorldXZ();\n${VERT_BEGIN}`);
  };
  mat.customProgramCacheKey = () => 'terrainView-depth';
}

// ---------------------------------------------------------------------------

export class TerrainView {
  readonly object: THREE.Object3D;

  private readonly terrain: Terrain;
  private readonly deformTex: THREE.DataTexture;
  private readonly textures: THREE.Texture[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly waterNormal: THREE.Texture | null = null;

  constructor(terrain: Terrain, renderer: THREE.WebGLRenderer) {
    this.terrain = terrain;
    const { size, res, verts, cell, defRes } = terrain;
    this.object = new THREE.Group();
    this.object.name = 'TerrainView';

    // --- Data textures -----------------------------------------------------
    const heightTex = new THREE.DataTexture(terrain.height, verts, verts, THREE.RedFormat, THREE.FloatType);
    heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter;
    heightTex.needsUpdate = true;

    const grad = new Uint16Array(verts * verts * 2);
    const h = terrain.height;
    for (let iz = 0; iz < verts; iz++) {
      const zm = Math.max(iz - 1, 0), zp = Math.min(iz + 1, verts - 1);
      for (let ix = 0; ix < verts; ix++) {
        const xm = Math.max(ix - 1, 0), xp = Math.min(ix + 1, verts - 1);
        const gx = (h[iz * verts + xp] - h[iz * verts + xm]) / ((xp - xm) * cell);
        const gz = (h[zp * verts + ix] - h[zm * verts + ix]) / ((zp - zm) * cell);
        const o = (iz * verts + ix) * 2;
        grad[o] = THREE.DataUtils.toHalfFloat(gx);
        grad[o + 1] = THREE.DataUtils.toHalfFloat(gz);
      }
    }
    const gradTex = new THREE.DataTexture(grad, verts, verts, THREE.RGFormat, THREE.HalfFloatType);
    gradTex.minFilter = gradTex.magFilter = THREE.LinearFilter;
    gradTex.needsUpdate = true;

    const splatTex = new THREE.DataTexture(terrain.splat, verts, verts, THREE.RGBAFormat);
    splatTex.minFilter = splatTex.magFilter = THREE.LinearFilter;
    splatTex.needsUpdate = true;

    const envTex = new THREE.DataTexture(terrain.env, verts, verts, THREE.RGBAFormat);
    envTex.minFilter = envTex.magFilter = THREE.LinearFilter;
    envTex.needsUpdate = true;

    const deformTex = new THREE.DataTexture(terrain.deform, defRes, defRes, THREE.RGBAFormat);
    deformTex.minFilter = deformTex.magFilter = THREE.LinearFilter;
    deformTex.needsUpdate = true;
    this.deformTex = deformTex;
    // Full upload once now, so per-frame updates can be row ranges of the dirty rect.
    renderer.initTexture(deformTex);
    terrain.dirty = null;

    const layers = buildLayerTextures();
    const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const layerA = new THREE.DataArrayTexture(layers.a, LAYER_TEX, LAYER_TEX, LAYER_GENS.length);
    layerA.colorSpace = THREE.SRGBColorSpace;
    const layerB = new THREE.DataArrayTexture(layers.b, LAYER_TEX, LAYER_TEX, LAYER_GENS.length);
    for (const t of [layerA, layerB]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = anisotropy;
      t.needsUpdate = true;
    }
    this.textures.push(heightTex, gradTex, splatTex, envTex, deformTex, layerA, layerB);

    // --- Material ----------------------------------------------------------
    const uniforms: Uniforms = {
      tHeight: { value: heightTex },
      tGrad: { value: gradTex },
      tSplat: { value: splatTex },
      tEnv: { value: envTex },
      tDeform: { value: deformTex },
      tLayerA: { value: layerA },
      tLayerB: { value: layerB },
      uTerr: { value: new THREE.Vector4(size, cell, verts, defRes) },
      uTile: { value: new THREE.Vector4(...LAYER_TILE) },
      uRutScale: { value: RUT_SCALE },
      uWaterScale: { value: WATER_SCALE },
      uGradRange: { value: LAYER_GRAD_RANGE },
      uSkirt: { value: SKIRT_DEPTH },
    };

    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    material.name = 'TerrainMaterial';
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}\nvarying vec3 vTWorld;`)
        .replace('#include <beginnormal_vertex>', VERT_NORMAL)
        .replace('#include <begin_vertex>', `${VERT_BEGIN}\nvTWorld = vec3(tWXZ.x, transformed.y + modelMatrix[3].y, tWXZ.y);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', FRAG_MAIN)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRoughOut;')
        .replace('#include <normal_fragment_begin>', FRAG_NORMAL);
    };
    material.customProgramCacheKey = () => 'terrainView';

    const depthMat = new THREE.MeshDepthMaterial();
    patchDepthMaterial(depthMat, uniforms);
    const distMat = new THREE.MeshDistanceMaterial();
    patchDepthMaterial(distMat, uniforms);
    this.materials.push(material, depthMat, distMat);

    // --- Chunked LOD mesh --------------------------------------------------
    const chunkCells = [128, 64, 32, 16, 8].find((c) => res % c === 0) ?? res;
    const steps = LOD_STEPS.filter((s) => chunkCells % s === 0 && chunkCells / s >= 4);
    if (steps.length === 0) steps.push(1);
    const levels = steps.map((s) => buildGridLevel(chunkCells / s, s * cell));
    const chunkMeters = chunkCells * cell;
    const lodDist0 = Math.max(48, chunkMeters * 1.6);
    const chunks = res / chunkCells;
    let terrainMin = Infinity;

    for (let cz = 0; cz < chunks; cz++) {
      for (let cx = 0; cx < chunks; cx++) {
        let lo = Infinity, hi = -Infinity;
        for (let iz = cz * chunkCells; iz <= (cz + 1) * chunkCells; iz++) {
          for (let ix = cx * chunkCells; ix <= (cx + 1) * chunkCells; ix++) {
            const v = h[iz * verts + ix];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        terrainMin = Math.min(terrainMin, lo);
        const box = new THREE.Box3(
          new THREE.Vector3(0, lo - RUT_SCALE - SKIRT_DEPTH, 0),
          new THREE.Vector3(chunkMeters, hi, chunkMeters),
        );
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const midY = (lo + hi) / 2;

        const lod = new THREE.LOD();
        lod.position.set(-size / 2 + (cx + 0.5) * chunkMeters, midY, -size / 2 + (cz + 0.5) * chunkMeters);
        levels.forEach((level, li) => {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', level.position);
          geo.setIndex(level.index);
          geo.boundingBox = box;
          geo.boundingSphere = sphere;
          this.geometries.push(geo);
          const mesh = new THREE.Mesh(geo, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.customDepthMaterial = depthMat;
          mesh.customDistanceMaterial = distMat;
          mesh.position.set(-chunkMeters / 2, -midY, -chunkMeters / 2);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          lod.addLevel(mesh, li === 0 ? 0 : lodDist0 * 2 ** (li - 1), 0.1);
        });
        this.object.add(lod);
      }
    }

    // --- Lake --------------------------------------------------------------
    if (terrain.waterLevel > terrainMin) {
      const wn = 256;
      const waterNormal = new THREE.DataTexture(buildWaterNormals(wn), wn, wn, THREE.RGBAFormat);
      waterNormal.wrapS = waterNormal.wrapT = THREE.RepeatWrapping;
      waterNormal.magFilter = THREE.LinearFilter;
      waterNormal.minFilter = THREE.LinearMipmapLinearFilter;
      waterNormal.generateMipmaps = true;
      waterNormal.anisotropy = anisotropy;
      waterNormal.repeat.set(size / 6, size / 6);
      waterNormal.needsUpdate = true;
      this.waterNormal = waterNormal;
      this.textures.push(waterNormal);

      const waterMat = new THREE.MeshStandardMaterial({
        color: 0x1f2e2a,
        roughness: 0.05,
        metalness: 0,
        transparent: true,
        opacity: 0.85,
        normalMap: waterNormal,
        normalScale: new THREE.Vector2(0.35, 0.35),
      });
      waterMat.name = 'LakeWater';
      const waterGeo = new THREE.PlaneGeometry(size, size);
      waterGeo.rotateX(-Math.PI / 2);
      this.geometries.push(waterGeo);
      this.materials.push(waterMat);
      const water = new THREE.Mesh(waterGeo, waterMat);
      water.name = 'Lake';
      water.position.y = terrain.waterLevel;
      water.receiveShadow = true;
      water.renderOrder = 1;
      this.object.add(water);
    }
  }

  /** Upload terrain.dirty sub-rect of terrain.deform into its texture, then set terrain.dirty = null. Called once per frame. */
  update(): void {
    if (this.waterNormal) {
      const t = performance.now() * 0.001;
      this.waterNormal.offset.set(t * 0.011, t * 0.007);
    }
    const d = this.terrain.dirty;
    if (d === null) return;
    const tex = this.deformTex;
    const n = this.terrain.defRes;
    const rowCount = (d.x1 - d.x0 + 1) * 4;
    // One texSubImage2D per dirty row (three merges nothing across rows); fall back to a
    // full upload when the rect is so tall that per-row calls would cost more.
    if (d.z1 - d.z0 + 1 <= 512) {
      for (let z = d.z0; z <= d.z1; z++) tex.addUpdateRange((z * n + d.x0) * 4, rowCount);
    } else {
      tex.clearUpdateRanges();
    }
    tex.needsUpdate = true;
    this.terrain.dirty = null;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }
}
