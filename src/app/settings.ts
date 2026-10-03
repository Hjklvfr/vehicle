import { ASSIST_PRESETS, type AssistPresetName, type AssistSettings } from '../sim/assists.ts';

const STORAGE_KEY = 'vaz2106.assists.v1';

type BoolKey = { [K in keyof AssistSettings]: AssistSettings[K] extends boolean ? K : never }[keyof AssistSettings];
type NumKey = { [K in keyof AssistSettings]: AssistSettings[K] extends number ? K : never }[keyof AssistSettings];

const SLIDERS: { key: NumKey; label: string; hint: string; min: number; max: number; step: number }[] = [
  { key: 'steeringAssist', label: 'Steering assist', hint: 'Speed-sensitive lock; full input = front tires at peak slip angle', min: 0, max: 1, step: 0.05 },
  { key: 'countersteer', label: 'Countersteer assist', hint: 'Turns the wheels into a slide automatically', min: 0, max: 1, step: 0.05 },
  { key: 'steeringSpeed', label: 'Keyboard steering speed', hint: 'How fast A/D move the wheel', min: 0.5, max: 2, step: 0.05 },
];

const TOGGLES: { key: BoolKey; label: string; hint: string }[] = [
  { key: 'pedalSmoothing', label: 'Pedal smoothing', hint: 'Ramp keyboard throttle/brake like a real foot' },
  { key: 'abs', label: 'ABS', hint: 'Anti-lock brakes (not fitted to a real 2106)' },
  { key: 'tcs', label: 'Traction control', hint: 'Throttle cut + brake-based diff lock' },
  { key: 'esc', label: 'Stability control', hint: 'Yaw control by braking individual wheels' },
  { key: 'autoClutch', label: 'Automatic clutch', hint: 'Off: hold Shift for the clutch pedal; the engine can stall' },
  { key: 'autoGearbox', label: 'Automatic gear changes', hint: 'Off: E/Q to shift; S at standstill does not select reverse' },
];

const PRESET_LABELS: Record<AssistPresetName, string> = {
  simulation: 'Simulation (stock 2106)',
  keyboard: 'Keyboard',
  assisted: 'Fully assisted',
};

export function loadAssistSettings(): AssistSettings {
  const base = { ...ASSIST_PRESETS.keyboard };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage: fall back to defaults.
  }
  return base;
}

/** Settings overlay bound to a live AssistSettings object (mutated in place). */
export class SettingsPanel {
  readonly element: HTMLElement;
  private readonly refreshers: (() => void)[] = [];

  constructor(private readonly settings: AssistSettings, onClose: () => void) {
    const el = document.createElement('div');
    el.className = 'panel settings hidden';
    el.innerHTML = `<h2>Driving assists</h2><div class="presets"></div><div class="rows"></div>
      <p class="note">Settings are saved in this browser. Esc / O closes.</p>`;
    const presets = el.querySelector('.presets')!;
    for (const name of Object.keys(ASSIST_PRESETS) as AssistPresetName[]) {
      const b = document.createElement('button');
      b.textContent = PRESET_LABELS[name];
      b.onclick = () => {
        Object.assign(this.settings, ASSIST_PRESETS[name]);
        this.changed();
      };
      presets.append(b);
    }
    const rows = el.querySelector('.rows')!;
    for (const s of SLIDERS) {
      const row = document.createElement('label');
      row.className = 'row';
      row.title = s.hint;
      row.innerHTML = `<span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><output></output>`;
      const input = row.querySelector('input')!;
      const out = row.querySelector('output')!;
      input.oninput = () => {
        this.settings[s.key] = Number(input.value);
        this.changed();
      };
      this.refreshers.push(() => {
        input.value = String(this.settings[s.key]);
        out.textContent = this.settings[s.key].toFixed(2);
      });
      rows.append(row);
    }
    for (const t of TOGGLES) {
      const row = document.createElement('label');
      row.className = 'row';
      row.title = t.hint;
      row.innerHTML = `<span>${t.label}</span><input type="checkbox"><small>${t.hint}</small>`;
      const input = row.querySelector('input')!;
      input.onchange = () => {
        this.settings[t.key] = input.checked;
        this.changed();
      };
      this.refreshers.push(() => { input.checked = this.settings[t.key]; });
      rows.append(row);
    }
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = 'Close';
    close.onclick = onClose;
    el.append(close);
    this.element = el;
    this.refresh();
  }

  get visible(): boolean {
    return !this.element.classList.contains('hidden');
  }

  toggle(): void {
    this.element.classList.toggle('hidden');
    this.refresh();
  }

  private changed(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    this.refresh();
  }

  private refresh(): void {
    for (const r of this.refreshers) r();
  }
}
