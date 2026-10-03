import { clamp, smoothstep } from './math.ts';

/**
 * Tire model: transient slip (relaxation length) + normalised combined-slip Magic Formula.
 *
 * - Slip states obey  sigma * ds/dt + |Vx| * s = slip velocity  (Pacejka, "Tire and Vehicle
 *   Dynamics" ch. 7). This is well-posed at zero speed (no division by Vx), gives the
 *   tire its standstill spring behaviour, and — crucially for surface transitions —
 *   makes force follow a change of surface over a rolled distance instead of instantly.
 * - Force curve: F = mu*Fz*sin(C*atan(B*s)), s = |(kappa/kappaPeak, tanAlpha/tanAlphaPeak)|.
 *   C is chosen so the post-peak asymptote equals the surface slideRatio, B so the peak is at s = 1.
 *   Peak slips follow from tire stiffness and surface mu: low-mu surfaces peak earlier
 *   (wet tarmac), deformable soils peak later (sand: stiffnessScale < 1).
 */

export interface TireSpec {
  radius: number;
  width: number;
  /** Longitudinal slip stiffness per unit load (dFx/dkappa / Fz). */
  longStiffness: number;
  /** Cornering stiffness per unit load (dFy/dalpha / Fz, 1/rad). */
  latStiffness: number;
  /** Relaxation lengths (m) at reference load. */
  relaxLong: number;
  relaxLat: number;
  refLoad: number;
  /** Friction drop per unit of load above reference (tire load sensitivity). */
  loadSensitivity: number;
  /** Inflation pressure (kPa), sets hydroplaning speed. */
  pressure: number;
  /** Radial (vertical) stiffness N/m and damping N s/m: the tire is the first spring over an edge. */
  verticalStiffness: number;
  verticalDamping: number;
}

export class TireState {
  /** Transient longitudinal slip ratio (+ = driving). */
  kappa = 0;
  /** Transient lateral slip, tan(alpha) (+ = contact moving to +lateral). */
  tanAlpha = 0;
}

export interface TireInput {
  /** Load (N) normal to the ground. */
  fz: number;
  /** Contact velocity along wheel heading (m/s). */
  vx: number;
  /** Contact velocity along wheel lateral axis (m/s). */
  vy: number;
  /** Wheel spin * rolling radius (m/s). */
  omegaR: number;
  /** Effective friction after all surface, speed, water and contamination effects. */
  mu: number;
  slideRatio: number;
  stiffnessScale: number;
  relaxationScale: number;
  /** Wheel spin inertia and step, to keep low-speed damping stable. */
  inertia: number;
  dt: number;
}

export interface TireOutput {
  fx: number;
  fy: number;
  /** Normalised combined slip (1 = at peak). */
  slip: number;
  /** Peak slip ratio / tan(peak slip angle) on the current surface — used by ABS/TCS and steering assist. */
  kappaPeak: number;
  alphaPeak: number;
}

const SLIP_CLAMP = 1.5;
/** Below this speed the transient model is helped by explicit damping. */
const LOW_SPEED = 4;

export function stepTire(spec: TireSpec, state: TireState, inp: TireInput, out: TireOutput): void {
  const { fz, vx, vy, omegaR, dt } = inp;
  const absVx = Math.abs(vx);
  const loadRatio = clamp(fz / spec.refLoad, 0.2, 3);

  // Relaxation length grows ~sqrt(load) and on soft ground.
  const relaxK = Math.sqrt(loadRatio) * inp.relaxationScale;
  const sx = spec.relaxLong * relaxK;
  const sy = spec.relaxLat * relaxK;

  // Implicit Euler on the relaxation ODEs: unconditionally stable for any |Vx|.
  state.kappa = clamp((state.kappa + (dt / sx) * (omegaR - vx)) / (1 + (dt * absVx) / sx), -SLIP_CLAMP, SLIP_CLAMP);
  state.tanAlpha = clamp((state.tanAlpha + (dt / sy) * vy) / (1 + (dt * absVx) / sy), -SLIP_CLAMP, SLIP_CLAMP);

  if (fz <= 0) {
    out.fx = 0; out.fy = 0; out.slip = 0;
    return;
  }

  const mu = Math.max(0.02, inp.mu * (1 - spec.loadSensitivity * (loadRatio - 1)));
  const r = clamp(inp.slideRatio, 0.3, 0.97);
  const C = (2 * (Math.PI - Math.asin(r))) / Math.PI;
  const B = Math.tan(Math.PI / (2 * C));
  const BC = B * C;
  const kappaPeak = (mu * BC) / (spec.longStiffness * inp.stiffnessScale);
  const alphaPeak = (mu * BC) / (spec.latStiffness * inp.stiffnessScale);

  const nx = state.kappa / kappaPeak;
  const ny = state.tanAlpha / alphaPeak;
  const s = Math.hypot(nx, ny);
  let fx = 0, fy = 0;
  if (s > 1e-9) {
    const f = mu * fz * Math.sin(C * Math.atan(B * s));
    // Direction: normalised-slip vector near the peak; once sliding, friction opposes the
    // actual sliding velocity (kappa, tanAlpha are proportional to its components).
    let dx = nx / s, dy = ny / s;
    const slide = smoothstep(1, 2.5, s);
    if (slide > 0) {
      const raw = Math.hypot(state.kappa, state.tanAlpha);
      dx += (state.kappa / raw - dx) * slide;
      dy += (state.tanAlpha / raw - dy) * slide;
      const l = Math.hypot(dx, dy);
      dx /= l; dy /= l;
    }
    fx = f * dx;
    fy = -f * dy;
  }

  // Low-speed damping (tire hysteresis): the relaxation model is an undamped spring at
  // standstill. Critical-ish damping per corner, capped for wheel-spin integration stability.
  const lowW = 1 - smoothstep(0, LOW_SPEED, absVx);
  if (lowW > 0) {
    const cMax = (0.6 * inp.inertia) / (spec.radius * spec.radius * dt);
    const c = Math.min(fz * Math.sqrt((spec.longStiffness * inp.stiffnessScale) / (sx * 9.81)), cMax) * lowW;
    fx -= c * (vx - omegaR);
    fy -= c * vy;
    const lim = mu * fz;
    const mag = Math.hypot(fx, fy);
    if (mag > lim) {
      fx *= lim / mag;
      fy *= lim / mag;
    }
  }

  out.fx = fx;
  out.fy = fy;
  out.slip = s;
  out.kappaPeak = kappaPeak;
  out.alphaPeak = alphaPeak;
}
