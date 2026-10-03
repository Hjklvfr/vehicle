import type { AssistSettings, DriverAssists } from '../sim/assists.ts';
import { LAYERS, LAYER_COUNT } from '../sim/surfaces.ts';
import type { Vehicle, VehicleControls } from '../sim/vehicle.ts';

const LAYER_COLORS = ['#4a4d52', '#d9c38f', '#6e4b2d', '#5d7d36'];
const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];
const REDLINE = 6000;
const RPM_MAX = 7000;

const HELP = `
<b>Drive</b> W/S or ↑/↓ throttle / brake (S at standstill → reverse in auto)<br>
A/D or ←/→ steer · Space handbrake · Shift clutch pedal<br>
E / Q gear up / down · I start engine · L headlights<br>
<b>View</b> C camera · T telemetry · F force vectors · H help<br>
<b>Places</b> 1 skid pad (dry | wet) · 2 transition lane · 3 shoulder drop-off<br>
4 mud pit · 5 dunes & beach · 6 wet ring road<br>
R reset car · Esc / O assists settings · gamepad supported
`;

interface WheelCard {
  bar: HTMLElement[];
  text: HTMLElement;
}

export class Hud {
  readonly element: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly rpmFill: HTMLElement;
  private readonly rpmText: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly mode: HTMLElement;
  private readonly lamps: Record<string, HTMLElement> = {};
  private readonly telemetry: HTMLElement;
  private readonly cards: WheelCard[] = [];
  private readonly help: HTMLElement;
  private readonly status: HTMLElement;
  private readonly place: HTMLElement;
  private telemetryTimer = 0;

  constructor() {
    const el = document.createElement('div');
    el.className = 'hud';
    el.innerHTML = `
      <div class="help panel">${HELP}</div>
      <div class="place"></div>
      <div class="status"></div>
      <div class="dash panel">
        <div class="speed"><span class="v">0</span><small>km/h</small></div>
        <div class="gearbox"><span class="gear">N</span><small class="mode"></small></div>
        <div class="rpm"><div class="fill"></div><div class="red"></div><span class="t"></span></div>
        <div class="lamps"></div>
      </div>
      <div class="telemetry panel"></div>`;
    this.speed = el.querySelector('.speed .v')!;
    this.rpmFill = el.querySelector('.rpm .fill')!;
    this.rpmText = el.querySelector('.rpm .t')!;
    this.gear = el.querySelector('.gear')!;
    this.mode = el.querySelector('.mode')!;
    this.help = el.querySelector('.help')!;
    this.status = el.querySelector('.status')!;
    this.place = el.querySelector('.place')!;
    (el.querySelector('.rpm .red') as HTMLElement).style.left = `${(REDLINE / RPM_MAX) * 100}%`;
    const lamps = el.querySelector('.lamps')!;
    for (const name of ['ABS', 'TCS', 'ESC', 'CLUTCH', 'AQUA', 'HB']) {
      const l = document.createElement('span');
      l.textContent = name;
      lamps.append(l);
      this.lamps[name] = l;
    }
    this.telemetry = el.querySelector('.telemetry')!;
    for (let i = 0; i < 4; i++) {
      const card = document.createElement('div');
      card.className = 'wheel';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const segs: HTMLElement[] = [];
      for (let l = 0; l < LAYER_COUNT; l++) {
        const s = document.createElement('i');
        s.style.background = LAYER_COLORS[l];
        s.title = LAYERS[l];
        bar.append(s);
        segs.push(s);
      }
      const text = document.createElement('pre');
      card.append(bar, text);
      this.telemetry.append(card);
      this.cards.push({ bar: segs, text });
    }
    this.element = el;
  }

  toggleTelemetry(): void {
    this.telemetry.classList.toggle('hidden');
  }
  toggleHelp(): void {
    this.help.classList.toggle('hidden');
  }
  setPlace(name: string): void {
    this.place.textContent = name;
  }

  update(dt: number, v: Vehicle, controls: VehicleControls, assists: DriverAssists, settings: AssistSettings): void {
    const d = v.drivetrain;
    this.speed.textContent = Math.round(Math.abs(v.forwardSpeed) * 3.6).toString();
    const rpm = d.rpm;
    this.rpmFill.style.width = `${Math.min(100, (rpm / RPM_MAX) * 100)}%`;
    this.rpmFill.classList.toggle('hot', rpm > REDLINE);
    this.rpmText.textContent = `${Math.round(rpm / 10) * 10} rpm`;
    const g = d.selectedGear;
    this.gear.textContent = (g < 0 ? 'R' : g === 0 ? 'N' : String(g)) + (d.isShifting ? '…' : '');
    this.mode.textContent = settings.autoGearbox ? 'auto' : 'manual';
    this.lamps.ABS.classList.toggle('on', assists.absActive);
    this.lamps.TCS.classList.toggle('on', assists.tcsActive);
    this.lamps.ESC.classList.toggle('on', assists.escActive);
    this.lamps.CLUTCH.classList.toggle('on', d.clutchSlipping || controls.clutch < 0.95);
    this.lamps.AQUA.classList.toggle('on', v.wheels.some((w) => w.hydroplaning > 0.3));
    this.status.textContent = v.submerged > 0.05 ? 'Deep water — engine hydro-locked, press R to recover'
      : !d.running ? 'ENGINE STALLED — press I (or throttle with auto clutch)'
      : v.hullContact ? 'Body touching the ground' : '';
    this.lamps.HB.classList.toggle('on', controls.handbrake > 0);

    this.telemetryTimer -= dt;
    if (this.telemetryTimer > 0 || this.telemetry.classList.contains('hidden')) return;
    this.telemetryTimer = 0.1;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const c = this.cards[i];
      for (let l = 0; l < LAYER_COUNT; l++) c.bar[l].style.flexGrow = (w.inContact ? w.layerWeights[l] : 0).toFixed(3);
      const deg = (w.slipAngle * 180) / Math.PI;
      c.text.textContent = w.inContact
        ? `${WHEEL_NAMES[i]}  load ${(w.load / 1000).toFixed(2)} kN\n` +
          `slip ${w.slipRatio.toFixed(2).padStart(5)}  α ${deg.toFixed(1).padStart(5)}°\n` +
          `μ ${w.mu.toFixed(2)}  wet ${(w.wetness * 100).toFixed(0).padStart(3)}%  water ${(w.water * 1000).toFixed(0)}mm\n` +
          `sink ${(w.sink * 100).toFixed(1)}cm  rr ${w.rollingResistance.toFixed(3)}\n` +
          `mud on tread ${(w.coating * 100).toFixed(0)}%${w.hydroplaning > 0.05 ? `  aqua ${(w.hydroplaning * 100).toFixed(0)}%` : ''}`
        : `${WHEEL_NAMES[i]}  — airborne —\n\n\n\n`;
    }
  }
}
