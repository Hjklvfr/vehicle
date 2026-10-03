/**
 * Headless physics benchmarks: run with `npm run sim`.
 * Compares the VAZ-2106 model against factory figures and prints per-surface and
 * surface-transition behaviour, so tuning changes can be checked without the renderer
 * (and later compared against the Unity port).
 */
import { ASSIST_PRESETS, DriverAssists, createDriverInput, type AssistSettings, type DriverInput } from '../src/sim/assists.ts';
import { LAYERS, LAYER_COUNT, MUD, SAND, TARMAC } from '../src/sim/surfaces.ts';
import { Terrain } from '../src/sim/terrain.ts';
import { Vehicle, createControls } from '../src/sim/vehicle.ts';
import { VAZ_2106 } from '../src/sim/vehicles/vaz2106.ts';

const DT = 1 / 1000;
const KMH = 3.6;

/** Surface layout as a function of position: returns [layer, wetness]. */
type Layout = (x: number, z: number) => [number, number];

function makeTerrain(size: number, cell: number, layout: Layout, slope = 0): Terrain {
  const res = Math.round(size / cell);
  const t = new Terrain(size, res, Math.min(res * 2, 4096), -100);
  const v = t.verts;
  for (let iz = 0; iz < v; iz++) {
    for (let ix = 0; ix < v; ix++) {
      const i = iz * v + ix;
      const x = -size / 2 + ix * t.cell;
      const z = -size / 2 + iz * t.cell;
      const [layer, wet] = layout(x, z);
      t.height[i] = -z * slope;
      for (let l = 0; l < LAYER_COUNT; l++) t.splat[i * 4 + l] = l === layer ? 255 : 0;
      t.env[i * 4] = Math.round(wet * 255);
    }
  }
  return t;
}

class Run {
  readonly vehicle: Vehicle;
  readonly assists: DriverAssists;
  readonly input: DriverInput = createDriverInput();
  readonly controls = createControls();
  time = 0;
  constructor(terrain: Terrain, settings: AssistSettings, x = 0, z = 0) {
    this.vehicle = new Vehicle(VAZ_2106, terrain);
    this.vehicle.reset(x, z, 0);
    this.assists = new DriverAssists({ ...settings });
    this.input.analog = true;
  }
  step(): void {
    this.assists.update(DT, this.input, this.vehicle, this.controls);
    this.vehicle.step(DT, this.controls);
    this.time += DT;
  }
  run(seconds: number, each?: () => void): void {
    for (let t = 0; t < seconds; t += DT) { this.step(); each?.(); }
  }
  /** Launch the settled car straight ahead at `kmh` in a matching gear (skips the run-up). */
  launch(kmh: number, gear: number): void {
    this.run(1.5);
    const v = kmh / KMH;
    this.vehicle.body.velocity.set(0, 0, -v);
    for (const w of this.vehicle.wheels) w.omega = v / w.radius;
    const d = this.vehicle.drivetrain;
    d.gear = gear;
    d.engineOmega = Math.abs(d.ratio(gear)) * (v / this.vehicle.spec.tire.radius);
    this.step();
    this.time = 0;
  }
  get kmh(): number {
    return this.vehicle.forwardSpeed * KMH;
  }
  get pos() {
    return this.vehicle.body.position;
  }
}

const auto: AssistSettings = { ...ASSIST_PRESETS.simulation, autoGearbox: true };
const fmt = (v: number, d = 1) => v.toFixed(d).padStart(7);

function accelTo(run: Run, targetKmh: number, maxTime: number): number {
  run.input.throttle = 1;
  while (run.kmh < targetKmh && run.time < maxTime) run.step();
  return run.kmh >= targetKmh ? run.time : NaN;
}

/** Brake to a stop with the clutch down; returns stopping distance (m). */
function stop(run: Run): number {
  run.input.throttle = 0;
  run.input.brake = 1;
  run.input.clutchPedal = 1;
  const z0 = run.pos.z;
  let t = 0;
  while (run.vehicle.speed > 0.1 && t < 30) { run.step(); t += DT; }
  return Math.abs(run.pos.z - z0);
}

const uniform = (layer: number, wet: number): Layout => () => [layer, wet];

// ---------------------------------------------------------------------------------------
console.log(`\n== ${VAZ_2106.name} straight line, dry tarmac — factory: 0-100 ≈ 17 s, Vmax 150 km/h ==`);
{
  const run = new Run(makeTerrain(6000, 20, uniform(TARMAC, 0)), auto, 0, 2900);
  run.run(1.5);
  run.time = 0;
  const t60 = accelTo(run, 60, 30);
  const t100 = accelTo(run, 100, 60);
  let vmax = 0;
  run.run(100, () => { vmax = Math.max(vmax, run.kmh); });
  console.log(`0-60 ${fmt(t60, 2)} s   0-100 ${fmt(t100, 2)} s   Vmax ${fmt(vmax)} km/h at ${fmt(run.vehicle.drivetrain.rpm, 0)} rpm`);
}

console.log(`\n== Braking 100→0 km/h — typical 1970s sedan on bias/early radials: 45–55 m dry ==`);
for (const [name, wet, abs] of [['dry', 0, false], ['dry + ABS', 0, true], ['wet', 1, false], ['wet + ABS', 1, true]] as const) {
  const run = new Run(makeTerrain(600, 4, uniform(TARMAC, wet)), { ...auto, abs }, 0, 250);
  run.launch(100, 4);
  const d = stop(run);
  console.log(`${name.padEnd(10)} ${fmt(d)} m   lateral drift ${fmt(run.pos.x, 2)} m`);
}

console.log(`\n== Per-surface (assisted preset: TCS + ESC keep it straight): 0-50 km/h, coast 40→20 km/h, average sinkage ==`);
for (let l = 0; l < LAYER_COUNT; l++) {
  for (const wet of [0, 1]) {
    const run = new Run(makeTerrain(1000, 0.5, uniform(l, wet)), ASSIST_PRESETS.assisted, 0, 480);
    run.run(1.5);
    run.time = 0;
    const t50 = accelTo(run, 50, 40);
    let tCoast = NaN;
    if (!Number.isNaN(t50)) {
      run.input.throttle = 0;
      run.input.clutchPedal = 1;
      while (run.kmh > 40) run.step();
      const t0 = run.time;
      while (run.kmh > 20 && run.time - t0 < 40) run.step();
      tCoast = run.time - t0;
    }
    const sink = run.vehicle.wheels.reduce((a, w) => a + w.sink, 0) / 4;
    console.log(`${(LAYERS[l] + (wet ? ' wet' : ' dry')).padEnd(11)} 0-50 ${fmt(t50, 2)} s   coast ${fmt(tCoast, 2)} s   sink ${fmt(sink * 100)} cm   (reached ${fmt(run.kmh)} km/h)`);
  }
}

console.log(`\n== Steady-state circle, constant steer, slowly rising speed: peak lateral g ==`);
for (const wet of [0, 1]) {
  const run = new Run(makeTerrain(800, 4, uniform(TARMAC, wet)), auto, 0, 0);
  run.run(1.5);
  let maxG = 0;
  run.input.steer = 0.2;
  for (let t = 0; t < 60; t += DT) {
    run.input.throttle = 0.25 + t / 120;
    run.step();
    maxG = Math.max(maxG, Math.abs(run.vehicle.lateralAccel) / 9.81);
  }
  console.log(`${wet ? 'wet' : 'dry'}  ${fmt(maxG, 2)} g`);
}

const splitMu: Layout = (x) => (x < 0 ? [MUD, 1] : [TARMAC, 0]);

console.log(`\n== Split-mu braking from 80 km/h: left wheels wet mud, right dry tarmac ==`);
for (const abs of [false, true]) {
  const run = new Run(makeTerrain(400, 0.25, splitMu), { ...auto, abs }, 0, 180);
  run.launch(80, 3);
  let maxYaw = 0, yaw = 0;
  run.input.brake = 1;
  run.input.clutchPedal = 1;
  while (run.vehicle.speed > 0.3 && run.time < 30) {
    run.step();
    maxYaw = Math.max(maxYaw, Math.abs(run.vehicle.yawRate));
    yaw += run.vehicle.yawRate * DT;
  }
  console.log(`${abs ? 'ABS   ' : 'no ABS'} peak yaw ${fmt(maxYaw, 2)} rad/s   heading change ${fmt((yaw * 180) / Math.PI)}°   (expect rotation toward the dry side: +)`);
}

console.log(`\n== Split-mu launch (open diff): left rear on wet mud, right on dry tarmac, 3 s full throttle ==`);
for (const tcs of [false, true]) {
  const run = new Run(makeTerrain(300, 0.25, splitMu), { ...auto, tcs }, 0, 120);
  run.run(1.5);
  run.input.throttle = 1;
  run.run(3);
  const [, , rl, rr] = run.vehicle.wheels;
  console.log(`${tcs ? 'TCS   ' : 'no TCS'} ${fmt(run.kmh)} km/h   RL ω·r ${fmt(rl.omega * rl.radius)} m/s   RR ω·r ${fmt(rr.omega * rr.radius)} m/s`);
}

console.log(`\n== Right wheels run off onto a sand shoulder at 70 km/h, steering fixed ==`);
{
  // Tarmac everywhere except a sand strip that starts at z < 0 for x > 0.3 (right wheels only).
  const layout: Layout = (x, z) => (x > 0.3 && z < 0 ? [SAND, 0] : [TARMAC, 0]);
  const run = new Run(makeTerrain(400, 0.25, layout), auto, 0, 60);
  run.launch(70, 3);
  run.input.throttle = 0.3;
  let maxYaw = 0, yaw = 0;
  while (run.pos.z > -60) {
    run.step();
    if (run.pos.z < 0) { maxYaw = Math.max(maxYaw, Math.abs(run.vehicle.yawRate)); yaw += run.vehicle.yawRate * DT; }
  }
  console.log(`speed ${fmt(run.kmh)} km/h after 60 m, heading change ${fmt((yaw * 180) / Math.PI)}° (+ = pulled right into sand), peak yaw ${fmt(maxYaw, 3)} rad/s`);
}

console.log(`\n== Climbing out of a 6 cm sand rut back onto tarmac lip at 30 km/h ==`);
{
  const layout: Layout = (_x, z) => (z > 0 ? [SAND, 0] : [TARMAC, 0]);
  const t = makeTerrain(300, 0.25, layout);
  // 4 cm asphalt lip.
  for (let iz = 0; iz < t.verts; iz++) for (let ix = 0; ix < t.verts; ix++) {
    if (-150 + iz * t.cell <= 0) t.height[iz * t.verts + ix] += 0.04;
  }
  const run = new Run(t, auto, 0, 40);
  run.launch(30, 2);
  run.input.throttle = 0.4;
  let peakDecel = 0, peakPitch = 0;
  while (run.pos.z > -15) {
    run.step();
    if (run.pos.z < 6) {
      peakDecel = Math.max(peakDecel, -run.vehicle.longitudinalAccel);
      peakPitch = Math.max(peakPitch, Math.abs(run.vehicle.body.angularVelocity.x));
    }
  }
  console.log(`exit speed ${fmt(run.kmh)} km/h, peak decel ${fmt(peakDecel / 9.81, 2)} g, peak pitch rate ${fmt(peakPitch, 2)} rad/s`);
}

console.log(`\n== Handbrake hold on a 20% slope (dry tarmac), engine off ==`);
{
  const run = new Run(makeTerrain(200, 0.5, uniform(TARMAC, 0), 0.2), ASSIST_PRESETS.simulation, 0, 0);
  run.input.handbrake = 1;
  run.vehicle.drivetrain.running = false;
  run.run(3);
  const z0 = run.pos.z;
  run.run(10);
  console.log(`creep over 10 s: ${fmt((run.pos.z - z0) * 1000, 1)} mm`);
}
