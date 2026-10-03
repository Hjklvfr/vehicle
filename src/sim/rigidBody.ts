import { Quat, Vec3, rotate, rotateInv } from './math.ts';

/**
 * 6-DOF rigid body with a diagonal body-space inertia tensor, integrated with
 * semi-implicit Euler (forces accumulated per step, then cleared).
 * Unity port: replace with Rigidbody (AddForceAtPosition, inertiaTensor, centerOfMass).
 */
export class RigidBody {
  readonly position = new Vec3();
  readonly orientation = new Quat();
  readonly velocity = new Vec3();
  /** World-space angular velocity (rad/s). */
  readonly angularVelocity = new Vec3();

  private readonly force = new Vec3();
  private readonly torque = new Vec3();
  private readonly tmpA = new Vec3();
  private readonly tmpB = new Vec3();

  constructor(
    public mass: number,
    /** Principal moments in body frame (x = pitch, y = yaw, z = roll). */
    public inertia: Vec3,
  ) {}

  /** World velocity of a world-space point attached to the body. */
  pointVelocity(worldPoint: Vec3, out: Vec3): Vec3 {
    const r = this.tmpA.copy(worldPoint).sub(this.position);
    out.crossVectors(this.angularVelocity, r);
    return out.add(this.velocity);
  }

  localToWorld(local: Vec3, out: Vec3): Vec3 {
    return rotate(this.orientation, local, out).add(this.position);
  }

  addForce(f: Vec3): void {
    this.force.add(f);
  }

  addForceAtPoint(f: Vec3, worldPoint: Vec3): void {
    this.force.add(f);
    const r = this.tmpA.copy(worldPoint).sub(this.position);
    this.torque.add(this.tmpB.crossVectors(r, f));
  }

  addTorque(t: Vec3): void {
    this.torque.add(t);
  }

  integrate(dt: number, gravity: number): void {
    const m = this.mass;
    this.velocity.x += (this.force.x / m) * dt;
    this.velocity.y += (this.force.y / m - gravity) * dt;
    this.velocity.z += (this.force.z / m) * dt;

    // Angular: Euler's equations in body frame, I dw/dt = tau - w x (I w).
    const wb = rotateInv(this.orientation, this.angularVelocity, this.tmpA);
    const tb = rotateInv(this.orientation, this.torque, this.tmpB);
    const I = this.inertia;
    const Lx = I.x * wb.x, Ly = I.y * wb.y, Lz = I.z * wb.z;
    const gx = wb.y * Lz - wb.z * Ly;
    const gy = wb.z * Lx - wb.x * Lz;
    const gz = wb.x * Ly - wb.y * Lx;
    wb.x += ((tb.x - gx) / I.x) * dt;
    wb.y += ((tb.y - gy) / I.y) * dt;
    wb.z += ((tb.z - gz) / I.z) * dt;
    rotate(this.orientation, wb, this.angularVelocity);

    this.position.addScaled(this.velocity, dt);
    this.orientation.integrate(this.angularVelocity, dt);

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }
}
