import { Drivetrain, type EngineSpec, type TransmissionSpec } from './drivetrain.ts';
import { Vec3, clamp, rotate, rotateInv, smoothstep } from './math.ts';
import { RigidBody } from './rigidBody.ts';
import {
  LAYER_COUNT, accumulateSurface, createSurfaceParams, createSurfaceSample, resetSurfaceParams,
  type SurfaceParams,
} from './surfaces.ts';
import { Terrain } from './terrain.ts';
import { TireState, stepTire, type TireOutput, type TireSpec } from './tire.ts';

export const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const WATER_DENSITY = 1000;

export interface AxleSpec {
  track: number;
  springRate: number;
  springPreload: number;
  bumpDamping: number;
  reboundDamping: number;
  /** Anti-roll rate (N/m of compression difference); negative = live axle with inboard springs. */
  antiRollRate: number;
  travel: number;
  staticCompression: number;
  /** Height above ground where lateral tire forces enter the body (suspension roll centre). */
  rollCenterHeight: number;
  brakeTorque: number;
  handbrakeTorque: number;
  maxSteerAngle: number;
  driven: boolean;
  wheelInertia: number;
  /** Per-wheel unsprung mass (wheel, hub, brake, share of links / live axle), kg. */
  unsprungMass: number;
}

export interface VehicleSpec {
  name: string;
  mass: number;
  inertia: { x: number; y: number; z: number };
  cgHeight: number;
  cgToFrontAxle: number;
  wheelbase: number;
  dimensions: { length: number; width: number; height: number; frontOverhang: number; groundClearance: number };
  aero: { dragCoefficient: number; frontalArea: number };
  /** [front, rear]. */
  axles: [AxleSpec, AxleSpec];
  tire: TireSpec;
  engine: EngineSpec;
  transmission: TransmissionSpec;
  hullPoints: [number, number, number][];
}

/** Final per-step actuator commands (after driver assists). */
export interface VehicleControls {
  /** Virtual centre road-wheel angle (rad), + = right. Ackermann is applied per wheel. */
  steer: number;
  throttle: number;
  /** Per-wheel service brake 0..1 [FL, FR, RL, RR] (lets ABS/ESC modulate individually). */
  brakes: [number, number, number, number];
  handbrake: number;
  /** Clutch engagement 0 (pedal down) .. 1 (released). */
  clutch: number;
}

export function createControls(): VehicleControls {
  return { steer: 0, throttle: 0, brakes: [0, 0, 0, 0], handbrake: 0, clutch: 1 };
}

// Disc contact sampling: arc angles along the tire circumference x lateral offsets.
const ARC_STEPS = 6;
const ARC_MAX = (55 * Math.PI) / 180;
const LATERAL_FRACTIONS = [-0.4, 0, 0.4];
const PATCH_LONG = [-0.07, 0, 0.07];
const PATCH_LAT = [-0.055, 0, 0.055];
const STAMP_DISTANCE = 0.04;
/** Hydroplaning onset (km/h) by Horne's NASA formula: 6.36 * sqrt(tire pressure kPa). */
const HORNE = 6.36;

export class Wheel {
  readonly droopLocal: Vec3;
  /** Hub position in body space (for rendering). */
  readonly hubLocal = new Vec3();
  readonly radius: number;
  readonly inertia: number;
  steer = 0;
  omega = 0;
  /** Accumulated rotation (rad) for rendering. */
  spinAngle = 0;

  /** Suspension compression from full droop (m) — the unsprung mass's own coordinate. */
  compression = 0;
  compressionVelocity = 0;
  /** Absolute hub velocity along the body's up axis (m/s). */
  hubVelocity = 0;
  readonly unsprungMass: number;
  /** Compression at which a rigid tire would just touch the ground (from the disc contact). */
  groundCompression = 0;
  /** Radial tire deflection (m); > 0 means touching. */
  tireDeflection = 0;
  suspensionForce = 0;
  /** True when solveContact computed a contact point/normal this step. */
  hasGeometry = false;
  inContact = false;
  /** Tire normal load (N). */
  load = 0;

  readonly tire = new TireState();
  readonly tireOut: TireOutput = { fx: 0, fy: 0, slip: 0, kappaPeak: 0.1, alphaPeak: 0.15 };
  readonly contactPoint = new Vec3();
  readonly contactNormal = new Vec3(0, 1, 0);
  /** Contact-plane heading and lateral axes (world). */
  readonly heading = new Vec3();
  readonly lateral = new Vec3();
  vx = 0;
  vy = 0;

  /** Blended surface under the contact patch. */
  readonly surface: SurfaceParams = createSurfaceParams();
  readonly layerWeights = new Float32Array(LAYER_COUNT);
  wetness = 0;
  water = 0;
  mudFilm = 0;
  /** Effective friction after water, speed, contamination. */
  mu = 0;
  hydroplaning = 0;

  /** Current soil sinkage (m) below the undisturbed surface. */
  sink = 0;
  /** Sinkage into soil not yet compacted by a previous pass (drives bulldozing resistance). */
  freshSink = 0;
  /** Mud packed into the tread (0..1). */
  coating = 0;
  rollingResistance = 0;
  /** Contact patch sliding speed (m/s). */
  slipSpeed = 0;

  private stampAccum = 0;
  /** Previous tire deflection, NaN when not in contact (no damping on first touch). */
  prevDeflection = NaN;

  constructor(
    readonly index: number,
    readonly axle: AxleSpec,
    /** -1 left, +1 right */
    readonly side: number,
    spec: VehicleSpec,
  ) {
    this.radius = spec.tire.radius;
    this.inertia = axle.wheelInertia;
    this.unsprungMass = axle.unsprungMass;
    const z = index < 2 ? -spec.cgToFrontAxle : spec.wheelbase - spec.cgToFrontAxle;
    // Static hub height: loaded tire radius below the hub, ground at y = -cgHeight.
    const cornerLoad = (spec.mass * GRAVITY * (index < 2 ? spec.wheelbase - spec.cgToFrontAxle : spec.cgToFrontAxle)) / spec.wheelbase / 2;
    const hubStaticY = -spec.cgHeight + spec.tire.radius - cornerLoad / spec.tire.verticalStiffness;
    this.droopLocal = new Vec3((side * axle.track) / 2, hubStaticY - axle.staticCompression, z);
    this.compression = axle.staticCompression;
    this.hubLocal.copy(this.droopLocal);
  }

  get slipRatio(): number {
    return this.tire.kappa;
  }
  get slipAngle(): number {
    return Math.atan(this.tire.tanAlpha);
  }

  resetState(): void {
    this.omega = 0;
    this.tire.kappa = 0;
    this.tire.tanAlpha = 0;
    this.sink = 0;
    this.coating = 0;
    this.compression = this.axle.staticCompression;
    this.compressionVelocity = 0;
    this.hubVelocity = 0;
    this.prevDeflection = NaN;
  }

  shouldStamp(distance: number): boolean {
    this.stampAccum += distance;
    if (this.stampAccum < STAMP_DISTANCE) return false;
    this.stampAccum = 0;
    return true;
  }
}

/**
 * Full vehicle: rigid chassis + 4 disc-contact wheels on spring/damper suspension,
 * transient tires, drivetrain, aero and hull collision against the terrain.
 * Step at a fixed dt (1 ms recommended).
 */
export class Vehicle {
  readonly body: RigidBody;
  readonly wheels: Wheel[];
  readonly drivetrain: Drivetrain;

  // Telemetry (updated each step).
  readonly up = new Vec3();
  readonly forward = new Vec3();
  readonly right = new Vec3();
  /** Velocity in body frame (x right, y up, z back). */
  readonly localVelocity = new Vec3();
  speed = 0;
  /** Forward speed (m/s), negative when reversing. */
  forwardSpeed = 0;
  yawRate = 0;
  /** Direction of travel of the front axle relative to heading (rad, + = right). */
  frontAxleSlip = 0;
  lateralAccel = 0;
  longitudinalAccel = 0;
  hullContact = false;
  /** Fraction of the body below the lake surface (0..1). */
  submerged = 0;

  // Scratch.
  private readonly sample = createSurfaceSample();
  private readonly patchSurface = createSurfaceParams();
  private readonly tmp = new Vec3();
  private readonly tmp2 = new Vec3();
  private readonly tmp3 = new Vec3();
  private readonly hub = new Vec3();
  private readonly pv = new Vec3();
  private readonly f = new Vec3();
  private readonly fwH = new Vec3();
  private readonly rwH = new Vec3();
  private readonly wheelFwd = new Vec3();
  private readonly prevVelocity = new Vec3();
  private readonly springForce = new Float64Array(4);
  private readonly unsprungWeight: number;
  private readonly stripC = new Float64Array(LATERAL_FRACTIONS.length);
  private readonly stripAlong = new Float64Array(LATERAL_FRACTIONS.length);
  private readonly stripH = new Float64Array(LATERAL_FRACTIONS.length);

  constructor(readonly spec: VehicleSpec, readonly terrain: Terrain) {
    const I = spec.inertia;
    this.body = new RigidBody(spec.mass, new Vec3(I.x, I.y, I.z));
    this.drivetrain = new Drivetrain(spec.engine, spec.transmission);
    const [front, rear] = spec.axles;
    this.wheels = [
      new Wheel(0, front, -1, spec),
      new Wheel(1, front, 1, spec),
      new Wheel(2, rear, -1, spec),
      new Wheel(3, rear, 1, spec),
    ];
    this.unsprungWeight = this.wheels.reduce((s, w) => s + w.unsprungMass, 0) * GRAVITY;
  }

  /** Place the car at rest on the ground at (x, z) facing `heading` (rad, 0 = -Z, + = turn right). */
  reset(x: number, z: number, heading: number): void {
    const b = this.body;
    b.orientation.setFromAxisAngle(new Vec3(0, 1, 0), -heading);
    const ground = Math.max(
      this.terrain.baseHeight(x, z),
      ...this.wheels.map((w) => {
        const p = rotate(b.orientation, w.droopLocal, new Vec3());
        return this.terrain.baseHeight(x + p.x, z + p.z);
      }),
    );
    b.position.set(x, ground + this.spec.cgHeight + 0.03, z);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    this.prevVelocity.set(0, 0, 0);
    for (const w of this.wheels) w.resetState();
    const dt = this.drivetrain;
    dt.engineOmega = this.spec.engine.idleRpm * (Math.PI / 30);
    dt.running = true;
    dt.hydroLocked = false;
    dt.shift(0);
  }

  step(dt: number, controls: VehicleControls): void {
    const body = this.body;
    const q = body.orientation;
    rotate(q, this.tmp.set(0, 1, 0), this.up);
    rotate(q, this.tmp.set(0, 0, -1), this.forward);
    rotate(q, this.tmp.set(1, 0, 0), this.right);

    this.applySteering(controls.steer);

    // 1. Ground contact geometry: where a rigid tire would touch.
    for (const w of this.wheels) this.solveContact(w);

    // 2. Suspension + unsprung masses. Spring/damper/anti-roll act between body and hub; the
    //    tire is a stiff radial spring between hub and ground, so an asphalt lip is absorbed by
    //    the tire first and a wheel can hop or briefly lose contact on its own.
    for (let a = 0; a < 2; a++) {
      const l = this.wheels[a * 2], r = this.wheels[a * 2 + 1];
      const arb = l.axle.antiRollRate * (l.compression - r.compression);
      this.springForce[a * 2] = this.suspensionForce(l) + arb;
      this.springForce[a * 2 + 1] = this.suspensionForce(r) - arb;
    }
    // Live-axle pinion torque reaction: the propshaft torque T twists the axle housing, pressing
    // the left rear down and lifting the right (engine turns clockwise seen from the front) — why
    // a Zhiguli spins its right rear wheel. The body receives the opposite torque.
    const shaftT = this.drivetrain.shaftTorque;
    const dF = shaftT / this.spec.axles[1].track;
    for (const w of this.wheels) {
      this.integrateWheel(w, this.springForce[w.index], w.index === 2 ? -dF : w.index === 3 ? dF : 0, dt);
    }
    body.addTorque(rotate(q, this.tmp.set(0, 0, -shaftT), this.tmp2));
    // The wheels carry their own weight; the body integrates with the full mass for inertia.
    body.addForce(this.f.set(0, this.unsprungWeight, 0));

    // 3. Tires.
    for (const w of this.wheels) this.tireForces(w, dt);

    // 4. Wheel spin: tire reaction, driveline, then resistive torques (brakes, rolling).
    for (const w of this.wheels) w.omega -= ((w.tireOut.fx * w.radius) / w.inertia) * dt;
    const throttle = controls.throttle;
    this.drivetrain.step(dt, throttle, controls.clutch, this.wheels[2], this.wheels[3]);
    for (const w of this.wheels) {
      const tb = controls.brakes[w.index] * w.axle.brakeTorque + controls.handbrake * w.axle.handbrakeTorque;
      const tr = tb + w.rollingResistance * w.load * w.radius;
      const dw = (tr / w.inertia) * dt;
      w.omega = Math.abs(w.omega) <= dw ? 0 : w.omega - Math.sign(w.omega) * dw;
      w.spinAngle = (w.spinAngle + w.omega * dt) % (Math.PI * 2);
    }

    // 5. Hull contacts, aero.
    this.hullContacts();
    this.deepWater();
    const v = body.velocity;
    const speed = v.length();
    const drag = 0.5 * AIR_DENSITY * this.spec.aero.dragCoefficient * this.spec.aero.frontalArea * speed;
    body.addForce(this.f.copy(v).scale(-drag));

    body.integrate(dt, GRAVITY);
    this.updateTelemetry(dt);
  }

  private applySteering(steer: number): void {
    const L = this.spec.wheelbase;
    const front = this.spec.axles[0];
    const max = front.maxSteerAngle;
    const d = clamp(steer, -max, max);
    if (Math.abs(d) < 1e-5) {
      this.wheels[0].steer = 0;
      this.wheels[1].steer = 0;
      return;
    }
    // Ackermann: both front wheels aim at the same turn centre on the rear-axle line.
    const R = L / Math.tan(Math.abs(d));
    const inner = Math.atan(L / (R - front.track / 2));
    const outer = Math.atan(L / (R + front.track / 2));
    const s = Math.sign(d);
    // Turning right (s > 0): right wheel (index 1) is inner.
    this.wheels[1].steer = s * (s > 0 ? inner : outer);
    this.wheels[0].steer = s * (s > 0 ? outer : inner);
  }

  /**
   * Disc-on-heightfield contact: find the hub height at which the tire circle first touches
   * the ground, sampling arc points (so kerbs, lips and rut walls are climbed smoothly
   * instead of snapping like a single ray) across the tread width.
   */
  private solveContact(w: Wheel): void {
    const body = this.body;
    const R = w.radius;
    const hub0 = body.localToWorld(w.droopLocal, this.hub);
    const up = this.up;

    // Wheel heading (steered) projected to horizontal.
    const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
    const wf = this.wheelFwd.set(
      this.forward.x * cs + this.right.x * sn,
      this.forward.y * cs + this.right.y * sn,
      this.forward.z * cs + this.right.z * sn,
    );
    this.fwH.set(wf.x, 0, wf.z).normalize();
    this.rwH.set(-this.fwH.z, 0, this.fwH.x);
    const upY = Math.max(0.2, up.y);
    const halfW = this.spec.tire.width * 0.5;

    // Per tread strip (lateral offset): the arc point that lifts the hub the most.
    const nLat = LATERAL_FRACTIONS.length;
    const sc = this.stripC, sa = this.stripAlong, sh = this.stripH;
    let best = -Infinity;
    for (let k = 0; k < nLat; k++) {
      const lat = LATERAL_FRACTIONS[k] * 2 * halfW;
      sc[k] = -Infinity;
      for (let j = -ARC_STEPS; j <= ARC_STEPS; j++) {
        const th = (j / ARC_STEPS) * ARC_MAX;
        const along = R * Math.sin(th);
        const px = hub0.x + this.fwH.x * along + this.rwH.x * lat;
        const pz = hub0.z + this.fwH.z * along + this.rwH.z * lat;
        const h = this.groundUnderWheel(w, px, pz);
        const c = (h + R * Math.cos(th) - hub0.y) / upY;
        if (c > sc[k]) { sc[k] = c; sa[k] = along; sh[k] = h; }
      }
      if (sc[k] > best) best = sc[k];
    }
    w.groundCompression = best;
    // Geometry is only needed when the tire is (nearly) touching.
    w.hasGeometry = best > w.compression - 0.02;
    if (!w.hasGeometry) return;

    // Load centre across the tread: strips within ~1 cm of the highest share the load, so a
    // flat road gives a centred contact and an asphalt lip shifts it to the edge smoothly
    // (an argmax would jump between strips and inject spurious roll moments).
    let ws = 0, along = 0, lat = 0, hc = 0;
    for (let k = 0; k < nLat; k++) {
      const wk = Math.max(0, 1 - (best - sc[k]) / 0.01);
      ws += wk;
      along += wk * sa[k];
      lat += wk * LATERAL_FRACTIONS[k] * 2 * halfW;
      hc += wk * sh[k];
    }
    along /= ws; lat /= ws; hc /= ws;
    w.contactPoint.set(
      hub0.x + this.fwH.x * along + this.rwH.x * lat,
      hc,
      hub0.z + this.fwH.z * along + this.rwH.z * lat,
    );
    const bestX = w.contactPoint.x, bestZ = w.contactPoint.z;
    // Normal in the wheel plane: from contact toward the hub (exact for a circle on any profile).
    const hub = this.tmp.copy(hub0).addScaled(up, best);
    const n = w.contactNormal.copy(hub).sub(w.contactPoint);
    n.addScaled(this.rwH, -n.dot(this.rwH));
    n.normalize();
    // Lateral tilt from the ground (camber of the road, rut walls) via finite difference.
    const e = 0.1;
    const hr = this.groundUnderWheel(w, bestX + this.rwH.x * e, bestZ + this.rwH.z * e);
    const hl = this.groundUnderWheel(w, bestX - this.rwH.x * e, bestZ - this.rwH.z * e);
    n.addScaled(this.rwH, -(hr - hl) / (2 * e));
    n.normalize();
    if (n.y < 0.2) n.set(0, 1, 0);
  }

  /** Ground height a wheel rests on: terrain minus how far this wheel is sunk into soft soil. */
  private groundUnderWheel(w: Wheel, x: number, z: number): number {
    const s = this.sample;
    const h = this.terrain.sample(x, z, s);
    if (w.sink <= 0) return h;
    const cap = Terrain.softCapacity(s);
    return h - Math.max(0, Math.min(w.sink, cap) - s.rut);
  }

  /** Spring + damper + bump stop between body and hub (positive = pushing them apart). */
  private suspensionForce(w: Wheel): number {
    const a = w.axle;
    const c = w.compression;
    const cv = w.compressionVelocity;
    let f = a.springPreload + a.springRate * Math.min(c, a.travel);
    f += cv * (cv > 0 ? a.bumpDamping : a.reboundDamping);
    // Progressive rubber bump stop over the last 3 cm of travel.
    const bs = c - (a.travel - 0.03);
    if (bs > 0) f += 90000 * bs + 3e6 * bs * bs;
    return f;
  }

  /**
   * Vertical dynamics of one unsprung mass: tire radial spring below, suspension above.
   * `extra` is any additional force on the hub along the suspension axis (pinion reaction).
   */
  private integrateWheel(w: Wheel, suspension: number, extra: number, dt: number): void {
    const body = this.body;
    const up = this.up;
    const tire = this.spec.tire;
    const mount = body.localToWorld(w.droopLocal, this.hub);
    const mountVel = body.pointVelocity(mount, this.pv).dot(up);
    const m = w.unsprungMass;

    const defl = w.groundCompression - w.compression;
    let ft = 0;
    if (defl > 0 && w.hasGeometry) {
      const dv = Number.isNaN(w.prevDeflection) ? 0 : clamp((defl - w.prevDeflection) / dt, -5, 5);
      ft = Math.max(0, tire.verticalStiffness * defl + tire.verticalDamping * dv);
      w.prevDeflection = defl;
    } else {
      w.prevDeflection = NaN;
    }
    w.tireDeflection = defl;
    w.inContact = ft > 0;
    w.load = ft;
    w.suspensionForce = suspension;

    const nUp = w.inContact ? w.contactNormal.dot(up) : 0;
    w.hubVelocity += ((ft * nUp - suspension + extra) / m - GRAVITY * up.y) * dt;
    w.compression += (w.hubVelocity - mountVel) * dt;
    // Hard travel limits (droop strap / axle on the chassis): momentum goes into the body.
    const max = w.axle.travel + 0.05;
    const rel = w.hubVelocity - mountVel;
    if ((w.compression < 0 && rel < 0) || (w.compression > max && rel > 0)) {
      w.compression = clamp(w.compression, 0, max);
      body.addForceAtPoint(this.f.copy(up).scale((m * rel) / dt), mount);
      w.hubVelocity = mountVel;
    }
    w.compressionVelocity = w.hubVelocity - mountVel;
    body.addForceAtPoint(this.f.copy(up).scale(suspension), mount);
    w.hubLocal.copy(w.droopLocal);
    w.hubLocal.y += w.compression;
  }

  private tireForces(w: Wheel, dt: number): void {
    const body = this.body;
    const out = w.tireOut;
    if (!w.inContact) {
      w.tire.kappa = 0;
      w.tire.tanAlpha = 0;
      out.fx = 0; out.fy = 0; out.slip = 0;
      w.vx = 0; w.vy = 0; w.slipSpeed = 0;
      w.rollingResistance = 0;
      return;
    }

    const n = w.contactNormal;
    const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
    const fw = w.heading.set(
      this.forward.x * cs + this.right.x * sn,
      this.forward.y * cs + this.right.y * sn,
      this.forward.z * cs + this.right.z * sn,
    );
    fw.projectOnPlane(n).normalize();
    const lat = w.lateral.crossVectors(fw, n).normalize();

    const v = body.pointVelocity(w.contactPoint, this.pv);
    const vx = v.dot(fw), vy = v.dot(lat);
    w.vx = vx; w.vy = vy;
    const R = w.radius;
    const fz = w.load;

    // --- Surface under the contact patch: area-weighted blend of 3x3 samples. ---
    const ps = this.patchSurface;
    resetSurfaceParams(ps);
    w.layerWeights.fill(0);
    let wet = 0, water = 0, mud = 0;
    const s = this.sample;
    const inv = 1 / (PATCH_LONG.length * PATCH_LAT.length);
    for (const pl of PATCH_LONG) {
      for (const pt of PATCH_LAT) {
        this.terrain.sample(
          w.contactPoint.x + fw.x * pl + lat.x * pt,
          w.contactPoint.z + fw.z * pl + lat.z * pt,
          s,
        );
        accumulateSurface(s, inv, ps);
        for (let l = 0; l < LAYER_COUNT; l++) w.layerWeights[l] += s.weights[l] * inv;
        wet += s.wetness * inv;
        water += s.water * inv;
        mud += s.mudFilm * inv;
      }
    }
    Object.assign(w.surface, ps);
    w.wetness = wet; w.water = water; w.mudFilm = mud;

    const slipVel = Math.hypot(R * w.omega - vx, vy);
    w.slipSpeed = slipVel;
    const rollDist = Math.abs(vx) * dt;

    // --- Effective friction. ---
    let mu = ps.mu / (1 + ps.speedSensitivity * Math.abs(vx));
    // Hydroplaning: water film thicker than the tread can evacuate lifts the tire.
    const vp = (HORNE * Math.sqrt(this.spec.tire.pressure)) / 3.6;
    const filmF = smoothstep(0.001, 0.008, water);
    w.hydroplaning = smoothstep(0.55 * vp, 1.05 * vp, Math.abs(vx)) * filmF;
    mu *= (1 - 0.2 * filmF) * (1 - 0.88 * w.hydroplaning);
    // Mud tracked onto a hard surface, and mud packed in this tire's tread.
    mu *= 1 - 0.45 * mud * ps.hardness;
    mu *= 1 - w.coating * (0.3 * ps.hardness + 0.1);
    w.mu = mu;

    // --- Soil sinkage: equilibrium under load, plus digging while the tire spins/slides. ---
    const capacity = ps.maxDepth;
    const target = Math.min(capacity, ps.sinkage * Math.pow(Math.max(fz, 0) / this.spec.tire.refLoad, 0.8));
    const k = Math.min(1, (rollDist + slipVel * dt) / 0.25);
    w.sink += (target - w.sink) * k + ps.digRate * slipVel * dt;
    w.sink = clamp(w.sink, 0, capacity);
    // Fresh (uncompacted) soil ahead of the tire in the direction of travel.
    const dir = vx >= 0 ? 1 : -1;
    const ahead = this.terrain.rutDepth(w.contactPoint.x + fw.x * dir * 0.2, w.contactPoint.z + fw.z * dir * 0.2);
    w.freshSink = Math.max(0, w.sink - ahead);
    w.rollingResistance = ps.rollingResistance + ps.bulldozing * w.freshSink;

    // --- Tread contamination (mud pick-up and shedding). ---
    const travelled = rollDist + 0.5 * slipVel * dt;
    w.coating += ps.coating * wet * (1 - w.coating) * travelled * 2;
    w.coating -= w.coating * (travelled * ps.hardness / 20 + slipVel * dt * 0.03);
    w.coating = clamp(w.coating, 0, 1);

    // --- Tire forces. ---
    stepTire(this.spec.tire, w.tire, {
      fz, vx, vy, omegaR: w.omega * R, mu, slideRatio: ps.slideRatio, stiffnessScale: ps.stiffnessScale,
      relaxationScale: ps.relaxationScale, inertia: w.inertia, dt,
    }, out);

    let fx = out.fx, fy = out.fy;
    // Soil piling up against the sidewall when sliding sideways in soft ground.
    fy -= fz * ps.bulldozing * w.sink * 0.5 * Math.tanh(vy / 0.4);
    // Water drag: tire ploughing through standing water (pulls the car toward a puddle).
    if (water > 0.003) {
      const depth = Math.min(water, R);
      fx -= 0.5 * WATER_DENSITY * 0.9 * this.spec.tire.width * depth * vx * Math.abs(vx);
    }

    // The ground reaction's component along the suspension axis went into the unsprung mass;
    // the rest (slopes, lip faces, rut walls) is taken by the suspension links into the body.
    const F = this.f.copy(n).addScaled(this.up, -n.dot(this.up)).scale(fz);
    body.addForceAtPoint(F, w.contactPoint);
    // Tire forces enter the body at the roll-centre height.
    const app = this.tmp3.copy(w.contactPoint).addScaled(this.up, w.axle.rollCenterHeight);
    F.copy(fw).scale(fx).addScaled(lat, fy);
    body.addForceAtPoint(F, app);

    // --- Deformation map: ruts, rubber marks on tarmac, mud carried onto hard surfaces. ---
    if (w.shouldStamp(travelled)) {
      const rubber = out.slip > 1.2 && ps.hardness > 0.5 ? clamp((out.slip - 1.2) * 0.04, 0, 0.12) * (1 - wet * 0.7) : 0;
      const mudOut = ps.hardness > 0.5 ? w.coating * 0.05 : 0;
      if (w.sink > 0.004 || rubber > 0 || mudOut > 0.002) {
        const hx = Math.hypot(fw.x, fw.z) || 1;
        this.terrain.stampFootprint(
          w.contactPoint.x, w.contactPoint.z, fw.x / hx, fw.z / hx, 0.1, this.spec.tire.width * 0.5,
          w.sink, rubber, mudOut,
        );
      }
    }
  }

  /**
   * Deep water (lake): buoyancy and hydrodynamic drag on the body, sampled at the hull points,
   * and the engine hydro-locks once the air intake goes under.
   */
  private deepWater(): void {
    const body = this.body;
    const level = this.terrain.waterLevel;
    const pts = this.spec.hullPoints;
    const n = pts.length;
    this.submerged = 0;
    for (const hp of pts) {
      const p = body.localToWorld(this.tmp.set(hp[0], hp[1], hp[2]), this.tmp2);
      const depth = level - p.y;
      if (depth <= 0) continue;
      // Each point stands for a 0.6 m slab of a partly air-tight shell (~2.1 m^3 of displacement).
      const frac = Math.min(1, depth / 0.6);
      this.submerged += frac / n;
      const v = body.pointVelocity(p, this.pv);
      const speed = v.length();
      const drag = (0.5 * WATER_DENSITY * 1.0 * (2.4 / n) * frac) * speed;
      this.f.set(-v.x * drag, (WATER_DENSITY * GRAVITY * 2.1 * frac) / n - v.y * drag, -v.z * drag);
      body.addForceAtPoint(this.f, p);
    }
    const intake = body.localToWorld(this.tmp.set(0, 0.22, -1.45), this.tmp2);
    if (intake.y < level) {
      this.drivetrain.running = false;
      this.drivetrain.hydroLocked = true;
    }
  }

  private hullContacts(): void {
    const body = this.body;
    const s = this.sample;
    this.hullContact = false;
    for (const hp of this.spec.hullPoints) {
      const p = body.localToWorld(this.tmp.set(hp[0], hp[1], hp[2]), this.tmp2);
      const h = this.terrain.sample(p.x, p.z, s);
      const pen = h - p.y;
      if (pen <= 0) continue;
      this.hullContact = true;
      const v = body.pointVelocity(p, this.pv);
      const fn = Math.max(0, 160000 * pen - 7000 * v.y);
      // Steel on tarmac scrapes (~0.5); belly in mud/sand bulldozes harder.
      const soft = s.weights[1] + s.weights[2] + s.weights[3];
      const muB = 0.45 + 0.35 * soft;
      const vh = Math.hypot(v.x, v.z);
      const k = (muB * fn) / Math.max(vh, 0.3);
      this.f.set(-v.x * k, fn, -v.z * k);
      body.addForceAtPoint(this.f, p);
    }
  }

  private updateTelemetry(dt: number): void {
    const b = this.body;
    rotateInv(b.orientation, b.velocity, this.localVelocity);
    this.speed = b.velocity.length();
    this.forwardSpeed = -this.localVelocity.z;
    this.yawRate = -b.angularVelocity.dot(this.up); // + = turning right
    const acc = this.tmp.copy(b.velocity).sub(this.prevVelocity).scale(1 / dt);
    this.prevVelocity.copy(b.velocity);
    const la = rotateInv(b.orientation, acc, this.tmp2);
    // Low-pass: per-step acceleration is noisy at 1 kHz.
    this.lateralAccel += (la.x - this.lateralAccel) * 0.02;
    this.longitudinalAccel += (-la.z - this.longitudinalAccel) * 0.02;
    // Front axle centre velocity in body frame -> slip direction for steering assists.
    // v_axle = v + w x r with r = (0, 0, -a): lateral component v.x + w.y * (-a).
    const axleZ = -this.spec.cgToFrontAxle;
    const lvx = this.localVelocity.x + rotateInv(b.orientation, b.angularVelocity, this.tmp3).y * axleZ;
    const lvz = this.localVelocity.z;
    this.frontAxleSlip = Math.abs(lvz) + Math.abs(lvx) > 0.5 ? Math.atan2(lvx, Math.abs(lvz)) : 0;
  }
}
