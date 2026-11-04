import RAPIER from '@dimforge/rapier3d-compat';

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
export const GRAVITY = -24;

let initPromise: Promise<typeof RAPIER> | null = null;

export function initRapier(): Promise<typeof RAPIER> {
  if (!initPromise) initPromise = RAPIER.init().then(() => RAPIER);
  return initPromise;
}

export interface TrackColliderData { positions: Float32Array; indices: Uint32Array }

export class PhysicsWorld {
  readonly R: typeof RAPIER;
  readonly world: RAPIER.World;
  readonly eventQueue: RAPIER.EventQueue;
  private trackColliders: RAPIER.Collider[] = [];

  constructor(R: typeof RAPIER) {
    this.R = R;
    this.world = new R.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_DT;
    this.eventQueue = new R.EventQueue(true);
  }

  setTrack(data: TrackColliderData) {
    this.clearTrack();
    if (data.indices.length === 0) return;
    const R = this.R;
    const desc = R.ColliderDesc.trimesh(data.positions, data.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED)
      .setFriction(0.6)
      .setRestitution(0.05);
    this.trackColliders.push(this.world.createCollider(desc));
  }

  addStaticBox(x: number, y: number, z: number, hx: number, hy: number, hz: number) {
    const desc = this.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.6);
    this.trackColliders.push(this.world.createCollider(desc));
  }

  clearTrack() {
    for (const c of this.trackColliders) this.world.removeCollider(c, false);
    this.trackColliders = [];
  }

  step() {
    this.world.step(this.eventQueue);
  }

  dispose() {
    this.world.free();
    this.eventQueue.free();
  }
}
