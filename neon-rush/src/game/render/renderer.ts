import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect, ChromaticAberrationEffect,
  BlendFunction, KernelSize, Effect, SMAAEffect, SMAAPreset,
} from 'postprocessing';

export type QualityLevel = 'low' | 'medium' | 'high';

const speedLinesFragment = /* glsl */ `
uniform float intensity;
uniform float time;
uniform float boost;
float hash(float n) { return fract(sin(n) * 43758.5453123); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 c = uv - 0.5;
  float r = length(c);
  float a = atan(c.y, c.x);
  float lines = 0.0;
  // radial streaks
  float seg = floor((a + 3.14159) / 6.28318 * 140.0);
  float rnd = hash(seg * 1.7 + 1.0);
  float speedPhase = fract(time * (2.0 + rnd * 4.0) + rnd);
  float streak = smoothstep(0.35, 1.0, r + rnd * 0.2 - 0.15);
  float gate = step(0.55, hash(seg * 3.3 + floor(time * 8.0) * 0.37 + 2.0));
  lines = streak * gate * smoothstep(0.0, 0.3, fract((a + 3.14159) / 6.28318 * 140.0)) * (0.5 + 0.5 * speedPhase);
  float strength = intensity * (0.55 + 0.45 * boost);
  vec3 tint = mix(vec3(0.75, 0.9, 1.0), vec3(1.0, 0.75, 0.45), boost);
  vec3 col = inputColor.rgb + tint * lines * strength * 0.9;
  outputColor = vec4(col, inputColor.a);
}
`;

export class SpeedLinesEffect extends Effect {
  constructor() {
    super('SpeedLinesEffect', speedLinesFragment, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['intensity', new THREE.Uniform(0)],
        ['time', new THREE.Uniform(0)],
        ['boost', new THREE.Uniform(0)],
      ]),
    });
  }
  set intensity(v: number) { this.uniforms.get('intensity')!.value = v; }
  set boost(v: number) { this.uniforms.get('boost')!.value = v; }
  update(_renderer: THREE.WebGLRenderer, _input: THREE.WebGLRenderTarget, deltaTime?: number) {
    this.uniforms.get('time')!.value += deltaTime ?? 0.016;
  }
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  private renderPass: RenderPass;
  private effectPass: EffectPass | null = null;
  bloom: BloomEffect | null = null;
  speedLines: SpeedLinesEffect | null = null;
  chroma: ChromaticAberrationEffect | null = null;
  quality: QualityLevel = 'high';
  usePost = true;
  private width = 1;
  private height = 1;
  private resizeObserver: ResizeObserver | null = null;

  constructor(public canvas: HTMLCanvasElement, quality: QualityLevel) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false, depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 4000);
    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.setQuality(quality);
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? document.body);
    window.addEventListener('resize', this.resize);
  }

  setScene(scene: THREE.Scene) {
    this.scene = scene;
    this.renderPass.mainScene = scene;
  }

  private extraPasses: EffectPass[] = [];

  setQuality(q: QualityLevel) {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    const cap = q === 'low' ? 1 : q === 'medium' ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(dpr, cap));
    this.renderer.shadowMap.enabled = q === 'high';
    // rebuild effect passes
    if (this.effectPass) { this.composer.removePass(this.effectPass); this.effectPass.dispose(); this.effectPass = null; }
    for (const p of this.extraPasses) { this.composer.removePass(p); p.dispose(); }
    this.extraPasses = [];
    this.usePost = q !== 'low';
    if (this.usePost) {
      try {
        this.bloom = new BloomEffect({
          blendFunction: BlendFunction.ADD,
          luminanceThreshold: 0.72,
          luminanceSmoothing: 0.25,
          intensity: q === 'high' ? 1.35 : 1.1,
          kernelSize: q === 'high' ? KernelSize.LARGE : KernelSize.MEDIUM,
          mipmapBlur: true,
          radius: 0.75,
          levels: q === 'high' ? 7 : 5,
        });
        this.speedLines = new SpeedLinesEffect();
        const vignette = new VignetteEffect({ darkness: 0.45, offset: 0.25 });
        this.effectPass = new EffectPass(this.camera, this.bloom, this.speedLines, vignette);
        this.composer.addPass(this.effectPass);
        // convolution effects need their own passes
        this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.3 });
        const chromaPass = new EffectPass(this.camera, this.chroma);
        this.composer.addPass(chromaPass);
        this.extraPasses.push(chromaPass);
        if (q === 'high') {
          const smaaPass = new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }));
          this.composer.addPass(smaaPass);
          this.extraPasses.push(smaaPass);
        }
      } catch (err) {
        console.warn('Post-processing unavailable, falling back to direct rendering', err);
        this.usePost = false; this.bloom = null; this.speedLines = null; this.chroma = null;
      }
    } else {
      this.bloom = null; this.speedLines = null; this.chroma = null;
    }
    this.resize();
  }

  resize = () => {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, parent ? parent.clientWidth : window.innerWidth);
    const h = Math.max(1, parent ? parent.clientHeight : window.innerHeight);
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  get aspect() { return this.width / this.height; }

  render(dt: number) {
    if (this.usePost) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this.resize);
    this.resizeObserver?.disconnect();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

export function detectQuality(): QualityLevel {
  const ua = navigator.userAgent;
  const isIPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = /iPhone|Android/.test(ua);
  const cores = navigator.hardwareConcurrency || 4;
  if (isMobile) return 'low';
  if (isIPad) return cores >= 6 ? 'medium' : 'low';
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (mem && mem <= 4) return 'medium';
  return 'high';
}
