/**
 * Minimal allocation-free vector math for the simulation core.
 *
 * Coordinate system (sim + three.js): right-handed, +Y up, vehicle forward = -Z, right = +X.
 * Unity port: negate Z for positions/vectors; quaternion (x, y, z, w) -> (-x, -y, z, w).
 */

export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  set(x: number, y: number, z: number): this {
    this.x = x; this.y = y; this.z = z;
    return this;
  }
  copy(v: Vec3): this {
    this.x = v.x; this.y = v.y; this.z = v.z;
    return this;
  }
  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }
  add(v: Vec3): this {
    this.x += v.x; this.y += v.y; this.z += v.z;
    return this;
  }
  sub(v: Vec3): this {
    this.x -= v.x; this.y -= v.y; this.z -= v.z;
    return this;
  }
  scale(s: number): this {
    this.x *= s; this.y *= s; this.z *= s;
    return this;
  }
  addScaled(v: Vec3, s: number): this {
    this.x += v.x * s; this.y += v.y * s; this.z += v.z * s;
    return this;
  }
  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  /** this = a x b (safe when this aliases a or b). */
  crossVectors(a: Vec3, b: Vec3): this {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z;
    return this;
  }
  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  normalize(): this {
    const l = this.length();
    if (l > 1e-12) this.scale(1 / l);
    return this;
  }
  /** Remove the component along unit vector n. */
  projectOnPlane(n: Vec3): this {
    return this.addScaled(n, -this.dot(n));
  }
}

export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

  copy(q: Quat): this {
    this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w;
    return this;
  }
  setFromAxisAngle(axis: Vec3, angle: number): this {
    const h = angle * 0.5;
    const s = Math.sin(h);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h);
    return this;
  }
  normalize(): this {
    const l = Math.hypot(this.x, this.y, this.z, this.w);
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  /** Integrate orientation by world-space angular velocity w over dt. */
  integrate(w: Vec3, dt: number): this {
    const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
    const { x, y, z, w: qw } = this;
    this.x += hx * qw + hy * z - hz * y;
    this.y += hy * qw + hz * x - hx * z;
    this.z += hz * qw + hx * y - hy * x;
    this.w += -hx * x - hy * y - hz * z;
    return this.normalize();
  }
}

/** out = q * v (rotate local vector into world). */
export function rotate(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return out.set(
    v.x + w * tx + (y * tz - z * ty),
    v.y + w * ty + (z * tx - x * tz),
    v.z + w * tz + (x * ty - y * tx),
  );
}

/** out = conj(q) * v (rotate world vector into local). */
export function rotateInv(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const x = -q.x, y = -q.y, z = -q.z, w = q.w;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return out.set(
    v.x + w * tx + (y * tz - z * ty),
    v.y + w * ty + (z * tx - x * tz),
    v.z + w * tz + (x * ty - y * tx),
  );
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Move `current` toward `target` by at most `maxDelta`. */
export const moveTowards = (current: number, target: number, maxDelta: number): number =>
  Math.abs(target - current) <= maxDelta ? target : current + Math.sign(target - current) * maxDelta;
