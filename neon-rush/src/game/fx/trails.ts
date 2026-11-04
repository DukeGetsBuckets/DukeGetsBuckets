// Ribbon trails: glowing exhaust/light trails and neon tire skid trails.
import * as THREE from 'three';

const vertex = /* glsl */ `
  attribute float aAlpha; attribute vec3 aColor;
  varying float vAlpha; varying vec3 vColor; varying float vSide;
  attribute float aSide;
  void main() {
    vAlpha = aAlpha; vColor = aColor; vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragment = /* glsl */ `
  varying float vAlpha; varying vec3 vColor; varying float vSide;
  void main() {
    float edge = 1.0 - abs(vSide);
    float a = vAlpha * smoothstep(0.0, 0.6, edge);
    gl_FragColor = vec4(vColor * 1.8, a);
  }
`;

export class Trail {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private alpha: Float32Array;
  private col: Float32Array;
  private side: Float32Array;
  private pts: THREE.Vector3[] = [];
  private ages: number[] = [];
  private colors: THREE.Color[] = [];
  private tmpRight = new THREE.Vector3();
  active = false;
  width: number;
  life: number;
  private lastPoint = new THREE.Vector3(Infinity, Infinity, Infinity);

  constructor(public maxPoints = 60, width = 0.25, life = 0.7, additive = true) {
    this.width = width; this.life = life;
    this.pos = new Float32Array(maxPoints * 2 * 3);
    this.alpha = new Float32Array(maxPoints * 2);
    this.col = new Float32Array(maxPoints * 2 * 3);
    this.side = new Float32Array(maxPoints * 2);
    const idx: number[] = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
  }

  /** Add a point (world space) with its "right" vector for ribbon width. */
  push(p: THREE.Vector3, right: THREE.Vector3, color: THREE.Color) {
    if (p.distanceToSquared(this.lastPoint) < 0.04) return;
    this.lastPoint.copy(p);
    this.pts.push(p.clone());
    this.ages.push(0);
    this.colors.push(color.clone());
    this.tmpRight.copy(right);
    (this.pts[this.pts.length - 1] as THREE.Vector3 & { r?: THREE.Vector3 }).r = right.clone();
    if (this.pts.length > this.maxPoints) { this.pts.shift(); this.ages.shift(); this.colors.shift(); }
  }

  /** Break the ribbon (start a new segment on next push). */
  break() { this.lastPoint.set(Infinity, Infinity, Infinity); if (this.pts.length) { this.pts = []; this.ages = []; this.colors = []; } }

  update(dt: number) {
    for (let i = 0; i < this.ages.length; i++) this.ages[i] += dt;
    while (this.ages.length && this.ages[0] > this.life) { this.pts.shift(); this.ages.shift(); this.colors.shift(); }
    const n = this.pts.length;
    for (let i = 0; i < this.maxPoints; i++) {
      if (i < n) {
        const p = this.pts[i] as THREE.Vector3 & { r?: THREE.Vector3 };
        const r = p.r ?? this.tmpRight;
        const k = 1 - this.ages[i] / this.life;
        const w = this.width * (0.3 + 0.7 * k);
        const c = this.colors[i];
        for (let s = 0; s < 2; s++) {
          const sign = s === 0 ? -1 : 1;
          const vi = i * 2 + s;
          this.pos[vi * 3] = p.x + r.x * w * sign;
          this.pos[vi * 3 + 1] = p.y + r.y * w * sign;
          this.pos[vi * 3 + 2] = p.z + r.z * w * sign;
          this.alpha[vi] = k * (i === n - 1 ? 1 : 1);
          this.col[vi * 3] = c.r; this.col[vi * 3 + 1] = c.g; this.col[vi * 3 + 2] = c.b;
          this.side[vi] = sign;
        }
      } else {
        // collapse unused vertices onto the last point
        const li = Math.max(0, n - 1);
        for (let s = 0; s < 2; s++) {
          const vi = i * 2 + s;
          if (n > 0) { const p = this.pts[li]; this.pos[vi * 3] = p.x; this.pos[vi * 3 + 1] = p.y; this.pos[vi * 3 + 2] = p.z; }
          this.alpha[vi] = 0;
        }
      }
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSide') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 1;
  }

  dispose() { this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

export function trailColor(trail: string, t: number, base: THREE.Color): THREE.Color {
  switch (trail) {
    case 'fire': return new THREE.Color().setHSL(0.02 + 0.08 * Math.abs(Math.sin(t * 9)), 1, 0.55);
    case 'rainbow': return new THREE.Color().setHSL((t * 0.6) % 1, 1, 0.6);
    case 'ice': return new THREE.Color('#bae6fd');
    case 'stars': return new THREE.Color().setHSL(0.12 + 0.02 * Math.sin(t * 7), 0.9, 0.75);
    default: return base;
  }
}
