// Procedural, stylized car models (6 original designs) with full customization:
// paint + finish, decals (canvas texture), accent color, neon underglow, tire colors,
// wheel designs, emissive lights. Also builds the holographic "ghost" variant.

import * as THREE from 'three';
import type { CarConfig, CarBodyId, WheelId, DecalId } from '@shared/game/carConfig';
import { CAR_SPEC } from '../physics/car';
import { getGlowTexture } from '../render/sky';

type Pt = [number, number]; // (z along length, y height) — +z = front

interface BodyDesign {
  width: number;
  cabinWidth: number;
  body: Pt[];
  cabin: Pt[] | null;
  extras: (g: THREE.Group, m: Materials) => void;
  lengthScale?: number;
  openWheels?: boolean;
}

interface Materials {
  paint: THREE.MeshPhysicalMaterial;
  accent: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  dark: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  headlight: THREE.MeshBasicMaterial;
  taillight: THREE.MeshBasicMaterial;
  tire: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  rimGlow: THREE.MeshBasicMaterial;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, g?: THREE.Group) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  g?.add(m);
  return m;
}

const DESIGNS: Record<CarBodyId, BodyDesign> = {
  viper: {
    width: 1.9, cabinWidth: 1.45,
    body: [[-2.1, 0.02], [2.1, 0.02], [2.15, 0.42], [1.55, 0.62], [0.3, 0.72], [-1.5, 0.76], [-2.12, 0.82]],
    cabin: [[0.55, 0.7], [-0.15, 1.1], [-1.05, 1.1], [-1.55, 0.76]],
    extras: (g, m) => {
      // rear spoiler
      box(1.9, 0.07, 0.42, m.accent, 0, 1.08, -2.0, g);
      box(0.08, 0.32, 0.3, m.dark, 0.7, 0.92, -2.0, g);
      box(0.08, 0.32, 0.3, m.dark, -0.7, 0.92, -2.0, g);
      // hood vents
      box(0.5, 0.03, 0.5, m.accent, 0.45, 0.66, 1.3, g);
      box(0.5, 0.03, 0.5, m.accent, -0.45, 0.66, 1.3, g);
      // side skirts
      box(0.08, 0.14, 3.2, m.accent, 0.98, 0.1, 0, g);
      box(0.08, 0.14, 3.2, m.accent, -0.98, 0.1, 0, g);
    },
  },
  brute: {
    width: 2.05, cabinWidth: 1.6,
    body: [[-2.15, 0.02], [2.15, 0.02], [2.15, 0.7], [1.3, 0.84], [0.5, 0.9], [-1.6, 0.94], [-2.15, 1.0]],
    cabin: [[0.6, 0.88], [0.05, 1.36], [-1.05, 1.36], [-1.65, 0.92]],
    extras: (g, m) => {
      box(0.7, 0.18, 0.9, m.dark, 0, 0.92, 1.1, g); // hood scoop
      box(0.5, 0.06, 0.3, m.accent, 0, 1.02, 0.7, g);
      box(2.1, 0.12, 0.5, m.dark, 0, 1.05, -2.05, g); // ducktail
      box(0.35, 0.25, 0.25, m.chrome, 0.6, 0.15, -2.25, g); // exhausts
      box(0.35, 0.25, 0.25, m.chrome, -0.6, 0.15, -2.25, g);
      box(2.1, 0.22, 0.25, m.chrome, 0, 0.2, 2.2, g); // front bumper
    },
  },
  phantom: {
    width: 2.0, cabinWidth: 1.3,
    body: [[-2.0, 0.08], [2.0, 0.08], [2.15, 0.5], [1.6, 0.92], [0.5, 1.12], [-0.8, 1.16], [-1.7, 0.92], [-2.1, 0.55]],
    cabin: [[1.15, 0.95], [0.35, 1.34], [-0.75, 1.34], [-1.3, 1.02]],
    extras: (g, m) => {
      // fenders covering wheels
      for (const [x, z] of [[0.95, 1.42], [-0.95, 1.42], [0.95, -1.35], [-0.95, -1.35]]) {
        const f = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 16, 1, false, 0, Math.PI), m.paint);
        f.rotation.z = Math.PI / 2; f.rotation.y = Math.PI / 2;
        f.position.set(x, 0.12, z);
        g.add(f);
      }
      // tail fins
      const finGeo = new THREE.BoxGeometry(0.08, 0.7, 0.9);
      const f1 = new THREE.Mesh(finGeo, m.accent); f1.position.set(0.8, 1.2, -1.7); f1.rotation.x = 0.4; g.add(f1);
      const f2 = new THREE.Mesh(finGeo, m.accent); f2.position.set(-0.8, 1.2, -1.7); f2.rotation.x = 0.4; g.add(f2);
      box(0.9, 0.08, 0.4, m.accent, 0, 1.5, -1.8, g);
      // glowing nose strip
      box(1.2, 0.08, 0.1, m.headlight, 0, 0.55, 2.16, g);
    },
  },
  formula: {
    width: 1.05, cabinWidth: 0.8, openWheels: true,
    body: [[-2.1, 0.1], [2.1, 0.1], [2.15, 0.36], [1.05, 0.48], [0.25, 0.62], [-0.55, 0.95], [-1.45, 0.95], [-2.1, 0.62]],
    cabin: [[0.35, 0.6], [-0.1, 0.98], [-0.6, 0.98], [-0.85, 0.75]],
    extras: (g, m) => {
      box(2.1, 0.05, 0.55, m.accent, 0, 0.12, 2.1, g); // front wing
      box(0.08, 0.3, 0.55, m.accent, 1.05, 0.25, 2.1, g);
      box(0.08, 0.3, 0.55, m.accent, -1.05, 0.25, 2.1, g);
      box(2.0, 0.07, 0.55, m.accent, 0, 1.15, -2.0, g); // rear wing
      box(0.07, 0.5, 0.6, m.dark, 1.0, 0.95, -2.0, g);
      box(0.07, 0.5, 0.6, m.dark, -1.0, 0.95, -2.0, g);
      box(0.5, 0.45, 0.5, m.dark, 0, 1.1, -0.9, g); // air intake
      box(0.6, 0.5, 1.6, m.paint, 0.95, 0.35, 0, g); // sidepods
      box(0.6, 0.5, 1.6, m.paint, -0.95, 0.35, 0, g);
    },
  },
  wedge: {
    width: 2.0, cabinWidth: 1.5,
    body: [[-2.15, 0.02], [2.15, 0.02], [2.15, 0.26], [0.2, 0.84], [-1.2, 1.02], [-2.15, 1.02]],
    cabin: [[0.35, 0.8], [-0.4, 1.08], [-1.3, 1.08], [-1.5, 1.0]],
    extras: (g, m) => {
      box(2.2, 0.06, 0.6, m.accent, 0, 1.25, -2.0, g); // big wing
      box(0.1, 0.3, 0.5, m.dark, 0.9, 1.1, -2.0, g);
      box(0.1, 0.3, 0.5, m.dark, -0.9, 1.1, -2.0, g);
      box(0.9, 0.05, 0.6, m.accent, 0.5, 0.56, 0.8, g); // louvers
      box(0.9, 0.05, 0.6, m.accent, -0.5, 0.56, 0.8, g);
      box(1.9, 0.08, 0.1, m.headlight, 0, 0.22, 2.17, g); // light bar
    },
  },
  bolt: {
    width: 1.85, cabinWidth: 1.55, lengthScale: 0.86,
    body: [[-2.1, 0.02], [2.1, 0.02], [2.15, 0.62], [1.35, 0.86], [0.4, 0.9], [-1.7, 0.9], [-2.12, 0.92]],
    cabin: [[0.5, 0.88], [0.1, 1.5], [-1.45, 1.5], [-1.9, 0.95]],
    extras: (g, m) => {
      box(1.6, 0.06, 0.4, m.accent, 0, 1.52, -1.75, g); // roof spoiler
      box(0.2, 0.3, 0.3, m.chrome, 0.5, 0.15, -2.05, g);
      box(1.5, 0.1, 0.1, m.accent, 0, 0.98, 2.1, g); // front lip
      box(1.0, 0.35, 0.1, m.dark, 0, 0.3, 2.16, g); // grill
    },
  },
};

function extrudeProfile(pts: Pt[], width: number, mat: THREE.Material, bevel = 0.1, lengthScale = 1): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0] * lengthScale, pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0] * lengthScale, pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, steps: 1 });
  // shape x (length) -> world z; extrusion z -> world x
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(-Math.PI / 2);
  // top-down UVs for decals
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / 2.4 + 0.5;
    uv[i * 2 + 1] = pos.getZ(i) / 4.8 + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

export function buildDecalTexture(cfg: CarConfig): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = cfg.paint;
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = cfg.paint2;
  ctx.strokeStyle = cfg.paint2;
  const d: DecalId = cfg.decal;
  // canvas x = car width (u), canvas y = car length (v), front at y=512
  switch (d) {
    case 'stripes':
      ctx.fillRect(196, 0, 40, 512);
      ctx.fillRect(276, 0, 40, 512);
      break;
    case 'checker':
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2 === 0) ctx.fillRect(x * 64, y * 64, 64, 64);
      ctx.globalAlpha = 1;
      break;
    case 'flames': {
      ctx.beginPath();
      ctx.moveTo(0, 512);
      for (let i = 0; i <= 10; i++) {
        const x = i * 51.2;
        const y = 512 - 120 - (i % 2 === 0 ? 150 : 40) - Math.sin(i * 1.7) * 40;
        ctx.quadraticCurveTo(x - 25, y + 90, x, y);
      }
      ctx.lineTo(512, 512);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'number': {
      ctx.beginPath(); ctx.arc(256, 300, 110, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.fillStyle = cfg.paint2;
      ctx.font = 'bold 150px Orbitron, Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.save(); ctx.translate(256, 300); ctx.rotate(Math.PI / 2); ctx.fillText(String(cfg.number), 0, 0); ctx.restore();
      break;
    }
    case 'lightning': {
      ctx.lineWidth = 34; ctx.lineJoin = 'miter';
      ctx.beginPath(); ctx.moveTo(300, 512); ctx.lineTo(220, 330); ctx.lineTo(290, 300); ctx.lineTo(200, 120); ctx.lineTo(260, 110); ctx.lineTo(180, 0);
      ctx.stroke();
      break;
    }
    case 'hex': {
      const r = 34;
      for (let row = 0; row < 10; row++) for (let col = 0; col < 10; col++) {
        const cx = col * r * 1.75 + (row % 2) * r * 0.875, cy = row * r * 1.5;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; ctx.lineTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78); }
        ctx.closePath();
        ctx.globalAlpha = 0.25 + 0.5 * ((row + col) % 3 === 0 ? 1 : 0.3);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'waves': {
      ctx.lineWidth = 14;
      for (let k = 0; k < 6; k++) {
        ctx.beginPath();
        for (let y = 0; y <= 512; y += 8) { const x = 256 + Math.sin(y / 40 + k) * (40 + k * 25); if (y === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.globalAlpha = 0.9 - k * 0.12;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    default: break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function buildWheel(kind: WheelId, m: Materials, radius: number): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.34, 22, 1), m.tire);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);
  const rimR = radius * 0.66;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, 0.36, kind === 'hex' ? 6 : 24, 1), m.rim);
  rim.rotation.z = Math.PI / 2;
  g.add(rim);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(rimR * 0.92, 0.035, 6, 24), m.rimGlow);
  ring.rotation.y = Math.PI / 2; ring.position.x = 0.19; g.add(ring);
  const ring2 = ring.clone(); ring2.position.x = -0.19; g.add(ring2);
  const spokeCount = kind === 'star' ? 5 : kind === 'blade' ? 3 : kind === 'turbo' ? 8 : kind === 'hex' ? 6 : 6;
  for (let i = 0; i < spokeCount; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.4, kind === 'blade' ? 0.12 : 0.07, rimR * 1.7), kind === 'turbo' ? m.rimGlow : m.rimGlow);
    s.rotation.x = (i / spokeCount) * Math.PI + (kind === 'star' ? 0.3 : 0);
    g.add(s);
  }
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), m.chrome);
  hub.position.x = 0.2; g.add(hub);
  const hub2 = hub.clone(); hub2.position.x = -0.2; g.add(hub2);
  return g;
}

export interface CarVisualState {
  wheelSteer: number[];      // rad per wheel
  wheelSpin: number[];       // rad per wheel
  wheelCompression: number[]; // 0..1
}

export class CarView {
  readonly group = new THREE.Group();
  readonly bodyGroup = new THREE.Group();
  readonly wheels: THREE.Group[] = [];
  readonly exhaustPoints: THREE.Vector3[] = [];
  readonly trailPoints: THREE.Vector3[] = [];
  underglowColor: THREE.Color | null = null;
  private materials: Materials | null = null;
  private decalTex: THREE.Texture | null = null;
  private underglowMesh: THREE.Mesh | null = null;
  private underglowLight: THREE.PointLight | null = null;
  private disposables: { dispose(): void }[] = [];
  config: CarConfig;
  readonly ghost: boolean;
  private ghostMat: THREE.MeshBasicMaterial | null = null;
  readonly brakeLights: THREE.Mesh[] = [];

  constructor(config: CarConfig, opts: { ghost?: boolean; ghostColor?: string; shadows?: boolean } = {}) {
    this.config = config;
    this.ghost = !!opts.ghost;
    this.group.add(this.bodyGroup);
    this.build(opts);
  }

  private build(opts: { ghost?: boolean; ghostColor?: string; shadows?: boolean }) {
    const cfg = this.config;
    const design = DESIGNS[cfg.body];
    const m = this.createMaterials(cfg, opts);
    this.materials = m;
    const bg = this.bodyGroup;
    const ls = design.lengthScale ?? 1;
    const bodyMesh = extrudeProfile(design.body, design.width, m.paint, 0.1, ls);
    bg.add(bodyMesh);
    if (design.cabin) {
      const cabin = extrudeProfile(design.cabin, design.cabinWidth, m.glass, 0.06, ls);
      bg.add(cabin);
    }
    const extras = new THREE.Group();
    design.extras(extras, m);
    extras.scale.z = ls;
    bg.add(extras);
    // lights
    const front = design.body.reduce((a, p) => Math.max(a, p[0]), 0) * ls;
    const rear = design.body.reduce((a, p) => Math.min(a, p[0]), 0) * ls;
    const hw = design.width / 2;
    if (!design.openWheels) {
      box(0.45, 0.14, 0.1, m.headlight, hw - 0.38, 0.45, front - 0.02, bg);
      box(0.45, 0.14, 0.1, m.headlight, -(hw - 0.38), 0.45, front - 0.02, bg);
    } else {
      box(0.3, 0.1, 0.1, m.headlight, 0, 0.42, front - 0.02, bg);
    }
    for (const side of [1, -1]) {
      const tl = box(design.openWheels ? 0.25 : 0.55, 0.12, 0.1, m.taillight, side * (hw - 0.4) * (design.openWheels ? 0.6 : 1), 0.62, rear + 0.02, bg);
      this.brakeLights.push(tl);
    }
    // exhausts / trail emitters
    this.exhaustPoints.length = 0;
    this.exhaustPoints.push(new THREE.Vector3(hw - 0.45, 0.2, rear - 0.1), new THREE.Vector3(-(hw - 0.45), 0.2, rear - 0.1));
    this.trailPoints.length = 0;
    this.trailPoints.push(new THREE.Vector3(hw * 0.75, 0.8, rear), new THREE.Vector3(-hw * 0.75, 0.8, rear));
    // wheels
    for (const w of CAR_SPEC.wheels) {
      const wg = buildWheel(cfg.wheel, m, CAR_SPEC.wheelRadius);
      const holder = new THREE.Group();
      holder.add(wg);
      holder.position.set(w.x, w.y - 0.4 + 0.3, w.z); // visual offset applied in update
      this.group.add(holder);
      this.wheels.push(holder);
    }
    // underglow
    if (cfg.underglow !== 'none' && !this.ghost) {
      this.underglowColor = new THREE.Color(cfg.underglow);
      const mat = new THREE.MeshBasicMaterial({ map: getGlowTexture(), color: this.underglowColor.clone().multiplyScalar(1.5), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 6.5), mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = -0.55;
      this.group.add(plane);
      this.underglowMesh = plane;
      this.disposables.push(mat, plane.geometry);
    }
    bg.position.y = -0.32;
    if (opts.shadows === false) bg.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false; });
  }

  private createMaterials(cfg: CarConfig, opts: { ghost?: boolean; ghostColor?: string }): Materials {
    if (opts.ghost) {
      const gc = new THREE.Color(opts.ghostColor ?? '#67e8f9');
      const gm = new THREE.MeshBasicMaterial({ color: gc, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ghostMat = gm;
      const bright = new THREE.MeshBasicMaterial({ color: gc.clone().multiplyScalar(2), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.disposables.push(gm, bright);
      return { paint: gm as unknown as THREE.MeshPhysicalMaterial, accent: bright as unknown as THREE.MeshStandardMaterial, glass: gm as unknown as THREE.MeshPhysicalMaterial, dark: gm as unknown as THREE.MeshStandardMaterial, chrome: gm as unknown as THREE.MeshStandardMaterial, headlight: bright, taillight: bright, tire: gm as unknown as THREE.MeshStandardMaterial, rim: bright as unknown as THREE.MeshStandardMaterial, rimGlow: bright };
    }
    this.decalTex = buildDecalTexture(cfg);
    const finish = cfg.finish;
    const paint = new THREE.MeshPhysicalMaterial({
      map: this.decalTex, color: 0xffffff,
      metalness: finish === 'metallic' ? 0.85 : finish === 'matte' ? 0.05 : 0.25,
      roughness: finish === 'metallic' ? 0.32 : finish === 'matte' ? 0.85 : 0.22,
      clearcoat: finish === 'matte' ? 0 : finish === 'metallic' ? 0.7 : 1,
      clearcoatRoughness: 0.12, envMapIntensity: finish === 'matte' ? 0.4 : 1.4,
    });
    const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.paint2), metalness: 0.5, roughness: 0.35, emissive: new THREE.Color(cfg.paint2), emissiveIntensity: 0.35 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0f22, metalness: 0.9, roughness: 0.08, envMapIntensity: 1.8, clearcoat: 1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15131f, metalness: 0.6, roughness: 0.55 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd8e3, metalness: 1, roughness: 0.2 });
    const headlight = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(3), toneMapped: false });
    const taillight = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2d6f').multiplyScalar(1.6), toneMapped: false });
    const tire = new THREE.MeshStandardMaterial({ color: 0x0d0d14, roughness: 0.95, metalness: 0 });
    const rim = new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.tireColor).multiplyScalar(0.5), metalness: 0.9, roughness: 0.3 });
    const rimGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.tireColor).multiplyScalar(2.0), toneMapped: false });
    this.disposables.push(paint, accent, glass, dark, chrome, headlight, taillight, tire, rim, rimGlow, this.decalTex);
    return { paint, accent, glass, dark, chrome, headlight, taillight, tire, rim, rimGlow };
  }

  setBraking(on: boolean) {
    if (!this.materials || this.ghost) return;
    (this.materials.taillight as THREE.MeshBasicMaterial).color.set('#ff2d6f').multiplyScalar(on ? 4 : 1.6);
  }

  setGhostOpacity(o: number) { if (this.ghostMat) this.ghostMat.opacity = o; }

  /** Apply pose from physics (interpolated). */
  setPose(pos: { x: number; y: number; z: number }, quat: { x: number; y: number; z: number; w: number }) {
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.quaternion.set(quat.x, quat.y, quat.z, quat.w);
  }

  updateWheels(state: CarVisualState) {
    for (let i = 0; i < 4; i++) {
      const holder = this.wheels[i];
      const w = CAR_SPEC.wheels[i];
      const comp = state.wheelCompression[i];
      // wheel center = attach - (rest*(1-comp)) + offset
      const drop = CAR_SPEC.suspensionRest * (1 - comp) * 0.8;
      holder.position.set(w.x, w.y - 0.08 - drop, w.z);
      holder.rotation.y = state.wheelSteer[i];
      const inner = holder.children[0];
      inner.rotation.x = state.wheelSpin[i];
    }
    if (this.underglowMesh) {
      const t = performance.now() * 0.002;
      (this.underglowMesh.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.2 * Math.sin(t * 3);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose(); });
    this.group.removeFromParent();
  }
}

export const CAR_BODY_NAMES: Record<CarBodyId, string> = {
  viper: 'Viper GT', brute: 'Brute V8', phantom: 'Phantom Pod', formula: 'Formula Zero', wedge: 'Wedge X', bolt: 'Bolt',
};
