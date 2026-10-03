import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface CarModelDimensions {
  length: number; // 4.166
  width: number; // 1.611
  height: number; // 1.44 (roof above ground at static ride)
  wheelbase: number; // 2.424
  frontTrack: number; // 1.365
  rearTrack: number; // 1.321
  frontOverhang: number; // 0.78 (bumper to front axle)
  wheelRadius: number; // 0.29
  tireWidth: number; // 0.165
  cgToFrontAxle: number; // 1.14 (horizontal distance CG -> front axle)
  cgHeight: number; // 0.55 (CG above ground at static ride)
  groundClearance: number; // 0.17
}

export interface CarModelOptions {
  /** Paint colour. Default: Корида red #9b1b1b. 'Белая ночь' white is #e9e6dc. */
  bodyColor?: THREE.ColorRepresentation;
}

export interface CarModel {
  /** Body group. Origin = centre of gravity. Forward = -Z, right = +X, up = +Y. Ground is at y = -cgHeight at static ride. Front axle at z = -cgToFrontAxle, rear axle at z = wheelbase - cgToFrontAxle. */
  readonly root: THREE.Group;
  /** [FL, FR, RL, RR]. Children of root. Each is a pivot at the wheel centre with the axle along local X; geometry centred on the pivot; hubcap faces outward (−X for left wheels, +X for right). The app overwrites position (body-local hub position) and quaternion (steer about Y, then spin about X) every frame. */
  readonly wheels: THREE.Object3D[];
  setLights(state: { brake: boolean; reverse: boolean; headlights: boolean }): void;
  dispose(): void;
}

/* ------------------------------------------------------------------------------------------------
 * Design space
 *
 * The body is drawn for the reference VAZ-2106 dimensions in a "design space":
 *   x = lateral (+ right), h = height above ground, z = distance behind the front axle (+ rearward).
 * The body group maps design space into root space (origin at CG) with a translation and, if the
 * supplied dimensions differ from the reference, a per-axis scale. Wheels are placed from `dim`.
 * ---------------------------------------------------------------------------------------------- */

const REF_LENGTH = 4.166;
const REF_WIDTH = 1.611;
const REF_HEIGHT = 1.44;
const REF_WHEELBASE = 2.424;

const HW = REF_WIDTH / 2; // body half width
const Z_FB = -0.78; // front bumper face
const Z_RB = Z_FB + REF_LENGTH; // rear bumper face
const Z_RA = REF_WHEELBASE; // rear axle
const ARCH_R = 0.36; // wheel-arch cut-out radius
const ARCH_H = 0.31; // wheel-arch centre height
const SILL_H = 0.25;

const Z_A = 0.64; // windscreen base (A-pillar foot)
const Z_C = 2.6; // rear-window base (C-pillar foot)
const BELT_H0 = 0.928; // belt height at the A-pillar
const BELT_H1 = 0.95; // belt height at the C-pillar
const ROOF_EDGE_H = 1.39; // drip-rail height
const ROOF_CROWN = REF_HEIGHT - 0.006 - ROOF_EDGE_H; // lateral roof crown
const Z_ROOF0 = 1.06; // windscreen top at the pillars
const Z_ROOF1 = 2.24; // rear-window top at the pillars
const XB = 0.785; // greenhouse half width at the belt
const XR = 0.672; // greenhouse half width at the drip rail
const K_TUMBLE = (XB - XR) / (ROOF_EDGE_H - BELT_H0);

const sideX = (h: number): number => XB - K_TUMBLE * (h - BELT_H0);
const beltH = (z: number): number =>
  BELT_H0 + (BELT_H1 - BELT_H0) * THREE.MathUtils.clamp((z - Z_A) / (Z_C - Z_A), 0, 1);
const bonnetH = (z: number): number => 0.828 + ((z + 0.72) * (0.905 - 0.828)) / (0.58 + 0.72);
const bootH = (z: number): number => 0.953 + ((z - 2.64) * (0.938 - 0.953)) / (3.29 - 2.64);

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const lerp = THREE.MathUtils.lerp;
type P2 = readonly [number, number];

/* ---------------------------------------------- geometry helpers ---------------------------------------------- */

/** Non-indexed, exactly position/normal/uv, no groups: the common layout required for merging. */
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  if (!out.getAttribute('uv')) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
  }
  out.clearGroups();
  return out;
}

function flipWinding(g: THREE.BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name) as THREE.BufferAttribute;
    const s = attr.itemSize;
    const arr = attr.array;
    for (let t = 0; t < attr.count; t += 3) {
      for (let c = 0; c < s; c++) {
        const i1 = (t + 1) * s + c;
        const i2 = (t + 2) * s + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

/** Apply a transform, keeping front faces outward even for mirroring transforms. */
function xf(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const out = prep(g);
  out.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(out);
  return out;
}

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

function shapeOf(pts: readonly P2[]): THREE.Shape {
  return new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b)));
}

function arc(cz: number, ch: number, r: number, a0: number, a1: number, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = lerp(a0, a1, i / n);
    out.push([cz + r * Math.cos(a), ch + r * Math.sin(a)]);
  }
  return out;
}

/** Tube along a polyline with mitred corners and parallel-transported frames. */
function polyTube(pts: readonly THREE.Vector3[], r: number, radial = 6, closed = false): THREE.BufferGeometry {
  const n = pts.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const t = new THREE.Vector3();
  const prevT = new THREE.Vector3();
  const dIn = new THREE.Vector3();
  const dOut = new THREE.Vector3();
  const bend = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const hasIn = closed || i > 0;
    const hasOut = closed || i < n - 1;
    if (hasIn) dIn.subVectors(pts[i], pts[(i - 1 + n) % n]).normalize();
    if (hasOut) dOut.subVectors(pts[(i + 1) % n], pts[i]).normalize();
    if (!hasIn) dIn.copy(dOut);
    if (!hasOut) dOut.copy(dIn);
    t.addVectors(dIn, dOut).normalize();
    const miter = 1 / Math.max(0.35, dIn.dot(t));
    bend.subVectors(dOut, dIn);
    const hasBend = bend.lengthSq() > 1e-10;
    if (hasBend) bend.normalize();
    if (i === 0) {
      const ax = Math.abs(t.x) < 0.6 ? v3(1, 0, 0) : v3(0, 1, 0);
      nrm.crossVectors(t, ax).normalize();
    } else {
      q.setFromUnitVectors(prevT, t);
      nrm.applyQuaternion(q);
      nrm.addScaledVector(t, -nrm.dot(t)).normalize();
    }
    prevT.copy(t);
    bin.crossVectors(t, nrm);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      dir.copy(nrm).multiplyScalar(Math.cos(a)).addScaledVector(bin, Math.sin(a));
      nor.push(dir.x, dir.y, dir.z);
      if (hasBend) dir.addScaledVector(bend, dir.dot(bend) * (miter - 1));
      pos.push(pts[i].x + dir.x * r, pts[i].y + dir.y * r, pts[i].z + dir.z * r);
      uv.push(i / Math.max(1, n - 1), j / radial);
    }
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = i2 * (radial + 1) + j;
      const c = b + 1;
      const d = a + 1;
      idx.push(a, d, b, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Parametric grid surface; `outward` (if given) selects the front-face orientation. */
function surface(nu: number, nv: number, fn: (u: number, v: number) => THREE.Vector3, outward?: THREE.Vector3): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      const p = fn(i / nu, j / nv);
      pos.push(p.x, p.y, p.z);
      uv.push(i / nu, j / nv);
    }
  }
  let flip = false;
  if (outward) {
    const c = fn(0.5, 0.5);
    const pu = fn(0.501, 0.5).sub(c);
    const pv = fn(0.5, 0.501).sub(c);
    flip = pu.cross(pv).dot(outward) < 0;
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j;
      const b = (i + 1) * (nv + 1) + j;
      const c = b + 1;
      const d = a + 1;
      if (flip) idx.push(a, d, b, b, d, c);
      else idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Surface of revolution about +X from an (radius, axial) profile. */
function lathe(profile: readonly P2[], segments: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, a]) => new THREE.Vector2(r, a)), segments);
  g.rotateZ(-Math.PI / 2); // lathe axis +Y -> +X
  return g;
}

/** Maps (u = z, v = h, w = inward depth) onto the tumblehome plane of the right greenhouse side. */
function sideMatrix(offset: number): THREE.Matrix4 {
  return new THREE.Matrix4().set(0, -K_TUMBLE, -1, XB + K_TUMBLE * BELT_H0 + offset, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
}

/** Projects an (z, h) polyline onto the right greenhouse side plane. */
function onSide(pts: readonly P2[], offset: number): THREE.Vector3[] {
  return pts.map(([z, h]) => v3(sideX(h) + offset, h, z));
}

/** Collects geometry per material and merges it into one mesh per material. */
class Parts {
  private readonly map = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(mat: THREE.Material, g: THREE.BufferGeometry): void {
    let list = this.map.get(mat);
    if (!list) {
      list = [];
      this.map.set(mat, list);
    }
    list.push(prep(g));
  }

  /** Adds the geometry (drawn on the right side) and its mirror on the left side. */
  sym(mat: THREE.Material, g: THREE.BufferGeometry): void {
    const right = prep(g);
    this.add(mat, xf(right.clone(), MIRROR_X));
    this.add(mat, right);
  }

  build(parent: THREE.Object3D, name: string, noReceive: ReadonlySet<THREE.Material> = new Set()): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [mat, list] of this.map) {
      const merged = mergeGeometries(list, false);
      if (!merged) throw new Error(`carModel: failed to merge ${name} geometry`);
      for (const g of list) g.dispose();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${name}:${mat.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = !noReceive.has(mat);
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.map.clear();
    return meshes;
  }
}

function makePlateTexture(text: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 112;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#efefe9';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#151515';
  ctx.lineWidth = 7;
  ctx.strokeRect(8, 8, c.width - 16, c.height - 16);
  ctx.fillStyle = '#151515';
  ctx.font = 'bold 76px "DejaVu Sans Mono", "Menlo", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------------------------------------------- materials ---------------------------------------------- */

interface Materials {
  paint: THREE.MeshPhysicalMaterial;
  chrome: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  plastic: THREE.MeshStandardMaterial;
  grille: THREE.MeshStandardMaterial;
  seam: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  interior: THREE.MeshStandardMaterial;
  seat: THREE.MeshStandardMaterial;
  headliner: THREE.MeshStandardMaterial;
  liner: THREE.MeshStandardMaterial;
  under: THREE.MeshStandardMaterial;
  headLens: THREE.MeshStandardMaterial;
  tail: THREE.MeshStandardMaterial;
  brake: THREE.MeshStandardMaterial;
  reverse: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  badge: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  tyre: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  exhaust: THREE.MeshStandardMaterial;
}

function makeMaterials(bodyColor: THREE.ColorRepresentation, plateTex: THREE.Texture | null): Materials {
  const std = (name: string, p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial(p);
    m.name = name;
    return m;
  };
  const paint = new THREE.MeshPhysicalMaterial({
    color: bodyColor,
    metalness: 0,
    roughness: 0.34,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  paint.name = 'paint';
  return {
    paint,
    chrome: std('chrome', { color: 0xeeeeee, metalness: 1, roughness: 0.15 }),
    rubber: std('rubber', { color: 0x101010, roughness: 0.75 }),
    plastic: std('plastic', { color: 0x0e0e0e, roughness: 0.55 }),
    grille: std('grille', { color: 0x222222, roughness: 0.45 }),
    seam: std('seam', { color: 0x050505, roughness: 0.9 }),
    glass: std('glass', {
      color: 0x0d171c,
      metalness: 0,
      roughness: 0.04,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    interior: std('interior', { color: 0x221d1a, roughness: 0.9 }),
    seat: std('seat', { color: 0x3b281d, roughness: 0.7 }),
    headliner: std('headliner', { color: 0x8a857a, roughness: 0.95 }),
    liner: std('liner', { color: 0x0b0b0b, roughness: 0.95, side: THREE.DoubleSide }),
    under: std('under', { color: 0x151515, roughness: 0.95 }),
    headLens: std('headLens', { color: 0xa9b5bb, metalness: 0.35, roughness: 0.08, emissive: 0xfff2dc, emissiveIntensity: 0 }),
    tail: std('tail', { color: 0x6e0606, roughness: 0.25, emissive: 0xff0600, emissiveIntensity: 0 }),
    brake: std('brake', { color: 0x6e0606, roughness: 0.25, emissive: 0xff0600, emissiveIntensity: 0 }),
    reverse: std('reverse', { color: 0xd4d4d0, roughness: 0.2, emissive: 0xffffff, emissiveIntensity: 0 }),
    amber: std('amber', { color: 0xd06a08, roughness: 0.25, emissive: 0xff7a00, emissiveIntensity: 0.05 }),
    badge: std('badge', { color: 0x8c1010, roughness: 0.4 }),
    plate: std('plate', { color: 0xffffff, roughness: 0.6, map: plateTex }),
    tyre: std('tyre', { color: 0x161616, roughness: 0.92 }),
    rim: std('rim', { color: 0xaab0b6, metalness: 0.55, roughness: 0.4, side: THREE.DoubleSide }),
    exhaust: std('exhaust', { color: 0x3a3632, metalness: 0.6, roughness: 0.6 }),
  };
}

/* ---------------------------------------------- body ---------------------------------------------- */

const FRONT_ARCH = { z: 0, a0: -Math.asin((ARCH_H - SILL_H) / ARCH_R), a1: Math.PI };
const REAR_ARCH = { z: Z_RA, a0: 0, a1: Math.PI + Math.asin((ARCH_H - SILL_H) / ARCH_R) };

function lowerBody(parts: Parts, m: Materials): void {
  // Side profile (z, h), traced nose -> bonnet -> belt -> boot -> tail -> underside.
  const profile: P2[] = [
    [-0.735, 0.3],
    [-0.748, 0.36],
    [-0.752, 0.55],
    [-0.755, 0.79],
    [-0.745, 0.815],
    [-0.72, 0.828],
    [0.58, 0.905],
    [Z_A, BELT_H0],
    [Z_C, BELT_H1],
    [2.64, 0.953],
    [3.29, 0.938],
    [3.325, 0.925],
    [3.345, 0.895],
    [3.352, 0.84],
    [3.356, 0.45],
    [3.35, 0.37],
    [3.33, ARCH_H],
    ...arc(REAR_ARCH.z, ARCH_H, ARCH_R, REAR_ARCH.a0, REAR_ARCH.a1, 20),
    ...arc(FRONT_ARCH.z, ARCH_H, ARCH_R, FRONT_ARCH.a0, FRONT_ARCH.a1, 20),
  ];
  const bevel = 0.03;
  const body = new THREE.ExtrudeGeometry(shapeOf(profile), {
    depth: 2 * HW - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    steps: 1,
  });
  // (u, v, w) -> (x = HW - bevel - w, h = v, z = u)
  parts.add(m.paint, xf(body, new THREE.Matrix4().set(0, 0, -1, HW - bevel, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1)));

  // Wheel wells: dark liners following the cut-outs plus an inner wall.
  for (const [arch, xIn] of [
    [FRONT_ARCH, 0.4],
    [REAR_ARCH, 0.5],
  ] as const) {
    const rl = ARCH_R - 0.004;
    parts.sym(
      m.liner,
      surface(24, 1, (u, v) => {
        const a = lerp(arch.a0, arch.a1, u);
        return v3(lerp(xIn, HW - 0.004, v), ARCH_H + rl * Math.sin(a), arch.z + rl * Math.cos(a));
      }),
    );
    const wall = new THREE.ShapeGeometry(shapeOf(arc(arch.z, ARCH_H, rl, arch.a0, arch.a1, 24)));
    parts.sym(m.liner, xf(wall, new THREE.Matrix4().set(0, 0, 1, xIn, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1)));
    // chrome wheel-arch moulding
    parts.sym(
      m.chrome,
      polyTube(
        arc(arch.z, ARCH_H, ARCH_R + 0.012, arch.a0, arch.a1, 28).map(([z, h]) => v3(HW - 0.006, h, z)),
        0.009,
      ),
    );
  }

  // Underbody tray and sump.
  parts.add(m.under, box(0.76, 0.06, 2.8, 0, 0.25, 1.6));
  parts.add(m.under, box(1.3, 0.04, 1.6, 0, 0.245, 1.21));
  parts.add(m.under, box(0.36, 0.08, 0.5, 0, 0.21, 0.05));
  // Exhaust tailpipe (right rear).
  parts.add(m.exhaust, polyTube([v3(0.2, 0.22, 1.0), v3(0.3, 0.22, 2.9), v3(0.42, 0.25, 3.25), v3(0.44, 0.255, 3.41)], 0.022, 8));
  parts.add(m.seam, box(0.03, 0.03, 0.004, 0.44, 0.255, 3.41));

  // Panel seams: bonnet, boot, doors.
  const seamR = 0.0035;
  const bonnet: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const z = lerp(-0.7, 0.56, i / 8);
    bonnet.push(v3(0.765, bonnetH(z) + 0.001, z));
  }
  parts.sym(m.seam, polyTube(bonnet, seamR, 4));
  parts.add(m.seam, polyTube([v3(-0.765, bonnetH(0.56) + 0.001, 0.56), v3(0.765, bonnetH(0.56) + 0.001, 0.56)], seamR, 4));
  const boot: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const z = lerp(2.7, 3.3, i / 6);
    boot.push(v3(0.74, bootH(z) + 0.001, z));
  }
  parts.sym(m.seam, polyTube(boot, seamR, 4));
  parts.add(m.seam, polyTube([v3(-0.74, bootH(2.7) + 0.001, 2.7), v3(0.74, bootH(2.7) + 0.001, 2.7)], seamR, 4));
  parts.add(m.seam, polyTube([v3(-0.74, 0.912, 3.343), v3(0.74, 0.912, 3.343)], seamR, 4));

  const xs = HW + 0.0005;
  const frontDoor: P2[] = [
    [0.66, beltH(0.66)],
    [0.66, 0.29],
    [1.57, 0.29],
    [1.57, beltH(1.57)],
  ];
  const rearDoorArc = arc(Z_RA, ARCH_H, 0.39, Math.PI + Math.asin(0.02 / 0.39), Math.PI - Math.acos((Z_RA - 2.21) / 0.39), 10);
  const rearDoor: P2[] = [[1.6, beltH(1.6)], [1.6, 0.29], ...rearDoorArc, [2.21, beltH(2.21)]];
  parts.sym(m.seam, polyTube(frontDoor.map(([z, h]) => v3(xs, h, z)), seamR, 4));
  parts.sym(m.seam, polyTube(rearDoor.map(([z, h]) => v3(xs, h, z)), seamR, 4));

  // Side mouldings: chrome strip with a black rubber insert, and sill trim.
  parts.sym(m.chrome, box(0.012, 0.026, 3.98, HW + 0.004, 0.735, 1.29));
  parts.sym(m.rubber, box(0.008, 0.01, 3.97, HW + 0.012, 0.735, 1.29));
  parts.sym(m.chrome, polyTube([v3(HW - 0.004, 0.27, 0.42), v3(HW - 0.004, 0.27, 2.0)], 0.008));
  // Belt-line chrome (window sill) along the shoulder.
  parts.sym(m.chrome, polyTube([v3(XB + 0.004, BELT_H0 + 0.006, Z_A + 0.03), v3(XB + 0.0, BELT_H1 + 0.006, Z_C - 0.02)], 0.006));

  // Door handles (pull type) with push buttons.
  for (const z of [1.42, 2.04]) {
    parts.sym(m.chrome, box(0.022, 0.026, 0.13, HW + 0.01, 0.865, z));
    parts.sym(m.chrome, polyTube([v3(HW + 0.012, 0.865, z + 0.075), v3(HW + 0.018, 0.865, z + 0.076)], 0.009, 8));
  }
  // Side repeaters on front wings.
  parts.sym(m.amber, box(0.01, 0.03, 0.075, HW + 0.005, 0.79, -0.42));
  parts.sym(m.chrome, box(0.006, 0.04, 0.085, HW + 0.002, 0.79, -0.42));

  // Door mirrors.
  parts.sym(m.chrome, polyTube([v3(HW - 0.01, 0.9, 0.82), v3(HW + 0.04, 0.95, 0.81), v3(HW + 0.075, 0.99, 0.8)], 0.008, 6));
  parts.sym(m.plastic, box(0.035, 0.075, 0.12, HW + 0.085, 1.0, 0.79, 0, -0.2, 0));
  parts.sym(m.chrome, box(0.028, 0.065, 0.004, HW + 0.087, 1.0, 0.851, 0, -0.2, 0));

  // Cowl panel and parked wipers.
  parts.add(
    m.plastic,
    surface(2, 8, (u, v) => {
      const t = v * 2 - 1;
      return v3(t * 0.74, lerp(0.906, BELT_H0, u) + 0.004, lerp(0.585, Z_A - 0.035 * (1 - t * t), u));
    }, v3(0, 1, 0)),
  );
  parts.add(m.plastic, polyTube([v3(-0.62, 0.938, 0.655), v3(-0.08, 0.938, 0.632)], 0.007, 5));
  parts.add(m.plastic, polyTube([v3(-0.02, 0.938, 0.63), v3(0.5, 0.938, 0.655)], 0.007, 5));
}

/* ---------------------------------------------- greenhouse ---------------------------------------------- */

const wsBottom = (t: number): THREE.Vector3 => v3(t * (sideX(BELT_H0) - 0.012), BELT_H0, Z_A - 0.035 * (1 - t * t));
const wsTop = (t: number): THREE.Vector3 => v3(t * (XR - 0.012), ROOF_EDGE_H + ROOF_CROWN * (1 - t * t), Z_ROOF0 - 0.03 * (1 - t * t));
const rwTop = (t: number): THREE.Vector3 => v3(t * (XR - 0.012), ROOF_EDGE_H + ROOF_CROWN * (1 - t * t), Z_ROOF1 + 0.02 * (1 - t * t));
const rwBottom = (t: number): THREE.Vector3 => v3(t * (sideX(BELT_H1) - 0.012), BELT_H1, Z_C + 0.03 * (1 - t * t));

function greenhouse(parts: Parts, m: Materials): void {
  const aSlope = (Z_ROOF0 - Z_A) / (ROOF_EDGE_H - BELT_H0); // dz/dh along the A-pillar
  const cSlope = (Z_C - Z_ROOF1) / (ROOF_EDGE_H - BELT_H1); // -dz/dh along the C-pillar
  const front: P2[] = [
    [Z_A + (0.965 - BELT_H0) * aSlope + 0.075, 0.965],
    [Z_A + (1.355 - BELT_H0) * aSlope + 0.075, 1.355],
    [1.54, 1.355],
    [1.54, 0.965],
  ];
  const rear: P2[] = [
    [1.6, 0.965],
    [1.6, 1.355],
    [2.16, 1.355],
    [2.205, 0.965],
  ];
  const outline: P2[] = [
    [Z_A - 0.02 * aSlope, BELT_H0 - 0.02],
    [Z_ROOF0, ROOF_EDGE_H],
    [Z_ROOF1, ROOF_EDGE_H],
    [Z_C + 0.02 * cSlope, BELT_H1 - 0.02],
  ];
  const panelShape = shapeOf(outline);
  panelShape.holes.push(shapeOf(front), shapeOf(rear));
  const panel = new THREE.ExtrudeGeometry(panelShape, { depth: 0.02, bevelEnabled: false, steps: 1 });
  parts.sym(m.paint, xf(panel, sideMatrix(0)));

  // Side glass and chrome window surrounds.
  for (const hole of [front, rear]) {
    parts.sym(m.glass, xf(new THREE.ShapeGeometry(shapeOf(hole)), sideMatrix(-0.01)));
    parts.sym(m.chrome, polyTube(onSide(hole, 0.003), 0.007, 6, true));
  }
  // Front quarter-vent divider.
  parts.sym(m.chrome, polyTube(onSide([[0.99, 0.965], [1.15, 1.355]], 0.0), 0.008));

  // C-pillar ventilation grille.
  parts.sym(m.plastic, xf(box(0.15, 0.075, 0.004, 2.33, 1.13, -0.002), sideMatrix(0)));
  for (let i = 0; i < 4; i++) {
    parts.sym(m.chrome, xf(box(0.14, 0.007, 0.004, 2.33, 1.102 + i * 0.019, -0.004), sideMatrix(0)));
  }
  parts.sym(m.chrome, polyTube(onSide([[2.25, 1.09], [2.25, 1.17], [2.41, 1.17], [2.41, 1.09]], 0.004), 0.005, 5, true));

  // Windscreen, roof, rear window.
  parts.add(m.glass, surface(6, 16, (u, v) => wsBottom(v * 2 - 1).lerp(wsTop(v * 2 - 1), u), v3(0, 0.6, -0.8)));
  parts.add(m.glass, surface(6, 16, (u, v) => rwBottom(v * 2 - 1).lerp(rwTop(v * 2 - 1), u), v3(0, 0.6, 0.8)));
  const roof = (u: number, v: number, drop: number): THREE.Vector3 => {
    const t = v * 2 - 1;
    const z0 = Z_ROOF0 - 0.03 * (1 - t * t);
    const z1 = Z_ROOF1 + 0.02 * (1 - t * t);
    const h = ROOF_EDGE_H + ROOF_CROWN * (1 - t * t) + 0.006 * Math.sin(Math.PI * u) * (1 - t * t) - drop;
    return v3(t * XR, h, lerp(z0, z1, u));
  };
  parts.add(m.paint, surface(10, 16, (u, v) => roof(u, v, 0), v3(0, 1, 0)));
  parts.add(m.headliner, surface(6, 8, (u, v) => roof(u, v, 0.02), v3(0, -1, 0)));

  const loop = (bottom: (t: number) => THREE.Vector3, top: (t: number) => THREE.Vector3): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) pts.push(bottom(lerp(-1, 1, i / 12)));
    for (let i = 0; i <= 12; i++) pts.push(top(lerp(1, -1, i / 12)));
    return pts;
  };
  parts.add(m.chrome, polyTube(loop(wsBottom, wsTop), 0.012, 6, true));
  parts.add(m.chrome, polyTube(loop(rwBottom, rwTop), 0.012, 6, true));
  // A-pillars (give the pillar edge some body) and drip rails.
  parts.sym(m.paint, polyTube([v3(sideX(BELT_H0) - 0.012, BELT_H0, Z_A), v3(XR - 0.012, ROOF_EDGE_H, Z_ROOF0)], 0.02, 6));
  parts.sym(m.chrome, polyTube([v3(XR + 0.006, ROOF_EDGE_H - 0.004, Z_ROOF0 + 0.02), v3(XR + 0.006, ROOF_EDGE_H - 0.004, Z_ROOF1 - 0.01)], 0.007));
}

/* ---------------------------------------------- interior ---------------------------------------------- */

function interior(parts: Parts, m: Materials): void {
  parts.add(
    m.interior,
    surface(4, 2, (u, v) => {
      const z = lerp(0.6, 2.64, u);
      return v3(lerp(-0.77, 0.77, v), beltH(z) + 0.003, z);
    }, v3(0, 1, 0)),
  );
  // Dashboard + instrument binnacle.
  parts.add(m.interior, box(1.46, 0.09, 0.3, 0, 0.975, 0.83));
  parts.add(m.interior, box(0.3, 0.05, 0.12, -0.37, 1.04, 0.93));
  // Steering wheel (LHD), column.
  const wheel = new THREE.TorusGeometry(0.19, 0.012, 6, 28);
  wheel.rotateX(-0.47);
  wheel.translate(-0.37, 1.03, 1.16);
  parts.add(m.plastic, wheel);
  parts.add(m.plastic, box(0.34, 0.03, 0.015, -0.37, 1.03, 1.16, -0.47));
  parts.add(m.plastic, polyTube([v3(-0.37, 1.03, 1.16), v3(-0.37, 0.96, 1.0)], 0.022, 6));
  // Rear-view mirror.
  parts.add(m.plastic, box(0.2, 0.06, 0.02, 0, 1.33, 1.08));
  // Front seats with headrests, rear bench.
  for (const x of [-0.37, 0.37]) {
    parts.add(m.seat, box(0.48, 0.62, 0.12, x, 0.92, 1.76, 0.2));
    parts.add(m.seat, box(0.25, 0.15, 0.09, x, 1.31, 1.84, 0.2));
    parts.add(m.interior, box(0.06, 0.08, 0.02, x, 1.2, 1.82, 0.2));
  }
  parts.add(m.seat, box(1.34, 0.5, 0.14, 0, 0.9, 2.27, 0.25));
}

/* ---------------------------------------------- front & rear ---------------------------------------------- */

function bumperOutline(hw: number, rc: number, wrap: number, off: number): P2[] {
  const pts: P2[] = [[-(hw + off), wrap]];
  const r = rc + off;
  for (let i = 0; i <= 6; i++) {
    const a = lerp(Math.PI, 1.5 * Math.PI, i / 6);
    pts.push([-(hw - rc) + r * Math.cos(a), rc + r * Math.sin(a)]);
  }
  for (let i = 0; i <= 6; i++) {
    const a = lerp(1.5 * Math.PI, 2 * Math.PI, i / 6);
    pts.push([hw - rc + r * Math.cos(a), rc + r * Math.sin(a)]);
  }
  pts.push([hw + off, wrap]);
  return pts;
}

/** Chrome bumper with rubber strip and rubber-faced overriders. `dirIn` is +1 for front (inward = +z), -1 for rear. */
function bumper(parts: Parts, m: Materials, zFace: number, dirIn: 1 | -1, hb: number, ht: number): void {
  const hw = 0.8;
  const rc = 0.11;
  const wrap = 0.17;
  const bandShape = (outerOff: number, innerOff: number): THREE.Shape =>
    shapeOf([...bumperOutline(hw, rc, wrap, outerOff), ...bumperOutline(hw, rc, wrap, innerOff).reverse()]);
  const bt = 0.012;
  const bar = new THREE.ExtrudeGeometry(bandShape(0, -0.055), {
    depth: ht - 2 * bt,
    bevelEnabled: true,
    bevelThickness: bt,
    bevelSize: bt,
    bevelOffset: -bt,
    bevelSegments: 2,
    steps: 1,
  });
  // (x, q, w) -> (x, h = hb + bt + w, z = zFace + dirIn * q)
  parts.add(m.chrome, xf(bar, new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, hb + bt, 0, dirIn, 0, zFace, 0, 0, 0, 1)));
  const strip = new THREE.ExtrudeGeometry(bandShape(0.006, -0.01), { depth: 0.03, bevelEnabled: false, steps: 1 });
  parts.add(m.rubber, xf(strip, new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, hb + ht / 2 - 0.015, 0, dirIn, 0, zFace, 0, 0, 0, 1)));
  for (const x of [-0.4, 0.4]) {
    parts.add(m.chrome, box(0.065, 0.2, 0.05, x, hb + ht / 2, zFace + dirIn * 0.0));
    parts.add(m.rubber, box(0.046, 0.16, 0.02, x, hb + ht / 2, zFace - dirIn * 0.032));
  }
}

function front(parts: Parts, m: Materials): THREE.Vector3[] {
  const zf = -0.752;
  // Black grille panel with horizontal slats, framed in chrome.
  parts.add(m.plastic, box(1.49, 0.215, 0.02, 0, 0.66, zf - 0.008));
  for (let i = 0; i < 8; i++) parts.add(m.grille, box(1.46, 0.009, 0.008, 0, 0.578 + i * 0.0235, zf - 0.022));
  parts.add(m.chrome, polyTube([v3(-0.752, 0.553, zf - 0.02), v3(-0.752, 0.768, zf - 0.02), v3(0.752, 0.768, zf - 0.02), v3(0.752, 0.553, zf - 0.02)], 0.009, 6, true));
  parts.add(m.chrome, box(0.012, 0.21, 0.012, -0.335, 0.66, zf - 0.024));
  parts.add(m.chrome, box(0.012, 0.21, 0.012, 0.335, 0.66, zf - 0.024));
  // Badge.
  parts.add(m.chrome, box(0.085, 0.055, 0.01, 0, 0.705, zf - 0.03));
  parts.add(m.badge, box(0.07, 0.04, 0.006, 0, 0.705, zf - 0.034));
  // Four round headlamps in chrome bezels.
  const lampR = 0.074;
  const capR = 0.13;
  const capTheta = Math.asin(lampR / capR);
  const centres: THREE.Vector3[] = [];
  for (const x of [-0.62, -0.43, 0.43, 0.62]) {
    const c = v3(x, 0.66, zf - 0.02);
    centres.push(c);
    const bezel = new THREE.TorusGeometry(lampR + 0.01, 0.011, 8, 32);
    bezel.translate(c.x, c.y, c.z - 0.004);
    parts.add(m.chrome, bezel);
    parts.add(m.chrome, polyTube([v3(c.x, c.y, c.z + 0.012), v3(c.x, c.y, c.z - 0.004)], lampR + 0.004, 24));
    const lens = new THREE.SphereGeometry(capR, 28, 4, 0, Math.PI * 2, 0, capTheta);
    lens.rotateX(-Math.PI / 2);
    lens.translate(c.x, c.y, c.z - 0.004 + capR * Math.cos(capTheta));
    parts.add(m.headLens, lens);
  }
  // Indicators / parking lamps below the bumper.
  for (const x of [-0.58, 0.58]) {
    parts.add(m.chrome, box(0.17, 0.06, 0.03, x, 0.35, zf + 0.0));
    parts.add(m.amber, box(0.1, 0.045, 0.012, x - Math.sign(x) * 0.03, 0.35, zf - 0.018));
    parts.add(m.reverse, box(0.05, 0.045, 0.012, x + Math.sign(x) * 0.05, 0.35, zf - 0.018));
  }
  bumper(parts, m, Z_FB, 1, 0.4, 0.1);
  parts.add(m.plate, box(0.52, 0.112, 0.006, 0, 0.45, Z_FB - 0.016));
  return centres;
}

function rear(parts: Parts, m: Materials): void {
  const zr = 3.354;
  // Tail-light clusters: inner -> outer: reverse, brake, tail, amber indicator.
  const segs: [number, number, THREE.Material][] = [
    [0.3, 0.4, m.reverse],
    [0.4, 0.52, m.brake],
    [0.52, 0.64, m.tail],
    [0.64, 0.765, m.amber],
  ];
  const h0 = 0.655;
  const h1 = 0.825;
  for (const [x0, x1, mat] of segs) {
    const w = x1 - x0 - 0.008;
    const xc = (x0 + x1) / 2;
    parts.sym(mat, box(w, h1 - h0 - 0.008, 0.02, xc, (h0 + h1) / 2, zr + 0.006));
    for (let i = 0; i < 4; i++) parts.sym(mat, box(w, 0.006, 0.006, xc, h0 + 0.025 + (i * (h1 - h0 - 0.05)) / 3, zr + 0.017));
    parts.sym(m.chrome, box(0.007, h1 - h0, 0.012, x1, (h0 + h1) / 2, zr + 0.014));
  }
  parts.sym(m.chrome, polyTube([v3(0.296, h0, zr + 0.016), v3(0.296, h1, zr + 0.016), v3(0.769, h1, zr + 0.016), v3(0.769, h0, zr + 0.016)], 0.007, 6, true));
  // Boot-lid chrome strip, lock, number plate with lamp housing.
  parts.add(m.chrome, box(1.4, 0.022, 0.012, 0, 0.872, 3.351));
  parts.add(m.chrome, box(0.06, 0.035, 0.016, 0, 0.84, 3.356));
  parts.add(m.plate, box(0.52, 0.112, 0.006, 0, 0.6, zr + 0.004));
  parts.add(m.chrome, box(0.3, 0.025, 0.04, 0, 0.67, zr + 0.016));
  bumper(parts, m, Z_RB, -1, 0.43, 0.1);
}

/* ---------------------------------------------- wheels ---------------------------------------------- */

function buildWheelParts(m: Materials, R: number, W: number): [THREE.Material, THREE.BufferGeometry][] {
  const hw = W / 2;
  const rimR = 0.1651; // 13" bead seat
  const half: P2[] = [
    [R - 0.009, 0],
    [R - 0.009, 0.7 * hw],
    [R - 0.013, 0.84 * hw],
    [R - 0.024, 0.95 * hw],
    [R - 0.045, 0.99 * hw],
    [(R + rimR) / 2, hw],
    [rimR + 0.03, 0.95 * hw],
    [rimR + 0.012, 0.86 * hw],
    [rimR + 0.004, 0.8 * hw],
  ];
  const tyreProfile: P2[] = [...half.slice(1).reverse().map(([r, a]): P2 => [r, -a]), ...half];
  const tyre: THREE.BufferGeometry[] = [prep(lathe(tyreProfile, 56))];
  // Tread blocks: two staggered rows; outer face exactly at R.
  const n = 40;
  const blockH = 0.0085;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < n; i++) {
      const th = ((i + row * 0.5) / n) * Math.PI * 2;
      const b = new THREE.BoxGeometry(0.37 * W, blockH, ((2 * Math.PI * R) / n) * 0.66);
      b.translate((row ? 1 : -1) * 0.205 * W, R - 0.0005 - blockH / 2, 0);
      b.rotateX(th);
      tyre.push(prep(b));
    }
  }
  const tyreGeo = mergeGeometries(tyre, false);
  for (const g of tyre) g.dispose();

  const rimProfile: P2[] = [
    [rimR + 0.01, -0.066],
    [rimR + 0.004, -0.062],
    [rimR - 0.005, -0.05],
    [rimR - 0.006, 0.04],
    [rimR - 0.002, 0.056],
    [rimR + 0.004, 0.062],
    [rimR + 0.01, 0.066],
    [rimR + 0.006, 0.07],
    [rimR - 0.004, 0.065],
    [rimR - 0.025, 0.05],
    [0.12, 0.04],
    [0.1, 0.036],
    [0.088, 0.036],
  ];
  const rimGeo = prep(lathe(rimProfile, 48));

  const capProfile: P2[] = [
    [0.09, 0.034],
    [0.093, 0.041],
    [0.089, 0.05],
    [0.079, 0.062],
    [0.06, 0.071],
    [0.035, 0.076],
    [0, 0.078],
  ];
  const capGeo = prep(lathe(capProfile, 40));

  const dark: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const th = (i / 6) * Math.PI * 2;
    const slot = new THREE.BoxGeometry(0.008, 0.02, 0.042);
    slot.rotateZ(0.3);
    slot.translate(0.041, 0.124, 0);
    slot.rotateX(th);
    dark.push(prep(slot));
  }
  for (let i = 0; i < 8; i++) {
    const th = ((i + 0.5) / 8) * Math.PI * 2;
    const notch = new THREE.BoxGeometry(0.006, 0.022, 0.006);
    notch.rotateZ(-0.9);
    notch.translate(0.066, 0.07, 0);
    notch.rotateX(th);
    dark.push(prep(notch));
  }
  const darkGeo = mergeGeometries(dark, false);
  for (const g of dark) g.dispose();

  const emblem = new THREE.CylinderGeometry(0.026, 0.026, 0.004, 24);
  emblem.rotateZ(-Math.PI / 2);
  emblem.translate(0.0785, 0, 0);
  const emblemBar = new THREE.BoxGeometry(0.003, 0.034, 0.006);
  emblemBar.translate(0.081, 0, 0);
  if (!tyreGeo || !darkGeo) throw new Error('carModel: failed to merge wheel geometry');
  return [
    [m.tyre, tyreGeo],
    [m.rim, rimGeo],
    [m.chrome, capGeo],
    [m.seam, darkGeo],
    [m.badge, prep(emblem)],
    [m.chrome, prep(emblemBar)],
  ];
}

/* ---------------------------------------------- assembly ---------------------------------------------- */

export function createVaz2106Model(dim: CarModelDimensions, options: CarModelOptions = {}): CarModel {
  const plateTex = makePlateTexture('21-06 ВАЗ');
  const m = makeMaterials(options.bodyColor ?? 0x9b1b1b, plateTex);

  const root = new THREE.Group();
  root.name = 'VAZ-2106';

  // Design space -> root space.
  const body = new THREE.Group();
  body.name = 'body';
  const sx = dim.width / REF_WIDTH;
  const sy = dim.height / REF_HEIGHT;
  const sz = dim.wheelbase / REF_WHEELBASE;
  body.scale.set(sx, sy, sz);
  body.position.set(0, -dim.cgHeight, -dim.cgToFrontAxle);
  root.add(body);
  const toRoot = (p: THREE.Vector3): THREE.Vector3 => v3(p.x * sx, p.y * sy - dim.cgHeight, p.z * sz - dim.cgToFrontAxle);

  const parts = new Parts();
  lowerBody(parts, m);
  greenhouse(parts, m);
  interior(parts, m);
  const lampCentres = front(parts, m);
  rear(parts, m);
  parts.build(body, 'body', new Set<THREE.Material>([m.glass]));

  // Headlight beams.
  const beams: THREE.SpotLight[] = [];
  for (const side of [-1, 1]) {
    const c = lampCentres[side < 0 ? 0 : 3].clone().add(lampCentres[side < 0 ? 1 : 2]).multiplyScalar(0.5);
    const light = new THREE.SpotLight(0xfff1d8, 900, 0, 0.36, 0.55, 2);
    light.name = side < 0 ? 'headlightL' : 'headlightR';
    light.position.copy(toRoot(v3(c.x, c.y, c.z - 0.05)));
    light.target.position.copy(toRoot(v3(c.x + side * 0.8, 0, -24)));
    light.visible = false;
    root.add(light, light.target);
    beams.push(light);
  }

  // Wheels: shared geometry; left wheels flipped 180° about Y so the hubcap faces -X.
  const wheelParts = buildWheelParts(m, dim.wheelRadius, dim.tireWidth);
  const wheels: THREE.Object3D[] = [];
  const hubY = -dim.cgHeight + dim.wheelRadius;
  const zF = -dim.cgToFrontAxle;
  const zR = dim.wheelbase - dim.cgToFrontAxle;
  const layout: [string, number, number][] = [
    ['FL', -dim.frontTrack / 2, zF],
    ['FR', dim.frontTrack / 2, zF],
    ['RL', -dim.rearTrack / 2, zR],
    ['RR', dim.rearTrack / 2, zR],
  ];
  for (const [name, x, z] of layout) {
    const pivot = new THREE.Group();
    pivot.name = `wheel${name}`;
    pivot.position.set(x, hubY, z);
    const holder = new THREE.Group();
    if (x < 0) holder.rotation.y = Math.PI;
    for (const [mat, geo] of wheelParts) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      holder.add(mesh);
    }
    pivot.add(holder);
    root.add(pivot);
    wheels.push(pivot);
  }

  const setLights = (state: { brake: boolean; reverse: boolean; headlights: boolean }): void => {
    const tailLevel = state.headlights ? 0.35 : 0;
    m.headLens.emissiveIntensity = state.headlights ? 3 : 0;
    m.tail.emissiveIntensity = tailLevel;
    m.brake.emissiveIntensity = state.brake ? 1.0 : tailLevel;
    m.reverse.emissiveIntensity = state.reverse ? 3 : 0;
    for (const b of beams) b.visible = state.headlights;
  };

  const dispose = (): void => {
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        geos.add(o.geometry as THREE.BufferGeometry);
        mats.add(o.material as THREE.Material);
      }
    });
    for (const g of geos) g.dispose();
    for (const mat of mats) mat.dispose();
    for (const b of beams) b.dispose();
    plateTex?.dispose();
    root.removeFromParent();
    root.clear();
  };

  return { root, wheels, setLights, dispose };
}
