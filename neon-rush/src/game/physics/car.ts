// Arcade raycast vehicle on top of a Rapier dynamic rigid body.
// Four suspension rays provide spring/damper forces; per-wheel tire friction is computed
// analytically (lateral grip with saturation, longitudinal drive/brake) which gives
// predictable, skill-based handling with controllable drifting, loops and wall rides.

import type RAPIER from '@dimforge/rapier3d-compat';
import { Vec3, Quat, v3, vadd, vsub, vscale, vcross, vdot, vnorm, vlen, quatRotate, clamp, lerp, quatLookUp } from '@shared/math';
import type { PhysicsWorld } from './world';
import { PHYSICS_DT, GRAVITY } from './world';

export interface CarInput {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steer: number;      // -1..1  (+1 = left)
  handbrake: boolean;
}

export const CAR_SPEC = {
  mass: 1200,
  halfExtents: { x: 0.95, y: 0.34, z: 2.15 },
  colliderOffsetY: 0.12,
  wheelRadius: 0.42,
  wheels: [
    { x: 0.92, y: -0.05, z: 1.42, front: true },
    { x: -0.92, y: -0.05, z: 1.42, front: true },
    { x: 0.92, y: -0.05, z: -1.35, front: false },
    { x: -0.92, y: -0.05, z: -1.35, front: false },
  ],
  suspensionRest: 0.5,
  suspensionStiffness: 58000,
  suspensionDamping: 4400,
  bumpStart: 0.55,           // compression (0..1) where the bump stop engages
  bumpStiffness: 420000,     // N at full compression (progressive, squared)
  engineForce: 26500,
  brakeForce: 34000,
  reverseForce: 11000,
  maxSpeed: 74,              // m/s on flat ground (drag limited)
  boostSpeed: 92,
  gripRate: 24,              // 1/s lateral velocity removal rate
  gripRateDrift: 7.5,
  muFront: 2.9,
  muRear: 3.1,
  muRearDrift: 1.35,
  downforce: 0.0085,         // acceleration per (m/s)^2
  stickStrength: 1.0,        // how strongly gravity follows the road surface when grounded at speed
  extraStick: 0.6,           // additional surface pull (fraction of g) while grounded at speed
  landingAbsorb: 0.75,       // fraction of the into-surface velocity removed on touchdown
  alignTorque: 14,           // chassis-to-surface alignment torque (per kg)
  steerMaxLow: 0.60,
  steerMaxHigh: 0.17,
  steerRate: 6.5,
  steerReturnRate: 11,
  angularDampingGround: 2.2,
  angularDampingAir: 1.1,
  airPitchTorque: 1.3,
  airRollTorque: 1.6,
  airAutoLevel: 9,
  rollingResistance: 38,
};

export interface WheelState {
  grounded: boolean;
  compression: number;   // 0..1
  contact: Vec3;
  normal: Vec3;
  slip: number;          // lateral slip speed (m/s)
  steer: number;         // rad
  spin: number;          // accumulated rotation (rad)
  load: number;          // normal force (N)
}

export interface CarTelemetry {
  speed: number;         // m/s along forward
  speedAbs: number;
  grounded: boolean;
  groundedWheels: number;
  airTime: number;
  drifting: boolean;
  slip: number;          // max lateral slip
  boostTime: number;
  throttle: number;
  steer: number;         // current front wheel steer in rad
  lastImpact: number;    // impulse magnitude from last contact event (decays)
  surfaceUp: Vec3;
}

export class CarPhysics {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly wheels: WheelState[] = [];
  readonly telemetry: CarTelemetry;
  input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private steerCurrent = 0;
  private airTime = 0;
  private wasAirborne = false;
  private lastAirTime = 0;
  landedImpact = 0;
  private boostTime = 0;
  private driftTime = 0;
  position: Vec3 = v3();
  rotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
  prevPosition: Vec3 = v3();
  prevRotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
  velocity: Vec3 = v3();
  angularVelocity: Vec3 = v3();
  forward: Vec3 = v3(0, 0, 1);
  up: Vec3 = v3(0, 1, 0);
  right: Vec3 = v3(-1, 0, 0);
  frozen = true;
  onImpact?: (magnitude: number, point: Vec3) => void;

  constructor(private pw: PhysicsWorld, spawnPos: Vec3, spawnForward: Vec3, spawnUp: Vec3) {
    const R = pw.R;
    const spec = CAR_SPEC;
    const q = quatLookUp(spawnForward, spawnUp);
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
      .setRotation(q)
      .setCcdEnabled(true)
      .setGravityScale(0) // gravity is applied manually (surface-aligned while grounded at speed)
      .setAngularDamping(spec.angularDampingGround)
      .setLinearDamping(0)
      .setCanSleep(false);
    this.body = pw.world.createRigidBody(bodyDesc);
    const colDesc = R.ColliderDesc.cuboid(spec.halfExtents.x, spec.halfExtents.y, spec.halfExtents.z)
      .setTranslation(0, spec.colliderOffsetY, 0)
      .setMassProperties(spec.mass, { x: 0, y: -0.25, z: 0 }, { x: 1600, y: 2400, z: 600 }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.25)
      .setRestitution(0.12)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(12000);
    this.collider = pw.world.createCollider(colDesc, this.body);
    for (const w of spec.wheels) {
      this.wheels.push({ grounded: false, compression: 0, contact: v3(), normal: v3(0, 1, 0), slip: 0, steer: 0, spin: 0, load: 0 });
    }
    this.telemetry = {
      speed: 0, speedAbs: 0, grounded: true, groundedWheels: 4, airTime: 0, drifting: false, slip: 0,
      boostTime: 0, throttle: 0, steer: 0, lastImpact: 0, surfaceUp: v3(0, 1, 0),
    };
    this.syncFromBody();
    this.prevPosition = { ...this.position };
    this.prevRotation = { ...this.rotation };
  }

  get handle() { return this.collider.handle; }

  teleport(pos: Vec3, forward: Vec3, up: Vec3) {
    const q = quatLookUp(forward, up);
    this.body.setTranslation(pos, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.steerCurrent = 0;
    this.airTime = 0;
    this.boostTime = 0;
    this.driftTime = 0;
    for (const w of this.wheels) { w.slip = 0; w.compression = 0.3; w.grounded = true; }
    this.syncFromBody();
    this.prevPosition = { ...this.position };
    this.prevRotation = { ...this.rotation };
  }

  applyBoost() {
    this.boostTime = 1.2;
    const v = this.body.linvel();
    const speed = vlen(v);
    const target = Math.max(speed, CAR_SPEC.boostSpeed);
    const dir = speed > 1 ? vnorm(v) : this.forward;
    this.body.setLinvel(vscale(dir, target), true);
  }

  private syncFromBody() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.position = { x: t.x, y: t.y, z: t.z };
    this.rotation = { x: r.x, y: r.y, z: r.z, w: r.w };
    const lv = this.body.linvel();
    const av = this.body.angvel();
    this.velocity = { x: lv.x, y: lv.y, z: lv.z };
    this.angularVelocity = { x: av.x, y: av.y, z: av.z };
    this.forward = quatRotate(this.rotation, { x: 0, y: 0, z: 1 });
    this.up = quatRotate(this.rotation, { x: 0, y: 1, z: 0 });
    this.right = quatRotate(this.rotation, { x: -1, y: 0, z: 0 });
  }

  /** Called once per fixed physics step BEFORE world.step(). Uses state read back after the previous step. */
  preStep() {
    const spec = CAR_SPEC;
    const dt = PHYSICS_DT;
    const body = this.body;
    const R = this.pw.R;
    const input = this.frozen ? { throttle: 0, brake: 1, steer: 0, handbrake: false } : this.input;
    // Rapier forces persist between steps: clear last step's forces first.
    body.resetForces(false);
    body.resetTorques(false);
    if (this.frozen) {
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.velocity = v3(); this.angularVelocity = v3();
    }

    const vel = this.velocity;
    const forwardSpeed = vdot(vel, this.forward);
    const speedAbs = vlen(vel);
    const speed01 = clamp(speedAbs / 60, 0, 1);

    // --- steering (speed sensitive, rate limited for keyboard play) ---
    const maxSteer = lerp(spec.steerMaxLow, spec.steerMaxHigh, Math.pow(speed01, 0.8));
    const steerTarget = clamp(input.steer, -1, 1) * maxSteer;
    const rate = Math.abs(steerTarget) < Math.abs(this.steerCurrent) ? spec.steerReturnRate : spec.steerRate;
    const maxDelta = rate * dt * maxSteer;
    this.steerCurrent += clamp(steerTarget - this.steerCurrent, -maxDelta, maxDelta);
    if (forwardSpeed < -0.5) {
      // reversing: keep steering intuitive
    }

    // --- suspension rays ---
    let groundedWheels = 0;
    let surfaceUp = v3();
    const comWorld = body.worldCom();
    const com = { x: comWorld.x, y: comWorld.y, z: comWorld.z };
    const rayDir = vscale(this.up, -1);
    const maxLen = spec.suspensionRest + spec.wheelRadius;
    const drifting = input.handbrake && speedAbs > 6;
    this.driftTime = drifting ? this.driftTime + dt : Math.max(0, this.driftTime - dt * 3);
    const driftBlend = clamp(this.driftTime / 0.18, 0, 1);

    let maxSlip = 0;
    for (let i = 0; i < 4; i++) {
      const wdef = spec.wheels[i];
      const w = this.wheels[i];
      const attach = vadd(this.position, quatRotate(this.rotation, { x: wdef.x, y: wdef.y, z: wdef.z }));
      const ray = new R.Ray(attach, rayDir);
      const hit = this.pw.world.castRayAndGetNormal(ray, maxLen, true, undefined, undefined, this.collider, body);
      w.steer = wdef.front ? this.steerCurrent : 0;
      if (hit) {
        const d = hit.timeOfImpact;
        const compression = clamp((maxLen - d) / spec.suspensionRest, 0, 1);
        const contact = vadd(attach, vscale(rayDir, d));
        const n = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
        // flip normal to face the car
        const normal = vdot(n, this.up) < 0 ? vscale(n, -1) : n;
        // point velocity at the attach point
        const rel = vsub(attach, com);
        const pv = vadd(vel, vcross(this.angularVelocity, rel));
        const springVel = vdot(pv, this.up);
        let force = spec.suspensionStiffness * compression * spec.suspensionRest - spec.suspensionDamping * springVel;
        // progressive bump stop: lets the suspension carry huge loads in loops / corkscrews
        // at top speed without the chassis bottoming out on the road
        if (compression > spec.bumpStart) {
          const b = (compression - spec.bumpStart) / (1 - spec.bumpStart);
          force += spec.bumpStiffness * b * b - spec.suspensionDamping * 2 * Math.min(0, springVel);
        }
        force = Math.max(0, force);
        body.addForceAtPoint(vscale(this.up, force), attach, true);

        // --- tire friction ---
        const relC = vsub(contact, com);
        const cv = vadd(vel, vcross(this.angularVelocity, relC));
        // wheel forward in car space, rotated by steer about car up
        const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
        // local forward (0,0,1) rotated around Y by steer: (sin, 0, cos)
        let wf = quatRotate(this.rotation, { x: sn, y: 0, z: cs });
        wf = vnorm(vsub(wf, vscale(normal, vdot(wf, normal))));
        const wr = vnorm(vcross(wf, normal));
        const vLat = vdot(cv, wr);
        const vLon = vdot(cv, wf);
        const load = force + spec.mass * Math.abs(GRAVITY) * 0.05;
        const massShare = spec.mass / 4;
        const isRear = !wdef.front;
        const gripRate = isRear ? lerp(spec.gripRate, spec.gripRateDrift, driftBlend) : lerp(spec.gripRate, spec.gripRate * 0.75, driftBlend);
        const mu = isRear ? lerp(spec.muRear, spec.muRearDrift, driftBlend) : spec.muFront;
        let latForce = -vLat * massShare * gripRate;
        const maxLat = mu * load;
        latForce = clamp(latForce, -maxLat, maxLat);
        w.slip = Math.abs(vLat);
        if (Math.abs(latForce) >= maxLat * 0.98) w.slip = Math.max(w.slip, 5);
        maxSlip = Math.max(maxSlip, w.slip);

        // longitudinal
        let lonForce = -vLon * spec.rollingResistance;
        const canDrive = true;
        if (input.throttle > 0 && canDrive) {
          const eff = clamp(1 - speedAbs / (spec.maxSpeed * 1.08), 0, 1);
          lonForce += (input.throttle * spec.engineForce / 4) * (0.35 + 0.65 * eff);
        }
        if (input.brake > 0) {
          if (vLon > 1.5) lonForce -= input.brake * spec.brakeForce / 4;
          else lonForce -= input.brake * spec.reverseForce / 4 * clamp(1 + vLon / 12, 0, 1);
        }
        if (drifting && isRear) lonForce *= 0.75;
        const maxLon = mu * load * 1.2;
        lonForce = clamp(lonForce, -maxLon, maxLon);
        const f = vadd(vscale(wr, latForce), vscale(wf, lonForce));
        body.addForceAtPoint(f, attach, true);

        w.grounded = true; w.compression = compression; w.contact = contact; w.normal = normal; w.load = load;
        groundedWheels++;
        surfaceUp = vadd(surfaceUp, normal);
        w.spin += (vLon / spec.wheelRadius) * dt;
      } else {
        w.grounded = false; w.compression = 0; w.slip = 0; w.load = 0;
        w.spin += (forwardSpeed / spec.wheelRadius) * dt;
      }
    }

    const grounded = groundedWheels >= 2;
    if (grounded) this.airTime = 0; else this.airTime += dt;
    surfaceUp = groundedWheels > 0 ? vnorm(surfaceUp) : v3(0, 1, 0);

    // --- gravity: world gravity in the air / at low speed, surface-aligned ("magnetic") when
    //     grounded at speed. This is what makes loops, corkscrews and wall rides drivable while
    //     keeping crest jumps and ramps physical (the car still lifts off when v^2/R > g).
    const stick = grounded ? clamp((speedAbs - 6) / 10, 0, 1) * spec.stickStrength : 0;
    const gWorld = v3(0, GRAVITY, 0);
    const gSurf = vscale(surfaceUp, GRAVITY);
    const gEff = { x: lerp(gWorld.x, gSurf.x, stick), y: lerp(gWorld.y, gSurf.y, stick), z: lerp(gWorld.z, gSurf.z, stick) };
    // extra "stick" presses the car onto the road at speed (acts like downforce on any surface)
    const extra = vscale(surfaceUp, GRAVITY * spec.extraStick * stick);
    body.addForce(vscale(vadd(gEff, extra), spec.mass), true);
    // landing absorber: when touching down after a jump, bleed off the velocity into the surface
    if (grounded && this.wasAirborne && this.lastAirTime > 0.15) {
      const vn = vdot(vel, surfaceUp);
      if (vn < 0) {
        body.setLinvel(vsub(vel, vscale(surfaceUp, vn * spec.landingAbsorb)), true);
        body.setAngvel(vscale(this.angularVelocity, 0.4), true);
      }
      this.landedImpact = Math.min(1, -vn / 30);
    } else this.landedImpact = 0;
    this.lastAirTime = this.airTime;
    this.wasAirborne = !grounded;
    // --- align the chassis with the surface while grounded (keeps wheels planted through
    //     twisting corkscrews, loops and wall rides) ---
    if (grounded && stick > 0) {
      const axis = vcross(this.up, surfaceUp);
      body.addTorque(vscale(axis, spec.alignTorque * spec.mass * stick), true);
    }

    // --- aero drag (caps top speed) and downforce ---
    const cDrag = spec.engineForce / (spec.maxSpeed * spec.maxSpeed);
    const dragScale = this.boostTime > 0 ? 0.35 : 1;
    if (speedAbs > 0.1) body.addForce(vscale(vel, -cDrag * speedAbs * dragScale), true);
    if (groundedWheels > 0) {
      const df = spec.downforce * speedAbs * speedAbs * spec.mass;
      body.addForce(vscale(this.up, -df), true);
    }

    // --- drift yaw assist: helps rotate the car into the slide ---
    if (drifting && grounded) {
      const yaw = input.steer * spec.mass * 1.3 * clamp(speedAbs / 25, 0, 1);
      body.addTorque(vscale(this.up, yaw * driftBlend), true);
    }
    // --- ground steering assist at low speed (prevents "boat" feel) ---
    if (grounded && speedAbs > 0.5) {
      const yawAssist = input.steer * spec.mass * 0.55 * clamp(speedAbs / 15, 0, 1) * (forwardSpeed >= 0 ? 1 : -1);
      body.addTorque(vscale(this.up, yawAssist), true);
    }

    // --- airborne control + auto-level ---
    body.setAngularDamping(grounded ? spec.angularDampingGround : spec.angularDampingAir);
    if (!grounded && this.airTime > 0.12) {
      const pitchInput = input.throttle - input.brake; // throttle = nose down, brake = nose up
      body.addTorque(vscale(this.right, -pitchInput * spec.airPitchTorque * spec.mass), true);
      body.addTorque(vscale(this.forward, -input.steer * spec.airRollTorque * spec.mass), true);
      if (this.airTime > 0.2) {
        // torque to align car up with world up
        const worldUp = v3(0, 1, 0);
        const axis = vcross(this.up, worldUp);
        const strength = spec.airAutoLevel * spec.mass;
        body.addTorque(vscale(axis, strength), true);
      }
    }

    this.boostTime = Math.max(0, this.boostTime - dt);

    const t = this.telemetry;
    t.speed = forwardSpeed; t.speedAbs = speedAbs; t.grounded = grounded; t.groundedWheels = groundedWheels;
    t.airTime = this.airTime; t.drifting = drifting && grounded; t.slip = maxSlip; t.boostTime = this.boostTime;
    t.throttle = input.throttle; t.steer = this.steerCurrent; t.surfaceUp = surfaceUp;
    t.lastImpact = Math.max(0, t.lastImpact - dt * 40);
  }

  /** Called after world.step(): reads back the new state and handles contact events. */
  postStep() {
    this.prevPosition = this.position;
    this.prevRotation = this.rotation;
    this.syncFromBody();
    this.pw.eventQueue.drainContactForceEvents((ev) => {
      if (ev.collider1() !== this.collider.handle && ev.collider2() !== this.collider.handle) return;
      const mag = ev.totalForceMagnitude();
      const dir = ev.maxForceDirection();
      const mag01 = clamp(mag / 90000, 0, 1);
      this.telemetry.lastImpact = Math.max(this.telemetry.lastImpact, mag01);
      if (this.onImpact && mag01 > 0.08) {
        const d = vnorm({ x: dir.x, y: dir.y, z: dir.z });
        const point = vsub(this.position, vscale(d, 1.6));
        this.onImpact(mag01, point);
      }
    });
    // also drain collision events to keep the queue empty
    this.pw.eventQueue.drainCollisionEvents(() => {});
  }

  dispose() {
    this.pw.world.removeRigidBody(this.body);
  }
}
