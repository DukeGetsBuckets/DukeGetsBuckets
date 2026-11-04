// Builds the visible track from compiled mesh data: road, neon rails, walls, wall rides,
// tunnels, boost pads, animated gates (start / checkpoint / finish), rings and arches.

import * as THREE from 'three';
import type { CompiledTrack, GateInfo, MeshData, DecorInfo } from '@shared/track/types';
import type { Theme } from './themes';
import { createRoadMaterial, createPanelMaterial, createBoostMaterial, createNeonMaterial, createMembraneMaterial, sharedUniforms } from '../render/materials';
import { getGlowTexture } from '../render/sky';

export function basisQuaternion(forward: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }): THREE.Quaternion {
  const f = new THREE.Vector3(forward.x, forward.y, forward.z).normalize();
  const u = new THREE.Vector3(up.x, up.y, up.z).normalize();
  const left = new THREE.Vector3().crossVectors(u, f).normalize(); // = -(f x u)
  const uu = new THREE.Vector3().crossVectors(f, left).normalize();
  const m = new THREE.Matrix4().makeBasis(left, uu, f);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function toGeometry(d: MeshData): THREE.BufferGeometry | null {
  if (d.indices.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(d.indices, 1));
  g.computeBoundingSphere();
  return g;
}

let checkerTex: THREE.Texture | null = null;
function getCheckerTexture() {
  if (checkerTex) return checkerTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111';
    ctx.fillRect(x * 8, y * 8, 8, 8);
  }
  checkerTex = new THREE.CanvasTexture(c);
  checkerTex.wrapS = checkerTex.wrapT = THREE.RepeatWrapping;
  checkerTex.magFilter = THREE.NearestFilter;
  return checkerTex;
}

export class GateView {
  readonly group = new THREE.Group();
  private membrane: THREE.ShaderMaterial;
  private flash = 0;
  private lights: THREE.Mesh[] = [];
  private baseColor: THREE.Color;
  constructor(public info: GateInfo, color: string) {
    this.baseColor = new THREE.Color(color);
    const hw = info.halfWidth - 2;
    const h = 9;
    const neon = createNeonMaterial(this.baseColor, 2.4);
    const dark = new THREE.MeshStandardMaterial({ color: 0x14102c, roughness: 0.5, metalness: 0.6 });
    const pillarGeo = new THREE.BoxGeometry(1.2, h, 1.2);
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(pillarGeo, dark);
      pillar.position.set(side * (hw + 0.8), h / 2, 0);
      this.group.add(pillar);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.25, h - 1, 1.3), neon);
      strip.position.set(side * (hw + 0.8), h / 2, 0);
      this.group.add(strip);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.75, 10, 8), neon);
      light.position.set(side * (hw + 0.8), h + 0.6, 0);
      this.group.add(light);
      this.lights.push(light);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 2.8, 1.2, 1.4), info.kind === 'finish' ? new THREE.MeshStandardMaterial({ map: getCheckerTexture(), roughness: 0.6 }) : dark);
    if (info.kind === 'finish') { (beam.material as THREE.MeshStandardMaterial).map!.repeat.set(hw / 2, 0.5); }
    beam.position.set(0, h + 0.1, 0);
    this.group.add(beam);
    const beamStrip = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 2.8, 0.25, 1.5), neon);
    beamStrip.position.set(0, h - 0.6, 0);
    this.group.add(beamStrip);
    this.membrane = createMembraneMaterial(this.baseColor);
    const mem = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, h - 0.8), this.membrane);
    mem.position.set(0, (h - 0.8) / 2, 0);
    mem.renderOrder = 10;
    this.group.add(mem);
    // ground line
    if (info.kind !== 'checkpoint') {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2 + 1, 2.2), info.kind === 'finish'
        ? new THREE.MeshBasicMaterial({ map: getCheckerTexture(), toneMapped: false })
        : createNeonMaterial(this.baseColor, 1.8));
      if (info.kind === 'finish') (line.material as THREE.MeshBasicMaterial).map!.repeat.set(hw, 1.5);
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.08, 0);
      this.group.add(line);
    }
    // glow sprite
    const glowMat = new THREE.SpriteMaterial({ map: getGlowTexture(), color: this.baseColor, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.set(hw * 2.6, 22, 1);
    glow.position.set(0, h / 2, 0);
    this.group.add(glow);

    this.group.position.set(info.pos.x, info.pos.y, info.pos.z);
    this.group.quaternion.copy(basisQuaternion(info.forward, info.up));
  }
  trigger() { this.flash = 1; }
  update(dt: number) {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 1.6);
      this.membrane.uniforms.uFlash.value = this.flash;
      const s = 1 + this.flash * 1.5;
      for (const l of this.lights) l.scale.setScalar(s);
    }
  }
}

export class TrackView {
  readonly group = new THREE.Group();
  readonly gates: GateView[] = [];
  private disposables: { dispose(): void }[] = [];
  private rings: THREE.Mesh[] = [];
  private boostMeshes: THREE.Mesh[] = [];

  constructor(public compiled: CompiledTrack, public theme: Theme) {
    const t = theme;
    const roadMat = createRoadMaterial(new THREE.Color(t.road.base), new THREE.Color(t.road.line), new THREE.Color(t.road.arrow));
    const railMat = createNeonMaterial(new THREE.Color(t.rail), 2.6);
    const wallMat = createPanelMaterial(new THREE.Color(t.wall.base), new THREE.Color(t.wall.line), 6, 1, 1.2);
    const wallrideMat = createPanelMaterial(new THREE.Color(t.wallride.base), new THREE.Color(t.wallride.line), 8, 6, 1.0);
    const tunnelMat = createPanelMaterial(new THREE.Color(t.tunnel.base), new THREE.Color(t.tunnel.line), 12, 10, 1.4);
    const boostMat = createBoostMaterial(new THREE.Color(t.boost[0]), new THREE.Color(t.boost[1]));
    const entries: [MeshData, THREE.Material, boolean][] = [
      [compiled.surfaces.road, roadMat, true],
      [compiled.surfaces.rail, railMat, false],
      [compiled.surfaces.wall, wallMat, true],
      [compiled.surfaces.wallride, wallrideMat, true],
      [compiled.surfaces.tunnel, tunnelMat, false],
      [compiled.surfaces.boost, boostMat, false],
    ];
    for (const [data, mat, shadow] of entries) {
      const geo = toGeometry(data);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = shadow;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
      if (mat === boostMat) this.boostMeshes.push(mesh);
    }
    for (const g of compiled.gates) {
      const color = g.kind === 'start' ? t.gate.start : g.kind === 'finish' ? t.gate.finish : t.gate.checkpoint;
      const gv = new GateView(g, color);
      this.gates.push(gv);
      this.group.add(gv.group);
    }
    for (const d of compiled.decor) this.addDecor(d);
  }

  private addDecor(d: DecorInfo) {
    const q = basisQuaternion(d.forward, d.up);
    if (d.kind === 'ring') {
      const geo = new THREE.TorusGeometry(12, 0.7, 10, 40);
      const mat = createNeonMaterial(new THREE.Color(this.theme.road.arrow), 2.2);
      const ring = new THREE.Mesh(geo, mat);
      ring.position.set(d.pos.x + d.up.x * 9, d.pos.y + d.up.y * 9, d.pos.z + d.up.z * 9);
      ring.quaternion.copy(q);
      ring.userData.baseQ = q.clone();
      this.group.add(ring);
      const inner = new THREE.Mesh(new THREE.TorusGeometry(10.5, 0.25, 6, 40), createNeonMaterial(new THREE.Color(this.theme.rail), 2));
      ring.add(inner);
      this.rings.push(ring);
      this.disposables.push(geo, mat);
    } else if (d.kind === 'arch') {
      const geo = new THREE.TorusGeometry(11, 0.9, 10, 32, Math.PI);
      const mat = createNeonMaterial(new THREE.Color(this.theme.gate.checkpoint), 2);
      const arch = new THREE.Mesh(geo, mat);
      arch.position.set(d.pos.x, d.pos.y, d.pos.z);
      arch.quaternion.copy(q);
      this.group.add(arch);
      this.disposables.push(geo, mat);
    }
  }

  triggerGate(index: number) {
    const g = this.gates.find((x) => x.info.index === index && x.info.kind !== 'start');
    g?.trigger();
  }

  update(dt: number) {
    for (const g of this.gates) g.update(dt);
    const t = sharedUniforms.uTime.value;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t * 0.6 + i);
      r.quaternion.copy(r.userData.baseQ as THREE.Quaternion).multiply(spin);
      const s = 1 + Math.sin(t * 2 + i) * 0.03;
      r.scale.setScalar(s);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
