import { createDriverInput, type DriverInput } from '../sim/assists.ts';

/** One-shot actions, consumed once per frame. */
export type Action =
  | 'shiftUp' | 'shiftDown' | 'reset' | 'camera' | 'telemetry' | 'debug' | 'help' | 'lights'
  | 'ignition' | 'settings' | 'teleport1' | 'teleport2' | 'teleport3' | 'teleport4' | 'teleport5' | 'teleport6';

const KEY_ACTIONS: Record<string, Action> = {
  KeyE: 'shiftUp', KeyQ: 'shiftDown', KeyR: 'reset', KeyC: 'camera', KeyT: 'telemetry', KeyF: 'debug',
  KeyH: 'help', KeyL: 'lights', KeyI: 'ignition', Escape: 'settings', KeyO: 'settings',
  Digit1: 'teleport1', Digit2: 'teleport2', Digit3: 'teleport3', Digit4: 'teleport4', Digit5: 'teleport5', Digit6: 'teleport6',
};

// Standard-mapping gamepad buttons.
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9 };
const PAD_ACTIONS: [number, Action][] = [
  [PAD.RB, 'shiftUp'], [PAD.LB, 'shiftDown'], [PAD.Y, 'camera'], [PAD.BACK, 'reset'], [PAD.START, 'settings'],
];

/** Keyboard + gamepad. Keyboard gives digital values; the assists layer smooths them. */
export class InputDevice {
  readonly driver: DriverInput = createDriverInput();
  private readonly held = new Set<string>();
  private readonly actions: Action[] = [];
  private readonly padPrev: boolean[] = [];

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!e.repeat && KEY_ACTIONS[e.code]) this.actions.push(KEY_ACTIONS[e.code]);
      this.held.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  /** Poll devices; returns actions triggered since the last poll. */
  poll(): Action[] {
    const k = this.held;
    const d = this.driver;
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    d.steer = (right ? 1 : 0) - (left ? 1 : 0);
    d.throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    d.brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    d.handbrake = k.has('Space') ? 1 : 0;
    d.clutchPedal = k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : 0;
    d.analog = false;

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const deadzone = (v: number) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
      const steer = deadzone(pad.axes[0] ?? 0);
      const thr = pad.buttons[PAD.RT]?.value ?? 0;
      const brk = pad.buttons[PAD.LT]?.value ?? 0;
      // Gamepad wins whenever it's being used (analog values skip keyboard smoothing).
      if (steer !== 0 || thr > 0.02 || brk > 0.02) {
        d.analog = true;
        d.steer = steer;
        d.throttle = Math.max(d.throttle, thr);
        d.brake = Math.max(d.brake, brk);
      }
      if (pad.buttons[PAD.B]?.pressed) d.handbrake = 1;
      if (pad.buttons[PAD.X]?.pressed) d.clutchPedal = 1;
      for (const [b, action] of PAD_ACTIONS) {
        const pressed = pad.buttons[b]?.pressed ?? false;
        if (pressed && !this.padPrev[b]) this.actions.push(action);
        this.padPrev[b] = pressed;
      }
    }
    return this.actions.splice(0);
  }
}
