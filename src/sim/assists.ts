import { clamp, lerp, moveTowards, smoothstep } from './math.ts';
import { GRAVITY, type Vehicle, type VehicleControls } from './vehicle.ts';

/**
 * Driver assistance layer: converts raw driver input (keyboard/gamepad) into actuator
 * commands. None of these exist on a real VAZ-2106 except what a skilled driver does with
 * hands and feet; they are optional, individually configurable systems.
 */
export interface AssistSettings {
  /** 0..1 — speed-sensitive steering that targets the front tires' peak slip angle. */
  steeringAssist: number;
  /** 0..1 — automatic countersteer toward the direction of travel during oversteer. */
  countersteer: number;
  /** Keyboard steering rate multiplier (0.5..2). */
  steeringSpeed: number;
  /** Ramp digital (keyboard) pedals instead of stepping 0→1. */
  pedalSmoothing: boolean;
  abs: boolean;
  /** Traction control: throttle cut + brake-based diff lock on the spinning rear wheel. */
  tcs: boolean;
  /** Stability control: yaw-rate tracking via individual wheel braking. */
  esc: boolean;
  autoClutch: boolean;
  autoGearbox: boolean;
}

export type AssistPresetName = 'simulation' | 'keyboard' | 'assisted';

export const ASSIST_PRESETS: Record<AssistPresetName, AssistSettings> = {
  // Stock 2106: no electronic aids; clutch automated only because keyboards have no clutch pedal.
  simulation: {
    steeringAssist: 0, countersteer: 0, steeringSpeed: 1, pedalSmoothing: true,
    abs: false, tcs: false, esc: false, autoClutch: true, autoGearbox: false,
  },
  keyboard: {
    steeringAssist: 0.8, countersteer: 0.5, steeringSpeed: 1, pedalSmoothing: true,
    abs: false, tcs: false, esc: false, autoClutch: true, autoGearbox: true,
  },
  assisted: {
    steeringAssist: 1, countersteer: 1, steeringSpeed: 1, pedalSmoothing: true,
    abs: true, tcs: true, esc: true, autoClutch: true, autoGearbox: true,
  },
};

/** Raw driver input, as read from devices. */
export interface DriverInput {
  /** -1 (left) .. 1 (right). */
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
  /** Manual clutch pedal 0 (up) .. 1 (down). */
  clutchPedal: number;
  /** True for analog devices (gamepad/wheel): no keyboard filtering. */
  analog: boolean;
}

export function createDriverInput(): DriverInput {
  return { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutchPedal: 0, analog: false };
}

const RPM = 30 / Math.PI;
/** Understeer gradient used for the ESC reference model (s^2/m). */
const ESC_UNDERSTEER = 0.0022;

export class DriverAssists {
  // Active-intervention flags for the HUD.
  absActive = false;
  tcsActive = false;
  escActive = false;

  private steerInput = 0;
  private steerAngle = 0;
  private throttle = 0;
  private brake = 0;
  private clutch = 1;
  private readonly absMod = [1, 1, 1, 1];
  private tcsCut = 0;
  private shiftCooldown = 0;
  private reverseHold = 0;

  constructor(public settings: AssistSettings) {}

  reset(): void {
    this.steerInput = 0;
    this.steerAngle = 0;
    this.throttle = 0;
    this.brake = 0;
    this.clutch = 1;
    this.absMod.fill(1);
    this.tcsCut = 0;
  }

  /** Manual gear request (+1 up, -1 down). Works in both manual and automatic mode. */
  requestShift(vehicle: Vehicle, dir: number): void {
    const d = vehicle.drivetrain;
    d.shift(d.selectedGear + dir);
    this.shiftCooldown = 1.2;
  }

  update(dt: number, input: DriverInput, vehicle: Vehicle, out: VehicleControls): void {
    const s = this.settings;
    const d = vehicle.drivetrain;
    const speed = Math.abs(vehicle.forwardSpeed);

    // ---------------- Pedals (with reverse remap in automatic mode) ----------------
    let thrIn = input.throttle, brkIn = input.brake;
    if (s.autoGearbox && d.selectedGear < 0) [thrIn, brkIn] = [brkIn, thrIn];
    if (s.pedalSmoothing && !input.analog) {
      this.throttle = moveTowards(this.throttle, thrIn, (thrIn > this.throttle ? 3 : 6) * dt);
      this.brake = moveTowards(this.brake, brkIn, (brkIn > this.brake ? 4 : 8) * dt);
    } else {
      this.throttle = thrIn;
      this.brake = brkIn;
    }

    if (s.autoGearbox) this.autoShift(dt, vehicle, input);
    if (!d.running && this.throttle > 0.05 && s.autoClutch) d.startEngine();

    // ---------------- Steering ----------------
    const lock = vehicle.spec.axles[0].maxSteerAngle;
    if (input.analog) {
      this.steerInput = input.steer;
    } else {
      const target = input.steer;
      const returning = target === 0 || Math.sign(target) !== Math.sign(this.steerInput);
      const rate = s.steeringSpeed * (returning ? 4 : lerp(3, 1.2, smoothstep(5, 30, speed)));
      this.steerInput = moveTowards(this.steerInput, target, rate * dt);
    }
    const si = this.steerInput;
    let delta = si * lock;
    const beta = vehicle.frontAxleSlip;
    // Oversteer: the front axle travels opposite to the way the car is rotating.
    // Steering assists only act when driving forward (reversing uses the plain lock).
    const fwdSpeed = vehicle.forwardSpeed;
    const oversteer = beta * vehicle.yawRate < 0 && Math.abs(beta) > 0.03 && fwdSpeed > 3;
    const front = vehicle.wheels[0].tireOut, front2 = vehicle.wheels[1].tireOut;
    const alphaPeak = Math.atan((front.alphaPeak + front2.alphaPeak) * 0.5);
    const assistW = s.steeringAssist * smoothstep(3, 10, fwdSpeed);
    if (assistW > 0) {
      // Full input = front tires at (slightly beyond) peak slip relative to the travel direction.
      const base = oversteer ? beta * s.countersteer : beta;
      const target = clamp(base + si * alphaPeak * 1.15, -lock, lock);
      delta = lerp(delta, target, assistW);
    }
    if (s.countersteer > 0 && oversteer) {
      // Countersteer also without steering assist, fading out as the driver steers.
      const w = s.countersteer * (1 - assistW) * (1 - smoothstep(0.1, 0.5, Math.abs(si)));
      delta = lerp(delta, clamp(beta, -lock, lock), w);
    }
    this.steerAngle = moveTowards(this.steerAngle, delta, 1.8 * dt);
    out.steer = this.steerAngle;

    // ---------------- Brakes: ABS + ESC ----------------
    let throttle = this.throttle;
    for (let i = 0; i < 4; i++) out.brakes[i] = this.brake;
    this.absActive = false;
    if (s.abs && this.brake > 0.01) {
      // Wheel-speed based slip (what a real ABS ECU sees), held in a band around the
      // surface's peak slip: dump fast above it, re-apply slowly below it.
      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheels[i];
        if (!w.inContact || Math.abs(w.vx) < 2) { this.absMod[i] = Math.min(1, this.absMod[i] + 10 * dt); }
        else {
          const slip = (w.vx - w.omega * w.radius) * Math.sign(w.vx) / Math.abs(w.vx);
          const kp = w.tireOut.kappaPeak;
          if (slip > kp * 1.2) this.absMod[i] = Math.max(0, this.absMod[i] - 25 * dt);
          else if (slip < kp * 0.8) this.absMod[i] = Math.min(1, this.absMod[i] + 5 * dt);
        }
        out.brakes[i] = this.brake * this.absMod[i];
        if (this.absMod[i] < 0.98) this.absActive = true;
      }
    } else this.absMod.fill(1);

    this.escActive = false;
    if (s.esc && speed > 5) {
      const L = vehicle.spec.wheelbase;
      const v = vehicle.forwardSpeed;
      let muEst = 0;
      for (const w of vehicle.wheels) muEst += w.inContact ? w.mu * 0.25 : 0;
      let rDes = (v * Math.tan(this.steerAngle)) / (L * (1 + ESC_UNDERSTEER * v * v));
      const rMax = (0.9 * Math.max(muEst, 0.15) * GRAVITY) / Math.max(speed, 1);
      rDes = clamp(rDes, -rMax, rMax);
      const r = vehicle.yawRate;
      const err = r - rDes;
      const thr = 0.06 + 0.12 * Math.abs(rDes);
      if (Math.abs(err) > thr) {
        const k = clamp((Math.abs(err) - thr) * 2.5, 0, 1);
        if (Math.abs(r) > Math.abs(rDes) || Math.sign(r) !== Math.sign(rDes)) {
          // Oversteer: brake the outer front wheel to pull the nose out of the rotation.
          const outer = r > 0 ? 0 : 1;
          out.brakes[outer] = Math.max(out.brakes[outer], k * 0.8);
        } else {
          // Understeer: brake the inner rear wheel and cut power.
          const inner = rDes > 0 ? 3 : 2;
          out.brakes[inner] = Math.max(out.brakes[inner], k * 0.6);
          throttle *= 1 - k * 0.7;
        }
        this.escActive = true;
      }
    }

    // ---------------- TCS ----------------
    this.tcsActive = false;
    if (s.tcs && d.gear !== 0) {
      // Works on slip *speed* with a ratio-based allowance: a slip ratio alone is
      // meaningless near standstill (any wheel creep reads as 100 % slip).
      const rl = vehicle.wheels[2], rr = vehicle.wheels[3];
      const sign = d.gear > 0 ? 1 : -1;
      const v = Math.abs(vehicle.forwardSpeed);
      const sl = (rl.omega * rl.radius) * sign - v, sr = (rr.omega * rr.radius) * sign - v;
      const kp = Math.max(0.03, (rl.tireOut.kappaPeak + rr.tireOut.kappaPeak) * 0.5);
      const allowed = Math.max(0.7, kp * 1.3 * v);
      const cutTarget = clamp((Math.max(sl, sr) - allowed) / 2.5, 0, 0.85);
      this.tcsCut = moveTowards(this.tcsCut, cutTarget, (cutTarget > this.tcsCut ? 10 : 3) * dt);
      throttle *= 1 - this.tcsCut;
      // Brake-based "diff lock": brake the faster wheel so the open diff feeds torque to the other.
      const diff = sl - sr;
      if (Math.abs(diff) > 0.8 && this.throttle > 0.05) {
        const idx = diff > 0 ? 2 : 3;
        out.brakes[idx] = Math.max(out.brakes[idx], clamp((Math.abs(diff) - 0.8) * 0.25, 0, 0.6));
        this.tcsActive = true;
      }
      if (this.tcsCut > 0.02) this.tcsActive = true;
    }

    // ---------------- Clutch ----------------
    const pedalEngage = 1 - clamp(input.clutchPedal, 0, 1);
    let engage = pedalEngage;
    if (s.autoClutch) {
      let target = 1;
      const idle = vehicle.spec.engine.idleRpm;
      const rpm = d.rpm;
      if (d.isShifting) {
        target = 0;
        throttle = 0;
      } else if (d.gear !== 0) {
        const carrier = (vehicle.wheels[2].omega + vehicle.wheels[3].omega) * 0.5;
        const drivelineRpm = Math.abs(d.ratio(d.gear) * carrier) * RPM;
        if (drivelineRpm > idle * 1.1) target = 1;
        else if (this.throttle > 0.05) target = smoothstep(idle + 150, idle + 1300, rpm);
        else target = 0;
        if (rpm < idle - 200) target = 0; // anti-stall
      }
      this.clutch = moveTowards(this.clutch, target, (target > this.clutch ? 3 : 12) * dt);
      engage = Math.min(engage, this.clutch);
    }
    out.clutch = engage;
    out.throttle = throttle;
    out.handbrake = input.handbrake;
  }

  private autoShift(dt: number, vehicle: Vehicle, input: DriverInput): void {
    const d = vehicle.drivetrain;
    const speed = vehicle.forwardSpeed;
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    if (d.isShifting) return;
    const g = d.selectedGear;

    // Reverse selection: hold brake at standstill to engage R; throttle at standstill → 1st.
    if (Math.abs(speed) < 0.6) {
      if (g >= 0 && input.brake > 0.5 && input.throttle < 0.05) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.35) { d.shift(-1); this.reverseHold = 0; }
        return;
      }
      if (g < 0 && input.throttle > 0.5 && input.brake < 0.05) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.35) { d.shift(1); this.reverseHold = 0; }
        return;
      }
    }
    this.reverseHold = 0;
    if (g === 0 && this.throttle > 0.05) { d.shift(1); return; }
    if (g <= 0 || this.shiftCooldown > 0) return;

    const rpm = d.rpm;
    const n = vehicle.spec.transmission.forward.length;
    const t = this.throttle;
    const upRpm = lerp(2900, 5700, t);
    const downRpm = lerp(1300, 2700, t);
    const carrier = (vehicle.wheels[2].omega + vehicle.wheels[3].omega) * 0.5;
    const drivelineRpm = Math.abs(d.ratio(g) * carrier) * RPM;
    // Don't upshift on wheelspin alone: driveline and road speed must agree.
    const roadRpm = (Math.abs(speed) / vehicle.spec.tire.radius) * Math.abs(d.ratio(g)) * RPM;
    if (g < n && rpm > upRpm && drivelineRpm > upRpm * 0.9 && roadRpm > upRpm * 0.75) {
      d.shift(g + 1);
      this.shiftCooldown = 0.9;
    } else if (g > 1 && rpm < downRpm) {
      const lowerRpm = (rpm * d.ratio(g - 1)) / d.ratio(g);
      if (lowerRpm < 5200) {
        d.shift(g - 1);
        this.shiftCooldown = 0.9;
      }
    }
  }
}
