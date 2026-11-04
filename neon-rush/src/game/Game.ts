// NEON RUSH game orchestrator: owns the renderer, physics world, car, track, environment,
// cameras, effects and the fixed-timestep loop. UI talks to it through a small API + HudState.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { TrackDefinition, CompiledTrack } from '@shared/track/types';
import { compileTrack, nearestFrameIndex } from '@shared/track/compile';
import { type CarConfig, DEFAULT_CAR } from '@shared/game/carConfig';
import { REPLAY_HZ, type Replay, sampleReplay } from '@shared/game/replay';
import { clamp, vdot, vsub } from '@shared/math';
import { GameRenderer, detectQuality, type QualityLevel } from './render/renderer';
import { sharedUniforms } from './render/materials';
import { Sky } from './render/sky';
import { Environment } from './render/environment';
import { THEMES, type Theme } from './track/themes';
import { TrackView } from './track/trackRender';
import { initRapier, PhysicsWorld, PHYSICS_DT } from './physics/world';
import { CarPhysics, CAR_SPEC } from './physics/car';
import { CarView } from './car/carModel';
import { CameraRig, type CameraMode } from './camera/cameraRig';
import { InputManager } from './input/input';
import { RaceController, type RaceState } from './race/raceController';
import { ParticleSystem } from './fx/particles';
import { Trail, trailColor } from './fx/trails';
import { createNeonMaterial } from './render/materials';

export interface HudState {
  timeMs: number;
  speed: number;        // m/s
  checkpoint: number;
  checkpointTotal: number;
  state: RaceState;
  countdown: number;
  boost: number;
  drifting: boolean;
  airborne: boolean;
  diffMs: number | null;
  diffAge: number;
  fps: number;
  respawning: number;   // fade amount 0..1
  cameraMode: CameraMode;
  gearSpeed: number;    // smoothed for speedometer
  progress: number;
}

export interface GameCallbacks {
  onCheckpoint: (index: number, timeMs: number, diffMs: number | null) => void;
  onFinish: (timeMs: number, splits: number[], replay: Replay) => void;
  onCountdown: (n: number) => void;
  onStart: () => void;
  onRespawn: (toStart: boolean) => void;
  onCameraChange: (mode: CameraMode) => void;
  onPause: () => void;
  onRestart: () => void;
  onImpact: (magnitude: number) => void;
  onLanding: (airTime: number) => void;
  onBoost: () => void;
  onDriftChange: (drifting: boolean) => void;
}

export type SceneMode = 'menu' | 'race' | 'garage' | 'editor';

export interface RemoteCarState { t: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; speed: number }

interface RemoteCar {
  view: CarView;
  label: THREE.Sprite;
  buffer: RemoteCarState[];
  trail: Trail;
  cfg: CarConfig;
  lastPos: THREE.Vector3;
}

export class Game {
  readonly renderer: GameRenderer;
  readonly scene = new THREE.Scene();
  readonly cameraRig: CameraRig;
  readonly input = new InputManager();
  readonly particles = new ParticleSystem(3000);
  readonly hud: HudState = {
    timeMs: 0, speed: 0, checkpoint: 0, checkpointTotal: 0, state: 'idle', countdown: 0, boost: 0, drifting: false, airborne: false,
    diffMs: null, diffAge: 99, fps: 60, respawning: 0, cameraMode: 'chase', gearSpeed: 0, progress: 0,
  };
  callbacks: Partial<GameCallbacks> = {};
  physics!: PhysicsWorld;
  car!: CarPhysics;
  carView!: CarView;
  trackView: TrackView | null = null;
  compiled: CompiledTrack | null = null;
  trackDef: TrackDefinition | null = null;
  env: Environment | null = null;
  sky: Sky | null = null;
  race: RaceController | null = null;
  theme: Theme = THEMES.neonCity;
  sceneMode: SceneMode = 'menu';
  carConfig: CarConfig = DEFAULT_CAR;
  quality: QualityLevel;
  running = false;
  paused = false;
  private accumulator = 0;
  private lastTime = 0;
  private raf = 0;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private exhaustTrails: Trail[] = [];
  private skidTrails: Trail[] = [];
  private platform: THREE.Group;
  private ghost: { replay: Replay; view: CarView; label: THREE.Sprite } | null = null;
  private recorder: { frames: number[]; stepCounter: number; active: boolean } = { frames: [], stepCounter: 0, active: false };
  private remote = new Map<string, RemoteCar>();
  private boostInside = false;
  private wasAirborne = false;
  private stuckTime = 0;
  private respawnFade = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private adaptiveLow = 0;
  private nearestFrame = 0;
  private garageAngle = 0.6;
  private garageTarget = 0.6;
  private impactQueue: { mag: number; x: number; y: number; z: number }[] = [];
  private finishedCelebration = 0;
  clockOffsetMs = 0; // local -> server time offset (multiplayer)
  private disposed = false;
  private autoQuality = true;

  private constructor(public canvas: HTMLCanvasElement, quality: QualityLevel) {
    this.quality = quality;
    this.renderer = new GameRenderer(canvas, quality);
    this.renderer.setScene(this.scene);
    this.cameraRig = new CameraRig(this.renderer.camera);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x222244, 0.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.castShadow = quality === 'high';
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 300;
    this.sun.shadow.camera.left = -60; this.sun.shadow.camera.right = 60; this.sun.shadow.camera.top = 60; this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.add(this.particles.points);
    // environment map for car reflections
    const pmrem = new THREE.PMREMGenerator(this.renderer.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;
    pmrem.dispose();
    // menu/garage platform
    this.platform = this.buildPlatform();
    this.platform.visible = false;
    this.scene.add(this.platform);
    this.input.attach();
    this.input.onAction((a) => this.handleAction(a));
  }

  static async create(canvas: HTMLCanvasElement, quality?: QualityLevel): Promise<Game> {
    const q = quality ?? detectQuality();
    const R = await initRapier();
    const game = new Game(canvas, q);
    game.physics = new PhysicsWorld(R);
    game.car = new CarPhysics(game.physics, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    game.car.onImpact = (mag, p) => game.impactQueue.push({ mag, x: p.x, y: p.y, z: p.z });
    game.carView = new CarView(DEFAULT_CAR);
    game.scene.add(game.carView.group);
    for (let i = 0; i < 2; i++) { const t = new Trail(70, 0.22, 0.55, true); game.scene.add(t.mesh); game.exhaustTrails.push(t); }
    for (let i = 0; i < 2; i++) { const t = new Trail(90, 0.3, 2.2, true); game.scene.add(t.mesh); game.skidTrails.push(t); }
    return game;
  }

  private buildPlatform(): THREE.Group {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.6, 0.5, 48), new THREE.MeshStandardMaterial({ color: 0x14102c, metalness: 0.7, roughness: 0.3 }));
    disc.position.y = -0.95;
    disc.receiveShadow = true;
    g.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.12, 8, 64), createNeonMaterial(0x22d3ee, 2.5));
    ring.rotation.x = Math.PI / 2; ring.position.y = -0.7; g.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.06, 8, 64), createNeonMaterial(0xa855f7, 2.5));
    ring2.rotation.x = Math.PI / 2; ring2.position.y = -0.69; g.add(ring2);
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* Scene / track management                                            */
  /* ------------------------------------------------------------------ */

  async loadTrack(def: TrackDefinition) {
    this.unloadTrack();
    this.trackDef = def;
    this.theme = THEMES[def.theme] ?? THEMES.neonCity;
    const compiled = compileTrack(def);
    this.compiled = compiled;
    const theme = this.theme;
    this.scene.fog = new THREE.Fog(new THREE.Color(theme.fog.color), theme.fog.near, theme.fog.far);
    this.scene.background = new THREE.Color(theme.sky.horizon);
    this.sky = new Sky(theme);
    this.scene.add(this.sky.mesh);
    this.trackView = new TrackView(compiled, theme);
    this.scene.add(this.trackView.group);
    this.env = new Environment(theme, compiled, def.seed ?? 1, this.quality);
    this.scene.add(this.env.group);
    this.physics.setTrack(compiled.collision);
    // lights
    this.hemi.color.set(theme.light.hemiSky); this.hemi.groundColor.set(theme.light.hemiGround); this.hemi.intensity = theme.light.hemiIntensity;
    this.sun.color.set(theme.light.sun); this.sun.intensity = theme.light.sunIntensity;
    const sd = new THREE.Vector3(...theme.sky.sunDir).normalize();
    sharedUniforms.uSunDir.value.copy(sd);
    sharedUniforms.uSunColor.value.set(theme.light.sun).multiplyScalar(theme.light.sunIntensity * 0.6);
    sharedUniforms.uAmbient.value.set(theme.light.ambient);
    this.race = new RaceController(compiled);
    this.race.events = {
      onCheckpoint: (i, t, diff) => { this.trackView?.triggerGate(i); this.hud.diffMs = diff; this.hud.diffAge = 0; this.checkpointBurst(i); this.callbacks.onCheckpoint?.(i, t, diff); },
      onFinish: (t, splits) => { this.trackView?.triggerGate(this.race!.checkpointCount); this.finishCelebration(); this.stopRecording(); this.callbacks.onFinish?.(t, splits, this.buildReplay(t, splits)); },
      onStart: () => { this.startRecording(); this.launchBurst(); this.callbacks.onStart?.(); },
      onCountdown: (n) => { this.hud.countdown = n; this.callbacks.onCountdown?.(n); },
      onRespawn: (toStart) => this.callbacks.onRespawn?.(toStart),
    };
    this.cameraRig.frames = compiled.frames;
    this.hud.checkpointTotal = this.race.checkpointCount;
    this.placeCarAtStart();
    this.cameraRig.snap();
  }

  unloadTrack() {
    this.trackView?.dispose(); this.trackView = null;
    this.env?.dispose(); this.env = null;
    if (this.sky) { this.scene.remove(this.sky.mesh); this.sky.dispose(); this.sky = null; }
    this.physics.clearTrack();
    this.compiled = null; this.race = null;
    this.clearGhost();
    for (const t of this.exhaustTrails) t.break();
    for (const t of this.skidTrails) t.break();
    this.particles.clear();
  }

  private placeCarAtStart() {
    if (!this.compiled) return;
    const s = this.compiled.start;
    this.car.teleport(s.pos, s.forward, s.up);
    this.car.frozen = true;
    this.syncCarVisual(1);
  }

  setSceneMode(mode: SceneMode) {
    this.sceneMode = mode;
    this.platform.visible = mode === 'menu' || mode === 'garage';
    if (mode === 'menu') { this.cameraRig.setMode('menu'); this.input.enabled = false; }
    else if (mode === 'garage') { this.cameraRig.setMode('orbit'); this.input.enabled = false; }
    else if (mode === 'race') { this.cameraRig.setMode(this.hud.cameraMode); this.input.enabled = true; }
    else { this.input.enabled = false; }
    if (mode !== 'race' && this.compiled) {
      this.placeCarAtStart();
      const s = this.compiled.start;
      this.platform.position.set(s.pos.x, s.pos.y - 0.2, s.pos.z);
      this.race?.reset(0);
      if (this.race) this.race.state = 'idle';
    }
    this.cameraRig.snap();
  }

  /* ------------------------------------------------------------------ */
  /* Race control                                                        */
  /* ------------------------------------------------------------------ */

  startRace(countdownSeconds = 3) {
    if (!this.race) return;
    this.setSceneMode('race');
    this.placeCarAtStart();
    this.race.reset(countdownSeconds);
    this.hud.countdown = Math.ceil(countdownSeconds);
    this.hud.diffMs = null;
    this.cameraRig.snap();
    this.finishedCelebration = 0;
    this.recorder.active = false;
  }

  /** Instant restart: back to the start line, timer armed (starts on first input). */
  restart() {
    if (!this.race) return;
    this.placeCarAtStart();
    this.race.reset(0);
    this.hud.countdown = 0;
    this.hud.diffMs = null;
    this.cameraRig.snap();
    this.finishedCelebration = 0;
    this.recorder.active = false;
    for (const t of this.exhaustTrails) t.break();
    for (const t of this.skidTrails) t.break();
    this.callbacks.onRestart?.();
  }

  respawn() {
    if (!this.race || this.race.state === 'finished') return;
    if (this.race.state !== 'racing') { this.restart(); return; }
    const sp = this.race.respawnPoint();
    this.car.teleport(sp.pos, sp.forward, sp.up);
    this.car.frozen = false;
    this.respawnFade = 1;
    this.cameraRig.snap();
    for (const t of this.exhaustTrails) t.break();
    for (const t of this.skidTrails) t.break();
  }

  setReferenceSplits(splits: number[] | null) { if (this.race) this.race.referenceSplits = splits; }

  setPaused(p: boolean) { this.paused = p; this.input.enabled = !p && this.sceneMode === 'race'; if (!p) this.lastTime = performance.now(); }

  setCameraMode(mode: CameraMode) { this.hud.cameraMode = mode; if (this.sceneMode === 'race') this.cameraRig.setMode(mode); this.callbacks.onCameraChange?.(mode); }
  cycleCamera() { const i = ['chase', 'close', 'hood', 'cinematic'].indexOf(this.hud.cameraMode); this.setCameraMode(['chase', 'close', 'hood', 'cinematic'][(i + 1) % 4] as CameraMode); }

  private handleAction(a: 'restart' | 'respawn' | 'camera' | 'pause') {
    if (this.sceneMode !== 'race') return;
    if (a === 'pause') { this.callbacks.onPause?.(); return; }
    if (this.paused) return;
    if (a === 'restart') this.restart();
    else if (a === 'respawn') this.respawn();
    else if (a === 'camera') this.cycleCamera();
  }

  /* ------------------------------------------------------------------ */
  /* Car config / garage                                                 */
  /* ------------------------------------------------------------------ */

  setCarConfig(cfg: CarConfig) {
    this.carConfig = cfg;
    const old = this.carView;
    this.carView = new CarView(cfg, { shadows: this.quality === 'high' });
    this.scene.add(this.carView.group);
    old.dispose();
    this.syncCarVisual(1);
  }

  setGarageAngle(a: number) { this.garageTarget = a; }
  nudgeGarageAngle(d: number) { this.garageTarget += d; }

  setQuality(q: QualityLevel) {
    this.quality = q;
    this.autoQuality = false;
    this.renderer.setQuality(q);
    this.sun.castShadow = q === 'high';
  }

  /* ------------------------------------------------------------------ */
  /* Ghosts / replays / remote cars                                      */
  /* ------------------------------------------------------------------ */

  setGhost(replay: Replay | null, name = 'Ghost', color = '#67e8f9') {
    this.clearGhost();
    if (!replay || replay.frameCount < 2) return;
    const view = new CarView(this.carConfig, { ghost: true, ghostColor: color });
    const label = this.makeLabel(name, color);
    label.position.y = 1.9;
    view.group.add(label);
    this.scene.add(view.group);
    this.ghost = { replay, view, label };
  }
  clearGhost() { if (this.ghost) { this.ghost.view.dispose(); this.ghost = null; } }

  private makeLabel(text: string, color: string): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.font = 'bold 34px Rajdhani, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(7,6,26,0.55)';
    const w = Math.min(250, ctx.measureText(text).width + 30);
    ctx.beginPath(); ctx.roundRect(128 - w / 2, 10, w, 44, 10); ctx.fill();
    ctx.fillStyle = color; ctx.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(4, 1, 1);
    sp.renderOrder = 50;
    return sp;
  }

  addRemoteCar(id: string, cfg: CarConfig, name: string) {
    this.removeRemoteCar(id);
    const view = new CarView(cfg, { shadows: false });
    const label = this.makeLabel(name, '#ffffff');
    label.position.y = 2.0;
    view.group.add(label);
    this.scene.add(view.group);
    const trail = new Trail(50, 0.18, 0.45, true);
    this.scene.add(trail.mesh);
    this.remote.set(id, { view, label, buffer: [], trail, cfg, lastPos: new THREE.Vector3() });
  }
  updateRemoteCar(id: string, s: RemoteCarState) {
    const r = this.remote.get(id);
    if (!r) return;
    r.buffer.push(s);
    if (r.buffer.length > 30) r.buffer.shift();
  }
  removeRemoteCar(id: string) {
    const r = this.remote.get(id);
    if (!r) return;
    r.view.dispose(); r.trail.dispose(); this.scene.remove(r.trail.mesh);
    this.remote.delete(id);
  }
  clearRemoteCars() { for (const id of Array.from(this.remote.keys())) this.removeRemoteCar(id); }

  /** Current pose for network broadcasting. */
  getNetState(): RemoteCarState {
    const c = this.car;
    return { t: 0, x: c.position.x, y: c.position.y, z: c.position.z, qx: c.rotation.x, qy: c.rotation.y, qz: c.rotation.z, qw: c.rotation.w, speed: c.telemetry.speedAbs };
  }

  private startRecording() { this.recorder = { frames: [], stepCounter: 0, active: true }; this.recordFrame(); }
  private stopRecording() { this.recorder.active = false; }
  private recordFrame() {
    const c = this.car;
    this.recorder.frames.push(c.position.x, c.position.y, c.position.z, c.rotation.x, c.rotation.y, c.rotation.z, c.rotation.w);
  }
  private buildReplay(timeMs: number, splits: number[]): Replay {
    const frames = new Float32Array(this.recorder.frames);
    return { version: 1, hz: REPLAY_HZ, timeMs, frameCount: frames.length / 7, frames, splits };
  }

  /* ------------------------------------------------------------------ */
  /* Main loop                                                           */
  /* ------------------------------------------------------------------ */

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running || this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  private frame(dt: number) {
    // fps tracking + adaptive quality
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 1) {
      this.hud.fps = this.fpsFrames / this.fpsAcc;
      if (this.autoQuality && this.sceneMode === 'race') {
        if (this.hud.fps < 38) { this.adaptiveLow++; if (this.adaptiveLow >= 3 && this.quality !== 'low') { this.quality = this.quality === 'high' ? 'medium' : 'low'; this.renderer.setQuality(this.quality); this.sun.castShadow = false; this.adaptiveLow = 0; } }
        else this.adaptiveLow = 0;
      }
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
    sharedUniforms.uTime.value += dt;
    if (!this.paused) {
      this.accumulator += dt;
      let steps = 0;
      const maxSteps = 8;
      while (this.accumulator >= PHYSICS_DT && steps < maxSteps) {
        this.physicsStep();
        this.accumulator -= PHYSICS_DT;
        steps++;
      }
      if (steps === maxSteps) this.accumulator = 0;
    }
    const alpha = clamp(this.accumulator / PHYSICS_DT, 0, 1);
    this.updateVisuals(dt, alpha);
    this.renderer.render(dt);
  }

  private physicsStep() {
    const race = this.race;
    const inRace = this.sceneMode === 'race' && !!race;
    const input = this.input.update(PHYSICS_DT);
    const car = this.car;
    if (inRace) {
      car.input = { throttle: input.throttle, brake: input.brake, steer: input.steer, handbrake: input.handbrake };
      const hasInput = input.throttle > 0 || input.brake > 0;
      const frozenNow = race.state === 'countdown' || race.state === 'armed' || race.state === 'idle';
      car.frozen = frozenNow;
      // boost pads
      if (this.compiled && !frozenNow) this.checkBoostPads();
    } else {
      car.frozen = true;
    }
    car.preStep();
    this.physics.step();
    car.postStep();
    if (inRace) {
      race.step(car.prevPosition, car.position, input.throttle > 0 || input.brake > 0);
      // record replay at REPLAY_HZ
      if (this.recorder.active) {
        this.recorder.stepCounter++;
        if (this.recorder.stepCounter >= 120 / REPLAY_HZ) { this.recorder.stepCounter = 0; this.recordFrame(); }
      }
      // fall / stuck detection
      if (this.compiled && race.state === 'racing') {
        if (car.position.y < this.compiled.bounds.min.y - 30) this.respawn();
        const upsideDown = car.up.y < -0.2 && car.telemetry.speedAbs < 3;
        this.stuckTime = upsideDown ? this.stuckTime + PHYSICS_DT : 0;
        if (this.stuckTime > 1.6) { this.stuckTime = 0; this.respawn(); }
      }
    }
  }

  private checkBoostPads() {
    const c = this.compiled!;
    const p = this.car.position;
    let inside = false;
    for (const b of c.boosts) {
      const rel = vsub(p, b.pos);
      if (Math.abs(vdot(rel, b.forward)) <= b.halfLength && Math.abs(vdot(rel, b.right)) <= b.halfWidth && Math.abs(vdot(rel, b.up)) < 4) { inside = true; break; }
    }
    if (inside && !this.boostInside) { this.car.applyBoost(); this.callbacks.onBoost?.(); this.cameraRig.shake(0.25); }
    this.boostInside = inside;
  }

  /* ------------------------------------------------------------------ */
  /* Visual update                                                       */
  /* ------------------------------------------------------------------ */

  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  private syncCarVisual(alpha: number) {
    const c = this.car;
    const p = this.tmpV.set(c.prevPosition.x, c.prevPosition.y, c.prevPosition.z).lerp(this.tmpV2.set(c.position.x, c.position.y, c.position.z), alpha);
    const q = this.tmpQ.set(c.prevRotation.x, c.prevRotation.y, c.prevRotation.z, c.prevRotation.w).slerp(new THREE.Quaternion(c.rotation.x, c.rotation.y, c.rotation.z, c.rotation.w), alpha);
    this.carView.setPose(p, q);
    this.carView.updateWheels({
      wheelSteer: c.wheels.map((w) => w.steer),
      wheelSpin: c.wheels.map((w) => -w.spin),
      wheelCompression: c.wheels.map((w) => w.compression),
    });
  }

  private updateVisuals(dt: number, alpha: number) {
    const c = this.car;
    const tel = c.telemetry;
    this.syncCarVisual(alpha);
    const carPos = this.carView.group.position;
    const forward = new THREE.Vector3(c.forward.x, c.forward.y, c.forward.z);
    const up = new THREE.Vector3(c.up.x, c.up.y, c.up.z);
    const right = new THREE.Vector3(c.right.x, c.right.y, c.right.z);
    const vel = new THREE.Vector3(c.velocity.x, c.velocity.y, c.velocity.z);
    const speed = tel.speedAbs;

    // camera
    if (this.sceneMode === 'garage') {
      this.garageAngle += (this.garageTarget - this.garageAngle) * Math.min(1, dt * 6);
      const r = 6.8;
      this.renderer.camera.position.set(carPos.x + Math.cos(this.garageAngle) * r, carPos.y + 1.9, carPos.z + Math.sin(this.garageAngle) * r);
      this.renderer.camera.up.set(0, 1, 0);
      this.renderer.camera.lookAt(carPos.x, carPos.y + 0.3, carPos.z);
      if (this.renderer.camera.fov !== 42) { this.renderer.camera.fov = 42; this.renderer.camera.updateProjectionMatrix(); }
    } else {
      this.cameraRig.update(dt, { position: carPos, quaternion: this.carView.group.quaternion, forward, up, velocity: vel, speed, grounded: tel.grounded, boost: tel.boostTime > 0 ? 1 : 0 });
    }
    if (this.sceneMode === 'race' && this.race?.state === 'finished') {
      this.finishedCelebration += dt;
      if (this.finishedCelebration > 0.4 && this.cameraRig.mode !== 'orbit') this.cameraRig.setMode('orbit');
    }
    const camPos = this.renderer.camera.position;
    this.sky?.update(camPos);
    this.env?.update(dt, camPos);
    this.trackView?.update(dt);
    // sun shadow follows car
    const sd = sharedUniforms.uSunDir.value;
    this.sun.position.copy(carPos).addScaledVector(sd, 120);
    this.sun.target.position.copy(carPos);
    // underglow light for road shader
    if (this.carView.underglowColor) { sharedUniforms.uGlowPos.value.copy(carPos).addScaledVector(up, -0.3); sharedUniforms.uGlowColor.value.copy(this.carView.underglowColor); }
    else { sharedUniforms.uGlowColor.value.setScalar(0); }

    // ---- effects ----
    const racing = this.sceneMode === 'race';
    const t = sharedUniforms.uTime.value;
    const cfg = this.carConfig;
    if (racing && !this.paused) {
      // impacts
      for (const imp of this.impactQueue) {
        this.particles.emit({ count: Math.round(10 + imp.mag * 40), position: new THREE.Vector3(imp.x, imp.y, imp.z), spread: 6 + imp.mag * 10, color: [new THREE.Color('#ffd166'), new THREE.Color('#ff7b00'), new THREE.Color('#ffffff')], size: 0.35, life: 0.5, gravity: 18, drag: 1.5 });
        this.cameraRig.shake(0.25 + imp.mag * 0.9);
        this.callbacks.onImpact?.(imp.mag);
      }
      this.impactQueue.length = 0;
      // landing
      if (this.wasAirborne && tel.grounded) {
        const air = this.lastAirTime;
        if (air > 0.25) {
          this.cameraRig.shake(Math.min(0.8, air * 0.5));
          this.callbacks.onLanding?.(air);
          for (const w of c.wheels) if (w.grounded) this.particles.emit({ count: 8, position: new THREE.Vector3(w.contact.x, w.contact.y, w.contact.z), spread: 3, color: new THREE.Color(this.theme.road.line), size: 0.5, life: 0.5, gravity: 2, drag: 2 });
        }
      }
      if (!tel.grounded) this.lastAirTime = tel.airTime;
      this.wasAirborne = !tel.grounded;
      // drift / skid
      const skidColor = trailColor(cfg.trail, t, new THREE.Color(cfg.tireColor));
      for (let i = 2; i < 4; i++) {
        const w = c.wheels[i];
        const trail = this.skidTrails[i - 2];
        if (w.grounded && (w.slip > 3.5 || tel.drifting) && speed > 6) {
          const p = new THREE.Vector3(w.contact.x, w.contact.y, w.contact.z).addScaledVector(up, 0.06);
          trail.push(p, right, skidColor);
          if (Math.random() < 0.5) this.particles.emit({ count: 1, position: p, velocity: vel.clone().multiplyScalar(-0.15).addScaledVector(up, 2), spread: 1.5, color: [skidColor, new THREE.Color('#ffffff')], size: 0.35, life: 0.45, gravity: 4, drag: 2 });
        } else trail.break();
      }
      if (tel.drifting !== this.hud.drifting) this.callbacks.onDriftChange?.(tel.drifting);
      // exhaust trails
      for (let i = 0; i < 2; i++) {
        const trail = this.exhaustTrails[i];
        if (cfg.trail !== 'none' && speed > 18) {
          const lp = this.carView.trailPoints[i];
          const p = lp.clone().applyQuaternion(this.carView.group.quaternion).add(carPos);
          trail.push(p, up, trailColor(cfg.trail, t + i, new THREE.Color(cfg.paint2)));
        } else trail.break();
        trail.width = 0.12 + Math.min(1, speed / 70) * 0.2;
      }
      // boost flames
      if (tel.boostTime > 0) {
        for (const ep of this.carView.exhaustPoints) {
          const p = ep.clone().applyQuaternion(this.carView.group.quaternion).add(carPos);
          this.particles.emit({ count: 3, position: p, velocity: forward.clone().multiplyScalar(-14).addScaledVector(vel, 0.6), spread: 2, color: [new THREE.Color('#fb923c'), new THREE.Color('#facc15'), new THREE.Color('#ffffff')], size: 0.7, life: 0.35, drag: 2 });
        }
      }
      // cosmetic effects
      if (cfg.effect !== 'none' && speed > 8 && Math.random() < 0.6) {
        const col = cfg.effect === 'sparkles' ? [new THREE.Color('#ffffff'), new THREE.Color(cfg.paint)] : cfg.effect === 'bubbles' ? [new THREE.Color('#bae6fd')] : cfg.effect === 'embers' ? [new THREE.Color('#fb923c'), new THREE.Color('#ef4444')] : cfg.effect === 'pixels' ? [new THREE.Color('#a3e635'), new THREE.Color('#22d3ee'), new THREE.Color('#f472b6')] : [new THREE.Color('#f472b6'), new THREE.Color('#fb7185')];
        this.particles.emit({ count: 2, position: carPos.clone().addScaledVector(forward, -2).addScaledVector(up, 0.4), velocity: vel.clone().multiplyScalar(0.3).addScaledVector(up, cfg.effect === 'bubbles' ? 3 : 1), spread: 2, positionSpread: 0.8, color: col, size: cfg.effect === 'pixels' ? 0.5 : 0.35, life: 0.9, gravity: cfg.effect === 'embers' ? -2 : cfg.effect === 'bubbles' ? -3 : 1, drag: 1, shrink: cfg.effect !== 'pixels' });
      }
      this.carView.setBraking(c.input.brake > 0.2);
    }
    this.particles.update(dt);
    for (const tr of this.exhaustTrails) tr.update(dt);
    for (const tr of this.skidTrails) tr.update(dt);

    // ghost
    if (this.ghost && this.race) {
      const r = this.ghost.replay;
      const tMs = this.race.state === 'racing' || this.race.state === 'finished' ? this.race.timeMs : 0;
      const o = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
      sampleReplay(r, tMs, o);
      this.ghost.view.setPose({ x: o.x, y: o.y, z: o.z }, { x: o.qx, y: o.qy, z: o.qz, w: o.qw });
      const d = this.ghost.view.group.position.distanceTo(carPos);
      this.ghost.view.setGhostOpacity(d < 6 ? 0.12 + 0.2 * (d / 6) : 0.32);
      this.ghost.view.group.visible = this.race.state !== 'idle';
    }
    // remote cars
    this.updateRemoteCars(dt);

    // post effects
    const speedK = clamp((speed - 32) / 45, 0, 1);
    if (this.renderer.speedLines) { this.renderer.speedLines.intensity = racing ? speedK * 0.9 : 0; this.renderer.speedLines.boost = tel.boostTime > 0 ? 1 : 0; }
    if (this.renderer.chroma) { const k = racing ? tel.boostTime * 0.004 + tel.lastImpact * 0.006 : 0; this.renderer.chroma.offset.set(k, k); }

    // hud
    const h = this.hud;
    const race = this.race;
    h.timeMs = race ? race.timeMs : 0;
    h.speed = speed;
    h.gearSpeed += (speed - h.gearSpeed) * Math.min(1, dt * 10);
    h.checkpoint = race ? race.nextCheckpoint : 0;
    h.state = race ? race.state : 'idle';
    h.boost = tel.boostTime;
    h.drifting = tel.drifting;
    h.airborne = !tel.grounded;
    h.diffAge += dt;
    this.respawnFade = Math.max(0, this.respawnFade - dt * 2.5);
    h.respawning = this.respawnFade;
    if (this.compiled && race) {
      this.nearestFrame = nearestFrameIndex(this.compiled.frames, c.position, this.nearestFrame, 40);
      h.progress = race.progress(this.nearestFrame);
    }
  }
  private lastAirTime = 0;

  private updateRemoteCars(dt: number) {
    const renderTime = performance.now() + this.clockOffsetMs - 120; // 120 ms interpolation delay
    for (const r of this.remote.values()) {
      const b = r.buffer;
      if (b.length === 0) continue;
      let i = b.length - 1;
      while (i > 0 && b[i - 1].t > renderTime) i--;
      let s0 = b[Math.max(0, i - 1)], s1 = b[i];
      if (b.length === 1) { s0 = s1 = b[0]; }
      const span = Math.max(1, s1.t - s0.t);
      const a = clamp((renderTime - s0.t) / span, 0, 1.2);
      const pos = new THREE.Vector3(s0.x + (s1.x - s0.x) * a, s0.y + (s1.y - s0.y) * a, s0.z + (s1.z - s0.z) * a);
      const q = new THREE.Quaternion(s0.qx, s0.qy, s0.qz, s0.qw).slerp(new THREE.Quaternion(s1.qx, s1.qy, s1.qz, s1.qw), clamp(a, 0, 1));
      r.view.setPose(pos, q);
      const spin = (s1.speed / CAR_SPEC.wheelRadius) * dt;
      r.view.updateWheels({ wheelSteer: [0, 0, 0, 0], wheelSpin: r.view.wheels.map((w) => w.children[0].rotation.x - spin), wheelCompression: [0.3, 0.3, 0.3, 0.3] });
      if (s1.speed > 18 && r.cfg.trail !== 'none') {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        for (const lp of r.view.trailPoints) {
          r.trail.push(lp.clone().applyQuaternion(q).add(pos), up, trailColor(r.cfg.trail, sharedUniforms.uTime.value, new THREE.Color(r.cfg.paint2)));
        }
      } else r.trail.break();
      r.trail.update(dt);
    }
  }

  private checkpointBurst(_index: number) {
    const p = this.carView.group.position.clone();
    const col = new THREE.Color(this.theme.gate.checkpoint);
    this.particles.emit({ count: 60, position: p, spread: 14, color: [col, new THREE.Color('#ffffff'), new THREE.Color(this.theme.rail)], size: 0.6, life: 0.9, gravity: 6, drag: 1.5, positionSpread: 2 });
  }
  private launchBurst() {
    const p = this.carView.group.position.clone();
    this.particles.emit({ count: 80, position: p, spread: 12, color: [new THREE.Color('#22d3ee'), new THREE.Color('#a855f7'), new THREE.Color('#f472b6'), new THREE.Color('#facc15')], size: 0.6, life: 1.1, gravity: 8, drag: 1.2, positionSpread: 2 });
    this.cameraRig.shake(0.3);
  }
  private finishCelebration() {
    const p = this.carView.group.position.clone();
    const cols = [new THREE.Color('#22d3ee'), new THREE.Color('#a855f7'), new THREE.Color('#f472b6'), new THREE.Color('#facc15'), new THREE.Color('#a3e635'), new THREE.Color('#ffffff')];
    for (let k = 0; k < 4; k++) {
      const off = new THREE.Vector3((Math.random() - 0.5) * 20, 6 + Math.random() * 10, (Math.random() - 0.5) * 20);
      this.particles.emit({ count: 90, position: p.clone().add(off), spread: 16, color: cols, size: 0.8, life: 1.8, lifeSpread: 0.6, gravity: 9, drag: 0.8 });
    }
    this.cameraRig.shake(0.5);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.input.detach();
    this.unloadTrack();
    this.clearRemoteCars();
    this.carView.dispose();
    this.particles.dispose();
    for (const t of this.exhaustTrails) t.dispose();
    for (const t of this.skidTrails) t.dispose();
    this.car.dispose();
    this.physics.dispose();
    this.renderer.dispose();
  }
}
