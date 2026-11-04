// Procedural themed environments: skyline/terrain decorations placed around the track,
// ground planes (grid / water / sand / snow / city), clouds, ambient sparkles, props
// along the road and support pylons. Everything is instanced for performance.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CompiledTrack } from '@shared/track/types';
import { seededRandom } from '@shared/math';
import type { Theme, DecorKind } from '../track/themes';
import { sharedUniforms, createNeonMaterial } from './materials';
import { getCloudTexture, getGlowTexture } from './sky';
import type { QualityLevel } from './renderer';

const buildingVertex = /* glsl */ `
  varying vec3 vLocal; varying vec3 vNormal; varying vec3 vWorld; varying vec3 vTint; varying vec3 vScale;
  #include <fog_pars_vertex>
  void main() {
    vLocal = position;
    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif
    vTint = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #endif
    vScale = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
    vec4 wp = modelMatrix * im * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormal = normalize(mat3(modelMatrix * im) * normal);
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const buildingFragment = /* glsl */ `
  uniform vec3 uBase; uniform float uTime; uniform vec3 uSunDir; uniform vec3 uAmbient; uniform vec3 uSunColor;
  uniform float uWindowDensity;
  varying vec3 vLocal; varying vec3 vNormal; varying vec3 vWorld; varying vec3 vTint; varying vec3 vScale;
  #include <fog_pars_fragment>
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main() {
    vec3 n = normalize(vNormal);
    float ndl = clamp(dot(n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = uBase * (uAmbient * 1.5 + uSunColor * ndl * 0.8);
    // window grid in world-scaled local space
    vec3 ls = vLocal * vScale;
    float side = abs(n.y) < 0.5 ? 1.0 : 0.0;
    vec2 g = abs(n.x) > 0.5 ? vec2(ls.z, ls.y) : vec2(ls.x, ls.y);
    vec2 cell = floor(g * uWindowDensity);
    vec2 f = fract(g * uWindowDensity);
    float win = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.7);
    float lit = step(0.45, hash21(cell + floor(vTint.rg * 10.0)));
    float blink = 0.75 + 0.25 * sin(uTime * 1.5 + hash21(cell) * 20.0);
    col += vTint * win * lit * side * blink * 1.6;
    // top edge glow stripe
    float topStripe = smoothstep(0.46, 0.5, vLocal.y) * side;
    col += vTint * topStripe * 1.2;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

const groundVertex = /* glsl */ `
  varying vec3 vWorld; varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const groundFragment = /* glsl */ `
  uniform vec3 uColor; uniform vec3 uLine; uniform float uTime; uniform float uKind; uniform vec3 uAmbient; uniform vec3 uSunColor;
  varying vec3 vWorld; varying vec2 vUv;
  #include <fog_pars_fragment>
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main() {
    vec3 col = uColor * (uAmbient * 1.2 + uSunColor * 0.7);
    vec2 p = vWorld.xz;
    if (uKind < 0.5) {
      // grid
      vec2 g = abs(fract(p / 20.0) - 0.5) * 2.0;
      float line = max(smoothstep(0.93, 0.99, g.x), smoothstep(0.93, 0.99, g.y));
      vec2 g2 = abs(fract(p / 100.0) - 0.5) * 2.0;
      float line2 = max(smoothstep(0.975, 0.995, g2.x), smoothstep(0.975, 0.995, g2.y));
      float pulse = 0.6 + 0.4 * sin(uTime * 1.2 + (p.x + p.y) * 0.01);
      col += uLine * (line * 0.7 + line2 * 1.6) * pulse;
    } else if (uKind < 1.5) {
      // water
      float w1 = sin(p.x * 0.08 + uTime * 1.1) * sin(p.y * 0.07 - uTime * 0.9);
      float w2 = sin((p.x + p.y) * 0.19 + uTime * 1.7);
      float w = w1 * 0.5 + w2 * 0.25 + 0.5;
      col = mix(uColor * 0.7, uLine, pow(w, 4.0) * 0.6) * (uAmbient * 1.2 + uSunColor * 0.8);
      float sparkle = step(0.985, hash21(floor(p * 0.6) + floor(uTime * 3.0)));
      col += vec3(1.0) * sparkle * 0.8;
    } else if (uKind < 2.5) {
      // sand / snow / city: noise mottling with faint grid
      float nz = hash21(floor(p / 6.0));
      col *= 0.85 + 0.3 * nz;
      vec2 g = abs(fract(p / 24.0) - 0.5) * 2.0;
      float line = max(smoothstep(0.96, 0.995, g.x), smoothstep(0.96, 0.995, g.y));
      col += uLine * line * 0.35;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

const sparkleVertex = /* glsl */ `
  attribute float aSeed; uniform float uTime; uniform float uSize;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    p.y += sin(uTime * 0.6 + aSeed * 12.0) * 3.0;
    p.x += cos(uTime * 0.4 + aSeed * 7.0) * 2.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float d = -mv.z;
    gl_PointSize = uSize * (300.0 / max(d, 1.0));
    vAlpha = (0.4 + 0.6 * sin(uTime * 2.0 + aSeed * 30.0)) * smoothstep(900.0, 200.0, d);
    gl_Position = projectionMatrix * mv;
  }
`;
const sparkleFragment = /* glsl */ `
  uniform vec3 uColor; varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.05, length(c)) * vAlpha;
    gl_FragColor = vec4(uColor * 1.5, a);
  }
`;

function withColors(geo: THREE.BufferGeometry, fn: (y: number, x: number, z: number) => THREE.Color) {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(fn(pos.getY(i), pos.getX(i), pos.getZ(i)));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function decorGeometry(kind: DecorKind, colA: THREE.Color, colB: THREE.Color): { geo: THREE.BufferGeometry; neon: boolean; building: boolean } {
  switch (kind) {
    case 'towers': {
      const g = new THREE.BoxGeometry(1, 1, 1);
      g.translate(0, 0.5, 0);
      return { geo: g, neon: false, building: true };
    }
    case 'cubes': {
      const g = new THREE.BoxGeometry(1, 1, 1);
      return { geo: g, neon: false, building: true };
    }
    case 'mountains': {
      const g = new THREE.ConeGeometry(1, 1, 6, 1);
      g.translate(0, 0.5, 0);
      withColors(g, (y) => colA.clone().lerp(colB, Math.pow(y, 1.5)));
      return { geo: g, neon: false, building: false };
    }
    case 'mesas': {
      const g = new THREE.CylinderGeometry(0.7, 1, 1, 7, 1);
      g.translate(0, 0.5, 0);
      withColors(g, (y) => colA.clone().lerp(colB, y * 0.8));
      return { geo: g, neon: false, building: false };
    }
    case 'islands': {
      const top = new THREE.CylinderGeometry(1, 0.85, 0.3, 9, 1);
      top.translate(0, -0.15, 0);
      withColors(top, () => colA.clone());
      const bottom = new THREE.ConeGeometry(0.85, 1.6, 9, 1);
      bottom.rotateX(Math.PI);
      bottom.translate(0, -1.1, 0);
      withColors(bottom, (y) => colB.clone().multiplyScalar(0.6 + 0.4 * (y + 1.9) / 1.6));
      const g = mergeGeometries([top, bottom], false)!;
      return { geo: g, neon: false, building: false };
    }
    case 'crystals': {
      const g = new THREE.OctahedronGeometry(1, 0);
      g.scale(0.35, 1, 0.35);
      g.translate(0, 0.8, 0);
      return { geo: g, neon: true, building: false };
    }
    case 'palms': {
      const trunk = new THREE.CylinderGeometry(0.12, 0.2, 2.4, 6, 1);
      trunk.translate(0, 1.2, 0);
      withColors(trunk, () => colB.clone());
      const leaves: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 6; i++) {
        const l = new THREE.ConeGeometry(0.22, 1.6, 4, 1);
        l.rotateX(Math.PI / 2 + 0.35);
        l.translate(0, 0, 0.75);
        l.rotateY((i / 6) * Math.PI * 2);
        l.translate(0, 2.5, 0);
        withColors(l, () => colA.clone());
        leaves.push(l);
      }
      const g = mergeGeometries([trunk, ...leaves], false)!;
      return { geo: g, neon: false, building: false };
    }
    case 'pillars': {
      const g = new THREE.BoxGeometry(0.3, 1, 0.3);
      g.translate(0, 0.5, 0);
      return { geo: g, neon: true, building: false };
    }
    case 'rings': {
      const g = new THREE.TorusGeometry(1, 0.06, 8, 48);
      return { geo: g, neon: true, building: false };
    }
    case 'platforms': {
      const g = new THREE.BoxGeometry(1, 0.08, 1);
      withColors(g, (y) => (y > 0 ? colB.clone() : colA.clone()));
      return { geo: g, neon: false, building: false };
    }
    case 'orbs': {
      const g = new THREE.SphereGeometry(1, 12, 8);
      return { geo: g, neon: true, building: false };
    }
  }
}

export class Environment {
  readonly group = new THREE.Group();
  private updaters: ((dt: number, cam: THREE.Vector3) => void)[] = [];
  private disposables: { dispose(): void }[] = [];
  readonly groundY: number;

  constructor(theme: Theme, track: CompiledTrack, seed: number, quality: QualityLevel) {
    const rnd = seededRandom(seed);
    const b = track.bounds;
    const center = new THREE.Vector3((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
    this.groundY = theme.ground.kind === 'none' ? b.min.y - theme.ground.depth : b.min.y - theme.ground.depth;
    const density = quality === 'low' ? 0.45 : quality === 'medium' ? 0.75 : 1;

    // coarse track sample for distance checks
    const samples: THREE.Vector3[] = [];
    for (let i = 0; i < track.frames.length; i += 3) samples.push(new THREE.Vector3(track.frames[i].pos.x, track.frames[i].pos.y, track.frames[i].pos.z));
    const distToTrack = (x: number, z: number) => {
      let best = Infinity;
      for (const s of samples) { const d = (s.x - x) ** 2 + (s.z - z) ** 2; if (d < best) best = d; }
      return Math.sqrt(best);
    };

    // ---- ground ----
    if (theme.ground.kind !== 'none') {
      const kind = theme.ground.kind === 'grid' ? 0 : theme.ground.kind === 'water' ? 1 : 2;
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
          uColor: { value: new THREE.Color(theme.ground.color) }, uLine: { value: new THREE.Color(theme.ground.line) }, uKind: { value: kind },
        }]), { uTime: sharedUniforms.uTime, uAmbient: sharedUniforms.uAmbient, uSunColor: sharedUniforms.uSunColor }),
        vertexShader: groundVertex, fragmentShader: groundFragment, fog: true,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000, 1, 1), mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(center.x, this.groundY, center.z);
      plane.receiveShadow = false;
      this.group.add(plane);
      this.disposables.push(plane.geometry, mat);
    }

    // ---- decorations ----
    const extent = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    for (const d of theme.decor) {
      const count = Math.max(1, Math.round(d.count * density));
      const colA = new THREE.Color(d.color), colB = new THREE.Color(d.color2);
      const { geo, neon, building } = decorGeometry(d.kind, colA, colB);
      let mat: THREE.Material;
      if (building) {
        mat = new THREE.ShaderMaterial({
          uniforms: Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uBase: { value: colA }, uWindowDensity: { value: d.kind === 'cubes' ? 0.08 : 0.22 } }]),
            { uTime: sharedUniforms.uTime, uSunDir: sharedUniforms.uSunDir, uAmbient: sharedUniforms.uAmbient, uSunColor: sharedUniforms.uSunColor }),
          vertexShader: buildingVertex, fragmentShader: buildingFragment, fog: true,
        });
      } else if (neon) {
        mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: true });
      } else {
        mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: true });
      }
      const inst = new THREE.InstancedMesh(geo, mat, count);
      inst.castShadow = false; inst.receiveShadow = false;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
      const tmpColor = new THREE.Color();
      let placed = 0, tries = 0;
      const rotating: number[] = [];
      while (placed < count && tries < count * 30) {
        tries++;
        const ang = rnd() * Math.PI * 2;
        const r = d.minDist + rnd() * (d.maxDist - d.minDist) + extent * 0.35;
        const x = center.x + Math.cos(ang) * r, z = center.z + Math.sin(ang) * r;
        const scale = d.scale[0] + rnd() * (d.scale[1] - d.scale[0]);
        let baseSize = 10;
        let sx = 1, sy = 1, sz = 1;
        switch (d.kind) {
          case 'towers': baseSize = 14; sx = (0.6 + rnd() * 0.8) * baseSize * scale; sz = (0.6 + rnd() * 0.8) * baseSize * scale; sy = (3 + rnd() * 9) * baseSize * scale * 0.6; break;
          case 'cubes': baseSize = 8; sx = sy = sz = baseSize * scale; break;
          case 'mountains': baseSize = 60; sx = sz = baseSize * scale * (0.8 + rnd() * 0.6); sy = baseSize * scale * (0.9 + rnd() * 0.8); break;
          case 'mesas': baseSize = 22; sx = sz = baseSize * scale * (0.7 + rnd() * 0.8); sy = baseSize * scale * (0.6 + rnd() * 0.9); break;
          case 'islands': baseSize = 26; sx = sz = baseSize * scale; sy = baseSize * scale * 0.9; break;
          case 'crystals': baseSize = 6; sx = sz = baseSize * scale; sy = baseSize * scale * (1 + rnd()); break;
          case 'palms': baseSize = 4; sx = sy = sz = baseSize * scale; break;
          case 'pillars': baseSize = 10; sx = sz = baseSize * scale * 0.5; sy = baseSize * scale * (6 + rnd() * 10); break;
          case 'rings': baseSize = 40; sx = sy = sz = baseSize * scale; break;
          case 'platforms': baseSize = 30; sx = baseSize * scale * (0.8 + rnd()); sz = baseSize * scale * (0.8 + rnd()); sy = baseSize * scale * 0.4; break;
          case 'orbs': baseSize = 3; sx = sy = sz = baseSize * scale; break;
        }
        const radius = Math.max(sx, sz) * 0.7;
        if (distToTrack(x, z) < 22 + radius) continue;
        let y = this.groundY;
        if (theme.ground.kind === 'none' || d.kind === 'cubes' || d.kind === 'orbs' || d.kind === 'rings' || d.kind === 'platforms' || (d.kind === 'islands' && theme.id === 'skyIslands')) {
          y = b.min.y + d.heightOffset[0] + rnd() * (d.heightOffset[1] - d.heightOffset[0]);
        }
        if (d.kind === 'rings') { q.setFromEuler(new THREE.Euler(rnd() * 0.6, rnd() * Math.PI, rnd() * 0.6)); rotating.push(placed); }
        else if (d.kind === 'cubes') { q.setFromEuler(new THREE.Euler(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI)); rotating.push(placed); }
        else q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
        p.set(x, y, z); s.set(sx, sy, sz);
        m.compose(p, q, s);
        inst.setMatrixAt(placed, m);
        tmpColor.copy(colB).lerp(colA, rnd() * 0.5).multiplyScalar(neon ? 1.6 + rnd() * 1.2 : 1);
        inst.setColorAt(placed, tmpColor);
        placed++;
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      this.group.add(inst);
      this.disposables.push(geo, mat);
      if (rotating.length) {
        const speeds = rotating.map(() => (rnd() - 0.5) * 0.4);
        const mats = rotating.map((i) => { const mm = new THREE.Matrix4(); inst.getMatrixAt(i, mm); return mm; });
        const rotM = new THREE.Matrix4();
        this.updaters.push((dt) => {
          rotating.forEach((idx, k) => {
            rotM.makeRotationY(speeds[k] * dt);
            const base = mats[k];
            // rotate about own center: decompose
            base.decompose(p, q, s);
            q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), speeds[k] * dt));
            base.compose(p, q, s);
            inst.setMatrixAt(idx, base);
          });
          inst.instanceMatrix.needsUpdate = true;
        });
      }
    }

    // ---- props along the road ----
    if (theme.props.kind !== 'none') this.buildProps(theme, track, rnd, density);

    // ---- support pylons ----
    if (theme.supports && theme.ground.kind !== 'none') this.buildSupports(theme, track);

    // ---- clouds ----
    if (theme.clouds) {
      const cl = theme.clouds;
      const tex = getCloudTexture();
      const count = Math.round(cl.count * density);
      const sprites: THREE.Sprite[] = [];
      const mat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(cl.color), transparent: true, opacity: cl.opacity, depthWrite: false, fog: true });
      for (let i = 0; i < count; i++) {
        const sp = new THREE.Sprite(mat);
        const ang = rnd() * Math.PI * 2, r = 80 + rnd() * (600 + extent * 0.6);
        const sc = 60 + rnd() * 160;
        sp.position.set(center.x + Math.cos(ang) * r, b.min.y + cl.height + (rnd() - 0.5) * 80, center.z + Math.sin(ang) * r);
        sp.scale.set(sc, sc * 0.5, 1);
        sp.userData.speed = 1.5 + rnd() * 3;
        this.group.add(sp);
        sprites.push(sp);
      }
      const limit = 900 + extent;
      this.updaters.push((dt) => {
        for (const sp of sprites) {
          sp.position.x += sp.userData.speed * dt;
          if (sp.position.x > center.x + limit) sp.position.x = center.x - limit;
        }
      });
      this.disposables.push(mat);
    }

    // ---- sparkles ----
    {
      const count = Math.round(theme.sparkles.count * density);
      const pos = new Float32Array(count * 3), seeds = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = b.min.x - 150 + rnd() * (b.max.x - b.min.x + 300);
        pos[i * 3 + 1] = b.min.y - 20 + rnd() * (b.max.y - b.min.y + 120);
        pos[i * 3 + 2] = b.min.z - 150 + rnd() * (b.max.z - b.min.z + 300);
        seeds[i] = rnd();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: sharedUniforms.uTime, uSize: { value: 2.2 }, uColor: { value: new THREE.Color(theme.sparkles.color) } },
        vertexShader: sparkleVertex, fragmentShader: sparkleFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      this.group.add(pts);
      this.disposables.push(geo, mat);
    }

    // ---- sun glow sprite ----
    {
      const mat = new THREE.SpriteMaterial({ map: getGlowTexture(), color: new THREE.Color(theme.sky.sunColor), transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, fog: false, blending: THREE.AdditiveBlending });
      const sun = new THREE.Sprite(mat);
      const dir = new THREE.Vector3(...theme.sky.sunDir).normalize();
      const size = 260 * theme.sky.sunSize;
      sun.scale.set(size, size, 1);
      sun.renderOrder = -999;
      this.group.add(sun);
      this.updaters.push((_dt, cam) => { sun.position.copy(cam).addScaledVector(dir, 1400); });
      this.disposables.push(mat);
    }
  }

  private buildProps(theme: Theme, track: CompiledTrack, rnd: () => number, density: number) {
    const kind = theme.props.kind;
    const color = new THREE.Color(theme.props.color);
    let base: THREE.BufferGeometry | null = null;
    let glow: THREE.BufferGeometry | null = null;
    const dark = new THREE.Color('#1f1b3a');
    switch (kind) {
      case 'lamp': {
        base = new THREE.CylinderGeometry(0.15, 0.25, 9, 6, 1); base.translate(0, 4.5, 0);
        withColors(base, () => dark.clone());
        glow = new THREE.SphereGeometry(0.7, 8, 6); glow.translate(0, 9.2, 0);
        break;
      }
      case 'crystal': {
        glow = new THREE.OctahedronGeometry(1, 0); glow.scale(0.9, 3.2, 0.9); glow.translate(0, 2.4, 0);
        break;
      }
      case 'palm': {
        const trunk = new THREE.CylinderGeometry(0.25, 0.4, 7, 6, 1); trunk.translate(0, 3.5, 0);
        withColors(trunk, () => new THREE.Color('#92400e'));
        const leaves: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 7; i++) {
          const l = new THREE.ConeGeometry(0.6, 4.5, 4, 1); l.rotateX(Math.PI / 2 + 0.45); l.translate(0, 0, 2.1); l.rotateY((i / 7) * Math.PI * 2); l.translate(0, 7.2, 0);
          withColors(l, () => new THREE.Color('#16a34a'));
          leaves.push(l);
        }
        base = mergeGeometries([trunk, ...leaves], false)!;
        break;
      }
      case 'spire': {
        base = new THREE.ConeGeometry(1.6, 11, 5, 1); base.translate(0, 5.5, 0);
        withColors(base, (y) => new THREE.Color('#9a3412').lerp(new THREE.Color('#fb923c'), (y / 11) + 0.5));
        glow = new THREE.SphereGeometry(0.5, 8, 6); glow.translate(0, 11.3, 0);
        break;
      }
      case 'cube': {
        glow = new THREE.BoxGeometry(1.4, 1.4, 1.4); glow.translate(0, 3, 0);
        break;
      }
      case 'balloon': {
        base = new THREE.CylinderGeometry(0.05, 0.05, 6, 4, 1); base.translate(0, 3, 0);
        withColors(base, () => new THREE.Color('#ffffff'));
        glow = new THREE.SphereGeometry(1.6, 10, 8); glow.translate(0, 7, 0);
        break;
      }
    }
    const frames = track.frames;
    const positions: THREE.Matrix4[] = [];
    let next = 0;
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    const spacing = theme.props.spacing / Math.max(0.5, density);
    let side = 1;
    for (const f of frames) {
      if (f.dist < next) continue;
      next = f.dist + spacing;
      if (f.up.y < 0.8) continue; // skip loops / corkscrews / walls
      const pieceType = track.pieceTypes[f.pieceIndex];
      if (pieceType && pieceType.startsWith('tunnel')) continue;
      side = -side;
      const off = 11 + rnd() * 5;
      p.set(f.pos.x + f.right.x * off * side, f.pos.y - 0.3, f.pos.z + f.right.z * off * side);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      const sc = 0.8 + rnd() * 0.5;
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      positions.push(m.clone());
    }
    if (!positions.length) return;
    if (base) {
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: true });
      const inst = new THREE.InstancedMesh(base, mat, positions.length);
      positions.forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
      this.disposables.push(base, mat);
    }
    if (glow) {
      const mat = createNeonMaterial(color, 2.4);
      const inst = new THREE.InstancedMesh(glow, mat, positions.length);
      positions.forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
      this.disposables.push(glow, mat);
      if (kind === 'cube' || kind === 'balloon') {
        const mats = positions.map((mm) => mm.clone());
        const t0 = rnd() * 100;
        this.updaters.push(() => {
          const t = sharedUniforms.uTime.value + t0;
          mats.forEach((mm, i) => {
            mm.decompose(p, q, s);
            const bob = Math.sin(t * 1.3 + i) * 0.6;
            const pp = p.clone(); pp.y += bob;
            if (kind === 'cube') q.setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), t * 0.8 + i);
            m.compose(pp, q, s);
            inst.setMatrixAt(i, m);
          });
          inst.instanceMatrix.needsUpdate = true;
        });
      }
    }
  }

  private buildSupports(theme: Theme, track: CompiledTrack) {
    const mats: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let next = 0;
    for (const f of track.frames) {
      if (f.dist < next) continue;
      next = f.dist + 48;
      if (f.up.y < 0.9) continue;
      const h = f.pos.y - this.groundY;
      if (h < 4 || h > 220) continue;
      p.set(f.pos.x, this.groundY + h / 2 - 0.8, f.pos.z);
      q.identity();
      s.set(2.2, h - 1.6, 2.2);
      m.compose(p, q, s);
      mats.push(m.clone());
    }
    if (!mats.length) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uBase: { value: new THREE.Color(theme.wall.base) }, uWindowDensity: { value: 0.06 } }]),
        { uTime: sharedUniforms.uTime, uSunDir: sharedUniforms.uSunDir, uAmbient: sharedUniforms.uAmbient, uSunColor: sharedUniforms.uSunColor }),
      vertexShader: buildingVertex, fragmentShader: buildingFragment, fog: true,
    });
    const inst = new THREE.InstancedMesh(geo, mat, mats.length);
    const c = new THREE.Color(theme.rail);
    mats.forEach((mm, i) => { inst.setMatrixAt(i, mm); inst.setColorAt(i, c); });
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
    this.disposables.push(geo, mat);
  }

  update(dt: number, cameraPos: THREE.Vector3) {
    for (const u of this.updaters) u(dt, cameraPos);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
