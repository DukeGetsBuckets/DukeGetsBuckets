// Unified input: keyboard, touch (set by the TouchControls UI), and gamepad.

export interface InputState {
  throttle: number;
  brake: number;
  steer: number;        // +1 left, -1 right
  handbrake: boolean;
  restart: boolean;     // edge-triggered (consumed)
  respawn: boolean;     // edge-triggered
  camera: boolean;      // edge-triggered
  pause: boolean;       // edge-triggered
}

type Listener = (action: 'restart' | 'respawn' | 'camera' | 'pause') => void;

export class InputManager {
  keys = new Set<string>();
  touch = { left: false, right: false, throttle: false, brake: false, drift: false, steerAxis: 0 };
  touchSteerSensitivity = 1;
  state: InputState = { throttle: 0, brake: 0, steer: 0, handbrake: false, restart: false, respawn: false, camera: false, pause: false };
  private listeners: Listener[] = [];
  private steerSmoothed = 0;
  enabled = true;
  private boundDown = (e: KeyboardEvent) => this.onKeyDown(e);
  private boundUp = (e: KeyboardEvent) => this.onKeyUp(e);
  private boundBlur = () => this.keys.clear();

  attach() {
    window.addEventListener('keydown', this.boundDown);
    window.addEventListener('keyup', this.boundUp);
    window.addEventListener('blur', this.boundBlur);
  }
  detach() {
    window.removeEventListener('keydown', this.boundDown);
    window.removeEventListener('keyup', this.boundUp);
    window.removeEventListener('blur', this.boundBlur);
  }
  onAction(l: Listener) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter((x) => x !== l); }; }
  fire(a: 'restart' | 'respawn' | 'camera' | 'pause') { for (const l of this.listeners) l(a); }

  private isTypingTarget(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.isTypingTarget(e)) return;
    const k = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) e.preventDefault();
    if (this.keys.has(k)) return;
    this.keys.add(k);
    if (!this.enabled) return;
    if (k === 'KeyR') this.fire('restart');
    else if (k === 'Backspace' || k === 'Enter' || k === 'Delete') this.fire('respawn');
    else if (k === 'KeyC') this.fire('camera');
    else if (k === 'Escape' || k === 'KeyP') this.fire('pause');
  }
  private onKeyUp(e: KeyboardEvent) { this.keys.delete(e.code); }

  private readGamepad(): { steer: number; throttle: number; brake: number; handbrake: boolean } | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const gp of pads) {
      if (!gp) continue;
      const lx = gp.axes[0] ?? 0;
      const rt = gp.buttons[7]?.value ?? 0;
      const lt = gp.buttons[6]?.value ?? 0;
      const a = gp.buttons[0]?.pressed ?? false;
      const b = gp.buttons[1]?.pressed ?? false;
      const x = gp.buttons[2]?.pressed ?? false;
      const steer = Math.abs(lx) > 0.08 ? -lx : 0;
      const throttle = Math.max(rt, a ? 1 : 0);
      const brake = Math.max(lt, b ? 1 : 0);
      if (steer !== 0 || throttle > 0 || brake > 0 || x) return { steer, throttle, brake, handbrake: x || (gp.buttons[5]?.pressed ?? false) };
    }
    return null;
  }

  /** Sample inputs; dt used to smooth digital steering. */
  update(dt: number): InputState {
    const k = this.keys;
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let steer = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) steer += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) steer -= 1;
    let handbrake = k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight');

    const t = this.touch;
    if (t.throttle) throttle = 1;
    if (t.brake) brake = 1;
    if (t.left) steer += 1;
    if (t.right) steer -= 1;
    if (t.steerAxis !== 0) steer += t.steerAxis * this.touchSteerSensitivity;
    if (t.drift) handbrake = true;

    const gp = this.readGamepad();
    if (gp) { steer = gp.steer; throttle = Math.max(throttle, gp.throttle); brake = Math.max(brake, gp.brake); handbrake = handbrake || gp.handbrake; }

    steer = Math.max(-1, Math.min(1, steer));
    // analog-ish smoothing for digital inputs
    const target = steer;
    const rate = Math.abs(target) > Math.abs(this.steerSmoothed) ? 9 : 14;
    this.steerSmoothed += (target - this.steerSmoothed) * Math.min(1, rate * dt);
    if (Math.abs(this.steerSmoothed) < 0.001) this.steerSmoothed = 0;

    if (!this.enabled) { throttle = 0; brake = 0; handbrake = false; this.steerSmoothed = 0; }
    const s = this.state;
    s.throttle = throttle; s.brake = brake; s.steer = this.steerSmoothed; s.handbrake = handbrake;
    return s;
  }
}
