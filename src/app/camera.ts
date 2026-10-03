import * as THREE from 'three';
import type { Terrain } from '../sim/terrain.ts';
import type { Vehicle } from '../sim/vehicle.ts';

export const CAMERA_MODES = ['chase', 'wheel', 'hood', 'orbit'] as const;
type Mode = (typeof CAMERA_MODES)[number];

/**
 * Chase (default), front-left wheel close-up (watch suspension and the contact patch
 * cross surface boundaries), bonnet view, and free mouse orbit around the car.
 */
export class CameraRig {
  mode: Mode = 'chase';
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly carQ = new THREE.Quaternion();
  private orbitYaw = 0.6;
  private orbitPitch = 0.35;
  private orbitDist = 7;
  private initialised = false;

  constructor(readonly camera: THREE.PerspectiveCamera, dom: HTMLElement, private readonly terrain: Terrain) {
    let dragging = false;
    dom.addEventListener('pointerdown', (e) => { dragging = true; dom.setPointerCapture(e.pointerId); });
    dom.addEventListener('pointerup', (e) => { dragging = false; dom.releasePointerCapture(e.pointerId); });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging || this.mode !== 'orbit') return;
      this.orbitYaw -= e.movementX * 0.006;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + e.movementY * 0.004, -0.1, 1.4);
    });
    dom.addEventListener('wheel', (e) => {
      if (this.mode === 'orbit') this.orbitDist = THREE.MathUtils.clamp(this.orbitDist * (1 + e.deltaY * 0.001), 3, 40);
    }, { passive: true });
  }

  cycle(): void {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.initialised = false;
  }

  update(dt: number, v: Vehicle): void {
    const p = v.body.position;
    const q = v.body.orientation;
    this.carQ.set(q.x, q.y, q.z, q.w);
    const carPos = this.tmp.set(p.x, p.y, p.z).clone();
    this.fwd.set(0, 0, -1).applyQuaternion(this.carQ);
    const cam = this.camera;

    if (this.mode === 'hood') {
      cam.position.set(0, 0.62, -0.35).applyQuaternion(this.carQ).add(carPos);
      cam.quaternion.copy(this.carQ);
      return;
    }
    if (this.mode === 'wheel') {
      // Outside the front-left wheel, slightly behind, looking at the tire contact.
      const w = v.wheels[0];
      const target = new THREE.Vector3(w.hubLocal.x, w.hubLocal.y - 0.15, w.hubLocal.z).applyQuaternion(this.carQ).add(carPos);
      const eye = new THREE.Vector3(w.hubLocal.x - 1.6, w.hubLocal.y + 0.35, w.hubLocal.z + 1.9).applyQuaternion(this.carQ).add(carPos);
      cam.position.copy(eye);
      cam.lookAt(target);
      return;
    }

    let desired: THREE.Vector3;
    let look: THREE.Vector3;
    if (this.mode === 'orbit') {
      const r = this.orbitDist;
      desired = new THREE.Vector3(
        Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * r,
        Math.sin(this.orbitPitch) * r + 0.5,
        Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * r,
      ).add(carPos);
      look = carPos.clone();
    } else {
      // Chase: follow the direction of travel when moving, heading otherwise (shows slides).
      const flat = new THREE.Vector3(this.fwd.x, 0, this.fwd.z).normalize();
      const vel = new THREE.Vector3(v.body.velocity.x, 0, v.body.velocity.z);
      if (vel.length() > 3 && v.forwardSpeed > 0) flat.lerp(vel.normalize(), 0.5).normalize();
      desired = carPos.clone().addScaledVector(flat, -6.2);
      desired.y += 2.1;
      look = carPos.clone().addScaledVector(flat, 2.5);
      look.y += 0.6;
    }
    const k = this.initialised ? 1 - Math.exp(-dt * (this.mode === 'orbit' ? 20 : 6)) : 1;
    this.pos.lerp(desired, k);
    this.look.lerp(look, this.initialised ? 1 - Math.exp(-dt * 12) : 1);
    this.initialised = true;
    const ground = this.terrain.baseHeight(this.pos.x, this.pos.z) + 0.4;
    if (this.pos.y < ground) this.pos.y = ground;
    cam.position.copy(this.pos);
    cam.lookAt(this.look);
  }
}
