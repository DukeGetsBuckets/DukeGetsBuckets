// GPU-friendly pooled particle system (single Points draw call, CPU-simulated).
import * as THREE from 'three';

const vertex = /* glsl */ `
  attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
  varying vec3 vColor; varying float vAlpha;
  void main() {
    vColor = aColor; vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (280.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;
const fragment = /* glsl */ `
  varying vec3 vColor; varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = smoothstep(0.5, 0.1, d) * vAlpha;
    gl_FragColor = vec4(vColor * 1.6, a);
  }
`;

export interface EmitOptions {
  count: number;
  position: THREE.Vector3;
  velocity?: THREE.Vector3;
  spread?: number;        // random velocity magnitude
  speedSpread?: number;
  color: THREE.Color | THREE.Color[];
  size?: number;
  sizeSpread?: number;
  life?: number;
  lifeSpread?: number;
  gravity?: number;
  drag?: number;
  positionSpread?: number;
  shrink?: boolean;
}

export class ParticleSystem {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private baseSize: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private shrink: Uint8Array;
  private head = 0;
  private alive = 0;
  readonly capacity: number;

  constructor(capacity = 2500) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.shrink = new Uint8Array(capacity);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
  }

  emit(o: EmitOptions) {
    const colors = Array.isArray(o.color) ? o.color : [o.color];
    const spread = o.spread ?? 2, life = o.life ?? 0.8, lifeSpread = o.lifeSpread ?? 0.4;
    const size = o.size ?? 0.5, sizeSpread = o.sizeSpread ?? 0.3, g = o.gravity ?? 0, drag = o.drag ?? 0.5, ps = o.positionSpread ?? 0.2;
    for (let n = 0; n < o.count; n++) {
      const i = this.head; this.head = (this.head + 1) % this.capacity;
      this.pos[i * 3] = o.position.x + (Math.random() - 0.5) * ps * 2;
      this.pos[i * 3 + 1] = o.position.y + (Math.random() - 0.5) * ps * 2;
      this.pos[i * 3 + 2] = o.position.z + (Math.random() - 0.5) * ps * 2;
      const rx = Math.random() - 0.5, ry = Math.random() - 0.5, rz = Math.random() - 0.5;
      const rl = Math.hypot(rx, ry, rz) || 1;
      const sp = spread * (0.4 + Math.random() * 0.8);
      this.vel[i * 3] = (o.velocity?.x ?? 0) + (rx / rl) * sp;
      this.vel[i * 3 + 1] = (o.velocity?.y ?? 0) + (ry / rl) * sp;
      this.vel[i * 3 + 2] = (o.velocity?.z ?? 0) + (rz / rl) * sp;
      const c = colors[Math.floor(Math.random() * colors.length)];
      this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
      const s = size + (Math.random() - 0.5) * sizeSpread * 2;
      this.size[i] = s; this.baseSize[i] = s;
      this.alpha[i] = 1;
      const l = Math.max(0.05, life + (Math.random() - 0.5) * lifeSpread * 2);
      this.life[i] = l; this.maxLife[i] = l;
      this.grav[i] = g; this.drag[i] = drag; this.shrink[i] = o.shrink === false ? 0 : 1;
    }
    this.alive = Math.min(this.capacity, this.alive + o.count);
  }

  update(dt: number) {
    const n = this.capacity;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = k < 0.3 ? k / 0.3 : 1;
      this.size[i] = this.shrink[i] ? this.baseSize[i] * (0.3 + 0.7 * k) : this.baseSize[i];
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() { this.life.fill(0); this.alpha.fill(0); }
  dispose() { this.geo.dispose(); (this.points.material as THREE.Material).dispose(); }
}
