import { clamp } from './math.ts';

const RPM_TO_RAD = Math.PI / 30;

export interface EngineSpec {
  idleRpm: number;
  /** Soft rev limiter (throttle cut). */
  limiterRpm: number;
  stallRpm: number;
  /** Crank + flywheel + clutch disc inertia (kg m^2). */
  inertia: number;
  /** Full-load torque curve [rpm, N m]. */
  torqueCurve: [number, number][];
  /** Friction/pumping torque T = a + b * rpm (N m) — gives engine braking. */
  frictionA: number;
  frictionB: number;
  starterTorque: number;
}

export interface TransmissionSpec {
  /** Forward ratios, gear 1 first. */
  forward: number[];
  reverse: number;
  finalDrive: number;
  efficiency: number;
  clutchMaxTorque: number;
  /** Time in neutral while the gear lever moves (s). */
  shiftTime: number;
}

/** Spin state of one driven wheel, mutated by the driveline. */
export interface SpinBody {
  omega: number;
  inertia: number;
}

export function curveLookup(curve: [number, number][], x: number): number {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

/**
 * Engine -> friction clutch -> manual gearbox -> open differential -> two rear wheels.
 *
 * The clutch is solved as a torque-limited velocity constraint each step: it transmits
 * exactly the torque needed to equalise engine and gearbox-input speed, unless that exceeds
 * its capacity (pedal * max torque), in which case it slips at capacity. This gives a rigid
 * lock when engaged (no spring jitter) and correct slip on launch/stall.
 * The open diff always splits torque 50/50, so one unloaded wheel spins up — as on a real 2106.
 */
export class Drivetrain {
  engineOmega: number;
  running = true;
  /** -1 = reverse, 0 = neutral, 1..n = forward. */
  gear = 0;
  /** Gear the lever is moving to while shiftTimer > 0. */
  private targetGear = 0;
  shiftTimer = 0;

  // Telemetry
  engineTorque = 0;
  clutchTorque = 0;
  /** Torque in the propeller shaft (N m) — reacts on the body and live axle. */
  shaftTorque = 0;
  clutchSlipping = false;
  effectiveThrottle = 0;

  constructor(readonly engine: EngineSpec, readonly trans: TransmissionSpec) {
    this.engineOmega = engine.idleRpm * RPM_TO_RAD;
  }

  /** Remaining starter-motor crank time (s). */
  private cranking = 0;

  get rpm(): number {
    return this.engineOmega / RPM_TO_RAD;
  }

  /** Water swallowed through the intake: the engine won't crank until the car is recovered. */
  hydroLocked = false;

  startEngine(): void {
    if (!this.running && !this.hydroLocked) this.cranking = 0.8;
  }

  get isShifting(): boolean {
    return this.shiftTimer > 0;
  }

  /** Engaged gear target (what the driver selected), including during the shift. */
  get selectedGear(): number {
    return this.shiftTimer > 0 ? this.targetGear : this.gear;
  }

  /** Signed overall ratio engine:wheel for a gear (0 in neutral). */
  ratio(gear: number): number {
    if (gear === 0) return 0;
    const g = gear < 0 ? -this.trans.reverse : this.trans.forward[gear - 1];
    return g * this.trans.finalDrive;
  }

  shift(gear: number): void {
    const g = clamp(gear, -1, this.trans.forward.length);
    if (g === this.selectedGear) return;
    this.targetGear = g;
    this.gear = 0;
    this.shiftTimer = this.trans.shiftTime;
  }

  /**
   * @param throttle pedal 0..1
   * @param clutchEngage 0 = pedal down (disengaged) .. 1 = fully engaged
   */
  step(dt: number, throttle: number, clutchEngage: number, left: SpinBody, right: SpinBody): void {
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) { this.shiftTimer = 0; this.gear = this.targetGear; }
    }

    const e = this.engine;
    const rpm = this.rpm;

    let thr = 0;
    if (this.running) {
      // Carburettor idle circuit: holds idle speed regardless of the pedal.
      const idleThr = clamp(0.16 + (e.idleRpm - rpm) * 0.0015, 0, 0.45);
      thr = Math.max(clamp(throttle, 0, 1), idleThr);
      if (rpm > e.limiterRpm) thr = 0;
      if (rpm < e.stallRpm) this.running = false;
    }
    this.effectiveThrottle = thr;
    const friction = e.frictionA + e.frictionB * Math.abs(rpm);
    const full = this.running ? curveLookup(e.torqueCurve, rpm) : 0;
    let tq = thr * (full + friction) - friction;
    if (this.cranking > 0) {
      this.cranking -= dt;
      tq += e.starterTorque;
      if (rpm > e.idleRpm * 0.7) { this.running = true; this.cranking = 0; }
    }
    // Friction can't drive the crank backwards.
    if (this.engineOmega <= 0 && tq < 0) tq = 0;
    this.engineTorque = tq;
    this.engineOmega = Math.max(0, this.engineOmega + (tq / e.inertia) * dt);

    const G = this.ratio(this.gear);
    const cap = G === 0 ? 0 : this.trans.clutchMaxTorque * clamp(clutchEngage, 0, 1);
    let tc = 0;
    if (cap > 0) {
      const carrier = (left.omega + right.omega) * 0.5;
      const delta = this.engineOmega - G * carrier;
      const K = 1 / e.inertia + ((G * G) / 4) * (1 / left.inertia + 1 / right.inertia);
      const lock = delta / (dt * K);
      tc = clamp(lock, -cap, cap);
      this.clutchSlipping = Math.abs(lock) > cap;
    } else {
      this.clutchSlipping = false;
    }
    this.clutchTorque = tc;
    this.engineOmega = Math.max(0, this.engineOmega - (tc / e.inertia) * dt);

    // Gear mesh losses when the engine drives the wheels.
    const axle = tc * G * (tc * G >= 0 ? this.trans.efficiency : 1);
    this.shaftTorque = tc * (G === 0 ? 0 : G / this.trans.finalDrive);
    left.omega += ((axle * 0.5) / left.inertia) * dt;
    right.omega += ((axle * 0.5) / right.inertia) * dt;
  }
}
