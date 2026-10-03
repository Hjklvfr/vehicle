import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createVaz2106Model } from '../render/carModel.ts';
import { ForceDebug, WheelEffects } from '../render/effects.ts';
import { TerrainView } from '../render/terrainView.ts';
import { DriverAssists } from '../sim/assists.ts';
import { LAYERS, LAYER_COUNT } from '../sim/surfaces.ts';
import { Vehicle, createControls } from '../sim/vehicle.ts';
import { VAZ_2106 } from '../sim/vehicles/vaz2106.ts';
import { PLACES, generatePlayground } from '../world/playground.ts';
import { CameraRig } from './camera.ts';
import { Hud } from './hud.ts';
import { InputDevice } from './input.ts';
import { SettingsPanel, loadAssistSettings } from './settings.ts';

/** Physics runs at a fixed 1 kHz regardless of frame rate (tire relaxation + clutch need it). */
const PHYSICS_DT = 1 / 1000;
const MAX_STEPS_PER_FRAME = 120;

const app = document.getElementById('app')!;
const loading = document.createElement('div');
loading.className = 'loading';
loading.textContent = 'Generating playground…';
document.body.append(loading);
// Let the loading text paint before the (blocking) world generation.
const painted = Promise.withResolvers<void>();
requestAnimationFrame(() => setTimeout(painted.resolve, 0));
await painted.promise;

// ---------------- Renderer & scene ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 1500);

const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(135));
const sky = new Sky();
sky.scale.setScalar(1000);
const su = sky.material.uniforms;
su.turbidity.value = 4;
su.rayleigh.value = 1.2;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.8;
su.sunPosition.value.copy(sunDir);
scene.add(sky);
// Sky-lit environment map so wet tarmac and puddles reflect the actual sky.
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(sky.clone());
scene.environment = pmrem.fromScene(envScene, 0, 0.1, 2000).texture;
scene.environmentIntensity = 0.5;
scene.fog = new THREE.Fog(0xb9c7d6, 120, 700);

const sun = new THREE.DirectionalLight(0xfff1dc, 4.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -30;
sc.right = sc.top = 30;
sc.near = 1;
sc.far = 200;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x5a4a35, 0.9));

// ---------------- World & vehicle ----------------
const terrain = generatePlayground();
const terrainView = new TerrainView(terrain, renderer);
scene.add(terrainView.object);

const spec = VAZ_2106;
const vehicle = new Vehicle(spec, terrain);
const car = createVaz2106Model({
  ...spec.dimensions, wheelbase: spec.wheelbase, frontTrack: spec.axles[0].track, rearTrack: spec.axles[1].track,
  wheelRadius: spec.tire.radius, tireWidth: spec.tire.width, cgToFrontAxle: spec.cgToFrontAxle, cgHeight: spec.cgHeight,
});
scene.add(car.root);

const effects = new WheelEffects(terrain);
effects.setViewportHeight(innerHeight * renderer.getPixelRatio());
scene.add(effects.object);
const forceDebug = new ForceDebug();
scene.add(forceDebug.object);

const settings = loadAssistSettings();
const assists = new DriverAssists(settings);
const controls = createControls();
const input = new InputDevice(window);
const rig = new CameraRig(camera, renderer.domElement, terrain);
const hud = new Hud();
document.body.append(hud.element);
const panel = new SettingsPanel(settings, () => panel.toggle());
document.body.append(panel.element);

let headlights = false;
let parked = true;

let lastPlace = 0;
function teleport(i: number): void {
  lastPlace = i;
  const p = PLACES[i];
  vehicle.reset(p.x, p.z, p.heading);
  assists.reset();
  parked = true;
  hud.setPlace(p.name);
}

function resetInPlace(): void {
  // Can't right the car in the lake: go back to the last teleport spot instead.
  if (vehicle.submerged > 0.05) return teleport(lastPlace);
  const f = vehicle.forward;
  const p = vehicle.body.position;
  vehicle.reset(p.x, p.z, Math.atan2(f.x, -f.z));
  assists.reset();
  parked = true;
}

teleport(0);
loading.remove();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  effects.setViewportHeight(innerHeight * renderer.getPixelRatio());
});

// ---------------- Main loop ----------------
const qSteer = new THREE.Quaternion();
const qSpin = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
let accumulator = 0;
let last = performance.now();
let surfaceTimer = 0;
let placeShownUntil = performance.now() + 6000;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  for (const a of input.poll()) {
    if (a === 'settings') panel.toggle();
    else if (a === 'shiftUp') assists.requestShift(vehicle, 1);
    else if (a === 'shiftDown') assists.requestShift(vehicle, -1);
    else if (a === 'reset') resetInPlace();
    else if (a === 'camera') rig.cycle();
    else if (a === 'telemetry') hud.toggleTelemetry();
    else if (a === 'help') hud.toggleHelp();
    else if (a === 'debug') forceDebug.object.visible = !forceDebug.object.visible;
    else if (a === 'lights') headlights = !headlights;
    else if (a === 'ignition') vehicle.drivetrain.startEngine();
    else if (a.startsWith('teleport')) {
      teleport(Number(a.slice(-1)) - 1);
      placeShownUntil = now + 6000;
    }
  }

  accumulator += dt;
  let steps = 0;
  // Parked after a reset/teleport: handbrake stays on until the driver uses a pedal.
  if (input.driver.throttle > 0 || input.driver.brake > 0) parked = false;
  if (parked) input.driver.handbrake = 1;
  while (accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
    assists.update(PHYSICS_DT, input.driver, vehicle, controls);
    vehicle.step(PHYSICS_DT, controls);
    accumulator -= PHYSICS_DT;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

  // ---- Sync visuals ----
  const b = vehicle.body;
  car.root.position.set(b.position.x, b.position.y, b.position.z);
  car.root.quaternion.set(b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w);
  for (let i = 0; i < 4; i++) {
    const w = vehicle.wheels[i];
    const m = car.wheels[i];
    m.position.set(w.hubLocal.x, w.hubLocal.y, w.hubLocal.z);
    // + steer = right = negative rotation about Y; forward roll = negative rotation about X.
    qSteer.setFromAxisAngle(AXIS_Y, -w.steer);
    qSpin.setFromAxisAngle(AXIS_X, -w.spinAngle);
    m.quaternion.copy(qSteer).multiply(qSpin);
  }
  car.setLights({
    brake: controls.brakes.some((x) => x > 0.05),
    reverse: vehicle.drivetrain.selectedGear < 0,
    headlights,
  });

  terrainView.update();
  effects.update(dt, vehicle);
  forceDebug.update(vehicle);
  rig.update(dt, vehicle);
  sun.position.set(b.position.x + sunDir.x * 80, b.position.y + sunDir.y * 80, b.position.z + sunDir.z * 80);
  sun.target.position.set(b.position.x, b.position.y, b.position.z);

  hud.update(dt, vehicle, controls, assists, settings);
  surfaceTimer -= dt;
  if (now > placeShownUntil && surfaceTimer <= 0) {
    surfaceTimer = 0.25;
    hud.setPlace(describeSurface());
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/** Live surface mix under the car, e.g. "tarmac 55% · sand 45% · wet 0%". */
function describeSurface(): string {
  const mix = new Float32Array(LAYER_COUNT);
  let wet = 0, water = 0, n = 0;
  for (const w of vehicle.wheels) {
    if (!w.inContact) continue;
    n++;
    for (let l = 0; l < LAYER_COUNT; l++) mix[l] += w.layerWeights[l];
    wet += w.wetness;
    water = Math.max(water, w.water);
  }
  if (n === 0) return 'airborne';
  const parts: string[] = [];
  for (let l = 0; l < LAYER_COUNT; l++) if (mix[l] / n > 0.02) parts.push(`${LAYERS[l]} ${Math.round((mix[l] / n) * 100)}%`);
  parts.push(`wet ${Math.round((wet / n) * 100)}%`);
  if (water > 0.002) parts.push(`water ${Math.round(water * 1000)} mm`);
  return parts.join(' · ');
}

requestAnimationFrame(frame);
