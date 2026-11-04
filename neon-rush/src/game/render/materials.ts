import * as THREE from 'three';

/** Shared uniforms updated every frame by the game. */
export const sharedUniforms = {
  uTime: { value: 0 },
  uGlowPos: { value: new THREE.Vector3(0, -1000, 0) },
  uGlowColor: { value: new THREE.Color(0x000000) },
  uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.9) },
  uAmbient: { value: new THREE.Color(0.25, 0.22, 0.35) },
};

const lightingChunk = /* glsl */ `
  vec3 applyLighting(vec3 albedo, vec3 n, vec3 wp) {
    float ndl = dot(n, uSunDir);
    float wrap = clamp(ndl * 0.6 + 0.4, 0.0, 1.0);
    vec3 col = albedo * (uAmbient + uSunColor * wrap);
    // car underglow light
    vec3 toG = uGlowPos - wp;
    float d = length(toG);
    float att = 1.0 / (1.0 + d * d * 0.09);
    float gndl = clamp(dot(n, toG / max(d, 0.001)), 0.0, 1.0);
    col += uGlowColor * att * (0.35 + 0.65 * gndl) * 2.2;
    return col;
  }
`;

const roadVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const roadFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uBase;
  uniform vec3 uLine;
  uniform vec3 uArrow;
  uniform vec3 uGlowPos;
  uniform vec3 uGlowColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uArrowSpeed;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  #include <fog_pars_fragment>
  ${lightingChunk}
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main() {
    float u = vUv.x;
    float v = vUv.y;
    float across = abs(v - 0.5) * 2.0; // 0 center, 1 edge
    // subtle asphalt texture
    float n = hash21(floor(vec2(u * 2.0, v * 14.0)));
    vec3 albedo = uBase * (0.88 + 0.24 * n);
    // panel seams every 6 m
    float seam = smoothstep(0.0, 0.08, abs(fract(u / 6.0) - 0.5) * 2.0 - 0.94);
    albedo *= 1.0 - 0.18 * (1.0 - seam) * 0.0;
    float seamLine = 1.0 - smoothstep(0.0, 0.03, abs(fract(u / 6.0 + 0.5) - 0.5));
    albedo = mix(albedo, uBase * 0.6, seamLine * 0.5);
    // lane lines
    float center = 1.0 - smoothstep(0.012, 0.03, abs(v - 0.5));
    float dash = step(0.5, fract(u / 4.0));
    vec3 col = applyLighting(albedo, normalize(vNormal), vWorldPos);
    col += uLine * center * dash * 0.9;
    // edge inner glow
    float edge = smoothstep(0.86, 1.0, across);
    col += uLine * edge * 0.55;
    // moving chevrons (direction arrows)
    float arrowU = u - uTime * uArrowSpeed;
    float ph = fract((arrowU + across * 3.2) / 16.0);
    float arrow = (1.0 - smoothstep(0.0, 0.06, ph)) * (1.0 - smoothstep(0.55, 0.75, across)) * step(0.08, across);
    float pulse = 0.65 + 0.35 * sin(uTime * 3.0 + u * 0.2);
    col += uArrow * arrow * 0.9 * pulse;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

export function createRoadMaterial(base: THREE.Color, line: THREE.Color, arrow: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uBase: { value: base }, uLine: { value: line }, uArrow: { value: arrow }, uArrowSpeed: { value: 10 },
    }]), sharedUniforms),
    vertexShader: roadVertex,
    fragmentShader: roadFragment,
    fog: true,
    side: THREE.DoubleSide,
  });
}

const panelFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uBase;
  uniform vec3 uLine;
  uniform vec3 uGlowPos;
  uniform vec3 uGlowColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uGridU;
  uniform float uGridV;
  uniform float uEmissive;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  #include <fog_pars_fragment>
  ${lightingChunk}
  void main() {
    float gu = abs(fract(vUv.x / uGridU) - 0.5) * 2.0;
    float gv = abs(fract(vUv.y * uGridV) - 0.5) * 2.0;
    float line = max(smoothstep(0.9, 0.98, gu), smoothstep(0.86, 0.97, gv));
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 col = applyLighting(uBase, n, vWorldPos);
    float flow = 0.5 + 0.5 * sin(vUv.x * 0.35 - uTime * 2.5);
    col += uLine * line * (0.45 + 0.55 * flow) * uEmissive;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

export function createPanelMaterial(base: THREE.Color, line: THREE.Color, gridU = 4, gridV = 2, emissive = 1) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uBase: { value: base }, uLine: { value: line }, uGridU: { value: gridU }, uGridV: { value: gridV }, uEmissive: { value: emissive },
    }]), sharedUniforms),
    vertexShader: roadVertex,
    fragmentShader: panelFragment,
    fog: true,
    side: THREE.DoubleSide,
  });
}

const boostFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  #include <fog_pars_fragment>
  void main() {
    float across = abs(vUv.y - 0.5) * 2.0;
    float arrowU = vUv.x - uTime * 28.0;
    float ph = fract((arrowU + across * 2.4) / 5.0);
    float arrow = 1.0 - smoothstep(0.0, 0.35, ph);
    vec3 col = mix(uColorA, uColorB, across) * (0.35 + 1.6 * arrow);
    col += uColorB * (1.0 - smoothstep(0.75, 1.0, across)) * 0.2;
    gl_FragColor = vec4(col * 1.6, 1.0);
    #include <fog_fragment>
  }
`;

export function createBoostMaterial(a: THREE.Color, b: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColorA: { value: a }, uColorB: { value: b } }]), { uTime: sharedUniforms.uTime }),
    vertexShader: roadVertex,
    fragmentShader: boostFragment,
    fog: true,
    side: THREE.DoubleSide,
  });
}

export function createNeonMaterial(color: THREE.Color | number, intensity = 2.2) {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({ color: c, toneMapped: false, fog: true });
}

/** Translucent animated gate membrane. */
const membraneFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uFlash;
  varying vec2 vUv;
  void main() {
    float scan = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 6.0);
    float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.x) * smoothstep(0.0, 0.1, vUv.y);
    float sweep = 1.0 - smoothstep(0.0, 0.25, abs(fract(uTime * 0.35) * 1.3 - vUv.y));
    float a = (0.08 + 0.1 * scan + 0.25 * sweep) * edge;
    a += uFlash * 0.8 * edge;
    gl_FragColor = vec4(uColor * (1.0 + uFlash * 2.0), a);
  }
`;
const membraneVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
export function createMembraneMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: sharedUniforms.uTime, uColor: { value: color }, uFlash: { value: 0 } },
    vertexShader: membraneVertex,
    fragmentShader: membraneFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}
