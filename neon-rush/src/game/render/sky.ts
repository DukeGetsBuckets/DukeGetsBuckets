import * as THREE from 'three';
import type { Theme } from '../track/themes';
import { sharedUniforms } from './materials';

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w * 0.99999; // always behind everything
  }
`;
const skyFragment = /* glsl */ `
  uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom;
  uniform vec3 uSunColor; uniform vec3 uSunDir; uniform float uSunSize;
  uniform float uStars; uniform float uAurora; uniform vec3 uAuroraColor; uniform float uTime;
  varying vec3 vDir;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  void main() {
    vec3 d = normalize(vDir);
    float y = d.y;
    vec3 col = y > 0.0 ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.6, y), 0.8)) : mix(uHorizon, uBottom, smoothstep(0.0, 0.35, -y));
    float sd = max(dot(d, uSunDir), 0.0);
    float disk = smoothstep(1.0 - 0.0025 * uSunSize, 1.0 - 0.0005 * uSunSize, sd);
    float halo = pow(sd, 18.0 / uSunSize) * 0.55 + pow(sd, 3.0) * 0.18;
    col += uSunColor * (disk * 2.5 + halo);
    if (uStars > 0.5 && y > -0.05) {
      vec3 g = floor(d * 260.0);
      float h = hash(g);
      float star = step(0.985, h) * smoothstep(0.0, 0.3, y + 0.05);
      float tw = 0.6 + 0.4 * sin(uTime * (1.0 + h * 5.0) + h * 40.0);
      col += vec3(1.0) * star * tw * (0.6 + h);
    }
    if (uAurora > 0.5 && y > 0.05) {
      float band = sin(d.x * 6.0 + uTime * 0.25 + sin(d.z * 4.0 + uTime * 0.2) * 1.5);
      float band2 = sin(d.z * 5.0 - uTime * 0.17 + d.x * 3.0);
      float a = smoothstep(0.55, 1.0, band) * smoothstep(0.3, 1.0, band2);
      col += uAuroraColor * a * smoothstep(0.05, 0.4, y) * (1.0 - smoothstep(0.5, 0.9, y)) * 0.6;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(theme: Theme) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(theme.sky.top) },
        uHorizon: { value: new THREE.Color(theme.sky.horizon) },
        uBottom: { value: new THREE.Color(theme.sky.bottom) },
        uSunColor: { value: new THREE.Color(theme.sky.sunColor) },
        uSunDir: { value: new THREE.Vector3(...theme.sky.sunDir).normalize() },
        uSunSize: { value: theme.sky.sunSize },
        uStars: { value: theme.sky.stars ? 1 : 0 },
        uAurora: { value: theme.sky.aurora ? 1 : 0 },
        uAuroraColor: { value: new THREE.Color(theme.sky.auroraColor) },
        uTime: sharedUniforms.uTime,
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }
  update(cameraPos: THREE.Vector3) { this.mesh.position.copy(cameraPos); }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

let cloudTexture: THREE.Texture | null = null;
export function getCloudTexture() {
  if (cloudTexture) return cloudTexture;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 128);
  const blobs = [[70, 70, 48], [120, 55, 56], [170, 68, 46], [100, 80, 40], [150, 85, 38], [60, 85, 30], [200, 85, 30]];
  for (const [x, y, r] of blobs) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  cloudTexture = new THREE.CanvasTexture(c);
  cloudTexture.colorSpace = THREE.SRGBColorSpace;
  return cloudTexture;
}

let glowTexture: THREE.Texture | null = null;
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}
