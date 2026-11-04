// Track Builder 3D view: renders the compiled track with the selected theme, a glowing
// build grid, the build cursor arrow, a ghost preview of the piece about to be placed and
// selection / warning highlights. Takes over the game's renderer while open (the game loop
// is stopped and our own rAF loop renders our scene with the game's camera), and gives
// everything back on detach(). Includes a small touch + mouse orbit camera controller.

import * as THREE from 'three';
import type { CompiledTrack, Frame, Placement, ThemeId } from '@shared/track/types';
import { compileTrack } from '@shared/track/compile';
import { CELL, PIECES } from '@shared/track/pieces';
import type { Cursor } from '@shared/track/chain';
import type { Game } from '../Game';
import { THEMES, type Theme } from '../track/themes';
import { TrackView } from '../track/trackRender';
import { Sky } from '../render/sky';
import { sharedUniforms } from '../render/materials';

type GameLike = Pick<Game, 'renderer' | 'scene' | 'running' | 'stop' | 'start' | 'setSceneMode' | 'theme'>;

export interface EditorSceneEvents {
  /** a short tap/click (no drag). piece = picked piece index, ground = snapped grid cell on the cursor's height plane */
  onTap?: (piece: number | null, ground: { x: number; z: number } | null) => void;
  /** mouse hover over a piece (null when none) */
  onHover?: (piece: number | null) => void;
}

export interface CameraState { target: [number, number, number]; azimuth: number; polar: number; distance: number }

const SELECT_COLOR = new THREE.Color('#facc15');
const HOVER_COLOR = new THREE.Color('#ffffff');
const WARN_COLOR = new THREE.Color('#fb7185');
const GHOST_COLOR = new THREE.Color('#22d3ee');
const CURSOR_COLOR = new THREE.Color('#a3e635');

/* ------------------------------------------------------------------ */
/* Grid shader                                                         */
/* ------------------------------------------------------------------ */

const gridVertex = /* glsl */ `
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const gridFragment = /* glsl */ `
  uniform vec3 uLine; uniform vec3 uMajor; uniform vec3 uFill; uniform vec3 uCenter;
  uniform float uCell; uniform float uRadius; uniform float uTime; uniform vec3 uCursor;
  varying vec3 vW;
  float lineAt(vec2 p, float cell, float width) {
    vec2 g = abs(fract(p / cell + 0.5) - 0.5) * cell;
    vec2 aa = fwidth(p) * width;
    vec2 l = 1.0 - smoothstep(vec2(0.0), aa, g);
    return max(l.x, l.y);
  }
  void main() {
    vec2 p = vW.xz;
    float minor = lineAt(p, uCell, 1.2);
    float major = lineAt(p, uCell * 5.0, 2.0);
    float d = length(p - uCenter.xz);
    float fade = 1.0 - smoothstep(uRadius * 0.35, uRadius, d);
    // pulse ring around the cursor
    float cd = length(p - uCursor.xz);
    float ring = (1.0 - smoothstep(0.0, 1.2, abs(cd - mod(uTime * 18.0, 60.0)))) * (1.0 - smoothstep(0.0, 60.0, cd));
    vec3 col = uFill * 0.9;
    col = mix(col, uLine, minor * 0.45);
    col = mix(col, uMajor, major * 0.75);
    col += uMajor * ring * 0.6;
    float a = max(0.82, max(minor * 0.8, major)) * fade;
    gl_FragColor = vec4(col, a);
  }
`;

/* ------------------------------------------------------------------ */
/* Ribbon helpers (pick surfaces, highlights, shadows)                 */
/* ------------------------------------------------------------------ */

function pieceHalfWidth(type: string) {
  const def = PIECES[type];
  return (def?.halfWidth ?? 7) + 1.5;
}

function ribbonPositions(frames: Frame[], half: number, lift: number, flatY: number | null): number[] {
  const out: number[] = [];
  for (const f of frames) {
    const ux = f.up.x * lift, uy = f.up.y * lift, uz = f.up.z * lift;
    const lx = f.pos.x - f.right.x * half + ux, ly = f.pos.y - f.right.y * half + uy, lz = f.pos.z - f.right.z * half + uz;
    const rx = f.pos.x + f.right.x * half + ux, ry = f.pos.y + f.right.y * half + uy, rz = f.pos.z + f.right.z * half + uz;
    out.push(lx, flatY ?? ly, lz, rx, flatY ?? ry, rz);
  }
  return out;
}

function ribbonIndices(n: number, base: number, out: number[]) {
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2, b = base + i * 2 + 1, c = base + i * 2 + 2, d = base + i * 2 + 3;
    out.push(a, c, b, b, c, d);
  }
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
  obj.removeFromParent();
}

/* ------------------------------------------------------------------ */
/* Editor scene                                                        */
/* ------------------------------------------------------------------ */

let savedCamera: CameraState | null = null;

export class EditorScene {
  readonly scene = new THREE.Scene();
  events: EditorSceneEvents = {};
  /** true when the camera was restored from a previous editor session (e.g. after a test drive) */
  restoredCamera = false;

  private camera: THREE.PerspectiveCamera;
  private raf = 0;
  private lastTime = 0;
  private attached = false;
  private disposed = false;
  private prev: { fov: number; near: number; far: number; up: THREE.Vector3; wasRunning: boolean; glow: THREE.Vector3 } | null = null;

  private theme: Theme = THEMES.neonCity;
  private sky: Sky | null = null;
  private hemi = new THREE.HemisphereLight(0xffffff, 0x222244, 0.9);
  private sun = new THREE.DirectionalLight(0xffffff, 1.3);
  private grid: THREE.Mesh;
  private gridMat: THREE.ShaderMaterial;

  private compiled: CompiledTrack | null = null;
  private placements: Placement[] = [];
  private trackView: TrackView | null = null;
  private trackExtras = new THREE.Group();     // gap markers + ground shadows
  private pickMesh: THREE.Mesh | null = null;
  private pickFaceToPiece: Int32Array = new Int32Array(0);
  private highlight = new THREE.Group();
  private selected: number | null = null;
  private hovered: number | null = null;
  private flagged: number[] = [];
  private selectionFill: THREE.MeshBasicMaterial;
  private cursorGroup = new THREE.Group();
  private cursorArrow: THREE.Mesh;
  private cursorStem: THREE.Line;
  private cursorDot: THREE.Mesh;
  private cursor: Cursor = { x: 0, y: 0, z: 0, rot: 0 };
  private cursorVisual = new THREE.Vector3();
  private cursorYaw = 0;
  private ghost: THREE.Group | null = null;
  private ghostKey = '';

  // orbit camera
  private target = new THREE.Vector3(0, 0, 40);
  private azimuth = Math.PI * 0.8;
  private polar = 0.95;
  private distance = 160;
  private cur = { target: new THREE.Vector3(0, 0, 40), azimuth: Math.PI * 0.8, polar: 0.95, distance: 160 };
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; type: string; button: number; t: number }>();
  private gestureMoved = false;
  private multiTouch = false;
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private hoverPending: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private gridY = 0;

  constructor(private game: GameLike, private dom: HTMLElement) {
    this.camera = game.renderer.camera;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.add(this.trackExtras, this.highlight, this.cursorGroup);

    // grid
    this.gridMat = new THREE.ShaderMaterial({
      uniforms: {
        uLine: { value: new THREE.Color('#22d3ee') }, uMajor: { value: new THREE.Color('#a855f7') }, uFill: { value: new THREE.Color('#07061a') },
        uCenter: { value: new THREE.Vector3() }, uCell: { value: CELL }, uRadius: { value: 1200 }, uTime: sharedUniforms.uTime,
        uCursor: { value: new THREE.Vector3() },
      },
      vertexShader: gridVertex, fragmentShader: gridFragment, transparent: true, depthWrite: false, toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), this.gridMat);
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.renderOrder = -10;
    this.grid.frustumCulled = false;
    this.scene.add(this.grid);

    this.selectionFill = new THREE.MeshBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });

    // cursor arrow (flat, pointing +Z in local space)
    const shape = new THREE.Shape();
    shape.moveTo(0, 9);
    shape.lineTo(-6.5, 1);
    shape.lineTo(-2.4, 1);
    shape.lineTo(-2.4, -6);
    shape.lineTo(2.4, -6);
    shape.lineTo(2.4, 1);
    shape.lineTo(6.5, 1);
    shape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(shape);
    arrowGeo.rotateX(Math.PI / 2); // shape +Y -> world +Z, facing up
    const arrowMat = new THREE.MeshBasicMaterial({ color: CURSOR_COLOR.clone().multiplyScalar(2.2), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.cursorArrow = new THREE.Mesh(arrowGeo, arrowMat);
    this.cursorArrow.position.set(0, 0.6, 12);
    this.cursorArrow.renderOrder = 50;
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(shape.getPoints().map((p) => new THREE.Vector3(p.x, 0, p.y))),
      new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
    outline.renderOrder = 51;
    this.cursorArrow.add(outline);
    // entry bar (road width)
    const bar = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 0.8), new THREE.MeshBasicMaterial({ color: CURSOR_COLOR.clone().multiplyScalar(2), depthTest: false, transparent: true, toneMapped: false }));
    bar.position.set(0, 0.6, 0);
    bar.renderOrder = 50;
    // stem down to the grid + dot
    this.cursorStem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]),
      new THREE.LineDashedMaterial({ color: CURSOR_COLOR, dashSize: 1.5, gapSize: 1.2, transparent: true, opacity: 0.8, depthTest: false, toneMapped: false }));
    this.cursorStem.renderOrder = 49;
    this.cursorDot = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.6, 24), new THREE.MeshBasicMaterial({ color: CURSOR_COLOR, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide, toneMapped: false }));
    this.cursorDot.rotation.x = -Math.PI / 2;
    this.cursorDot.renderOrder = 49;
    this.cursorGroup.add(this.cursorArrow, bar, this.cursorStem, this.cursorDot);

    if (savedCamera) { this.setCameraState(savedCamera, true); this.restoredCamera = true; }
    this.setTheme('neonCity');
  }

  /* ---------------- renderer takeover ---------------- */

  attach() {
    if (this.attached || this.disposed) return;
    this.attached = true;
    const g = this.game;
    const cam = this.camera;
    this.prev = { fov: cam.fov, near: cam.near, far: cam.far, up: cam.up.clone(), wasRunning: g.running, glow: sharedUniforms.uGlowPos.value.clone() };
    g.stop();
    try { g.setSceneMode('editor'); } catch { /* ignore */ }
    g.renderer.setScene(this.scene);
    if (g.renderer.speedLines) g.renderer.speedLines.intensity = 0;
    g.renderer.chroma?.offset.set(0, 0);
    cam.fov = 50; cam.near = 0.5; cam.far = 8000; cam.up.set(0, 1, 0); cam.updateProjectionMatrix();
    sharedUniforms.uGlowPos.value.set(0, -10000, 0);
    this.applyThemeUniforms();

    const d = this.dom;
    d.addEventListener('pointerdown', this.onPointerDown);
    d.addEventListener('pointermove', this.onPointerMove);
    d.addEventListener('pointerup', this.onPointerUp);
    d.addEventListener('pointercancel', this.onPointerUp);
    d.addEventListener('pointerleave', this.onPointerLeave);
    d.addEventListener('wheel', this.onWheel, { passive: false });
    d.addEventListener('contextmenu', this.onContextMenu);

    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.attached) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    cancelAnimationFrame(this.raf);
    if (this.compiled) savedCamera = this.getCameraState();
    const d = this.dom;
    d.removeEventListener('pointerdown', this.onPointerDown);
    d.removeEventListener('pointermove', this.onPointerMove);
    d.removeEventListener('pointerup', this.onPointerUp);
    d.removeEventListener('pointercancel', this.onPointerUp);
    d.removeEventListener('pointerleave', this.onPointerLeave);
    d.removeEventListener('wheel', this.onWheel);
    d.removeEventListener('contextmenu', this.onContextMenu);
    this.pointers.clear();

    const g = this.game;
    g.renderer.setScene(g.scene);
    const cam = this.camera;
    cam.clearViewOffset();
    this.viewShift = { x: 0, y: 0, w: 0, h: 0 };
    if (this.prev) {
      cam.fov = this.prev.fov; cam.near = this.prev.near; cam.far = this.prev.far; cam.up.copy(this.prev.up);
      cam.updateProjectionMatrix();
      sharedUniforms.uGlowPos.value.copy(this.prev.glow);
    }
    // restore the lighting uniforms for whatever track the game has loaded (it may have changed meanwhile)
    const t = g.theme;
    sharedUniforms.uSunDir.value.copy(new THREE.Vector3(...t.sky.sunDir).normalize());
    sharedUniforms.uSunColor.value.set(t.light.sun).multiplyScalar(t.light.sunIntensity * 0.6);
    sharedUniforms.uAmbient.value.set(t.light.ambient);
    if (!this.prev || this.prev.wasRunning || !g.running) g.start();
    this.prev = null;
  }

  dispose() {
    this.detach();
    this.disposed = true;
    if (this.trackView) { this.trackView.dispose(); disposeObject(this.trackView.group); this.trackView = null; }
    for (const c of [...this.trackExtras.children]) disposeObject(c);
    this.clearHighlight();
    if (this.ghost) { disposeObject(this.ghost); this.ghost = null; }
    this.pickMesh?.geometry.dispose();
    if (this.sky) { this.sky.mesh.removeFromParent(); this.sky.dispose(); this.sky = null; }
    this.grid.geometry.dispose(); this.gridMat.dispose();
    disposeObject(this.cursorGroup);
    this.selectionFill.dispose();
  }

  /* ---------------- content ---------------- */

  setTheme(id: ThemeId) {
    const theme = THEMES[id] ?? THEMES.neonCity;
    if (this.sky && theme === this.theme) return;
    this.theme = theme;
    if (this.sky) { this.sky.mesh.removeFromParent(); this.sky.dispose(); }
    this.sky = new Sky(theme);
    this.scene.add(this.sky.mesh);
    this.scene.background = new THREE.Color(theme.sky.horizon);
    this.scene.fog = new THREE.Fog(new THREE.Color(theme.fog.color), 600, 3000);
    this.hemi.color.set(theme.light.hemiSky); this.hemi.groundColor.set(theme.light.hemiGround); this.hemi.intensity = theme.light.hemiIntensity;
    this.sun.color.set(theme.light.sun); this.sun.intensity = theme.light.sunIntensity;
    this.sun.position.set(...theme.sky.sunDir).multiplyScalar(500);
    const u = this.gridMat.uniforms;
    (u.uLine.value as THREE.Color).set(theme.rail).multiplyScalar(1.2);
    (u.uMajor.value as THREE.Color).set(theme.road.arrow).multiplyScalar(1.6);
    const fill = (u.uFill.value as THREE.Color).set(theme.ground.color).lerp(new THREE.Color(theme.sky.horizon), 0.4);
    const hsl = { h: 0, s: 0, l: 0 };
    fill.getHSL(hsl);
    fill.setHSL(hsl.h, Math.min(hsl.s, 0.65), THREE.MathUtils.clamp(hsl.l, 0.07, 0.13));
    if (this.attached) this.applyThemeUniforms();
    if (this.compiled) this.rebuildTrack();
  }

  private applyThemeUniforms() {
    const t = this.theme;
    sharedUniforms.uSunDir.value.copy(new THREE.Vector3(...t.sky.sunDir).normalize());
    sharedUniforms.uSunColor.value.set(t.light.sun).multiplyScalar(t.light.sunIntensity * 0.6);
    sharedUniforms.uAmbient.value.set(t.light.ambient).multiplyScalar(1.3);
  }

  setTrack(placements: Placement[], compiled: CompiledTrack, theme: ThemeId) {
    this.placements = placements;
    this.compiled = compiled;
    if (THEMES[theme] !== this.theme || !this.sky) this.setTheme(theme); // rebuilds the track
    else this.rebuildTrack();
  }

  private rebuildTrack() {
    const compiled = this.compiled;
    if (!compiled) return;
    this.trackView?.dispose();
    if (this.trackView) disposeObject(this.trackView.group);
    this.trackView = new TrackView(compiled, this.theme);
    this.scene.add(this.trackView.group);

    for (const c of [...this.trackExtras.children]) disposeObject(c);
    // grid level: at or below the lowest point of the track
    const minY = compiled.frames.length ? compiled.bounds.min.y : 0;
    this.gridY = Math.min(0, Math.floor((minY - 2) / 8) * 8) - 0.6;
    this.grid.position.y = this.gridY;

    // pick ribbons (one merged mesh) + ground shadows + gap markers
    const pickPos: number[] = [], pickIdx: number[] = [], faceMap: number[] = [];
    const shadowPos: number[] = [], shadowIdx: number[] = [];
    const accent = new THREE.Color(this.theme.road.arrow);
    for (const pf of compiled.pieceFrames) {
      const frames = compiled.frames.slice(pf.start, pf.end + 1);
      if (frames.length < 2) continue;
      const type = this.placements[pf.pieceIndex]?.type ?? '';
      const half = pieceHalfWidth(type);
      const base = pickPos.length / 3;
      pickPos.push(...ribbonPositions(frames, half, 0.4, null));
      const before = pickIdx.length;
      ribbonIndices(frames.length, base, pickIdx);
      for (let k = before; k < pickIdx.length; k += 3) faceMap.push(pf.pieceIndex);
      const sb = shadowPos.length / 3;
      shadowPos.push(...ribbonPositions(frames, PIECES[type]?.halfWidth ?? 7, 0, this.gridY + 0.15));
      ribbonIndices(frames.length, sb, shadowIdx);
      if (PIECES[type]?.gap) {
        const pts = frames.map((f) => new THREE.Vector3(f.pos.x, f.pos.y + 0.5, f.pos.z));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineDashedMaterial({ color: accent.clone().multiplyScalar(2), dashSize: 2.5, gapSize: 2, toneMapped: false }));
        line.computeLineDistances();
        this.trackExtras.add(line);
        const fill = new THREE.Mesh(this.makeGeo(ribbonPositions(frames, 7, 0.2, null), frames.length),
          new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
        this.trackExtras.add(fill);
      }
    }
    if (shadowPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(shadowPos, 3));
      g.setIndex(shadowIdx);
      const shadow = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide }));
      shadow.renderOrder = -5;
      this.trackExtras.add(shadow);
    }
    // support stems from elevated pieces to the grid (depth cue)
    const stems: number[] = [];
    for (const pf of compiled.pieceFrames) {
      const f = compiled.frames[Math.floor((pf.start + pf.end) / 2)];
      if (!f || f.pos.y - this.gridY < 4 || PIECES[this.placements[pf.pieceIndex]?.type ?? '']?.gap) continue;
      stems.push(f.pos.x, f.pos.y - 0.5, f.pos.z, f.pos.x, this.gridY, f.pos.z);
    }
    if (stems.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(stems, 3));
      this.trackExtras.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(this.theme.rail), transparent: true, opacity: 0.35, toneMapped: false })));
    }

    this.pickMesh?.geometry.dispose();
    this.pickMesh = null;
    if (pickPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pickPos, 3));
      g.setIndex(pickIdx);
      g.computeBoundingSphere();
      this.pickMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      this.pickMesh.visible = false;
    }
    this.pickFaceToPiece = Int32Array.from(faceMap);
    this.rebuildHighlight();
    this.ghostKey = '';
  }

  private makeGeo(pos: number[], n: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const idx: number[] = [];
    ribbonIndices(n, 0, idx);
    g.setIndex(idx);
    return g;
  }

  setSelection(selected: number | null, hovered: number | null, flagged: number[]) {
    if (selected === this.selected && hovered === this.hovered && flagged.join() === this.flagged.join()) return;
    this.selected = selected; this.hovered = hovered; this.flagged = flagged.slice();
    this.rebuildHighlight();
  }

  private clearHighlight() {
    for (const c of [...this.highlight.children]) {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material !== this.selectionFill) (m.material as THREE.Material).dispose();
      c.removeFromParent();
    }
  }

  private rebuildHighlight() {
    this.clearHighlight();
    const c = this.compiled;
    if (!c) return;
    const add = (index: number, color: THREE.Color, opacity: number, lineOpacity: number, lift: number, shared = false) => {
      const pf = c.pieceFrames.find((p) => p.pieceIndex === index);
      if (!pf) return;
      const frames = c.frames.slice(pf.start, pf.end + 1);
      if (frames.length < 2) return;
      const half = pieceHalfWidth(this.placements[index]?.type ?? '');
      const mat = shared ? this.selectionFill : new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
      const fill = new THREE.Mesh(this.makeGeo(ribbonPositions(frames, half, lift, null), frames.length), mat);
      fill.renderOrder = 40;
      this.highlight.add(fill);
      // outline: both edges + end caps
      const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
      for (const f of frames) {
        const u = new THREE.Vector3(f.up.x, f.up.y, f.up.z).multiplyScalar(lift + 0.05);
        const p = new THREE.Vector3(f.pos.x, f.pos.y, f.pos.z).add(u);
        const r = new THREE.Vector3(f.right.x, f.right.y, f.right.z).multiplyScalar(half);
        left.push(p.clone().sub(r)); right.push(p.clone().add(r));
      }
      const loop = [...left, ...right.reverse()];
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(loop),
        new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(2), transparent: true, opacity: lineOpacity, depthTest: false, toneMapped: false }));
      line.renderOrder = 41;
      this.highlight.add(line);
    };
    for (const i of this.flagged) if (i !== this.selected) add(i, WARN_COLOR, 0.22, 0.8, 0.5);
    if (this.hovered !== null && this.hovered !== this.selected) add(this.hovered, HOVER_COLOR, 0.12, 0.6, 0.55);
    if (this.selected !== null) add(this.selected, SELECT_COLOR, 0.35, 1, 0.6, true);
  }

  private cursorInit = false;
  setCursor(c: Cursor) {
    this.cursor = { ...c };
    if (!this.cursorInit) { this.cursorInit = true; this.cursorVisual.set(c.x, c.y, c.z); this.cursorYaw = (c.rot * Math.PI) / 2; }
  }

  /** Translucent preview of `type` placed at `at` (null hides it). */
  setGhost(type: string | null, at: Cursor | null) {
    const key = type && at ? `${type}|${at.x}|${at.y}|${at.z}|${at.rot}` : '';
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    if (this.ghost) { disposeObject(this.ghost); this.ghost = null; }
    if (!type || !at || !PIECES[type]) return;
    const pl: Placement = { type, x: at.x, y: at.y, z: at.z, rot: at.rot };
    const c = compileTrack({ pieces: [pl] });
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
    for (const k of ['road', 'wall', 'wallride', 'tunnel', 'rail'] as const) {
      const d = c.surfaces[k];
      if (!d.indices.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(d.indices, 1));
      const m = new THREE.Mesh(geo, k === 'road' ? mat : mat.clone());
      m.renderOrder = 30;
      g.add(m);
    }
    const pts = c.frames.map((f) => new THREE.Vector3(f.pos.x + f.up.x * 0.8, f.pos.y + f.up.y * 0.8, f.pos.z + f.up.z * 0.8));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: GHOST_COLOR.clone().multiplyScalar(2.5), dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true, toneMapped: false }));
    line.computeLineDistances();
    line.renderOrder = 31;
    g.add(line);
    this.ghost = g;
    this.scene.add(g);
  }

  /* ---------------- camera ---------------- */

  getCameraState(): CameraState {
    return { target: [this.target.x, this.target.y, this.target.z], azimuth: this.azimuth, polar: this.polar, distance: this.distance };
  }
  setCameraState(s: CameraState, snap = false) {
    this.target.set(...s.target); this.azimuth = s.azimuth; this.polar = s.polar; this.distance = s.distance;
    if (snap) { this.cur.target.copy(this.target); this.cur.azimuth = this.azimuth; this.cur.polar = this.polar; this.cur.distance = this.distance; }
  }
  /** True once a camera state has been restored from an earlier editor session. */
  static hasSavedCamera() { return savedCamera !== null; }

  focusCursor() {
    this.target.set(this.cursor.x, this.cursor.y, this.cursor.z);
    this.distance = Math.min(this.distance, 140);
  }

  focusPiece(index: number) {
    const c = this.compiled;
    const pf = c?.pieceFrames.find((p) => p.pieceIndex === index);
    if (!c || !pf) return;
    const f = c.frames[Math.floor((pf.start + pf.end) / 2)];
    this.target.set(f.pos.x, f.pos.y, f.pos.z);
  }

  /**
   * Fit the whole track in the free part of the screen. With `autoAngle` the camera also
   * turns so the track's long side runs across the (wide) screen.
   */
  frameAll(snap = false, autoAngle = false) {
    const c = this.compiled;
    if (!c || !c.frames.length) { this.target.set(0, 0, 0); this.distance = 160; return; }
    const b = c.bounds;
    const ex = b.max.x - b.min.x, ez = b.max.z - b.min.z;
    this.target.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    if (autoAngle) {
      // pick the closest of the 4 diagonal-ish views that puts the long axis horizontally
      const base = ex >= ez ? 0 : Math.PI / 2;
      const options = [base - 0.35, base + 0.35, base + Math.PI - 0.35, base + Math.PI + 0.35];
      let best = this.azimuth, bestD = Infinity;
      for (const o of options) {
        const d = Math.abs(Math.atan2(Math.sin(o - this.azimuth), Math.cos(o - this.azimuth)));
        if (d < bestD) { bestD = d; best = this.azimuth + Math.atan2(Math.sin(o - this.azimuth), Math.cos(o - this.azimuth)); }
      }
      this.azimuth = best;
      this.polar = 0.8;
    } else {
      this.polar = Math.min(this.polar, 0.85);
    }
    const r = Math.max(75, 0.5 * Math.hypot(ex, ez, b.max.y - b.min.y));
    const W = Math.max(1, this.game.renderer.canvas.clientWidth), H = Math.max(1, this.game.renderer.canvas.clientHeight);
    const freeW = Math.max(0.3, (W - this.insets.left - this.insets.right) / W);
    const freeH = Math.max(0.3, (H - this.insets.top - this.insets.bottom) / H);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tanH = tanV * (W / H);
    const fit = r / Math.min(tanV * freeH, tanH * freeW);
    this.distance = THREE.MathUtils.clamp(fit * 0.92 + 10, 60, 2000);
    if (snap) this.setCameraState(this.getCameraState(), true);
  }

  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private viewShift = { x: 0, y: 0, w: 0, h: 0 };
  /** Screen areas covered by UI panels (px); the view is centered in the remaining space. */
  setInsets(i: { left: number; right: number; top: number; bottom: number }) {
    this.insets = { ...i };
  }

  private applyViewOffset() {
    const W = this.game.renderer.canvas.clientWidth, H = this.game.renderer.canvas.clientHeight;
    if (!W || !H) return;
    const sx = Math.round((this.insets.left - this.insets.right) / 2);
    const sy = Math.round((this.insets.top - this.insets.bottom) / 2);
    const v = this.viewShift;
    if (v.x === sx && v.y === sy && v.w === W && v.h === H) return;
    this.viewShift = { x: sx, y: sy, w: W, h: H };
    if (sx === 0 && sy === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(W, H, -sx, -sy, W, H);
  }

  /** Grid step (world cells) that corresponds to "forward" on screen, for camera-relative cursor movement. */
  screenAxes(): { forward: { dx: number; dz: number }; right: { dx: number; dz: number } } {
    const fx = -Math.sin(this.cur.azimuth), fz = -Math.cos(this.cur.azimuth);
    const forward = Math.abs(fx) > Math.abs(fz) ? { dx: Math.sign(fx), dz: 0 } : { dx: 0, dz: Math.sign(fz) };
    return { forward, right: { dx: -forward.dz, dz: forward.dx } };
  }

  /** Pan the camera toward `c` if it is near the edge of / outside the view. */
  keepInView(c: Cursor) {
    if (!this.attached) return;
    const p = new THREE.Vector3(c.x, c.y, c.z).project(this.camera);
    const behind = p.z > 1;
    if (behind || Math.abs(p.x) > 0.6 || Math.abs(p.y) > 0.55) {
      const want = new THREE.Vector3(c.x, c.y, c.z);
      this.target.lerp(want, behind ? 1 : 0.6);
    }
  }

  zoom(factor: number) {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, 15, 2000);
  }

  rotateView(dAz: number) { this.azimuth += dAz; }

  private updateCamera(dt: number) {
    const k = 1 - Math.exp(-dt * 14);
    const c = this.cur;
    c.target.lerp(this.target, k);
    c.azimuth += (this.azimuth - c.azimuth) * k;
    c.polar += (this.polar - c.polar) * k;
    c.distance += (this.distance - c.distance) * k;
    const sp = Math.sin(c.polar);
    this.camera.position.set(
      c.target.x + c.distance * sp * Math.sin(c.azimuth),
      c.target.y + c.distance * Math.cos(c.polar),
      c.target.z + c.distance * sp * Math.cos(c.azimuth),
    );
    this.camera.lookAt(c.target);
    this.applyViewOffset();
    const near = THREE.MathUtils.clamp(c.distance * 0.01, 0.3, 5);
    if (Math.abs(this.camera.near - near) > 0.05) { this.camera.near = near; this.camera.updateProjectionMatrix(); }
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) { fog.near = c.distance * 1.4 + 300; fog.far = c.distance * 4 + 1800; }
    this.gridMat.uniforms.uRadius.value = Math.max(900, c.distance * 4);
    (this.gridMat.uniforms.uCenter.value as THREE.Vector3).copy(c.target);
  }

  /* ---------------- input ---------------- */

  private onContextMenu = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, type: e.pointerType, button: e.button, t: performance.now() });
    if (this.pointers.size === 1) { this.gestureMoved = false; this.multiTouch = false; }
    if (this.pointers.size >= 2) { this.multiTouch = true; this.pinch = this.pinchInfo(); }
  };

  private pinchInfo() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private pan(dxPx: number, dyPx: number) {
    const h = this.dom.clientHeight || window.innerHeight;
    const worldPerPx = (2 * this.cur.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
    const az = this.cur.azimuth;
    const rx = Math.cos(az), rz = -Math.sin(az);      // screen right on the ground
    const fx = -Math.sin(az), fz = -Math.cos(az);     // screen up (forward) on the ground
    const s = worldPerPx * 1.1;
    this.target.x += (-dxPx * rx + dyPx * fx) * s;
    this.target.z += (-dxPx * rz + dyPx * fz) * s;
    this.cur.target.copy(this.target);
  }

  private onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.hoverPending = { x: e.clientX, y: e.clientY };
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > 7) this.gestureMoved = true;
    if (this.pointers.size >= 2) {
      const info = this.pinchInfo();
      if (this.pinch) {
        if (info.dist > 10 && this.pinch.dist > 10) this.zoom(this.pinch.dist / info.dist);
        this.pan(info.mx - this.pinch.mx, info.my - this.pinch.my);
      }
      this.pinch = info;
      return;
    }
    const panMode = p.type === 'mouse' && (p.button === 1 || p.button === 2 || e.shiftKey);
    if (panMode) this.pan(dx, dy);
    else {
      this.azimuth -= dx * 0.0065;
      this.polar = THREE.MathUtils.clamp(this.polar - dy * 0.005, 0.12, 1.45);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!p || e.type === 'pointercancel') return;
    const quick = performance.now() - p.t < 600;
    if (!this.gestureMoved && !this.multiTouch && quick && this.pointers.size === 0 && p.button === 0) {
      this.handleTap(e.clientX, e.clientY);
    }
  };

  private onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && !this.pointers.size) { this.hoverPending = null; this.events.onHover?.(null); }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    this.zoom(Math.exp(THREE.MathUtils.clamp(d, -200, 200) * 0.0012));
  };

  private ndc(x: number, y: number) {
    const r = this.game.renderer.canvas.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  /** Piece index under a screen point (or null). */
  pick(x: number, y: number): number | null {
    if (!this.pickMesh) return null;
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const hits = this.raycaster.intersectObject(this.pickMesh, false);
    for (const h of hits) {
      if (h.faceIndex === undefined || h.faceIndex === null) continue;
      const piece = this.pickFaceToPiece[h.faceIndex];
      if (piece !== undefined) return piece;
    }
    return null;
  }

  /** Grid cell (snapped x/z) under a screen point on the plane y = planeY. */
  groundCell(x: number, y: number, planeY: number): { x: number; z: number } | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    if (hit.distanceTo(this.camera.position) > 4000) return null;
    return { x: Math.round(hit.x / CELL) * CELL, z: Math.round(hit.z / CELL) * CELL };
  }

  private handleTap(x: number, y: number) {
    const piece = this.pick(x, y);
    const ground = piece === null ? this.groundCell(x, y, this.cursor.y) : null;
    this.events.onTap?.(piece, ground);
  }

  /* ---------------- frame ---------------- */

  private frame(dt: number) {
    sharedUniforms.uTime.value += dt;
    if (this.hoverPending) {
      const h = this.hoverPending; this.hoverPending = null;
      this.events.onHover?.(this.pick(h.x, h.y));
    }
    this.updateCamera(dt);
    this.trackView?.update(dt);
    this.sky?.update(this.camera.position);

    // cursor: glide toward the target cell, pulse
    const k = 1 - Math.exp(-dt * 16);
    this.cursorVisual.lerp(new THREE.Vector3(this.cursor.x, this.cursor.y, this.cursor.z), k);
    const yawTarget = (this.cursor.rot * Math.PI) / 2;
    let dy = yawTarget - this.cursorYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.cursorYaw += dy * k;
    this.cursorGroup.position.copy(this.cursorVisual);
    this.cursorGroup.rotation.y = this.cursorYaw;
    const t = sharedUniforms.uTime.value;
    const pulse = 1 + Math.sin(t * 4) * 0.08;
    this.cursorArrow.scale.setScalar(pulse);
    this.cursorArrow.position.z = 12 + Math.sin(t * 4) * 1.2;
    const stemLen = Math.max(0.01, this.cursorVisual.y - this.gridY);
    const stemGeo = this.cursorStem.geometry as THREE.BufferGeometry;
    const arr = stemGeo.getAttribute('position') as THREE.BufferAttribute;
    arr.setXYZ(1, 0, -stemLen, 0); arr.needsUpdate = true;
    this.cursorStem.computeLineDistances();
    this.cursorStem.visible = stemLen > 1;
    this.cursorDot.position.y = -stemLen + 0.2;
    (this.gridMat.uniforms.uCursor.value as THREE.Vector3).copy(this.cursorVisual);
    this.selectionFill.opacity = 0.28 + Math.sin(t * 5) * 0.1;
    if (this.ghost) {
      const o = 0.26 + Math.sin(t * 6) * 0.08;
      this.ghost.traverse((m) => { const mm = (m as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (mm && (m as THREE.Mesh).isMesh) mm.opacity = o; });
    }
    this.game.renderer.render(dt);
  }
}
