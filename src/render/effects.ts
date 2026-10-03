import * as THREE from 'three';
import { GRASS, MUD, SAND, TARMAC } from '../sim/surfaces.ts';
import type { Terrain } from '../sim/terrain.ts';
import type { Vehicle } from '../sim/vehicle.ts';

const MAX_PARTICLES = 4000;

interface Kind {
  color: [number, number, number];
  size: number;
  life: number;
  alpha: number;
  gravity: number;
  drag: number;
  grow: number;
}

const DUST: Kind = { color: [0.74, 0.65, 0.5], size: 0.9, life: 1.8, alpha: 0.35, gravity: -0.15, drag: 1.6, grow: 1.4 };
const MUD_CLUMP: Kind = { color: [0.24, 0.16, 0.09], size: 0.09, life: 1.4, alpha: 1, gravity: 1, drag: 0.2, grow: 0 };
const SPRAY: Kind = { color: [0.82, 0.86, 0.9], size: 0.25, life: 0.7, alpha: 0.55, gravity: 0.8, drag: 1.2, grow: 1.5 };
const MUDDY_SPRAY: Kind = { ...SPRAY, color: [0.42, 0.33, 0.24], alpha: 0.7 };
const SMOKE: Kind = { color: [0.82, 0.82, 0.82], size: 1.1, life: 2.2, alpha: 0.3, gravity: -0.1, drag: 1.4, grow: 1.6 };

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / -mv.z;
  vAlpha = aAlpha;
  vColor = aColor;
}`;

const FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  gl_FragColor = vec4(vColor, vAlpha * (1.0 - d * 4.0));
  #include <colorspace_fragment>
}`;

/** Pooled point particles: dust, mud clumps, water spray, tire smoke — emitted from wheel telemetry. */
export class WheelEffects {
  readonly object: THREE.Points;
  private readonly pos = new Float32Array(MAX_PARTICLES * 3);
  private readonly vel = new Float32Array(MAX_PARTICLES * 3);
  private readonly col = new Float32Array(MAX_PARTICLES * 3);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly alpha = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly baseAlpha = new Float32Array(MAX_PARTICLES);
  private readonly gravity = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private readonly grow = new Float32Array(MAX_PARTICLES);
  private next = 0;
  private readonly carry = new Float32Array(16);
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly terrain: Terrain) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 600 } },
    });
    this.object = new THREE.Points(g, this.material);
    this.object.frustumCulled = false;
  }

  setViewportHeight(px: number): void {
    this.material.uniforms.uScale.value = px * 0.9;
  }

  private spawn(k: Kind, x: number, y: number, z: number, vx: number, vy: number, vz: number, shade: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([k.color[0] * shade, k.color[1] * shade, k.color[2] * shade], i * 3);
    this.size[i] = k.size * (0.7 + Math.random() * 0.6);
    this.life[i] = this.maxLife[i] = k.life * (0.6 + Math.random() * 0.8);
    this.baseAlpha[i] = k.alpha;
    this.gravity[i] = k.gravity;
    this.drag[i] = k.drag;
    this.grow[i] = k.grow;
  }

  /** Emit from each wheel based on its surface and slip, then integrate. */
  update(dt: number, v: Vehicle): void {
    const bv = v.body.velocity;
    for (const w of v.wheels) {
      if (!w.inContact) continue;
      const lw = w.layerWeights;
      const dry = 1 - w.wetness;
      const speed = Math.abs(w.vx);
      const spin = w.omega * w.radius;
      const slip = w.slipSpeed;
      const c = w.contactPoint;
      const h = w.heading, lat = w.lateral;
      const base = w.index * 4;

      // Dust: dry loose surfaces, from speed and wheelspin.
      const dustAmt = (lw[SAND] * 1 + lw[MUD] * 0.5 + lw[GRASS] * 0.15) * dry;
      const dustRate = dustAmt * (Math.min(1, Math.max(0, speed - 3) / 15) * 40 + Math.min(1, slip / 5) * 70);
      this.emit(base, dustRate * dt, () => this.spawn(DUST, c.x + (Math.random() - 0.5) * 0.3, c.y + 0.1, c.z + (Math.random() - 0.5) * 0.3,
        bv.x * 0.3 + (Math.random() - 0.5), 0.6 + Math.random() * 0.8, bv.z * 0.3 + (Math.random() - 0.5), 0.9 + Math.random() * 0.2));

      // Mud clumps: thrown back off the tread by wheelspin (and some at speed).
      const mudAmt = lw[MUD] * (0.3 + 0.7 * w.wetness) + w.coating * 0.3;
      const mudRate = mudAmt * (Math.min(1, slip / 6) * 120 + Math.min(1, speed / 20) * 20);
      this.emit(base + 1, mudRate * dt, () => {
        const back = -spin * (0.4 + Math.random() * 0.4);
        const side = (Math.random() - 0.5) * 1.5;
        this.spawn(MUD_CLUMP, c.x - h.x * 0.25, c.y + 0.12, c.z - h.z * 0.25,
          bv.x + h.x * back + lat.x * side, 1 + Math.random() * 2.5, bv.z + h.z * back + lat.z * side, 0.8 + Math.random() * 0.4);
      });

      // Water spray from puddles: sideways bow wave plus rooster tail; brown in muddy water.
      const water = Math.min(1, w.water / 0.02);
      const sprayRate = water * Math.min(1, speed / 15) * 220 + (water > 0 ? Math.min(1, slip / 6) * 60 : 0);
      const spray = lw[MUD] > 0.3 ? MUDDY_SPRAY : SPRAY;
      this.emit(base + 2, sprayRate * dt, () => {
        const side = (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 2.5);
        this.spawn(spray, c.x, c.y + 0.05, c.z,
          bv.x * 0.6 + lat.x * side, 1 + Math.random() * 2, bv.z * 0.6 + lat.z * side, 1);
      });

      // Tire smoke: sliding on dry tarmac.
      const smokeAmt = lw[TARMAC] * dry * Math.max(0, Math.min(1, (slip - 3) / 6)) * (w.tireOut.slip > 1.3 ? 1 : 0);
      this.emit(base + 3, smokeAmt * 60 * dt, () => this.spawn(SMOKE, c.x, c.y + 0.15, c.z,
        bv.x * 0.2 + (Math.random() - 0.5), 0.4 + Math.random() * 0.5, bv.z * 0.2 + (Math.random() - 0.5), 0.95));
    }
    this.integrate(dt);
  }

  /** Fractional emission with carry-over so low rates still emit. */
  private emit(slot: number, count: number, fn: () => void): void {
    this.carry[slot] += count;
    while (this.carry[slot] >= 1) {
      fn();
      this.carry[slot] -= 1;
    }
  }

  private integrate(dt: number): void {
    const p = this.pos, vl = this.vel;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const j = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      vl[j] *= dr; vl[j + 2] *= dr;
      vl[j + 1] = vl[j + 1] * dr - 9.81 * this.gravity[i] * dt;
      p[j] += vl[j] * dt; p[j + 1] += vl[j + 1] * dt; p[j + 2] += vl[j + 2] * dt;
      const ground = this.terrain.baseHeight(p[j], p[j + 2]);
      if (p[j + 1] < ground) {
        p[j + 1] = ground;
        vl[j] = vl[j + 1] = vl[j + 2] = 0;
        if (this.gravity[i] > 0.5) this.life[i] = Math.min(this.life[i], 0.15);
      }
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = this.baseAlpha[i] * Math.min(1, t * 2.5) * (t > 0 ? 1 : 0);
      this.size[i] *= 1 + this.grow[i] * dt;
    }
    const g = this.object.geometry;
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) g.getAttribute(name).needsUpdate = true;
  }
}

/** Per-wheel force arrows: green = normal load, red = tire friction force (1 m per 3 kN). */
export class ForceDebug {
  readonly object = new THREE.Group();
  private readonly normal: THREE.ArrowHelper[] = [];
  private readonly friction: THREE.ArrowHelper[] = [];
  private readonly dir = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < 4; i++) {
      const n = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0x33ff66, 0.12, 0.08);
      const f = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xff3333, 0.12, 0.08);
      this.normal.push(n);
      this.friction.push(f);
      this.object.add(n, f);
    }
    // Draw through the car body so contact forces stay visible from the chase camera.
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.material.depthTest = false;
        o.renderOrder = 999;
      }
    });
    this.object.visible = false;
  }

  update(v: Vehicle): void {
    if (!this.object.visible) return;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const n = this.normal[i], f = this.friction[i];
      n.visible = f.visible = w.inContact;
      if (!w.inContact) continue;
      const c = w.contactPoint;
      this.origin.set(c.x, c.y + 0.02, c.z);
      n.position.copy(this.origin);
      n.setDirection(this.dir.set(w.contactNormal.x, w.contactNormal.y, w.contactNormal.z));
      n.setLength(Math.max(0.05, w.load / 3000), 0.12, 0.08);
      const fx = w.tireOut.fx, fy = w.tireOut.fy;
      this.dir.set(w.heading.x * fx + w.lateral.x * fy, w.heading.y * fx + w.lateral.y * fy, w.heading.z * fx + w.lateral.z * fy);
      const mag = this.dir.length();
      f.position.copy(this.origin);
      if (mag > 1) f.setDirection(this.dir.normalize());
      f.setLength(Math.max(0.05, mag / 3000), 0.12, 0.08);
    }
  }
}
