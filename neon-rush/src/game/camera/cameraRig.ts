import * as THREE from 'three';
import { clamp, damp } from '@shared/math';
import type { Frame } from '@shared/track/types';

export type CameraMode = 'chase' | 'close' | 'hood' | 'cinematic' | 'orbit' | 'menu';
export const CAMERA_MODES: CameraMode[] = ['chase', 'close', 'hood', 'cinematic'];
export const CAMERA_MODE_NAMES: Record<CameraMode, string> = { chase: 'Chase', close: 'Close', hood: 'Hood', cinematic: 'Cinematic', orbit: 'Orbit', menu: 'Menu' };

export interface CameraTarget {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
  grounded: boolean;
  boost: number;
}

export class CameraRig {
  mode: CameraMode = 'chase';
  private smoothedPos = new THREE.Vector3();
  private smoothedLook = new THREE.Vector3();
  private smoothedUp = new THREE.Vector3(0, 1, 0);
  private fov = 70;
  private shakeAmount = 0;
  private shakeTime = 0;
  private orbitAngle = 0;
  private cinematicPos = new THREE.Vector3();
  private cinematicIndex = -1;
  private hoodQuat = new THREE.Quaternion();
  private needSnap = true;
  frames: Frame[] = [];

  constructor(public camera: THREE.PerspectiveCamera) {}

  setMode(mode: CameraMode) {
    this.mode = mode;
    this.needSnap = true;
    this.cinematicIndex = -1;
  }
  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }
  snap() { this.needSnap = true; }
  shake(amount: number) { this.shakeAmount = Math.min(1.5, this.shakeAmount + amount); }

  update(dt: number, t: CameraTarget) {
    const cam = this.camera;
    const speed01 = clamp(t.speed / 70, 0, 1);
    let desiredPos = new THREE.Vector3();
    let desiredLook = new THREE.Vector3();
    let desiredFov = 70;
    let desiredUp = new THREE.Vector3(0, 1, 0);
    const worldUp = new THREE.Vector3(0, 1, 0);

    const velDir = t.speed > 4 ? t.velocity.clone().normalize() : t.forward.clone();
    const back = t.forward.clone().lerp(velDir, 0.45).normalize();

    switch (this.mode) {
      case 'chase':
      case 'close': {
        const close = this.mode === 'close';
        const dist = close ? 5.2 + speed01 * 1.2 : 7.8 + speed01 * 2.6;
        const height = close ? 1.7 + speed01 * 0.3 : 2.7 + speed01 * 0.6;
        // blend up vector: follow car up on ground (loops), world up in air
        const upTarget = t.grounded ? t.up.clone() : t.up.clone().lerp(worldUp, 0.6).normalize();
        desiredUp = upTarget;
        desiredPos.copy(t.position).addScaledVector(back, -dist).addScaledVector(upTarget, height);
        desiredLook.copy(t.position).addScaledVector(t.forward, 3 + speed01 * 6).addScaledVector(upTarget, 0.9);
        desiredFov = (close ? 72 : 68) + speed01 * 24 + t.boost * 8;
        break;
      }
      case 'hood': {
        desiredPos.copy(t.position).addScaledVector(t.forward, 0.9).addScaledVector(t.up, 0.95);
        desiredLook.copy(desiredPos).addScaledVector(t.forward, 10).addScaledVector(t.up, -0.2);
        desiredUp = t.up.clone();
        desiredFov = 78 + speed01 * 20 + t.boost * 8;
        break;
      }
      case 'cinematic': {
        // TV-style cameras along the track
        if (this.frames.length) {
          if (this.cinematicIndex < 0 || this.passed(t)) this.pickCinematic(t);
          desiredPos.copy(this.cinematicPos);
        } else {
          desiredPos.copy(t.position).addScaledVector(t.forward, 25).add(new THREE.Vector3(10, 12, 0));
        }
        desiredLook.copy(t.position).addScaledVector(t.velocity, 0.08);
        desiredFov = 50;
        break;
      }
      case 'orbit': {
        this.orbitAngle += dt * 0.6;
        const r = 9;
        desiredPos.set(t.position.x + Math.cos(this.orbitAngle) * r, t.position.y + 3.2, t.position.z + Math.sin(this.orbitAngle) * r);
        desiredLook.copy(t.position).addScaledVector(worldUp, 0.6);
        desiredFov = 55;
        break;
      }
      case 'menu': {
        this.orbitAngle += dt * 0.25;
        const r = 8.5;
        desiredPos.set(t.position.x + Math.cos(this.orbitAngle) * r, t.position.y + 2.6 + Math.sin(this.orbitAngle * 0.7) * 0.6, t.position.z + Math.sin(this.orbitAngle) * r);
        desiredLook.copy(t.position).addScaledVector(worldUp, 0.5);
        desiredFov = 45;
        break;
      }
    }

    if (this.needSnap) {
      this.smoothedPos.copy(desiredPos);
      this.smoothedLook.copy(desiredLook);
      this.smoothedUp.copy(desiredUp);
      this.fov = desiredFov;
      this.needSnap = false;
    } else {
      const lam = this.mode === 'hood' ? 40 : this.mode === 'cinematic' ? 6 : 11;
      const k = 1 - Math.exp(-lam * dt);
      this.smoothedPos.lerp(desiredPos, k);
      this.smoothedLook.lerp(desiredLook, 1 - Math.exp(-(lam + 6) * dt));
      this.smoothedUp.lerp(desiredUp, 1 - Math.exp(-5 * dt)).normalize();
      this.fov = damp(this.fov, desiredFov, 5, dt);
    }

    cam.position.copy(this.smoothedPos);
    // shake
    if (this.shakeAmount > 0.001) {
      this.shakeTime += dt * 60;
      const s = this.shakeAmount;
      cam.position.x += Math.sin(this.shakeTime * 1.3) * 0.12 * s;
      cam.position.y += Math.sin(this.shakeTime * 1.9 + 1) * 0.1 * s;
      cam.position.z += Math.cos(this.shakeTime * 1.1) * 0.12 * s;
      this.shakeAmount = damp(this.shakeAmount, 0, 7, dt);
    }
    cam.up.copy(this.smoothedUp);
    cam.lookAt(this.smoothedLook);
    if (this.mode === 'hood') {
      // slight roll damping to reduce jitter
      this.hoodQuat.slerp(cam.quaternion, 0.8);
      cam.quaternion.copy(this.hoodQuat);
    }
    if (Math.abs(cam.fov - this.fov) > 0.05) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  private passed(t: CameraTarget) {
    const toCam = this.cinematicPos.clone().sub(t.position);
    return toCam.dot(t.forward) < -12 || toCam.length() > 140;
  }

  private pickCinematic(t: CameraTarget) {
    // find nearest frame then pick one ~70 m ahead
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.frames.length; i += 2) {
      const f = this.frames[i].pos;
      const d = (f.x - t.position.x) ** 2 + (f.y - t.position.y) ** 2 + (f.z - t.position.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const target = Math.min(this.frames.length - 1, best + 45);
    const f = this.frames[target];
    const side = (target % 2 === 0 ? 1 : -1) * 18;
    this.cinematicPos.set(f.pos.x + f.right.x * side, f.pos.y + 9 + f.up.y * 2, f.pos.z + f.right.z * side);
    this.cinematicIndex = target;
  }
}
