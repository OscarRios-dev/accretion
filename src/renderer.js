// Accretion — renderer: 3D scene, camera, labels and all UI.
// Pure logic lives in model.mjs (graph + layout), stats.mjs (statistics), markdown.mjs (safe rendering)
// and i18n.mjs (strings). This file wires them to three.js and the DOM.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LensShader } from './lens.js';
import { DAY, rng, gauss, ease, esc, store, debounce } from './util.mjs';
import { buildModel, neighbourhood, search, DISC_IN } from './model.mjs';
import { computeStats, renderHomeHtml, renderStatsHtml, noteInsights } from './stats.mjs';
import { renderMd, enhanceBody } from './markdown.mjs';
import { t, tn, fmt, ago, fdate, setLang, resolveLang, applyI18n, LANGS } from './i18n.mjs';

// ───────────────────────── constants ─────────────────────────
const RS = 12;                    // Schwarzschild radius (world units)
const LENS_R = RS * 14;           // sphere where light bends
const DEFAULT_CAM = new THREE.Vector3(0, 1430, 470);
const MAX_NOTE_LABELS = 150;      // DOM labels drawn at once (highest degree first)
const $ = (s) => document.querySelector(s);
// Motion: 'full', 'soft' or 'reduced'. Windows reports "reduce" whenever its animation effects are off, which many
// people do for speed, so on 'auto' that only softens motion (shorter flights). 'reduced' in settings removes it.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let motionPref = store.get('sbg.motion', 'auto'); // 'auto' | 'full' | 'reduced'
const motion = () => (motionPref === 'full' ? 'full' : motionPref === 'reduced' ? 'reduced' : reducedMotion.matches ? 'soft' : 'full');
const still = () => motion() === 'reduced';
const ROT_SPEED = () => (still() ? 0 : 0.008);
const flightDur = (d) => { const m = motion(); return m === 'reduced' ? 0.01 : m === 'soft' ? Math.max(0.45, d * 0.6) : d; };

// ───────────────────────── renderer & scene ─────────────────────────
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 200000);
camera.position.copy(DEFAULT_CAM);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.5;
controls.enableZoom = false; // our own eased zoom (see stepZoom); OrbitControls' wheel zoom jumps per notch
controls.minDistance = 10;
controls.maxDistance = 4200;

const galaxy = new THREE.Group();
scene.add(galaxy);

// Accretion disc in the galaxy's own plane, tilted a few degrees like a real disc. It used to stand edge-on to the
// default camera (perpendicular to the galaxy), which looked right from one angle only. V = U × N makes the disc's
// swirl and its Doppler-bright side turn the same way as the galaxy.
const diskBasis = (() => {
  const tilt = THREE.MathUtils.degToRad(3);
  const N = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
  const U = new THREE.Vector3(1, 0, 0);
  const V = new THREE.Vector3().crossVectors(U, N).normalize();
  return { N, U, V };
})();
// Close-up of the black hole (B): a low angle over the disc, where the lensed far side arches over the shadow.
const bhView = () => new THREE.Vector3()
  .addScaledVector(diskBasis.N, Math.sin(THREE.MathUtils.degToRad(11)))
  .addScaledVector(diskBasis.V, Math.cos(THREE.MathUtils.degToRad(11)))
  .multiplyScalar(RS * 17);

// ───────────────────────── background sky (cubemap) ─────────────────────────
function buildSky() {
  const sky = new THREE.Scene();
  const r = rng(7);
  const N = 9000;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    tmp.set(gauss(r), gauss(r), gauss(r)).normalize().multiplyScalar(50000).toArray(pos, i * 3);
    const b = Math.pow(r(), 7) * 0.9 + 0.06;
    const warm = r() * 0.08;
    col[i * 3] = b; col[i * 3 + 1] = b * (1 - warm * 0.4); col[i * 3 + 2] = b * (1 - warm);
    size[i] = 1 + Math.pow(r(), 10) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: `attribute vec3 aColor; attribute float aSize; varying vec3 vC;
      void main(){ vC=aColor; gl_PointSize=aSize*1.2; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec3 vC; void main(){ float d=length(gl_PointCoord-.5); gl_FragColor=vec4(vC*smoothstep(.5,.0,d),1.); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  sky.add(new THREE.Points(g, mat));
  // 512² half-float: ~12 MiB of VRAM instead of 48 MiB at 1024², visually identical behind bloom.
  const rt = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType });
  new THREE.CubeCamera(1, 100000, rt).update(renderer, sky);
  g.dispose();
  mat.dispose();
  return rt.texture;
}
const skyTex = buildSky();
scene.background = skyTex;

// ───────────────────────── soft grey smoke ─────────────────────────
function smokeTexture(seed) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const x = cv.getContext('2d');
  const r = rng(seed);
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2, d = Math.pow(r(), 0.7) * 40;
    const cx = 64 + Math.cos(a) * d, cy = 64 + Math.sin(a) * d, rad = 15 + r() * 30;
    const gr = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, `rgba(255,255,255,${0.05 + r() * 0.08})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(cv);
}
(function buildSmoke() {
  const r = rng(31);
  const texes = [smokeTexture(1), smokeTexture(2), smokeTexture(3)];
  // 12 large sprites (was 22): the faint haze is the same, a fraction of the overdraw.
  for (let i = 0; i < 12; i++) {
    const a = r() * Math.PI * 2, d = 900 + r() * 1500;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texes[i % 3], color: new THREE.Color(0.5, 0.5, 0.52), transparent: true,
      opacity: 0.05 + r() * 0.05, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    s.position.set(Math.cos(a) * d, -500 - r() * 700, Math.sin(a) * d);
    s.scale.setScalar(1000 + r() * 1200);
    s.material.rotation = r() * Math.PI * 2;
    scene.add(s);
  }
})();

// ───────────────────────── star dust ─────────────────────────
const dustMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
  vertexShader: `attribute vec3 aRAY; attribute float aB; attribute float aSize;
    uniform float uTime, uScale; varying float vB;
    void main(){
      float r=aRAY.x;
      float a=aRAY.y - uTime*0.5*pow(max(0., 1.-r/360.), 2.);
      vec3 p=vec3(cos(a)*r, aRAY.z, sin(a)*r);
      vec4 mv=modelViewMatrix*vec4(p,1.);
      float s=aSize*uScale/-mv.z;
      gl_PointSize=clamp(s,1.,5.);
      vB=aB*min(s,1.)*smoothstep(0.,40.,-mv.z);
      gl_Position=projectionMatrix*mv;
    }`,
  fragmentShader: `varying float vB; void main(){ float d=length(gl_PointCoord-.5); gl_FragColor=vec4(vec3(1.,.97,.92)*vB*smoothstep(.5,0.,d),1.); }`,
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
});
(function buildDust() {
  const r = rng(42);
  const N = 14000;
  const ray = new Float32Array(N * 3), b = new Float32Array(N), size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let rad, y;
    if (i < N * 0.3) { rad = RS * 6 + Math.abs(gauss(r)) * 140; y = gauss(r) * 6; }
    else { rad = Math.sqrt(DISC_IN * DISC_IN * 0.6 + r() * (760 * 760 - DISC_IN * DISC_IN * 0.6)); y = gauss(r) * 18; }
    ray[i * 3] = rad; ray[i * 3 + 1] = r() * Math.PI * 2; ray[i * 3 + 2] = y;
    b[i] = 0.12 + Math.pow(r(), 4) * 0.7;
    size[i] = 0.8 + Math.pow(r(), 6) * 2.5;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aRAY', new THREE.BufferAttribute(ray, 3));
  g.setAttribute('aB', new THREE.BufferAttribute(b, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const pts = new THREE.Points(g, dustMat);
  pts.frustumCulled = false;
  galaxy.add(pts);
})();

// ───────────────────────── orbits with comets ─────────────────────────
const orbits = [];
let orbitHeads = null;
(function buildOrbits() {
  const r = rng(77);
  for (let k = 0; k < 9; k++) {
    const R = 760 + k * 62 + r() * 40;
    const n = new THREE.Vector3((r() - 0.5) * 0.5, 1, (r() - 0.5) * 0.5).normalize();
    const u = new THREE.Vector3(1, 0, 0).cross(n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const S = 256;
    const P = new Float32Array((S + 1) * 3), U = new Float32Array(S + 1);
    for (let i = 0; i <= S; i++) {
      const a = (i / S) * Math.PI * 2;
      new THREE.Vector3().addScaledVector(u, Math.cos(a) * R).addScaledVector(v, Math.sin(a) * R).toArray(P, i * 3);
      U[i] = i / S;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aU', new THREE.BufferAttribute(U, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uHead: { value: r() }, uLen: { value: 0.07 + r() * 0.1 }, uBase: { value: 0.018 } },
      vertexShader: `attribute float aU; varying float vU; void main(){ vU=aU; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float uHead, uLen, uBase; varying float vU;
        void main(){ float d=fract(uHead - vU); float t=smoothstep(uLen,0.,d); gl_FragColor=vec4(vec3(1.)*(uBase*0.4 + 0.75*pow(t,1.8)),1.); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const line = new THREE.Line(g, m);
    line.frustumCulled = false;
    scene.add(line);
    orbits.push({ R, u, v, m, speed: (0.012 + r() * 0.02) * (r() < 0.3 ? -1 : 1) });
  }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
  orbitHeads = new THREE.Points(hg, new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 } },
    vertexShader: `uniform float uScale; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=clamp(9.*uScale/-mv.z,4.,16.); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `void main(){ float d=length(gl_PointCoord-.5); gl_FragColor=vec4(vec3(1.)*(exp(-d*d*90.)*1.6+exp(-d*10.)*.25),1.); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  orbitHeads.frustumCulled = false;
  scene.add(orbitHeads);
})();
function stepOrbits(dt) {
  const arr = orbitHeads.geometry.attributes.position;
  orbits.forEach((o, k) => {
    const h = (o.m.uniforms.uHead.value + o.speed * dt + 1) % 1;
    o.m.uniforms.uHead.value = h;
    const a = h * Math.PI * 2, c = Math.cos(a) * o.R, s = Math.sin(a) * o.R;
    arr.setXYZ(k, o.u.x * c + o.v.x * s, o.u.y * c + o.v.y * s, o.u.z * c + o.v.z * s);
  });
  arr.needsUpdate = true;
}

// ───────────────────────── post-processing ─────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const lensPass = new ShaderPass(LensShader);
const LU = lensPass.uniforms;
LU.uSky.value = skyTex;
LU.uRs.value = RS;
LU.uInfl.value = LENS_R / RS;
LU.uDiskOut.value = 12.5;
LU.uDiskN.value.copy(diskBasis.N);
LU.uDiskU.value.copy(diskBasis.U);
LU.uDiskV.value.copy(diskBasis.V);
composer.addPass(lensPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ───────────────────────── state ─────────────────────────
const state = {
  data: [],
  selPaths: store.get('sbg.selPaths', null),
  groupBy: store.get('sbg.group', 'folder'),
  colorMode: store.get('sbg.colorMode', store.get('sbg.colored', true) ? 'group' : 'white'), // 'white' | 'group' | 'heat'
  showFps: store.get('sbg.fps', false),
  rotating: store.get('sbg.rotating', true),
  quality: store.get('sbg.quality', 'auto'),
  depth: store.get('sbg.depth', 1),           // neighbourhood depth for a selected note: 1, 2 or Infinity (0 in storage)
  pins: store.get('sbg.pins', []),            // note ids
  model: null,
  stats: null,
  selected: null,                              // note object (re-resolved by id after each rebuild)
  focusedConst: null,
  filter: { query: '', tags: [], hidden: [], orphans: false, days: 0 },
  timeline: null,                              // { on, at } — hides notes created after `at`
  profile: { name: '' },
};
if (state.depth === 0) state.depth = Infinity;
const activeVaults = () => {
  const sel = (state.selPaths || []).filter((p) => state.data.some((v) => v.path === p));
  return sel.length ? state.data.map((_, i) => i).filter((i) => sel.includes(state.data[i].path)) : state.data.map((_, i) => i);
};
const findById = (id) => (state.model && id ? state.model.byId.get(id) : null);

// ───────────────────────── note objects ─────────────────────────
let starPoints = null, ideaPoints = null, linesObj = null, linkObj = null;
const starMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uHover: { value: -1 }, uSel: { value: -1 }, uScale: { value: 1 }, uColorMix: { value: 0 }, uHeatMix: { value: 0 } },
  vertexShader: `
    attribute float aSize, aSeed, aFocus, aIndex;
    attribute vec3 aColor;
    attribute vec4 aHeat; // rgb = temperature colour, a = brightness
    uniform float uTime, uHover, uSel, uScale, uHeatMix;
    varying float vBright, vSel;
    varying vec3 vCol;
    void main(){
      vCol = mix(aColor, aHeat.rgb, uHeatMix);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float tw = 0.88 + 0.12 * sin(uTime * (0.9 + aSeed * 2.0) + aSeed * 40.0);
      vSel = step(abs(aIndex - uSel), 0.5);
      float vHov = step(abs(aIndex - uHover), 0.5);
      float s = aSize * tw * (0.6 + 0.4 * aFocus) * (1.0 + vSel * 3.0 + vHov * 0.4);
      // Unselected stars use a tighter quad: their visible glow ends near the centre.
      gl_PointSize = clamp(s * uScale / -mv.z * mix(0.55, 1.0, vSel), 2.0, mix(24.0, 150.0, vSel));
      // focus 0 = hidden (time travel / filters), small values = dimmed
      vBright = step(0.02, aFocus) * (0.07 + 0.93 * aFocus) * (1.0 + vHov * 0.6) * mix(1.0, aHeat.a, uHeatMix);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform float uColorMix;
    varying float vBright, vSel;
    varying vec3 vCol;
    void main(){
      if (vBright <= 0.0) discard;
      vec2 uv = (gl_PointCoord - 0.5) * mix(0.55, 1.0, vSel);
      float d = length(uv);
      float k = 1.0 + vSel * 3.0;
      float core = exp(-d * d * 300.0 * k * k);
      float halo = exp(-d * 16.0 * k) * 0.2;
      float a = core * 1.9 + halo;
      if (vSel > 0.5) {
        float ang = atan(uv.y, uv.x);
        a += pow(abs(cos(ang * 3.0 + 0.3)), 140.0) * exp(-d * 6.0) * smoothstep(0.5, 0.25, d) * 1.2;
      }
      if (a < 0.004) discard;
      vec3 white = vec3(1.0, 0.98, 0.95);
      vec3 tint = mix(white, vCol, uColorMix);
      vec3 c = mix(tint, white, smoothstep(0.35, 1.6, core * 1.9) * 0.6) * a;
      gl_FragColor = vec4(c * vBright, 1.0);
    }`,
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
});
const ideaMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 1 }, uColorMix: { value: 0 }, uHeatMix: { value: 0 } },
  vertexShader: `attribute float aFocus; attribute vec3 aColor; attribute vec4 aHeat; uniform float uScale, uColorMix, uHeatMix; varying float vB; varying vec3 vC;
    void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=clamp(2.6*uScale/-mv.z,1.5,10.); vB=step(0.02,aFocus)*(0.05+0.5*aFocus)*mix(1.,aHeat.a,uHeatMix); vC=mix(vec3(1.),mix(aColor,aHeat.rgb,uHeatMix),uColorMix); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `varying float vB; varying vec3 vC; void main(){ if (vB<=0.) discard; float d=length(gl_PointCoord-.5); gl_FragColor=vec4(vC*vB*exp(-d*d*40.),1.); }`,
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
});
const linkMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uFade: { value: 0 } },
  vertexShader: `attribute float aT; varying float vT; void main(){ vT=aT; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform float uTime, uFade; varying float vT;
    void main(){ float p=fract(vT*1.2 - uTime*0.35); gl_FragColor=vec4(vec3(1.)*(0.32 + 0.5*smoothstep(0.88,1.,p))*uFade,1.); }`,
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
});
const linesMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });

let focusCur = null, focusTarget = null, ideaParent = null, ideaFocus = null, basePos = null;

// "Accretion heat": like the disc, what was touched recently burns white-hot and what is dormant
// cools to a dim red. t = 1 today … 0 after a year (log scale, so recent weeks are well separated).
const HEAT_STOPS = [[0, [0.5, 0.13, 0.08]], [0.3, [0.92, 0.36, 0.13]], [0.6, [1.0, 0.66, 0.32]], [0.85, [1.0, 0.9, 0.74]], [1, [0.9, 0.94, 1.0]]];
function heatOf(mtime, now = Date.now()) {
  const days = Math.max(0, (now - mtime) / DAY);
  const tt = Math.max(0, Math.min(1, 1 - Math.log1p(days) / Math.log1p(365)));
  let k = 1;
  while (k < HEAT_STOPS.length - 1 && tt > HEAT_STOPS[k][0]) k++;
  const [t0, c0] = HEAT_STOPS[k - 1], [t1, c1] = HEAT_STOPS[k];
  const f = (tt - t0) / (t1 - t0 || 1);
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f, 0.42 + 0.75 * tt];
}

function buildObjects() {
  const M = state.model;
  for (const o of [starPoints, ideaPoints, linesObj, linkObj]) if (o) { galaxy.remove(o); o.geometry.dispose(); }
  linkObj = null;
  const N = M.notes.length;
  const pos = new Float32Array(N * 3), size = new Float32Array(N), seed = new Float32Array(N), idx = new Float32Array(N), col = new Float32Array(N * 3), heat = new Float32Array(N * 4);
  focusCur = new Float32Array(N).fill(1);
  focusTarget = new Float32Array(N).fill(1);
  const now = Date.now();
  M.notes.forEach((n, i) => { n.pos.toArray(pos, i * 3); size[i] = n.size; seed[i] = n.seed; idx[i] = i; n.c.color.toArray(col, i * 3); n.heat = heatOf(n.mtime, now); heat.set(n.heat, i * 4); });
  basePos = pos.slice();
  arrivals.clear();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aHeat', new THREE.BufferAttribute(heat, 4));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  g.setAttribute('aIndex', new THREE.BufferAttribute(idx, 1));
  g.setAttribute('aFocus', new THREE.BufferAttribute(focusCur, 1));
  starPoints = new THREE.Points(g, starMat);
  starPoints.frustumCulled = false;
  galaxy.add(starPoints);

  // Ideas (headings of each note) as satellite stars.
  const ip = [], par = [], icol = [], iheat = [];
  const lp = [], lc = [];
  const seg = (a, b, k) => { lp.push(a.x, a.y, a.z, b.x, b.y, b.z); lc.push(k, k, k, k, k, k); };
  for (const n of M.notes) {
    const r = rng(n.seed * 4294967296);
    const k = Math.min(14, n.headings);
    for (let j = 0; j < k; j++) {
      const a = r() * Math.PI * 2, d = 6 + r() * 11;
      const p = n.pos.clone().add(new THREE.Vector3(Math.cos(a) * d, gauss(r) * 3, Math.sin(a) * d));
      ip.push(p.x, p.y, p.z);
      icol.push(n.c.color.r, n.c.color.g, n.c.color.b);
      iheat.push(...n.heat);
      par.push(n.index);
      seg(n.pos, p, 0.05);
    }
  }
  ideaParent = Int32Array.from(par);
  ideaFocus = new Float32Array(par.length).fill(1);
  const ig = new THREE.BufferGeometry();
  ig.setAttribute('position', new THREE.Float32BufferAttribute(ip, 3));
  ig.setAttribute('aFocus', new THREE.BufferAttribute(ideaFocus, 1));
  ig.setAttribute('aColor', new THREE.Float32BufferAttribute(icol, 3));
  ig.setAttribute('aHeat', new THREE.Float32BufferAttribute(iheat, 4));
  ideaPoints = new THREE.Points(ig, ideaMat);
  ideaPoints.frustumCulled = false;
  galaxy.add(ideaPoints);

  // Faint web: minimum spanning tree per group (Prim, O(n²) but capped) + real links.
  for (const cst of M.consts) {
    const ns = cst.notes.length > 1500 ? [...cst.notes].sort((a, b) => b.deg - a.deg).slice(0, 1500) : cst.notes;
    if (ns.length < 2) continue;
    const inTree = new Uint8Array(ns.length);
    inTree[0] = 1;
    const best = ns.map((n) => n.pos.distanceToSquared(ns[0].pos));
    const from = new Int32Array(ns.length);
    for (let added = 1; added < ns.length; added++) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < ns.length; i++) if (!inTree[i] && best[i] < bd) { bd = best[i]; bi = i; }
      inTree[bi] = 1;
      seg(ns[from[bi]].pos, ns[bi].pos, 0.09);
      for (let i = 0; i < ns.length; i++) if (!inTree[i]) {
        const d = ns[i].pos.distanceToSquared(ns[bi].pos);
        if (d < best[i]) { best[i] = d; from[i] = bi; }
      }
    }
  }
  for (const [a, b] of M.edges) if (a.c === b.c) seg(a.pos, b.pos, 0.1);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  linesObj = new THREE.LineSegments(lg, linesMat);
  linesObj.frustumCulled = false;
  galaxy.add(linesObj);
}

function buildLinkLines(set, center) {
  if (linkObj) { galaxy.remove(linkObj); linkObj.geometry.dispose(); linkObj = null; }
  if (!set || !center) return;
  const P = [], T = [];
  const add = (a, b) => {
    const S = 24;
    for (let i = 0; i < S; i++) {
      const p0 = a.pos.clone().lerp(b.pos, i / S), p1 = a.pos.clone().lerp(b.pos, (i + 1) / S);
      P.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
      T.push(i / S, (i + 1) / S);
    }
  };
  // Every link inside the neighbourhood (depth 1 = the note's own links).
  const done = new Set();
  for (const a of set) for (const b of a.out) if (set.has(b)) {
    const k = a.id < b.id ? a.id + b.id : b.id + a.id;
    if (!done.has(k) && (state.depth > 1 || a === center || b === center)) { done.add(k); add(a, b); }
  }
  if (!P.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(T, 1));
  linkObj = new THREE.LineSegments(g, linkMat);
  linkObj.frustumCulled = false;
  linkMat.uniforms.uFade.value = 0;
  galaxy.add(linkObj);
}

// ───────────────────────── labels ─────────────────────────
const labelsEl = $('#labels');
let constLabels = [], noteLabels = [];

function buildConstLabels() {
  constLabels.forEach((l) => l.el.remove());
  constLabels = state.model.consts.map((c) => {
    const el = document.createElement('button');
    el.className = 'clabel';
    el.innerHTML = `<b style="--gc:${c.css}"><i></i>${esc(c.label)}</b><small>${tn(c.notes.length, '{n} note', '{n} notes')} · ${tn(c.ideas, '{n} idea', '{n} ideas')}</small>`;
    el.addEventListener('click', () => focusConst(c));
    labelsEl.appendChild(el);
    return { el, c, w: 0, h: 0 };
  });
}
function setNoteLabels(list, selected) {
  noteLabels.forEach((l) => l.el.remove());
  list = [...list].sort((a, b) => (b === selected) - (a === selected) || b.deg - a.deg).slice(0, MAX_NOTE_LABELS);
  noteLabels = list.map((n) => {
    const el = document.createElement('div');
    el.className = 'nlabel' + (n === selected ? ' sel' : '');
    el.textContent = n.title;
    labelsEl.appendChild(el);
    return { el, n, w: 0 };
  });
}
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3();
function toScreen(w) {
  _v.copy(w).project(camera);
  return { x: (_v.x * 0.5 + 0.5) * innerWidth, y: (-_v.y * 0.5 + 0.5) * innerHeight, vis: _v.z < 1 && _v.z > -1 };
}
const worldOf = (local, out = new THREE.Vector3()) => galaxy.localToWorld(out.copy(local));
function behindHole(w) {
  const cam = camera.position;
  _d.copy(w).sub(cam);
  const L = _d.length();
  _d.divideScalar(L);
  const tt = -cam.dot(_d);
  if (tt <= 0 || tt >= L) return false;
  return _w.copy(cam).addScaledVector(_d, tt).length() < LENS_R * 0.75;
}
const place = (el, x, y) => { el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`; };
const lastCam = { p: new THREE.Vector3(), q: new THREE.Quaternion(), rot: 0, w: 0, h: 0, force: true };
function updateLabels() {
  // Skip the whole DOM pass when nothing moved (big win while idle with rotation paused).
  const moved = lastCam.force || !lastCam.p.equals(camera.position) || !lastCam.q.equals(camera.quaternion) || lastCam.rot !== galaxy.rotation.y || lastCam.w !== innerWidth || lastCam.h !== innerHeight;
  if (!moved) return;
  lastCam.p.copy(camera.position); lastCam.q.copy(camera.quaternion); lastCam.rot = galaxy.rotation.y; lastCam.w = innerWidth; lastCam.h = innerHeight; lastCam.force = false;

  document.body.classList.toggle('zoomed', camera.position.length() < 900);

  const sel = state.selected;
  for (const l of constLabels) {
    const { el, c } = l;
    const w = worldOf(c.center, _w);
    const s = toScreen(w);
    const d = camera.position.distanceTo(w);
    let o = s.vis && !behindHole(w) ? 1 : 0;
    if (state.focusedConst === c || (sel && sel.c === c)) o *= d < 300 ? 0 : 1;
    else if (state.focusedConst || sel) o *= 0.35;
    if (c.hidden) o = 0;
    el.style.opacity = o;
    el.style.pointerEvents = o > 0.2 ? 'auto' : 'none';
    el.tabIndex = o > 0.2 ? 0 : -1;
    if (!l.w) { l.w = el.offsetWidth; l.h = el.offsetHeight; }
    place(el, s.x - l.w / 2, s.y - l.h / 2);
  }
  const placed = [];
  for (const l of noteLabels) {
    const wp = worldOf(l.n.pos, _w);
    const s = toScreen(wp);
    const isSel = l.n === sel;
    const w = l.w || (l.w = l.el.offsetWidth || l.n.title.length * 6);
    const x = isSel ? s.x - w / 2 : s.x + 10;
    const y = isSel ? s.y - 46 : s.y - 8;
    const box = { x0: x - 4, x1: x + w + 4, y0: y - 4, y1: y + (isSel ? 28 : 16) };
    const visible = focusCur && focusCur[l.n.index] > 0.05;
    const free = visible && s.vis && !behindHole(wp) && !placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
    if (free) placed.push(box);
    l.el.style.opacity = free ? 1 : 0;
    place(l.el, x, y);
  }
}

// ───────────────────────── camera ─────────────────────────
// Camera targets are described by ids, not object refs, so they survive rebuilds.
let flight = null, follow = null, zoomGoal = null;
function targetPos(tg) {
  if (!tg || tg.type === 'origin') return new THREE.Vector3();
  if (tg.type === 'note') { const n = findById(tg.id); return n ? worldOf(n.pos) : null; }
  if (tg.type === 'const') { const c = state.model && state.model.consts.find((x) => x.key === tg.id); return c ? worldOf(c.center) : null; }
  if (tg.type === 'point') return tg.p.clone();
  return null;
}
function flyTo({ target, offset, dur = 2.2, follow: f = false }) {
  flight = { t: 0, dur: flightDur(dur), fromPos: camera.position.clone(), fromTgt: controls.target.clone(), target, offset, f };
  follow = null;
  zoomGoal = null;
  controls.enabled = false;
}
function stepFlight(dt) {
  if (!flight) return;
  flight.t = Math.min(1, flight.t + dt / flight.dur);
  const k = ease(flight.t);
  const tgt = targetPos(flight.target) || controls.target.clone();
  controls.target.lerpVectors(flight.fromTgt, tgt, k);
  camera.position.lerpVectors(flight.fromPos, tgt.clone().add(flight.offset), k);
  if (flight.t >= 1) {
    if (flight.f) follow = { target: flight.target, last: tgt };
    flight = null;
    controls.enabled = true;
  }
}
function stepFollow() {
  if (!follow) return;
  const p = targetPos(follow.target);
  if (!p) { follow = null; return; }
  const d = p.clone().sub(follow.last);
  if (d.lengthSq() > 250000) { follow.last = p; return; } // target jumped (rebuild): don't teleport
  camera.position.add(d);
  controls.target.add(d);
  follow.last = p;
}
function viewOffset(worldTarget, dist) {
  const dir = camera.position.clone().sub(worldTarget).normalize();
  if (dir.y < 0.75) { dir.y = 0.75; dir.normalize(); }
  return dir.multiplyScalar(dist);
}
// Smooth zoom: the wheel and +/− move a goal distance; every frame the camera glides a fraction of the way there,
// so fast scrolling piles up into one continuous, eased move instead of a jump per notch.
function zoom(f) {
  if (flight) return;
  const cur = zoomGoal != null ? zoomGoal : camera.position.distanceTo(controls.target);
  const min = Math.max(controls.minDistance, RS * 2.4 - controls.target.length());
  zoomGoal = THREE.MathUtils.clamp(cur * f, min, controls.maxDistance);
}
const _z = new THREE.Vector3();
function stepZoom(dt) {
  if (zoomGoal == null || flight) return;
  _z.copy(camera.position).sub(controls.target);
  const d = _z.length();
  const nd = still() ? zoomGoal : d + (zoomGoal - d) * (1 - Math.exp(-dt * 8));
  camera.position.copy(controls.target).addScaledVector(_z, nd / d);
  if (Math.abs(nd - zoomGoal) < zoomGoal * 0.002) zoomGoal = null;
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  hideGreet();
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  zoom(Math.exp(THREE.MathUtils.clamp(px, -300, 300) * 0.0011));
}, { passive: false });

// ───────────────────────── focus (what is bright, dim or hidden) ─────────────────────────
// One function decides every star's brightness from selection, group focus, filters and time travel.
let filterMatch = null;
let lastTlAt = null; // Set of notes matching the filter, or null when no filter is active
function filterActive() {
  const f = state.filter;
  return !!(f.query || f.tags.length || f.hidden.length || f.orphans || f.days);
}
function computeFilter() {
  const M = state.model;
  if (!M || !filterActive()) { filterMatch = null; return; }
  const f = state.filter;
  const qset = f.query ? new Set(search(M.notes, f.query, Infinity).all) : null;
  const since = f.days ? Date.now() - f.days * DAY : 0;
  filterMatch = new Set(M.notes.filter((n) =>
    (!qset || qset.has(n)) &&
    (!f.tags.length || f.tags.every((tg) => n.tags.some((x) => x === tg || x.startsWith(tg + '/')))) &&
    !f.hidden.includes(n.c.key) &&
    (!f.orphans || n.deg === 0) &&
    (!since || n.mtime >= since)));
}
function applyFocus() {
  const M = state.model;
  if (!M) return;
  const sel = state.selected, fc = state.focusedConst;
  const nb = sel ? neighbourhood(sel, state.depth) : null;
  const tl = state.timeline && state.timeline.on ? state.timeline.at : null;
  const created = state.stats && state.stats.created;
  const forward = tl != null && lastTlAt != null && tl > lastTlAt && motion() === 'full';
  lastTlAt = tl;
  M.notes.forEach((n, i) => {
    let f = 1;
    if (tl != null && created && created[i] > tl) f = 0;
    else if (filterMatch && !filterMatch.has(n)) f = state.filter.hidden.includes(n.c.key) ? 0 : 0.06;
    else if (nb) f = nb.has(n) ? 1 : n.c === sel.c ? 0.3 : 0.1;
    else if (fc) f = n.c === fc ? 1 : 0.15;
    if (forward && f > 0 && focusTarget[i] === 0 && !arrivals.has(i)) arrivals.set(i, time);
    focusTarget[i] = f;
  });
  if (tl == null) clearArrivals();
  // A group whose stars are all hidden (time travel, hidden groups) also hides its label.
  for (const c of M.consts) c.hidden = c.notes.every((n) => focusTarget[n.index] === 0);
  buildLinkLines(nb, sel);
  lastCam.force = true;
}
function updateBack() {
  const c = state.selected ? state.selected.c : state.focusedConst;
  $('#back').hidden = !c;
  $('#brand').hidden = !!c;
  if (c) { $('#back').textContent = '← ' + c.label; hideGreet(); }
}
function focusConst(c) {
  closePanel(false);
  state.focusedConst = c;
  state.selected = null;
  starMat.uniforms.uSel.value = -1;
  applyFocus();
  setNoteLabels(c.notes, null);
  updateBack();
  const tg = { type: 'const', id: c.key };
  flyTo({ target: tg, offset: viewOffset(targetPos(tg), c.radius * 4.2 + 160), dur: 1.5, follow: true });
}
async function selectNote(n, { fly = true } = {}) {
  state.selected = n;
  if (!state.focusedConst || state.focusedConst !== n.c) state.focusedConst = n.c;
  starMat.uniforms.uSel.value = n.index;
  applyFocus();
  const nb = neighbourhood(n, state.depth);
  setNoteLabels(state.depth > 1 ? nb : [n], n);
  updateBack();
  const rec = store.get('sbg.recent', []).filter((x) => x.id !== n.id);
  rec.unshift({ id: n.id, t: Date.now() });
  store.set('sbg.recent', rec.slice(0, 12));
  if (fly) {
    const tg = { type: 'note', id: n.id };
    flyTo({ target: tg, offset: viewOffset(targetPos(tg), state.depth > 1 ? 420 : 240), dur: 2.0, follow: true });
  }
  await openPanel(n);
}
function clearSelection() {
  state.selected = null;
  state.focusedConst = null;
  starMat.uniforms.uSel.value = -1;
  setNoteLabels([], null);
  applyFocus();
  updateBack();
}
function resetView() {
  closePanel(false);
  clearSelection();
  flyTo({ target: { type: 'origin' }, offset: DEFAULT_CAM.clone(), dur: 2.4 });
}
function flyToBlackHole() {
  closePanel(false);
  clearSelection();
  flyTo({ target: { type: 'origin' }, offset: bhView(), dur: 3.0 });
}
$('#back').addEventListener('click', () => {
  if (state.selected && state.focusedConst) focusConst(state.focusedConst);
  else resetView();
});

// ───────────────────────── note panel ─────────────────────────
const panel = $('#panel');
let panelOpener = null;
async function openPanel(n) {
  if (!panel.classList.contains('open')) panelOpener = document.activeElement;
  panel.classList.add('open');
  $('#crumb').textContent = `${n.vaultName} · ${n.c.label}`;
  $('#p-title').textContent = n.title;
  const meta = [t('Edited {when}', { when: ago(n.mtime) }), tn(n.words, '{n} word', '{n} words'), tn(Math.max(1, n.headings), '{n} idea', '{n} ideas')];
  if (n.tasksOpen + n.tasksDone) meta.push(t('{a}/{b} tasks', { a: n.tasksDone, b: n.tasksOpen + n.tasksDone }));
  $('#p-meta').innerHTML = meta.map((m) => `<span>${esc(m)}</span>`).join('');
  $('#p-insights').innerHTML = state.stats ? noteInsights(n, state.stats).map((x) => `<span>${esc(x)}</span>`).join('') : '';
  $('#p-tags').innerHTML = n.tags.slice(0, 14).map((tg) => `<button class="chip" data-tag="${esc(tg)}">#${esc(tg)}</button>`).join('');
  updatePinBtn();
  updateDepthSegs();
  const rows = (set) => [...set].sort((a, b) => b.deg - a.deg).map((x) => `<a data-id="${esc(x.id)}" tabindex="0" role="button">${esc(x.title)}<small>${esc(x.c.label)}</small></a>`).join('');
  let links = '';
  if (n.out.size) links += `<h4>${t('Links to · {n}', { n: n.out.size })}</h4>${rows(n.out)}`;
  if (n.inn.size) links += `<h4>${t('Mentioned in · {n}', { n: n.inn.size })}</h4>${rows(n.inn)}`;
  $('#p-links').innerHTML = links;
  $('#p-links').hidden = !links;
  const body = $('#p-body');
  body.innerHTML = '';
  const md = await window.brain.readNote(n.vaultPath, n.rel);
  if (state.selected !== n) return;
  body.innerHTML = md == null ? `<p class="muted">${t('Couldn’t read the note (was it moved or deleted?).')}</p>` : renderMd(md);
  body.scrollTop = 0;
  if (md != null) {
    enhanceBody(body, {
      resolve: (target) => state.model.resolve(n.vault, target),
      resolveAttachment: (target) => window.brain.resolveAttachment(n.vaultPath, n.rel, target),
      isCurrent: () => state.selected === n,
    });
  }
}
function closePanel(resetSel = true) {
  const wasOpen = panel.classList.contains('open');
  panel.classList.remove('open');
  if (resetSel && state.selected) {
    const c = state.selected.c;
    state.selected = null;
    starMat.uniforms.uSel.value = -1;
    if (state.focusedConst === c) setNoteLabels(c.notes, null);
    else { state.focusedConst = null; setNoteLabels([], null); }
    applyFocus();
    updateBack();
  }
  if (wasOpen && panelOpener && panelOpener.isConnected && panel.contains(document.activeElement)) panelOpener.focus();
}
function updatePinBtn() {
  const on = state.selected && state.pins.includes(state.selected.id);
  const b = $('#p-pin');
  b.classList.toggle('on', !!on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? t('Unpin (F)') : t('Pin (F)');
}
function togglePin() {
  const n = state.selected;
  if (!n) return;
  const on = state.pins.includes(n.id);
  state.pins = on ? state.pins.filter((x) => x !== n.id) : [n.id, ...state.pins].slice(0, 50);
  store.set('sbg.pins', state.pins);
  updatePinBtn();
  toast(on ? t('Unpinned') : t('Pinned to Home'));
}
function updateDepthSegs() {
  for (const b of document.querySelectorAll('#p-depth button')) {
    const d = b.dataset.d === 'all' ? Infinity : +b.dataset.d;
    b.classList.toggle('on', d === state.depth);
    b.setAttribute('aria-pressed', d === state.depth ? 'true' : 'false');
  }
}
function setDepth(d) {
  state.depth = d;
  store.set('sbg.depth', d === Infinity ? 0 : d);
  updateDepthSegs();
  if (state.selected) selectNote(state.selected, { fly: true });
}
$('#panel-close').addEventListener('click', () => closePanel());
$('#p-open').addEventListener('click', async () => {
  if (!state.selected) return;
  const ok = await window.brain.openInObsidian(state.selected.vaultPath, state.selected.rel);
  if (!ok) toast(t('Couldn’t open Obsidian. Is it installed?'), true);
});
$('#p-reveal').addEventListener('click', () => state.selected && window.brain.revealNote(state.selected.vaultPath, state.selected.rel));
$('#p-pin').addEventListener('click', togglePin);
$('#p-depth').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setDepth(b.dataset.d === 'all' ? Infinity : +b.dataset.d); });
$('#p-links').addEventListener('click', (e) => { const a = e.target.closest('[data-id]'); const n = a && findById(a.dataset.id); if (n) selectNote(n); });
$('#p-tags').addEventListener('click', (e) => { const tg = e.target.closest('[data-tag]'); if (tg) searchFor('#' + tg.dataset.tag); });
$('#p-body').addEventListener('click', (e) => {
  const tg = e.target.closest('[data-tag]');
  if (tg) { searchFor('#' + tg.dataset.tag); return; }
  const ext = e.target.closest('a[href]');
  if (ext) { e.preventDefault(); const h = ext.getAttribute('href'); if (/^https?:/i.test(h)) window.brain.openExternal(h); return; }
  const a = e.target.closest('a.wl');
  if (!a || !state.selected) return;
  e.preventDefault();
  const target = state.model.resolve(state.selected.vault, a.dataset.t);
  if (target) selectNote(target);
});

// ───────────────────────── canvas interaction ─────────────────────────
const tooltip = $('#tooltip');
const _p = new THREE.Vector3();
function pickNote(x, y) {
  if (!state.model) return null;
  let best = null, bd = 144; // 12px radius
  for (const n of state.model.notes) {
    if (focusCur[n.index] < 0.02) continue;
    const s = toScreen(worldOf(n.pos, _p));
    if (!s.vis) continue;
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bd && !behindHole(_p.copy(worldOf(n.pos, _p)))) { bd = d; best = n; }
  }
  return best;
}
function pickConst(x, y) {
  if (!state.model) return null;
  let best = null, bd = Infinity;
  const focal = innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  for (const c of state.model.consts) {
    const w = worldOf(c.center);
    const s = toScreen(w);
    if (!s.vis) continue;
    const pr = (c.radius * focal) / camera.position.distanceTo(w);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < pr && d < bd) { bd = d; best = c; }
  }
  return best;
}
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; hideGreet(); follow = null; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const quick = performance.now() - downAt.t < 450;
  downAt = null;
  if (moved > 5 || !quick || e.button !== 0) return;
  const n = pickNote(e.clientX, e.clientY);
  if (n) {
    if (e.ctrlKey || e.metaKey) window.brain.openInObsidian(n.vaultPath, n.rel);
    else selectNote(n);
    return;
  }
  const c = pickConst(e.clientX, e.clientY);
  if (c && state.focusedConst !== c) focusConst(c);
});
let hoverNote = null;
const hoverPick = (x, y) => {
  hoverNote = pickNote(x, y);
  if (hoverNote === state.selected) hoverNote = null;
  starMat.uniforms.uHover.value = hoverNote ? hoverNote.index : -1;
  canvas.classList.toggle('pointing', !!hoverNote);
  if (hoverNote) {
    const snip = hoverNote.text.slice(0, 160);
    tooltip.innerHTML = `<b>${esc(hoverNote.title)}</b><span>${esc(hoverNote.c.label)} · ${tn(hoverNote.deg, '{n} link', '{n} links')}</span>${snip ? `<p>${esc(snip)}</p>` : ''}`;
  }
  tooltip.style.opacity = hoverNote ? 1 : 0;
};
let pickPending = null;
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) { tooltip.style.opacity = 0; return; }
  // Picking is throttled to one per animation frame.
  if (!pickPending) requestAnimationFrame(() => { hoverPick(pickPending.x, pickPending.y); pickPending = null; });
  pickPending = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerleave', () => { tooltip.style.opacity = 0; hoverNote = null; starMat.uniforms.uHover.value = -1; });
function updateTooltip() {
  if (!hoverNote) return;
  const s = toScreen(worldOf(hoverNote.pos, _p));
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  const x = s.x - w - 14 < 8 ? s.x + 14 : s.x - w - 14;
  place(tooltip, x, Math.max(8, s.y - h - 6));
}

// ───────────────────────── dock ─────────────────────────
function setRotating(on) {
  state.rotating = on;
  store.set('sbg.rotating', on);
  // SVG elements have no .hidden property: toggle the attribute itself or the icon never changes.
  $('#ico-pause').toggleAttribute('hidden', !on);
  $('#ico-play').toggleAttribute('hidden', on);
  const b = $('#dock [data-a=pause]');
  b.setAttribute('aria-pressed', on ? 'false' : 'true');
  b.setAttribute('aria-label', on ? t('Pause rotation (R)') : t('Resume rotation (R)'));
  $('#s-rotate').checked = on;
}
const COLOR_MODES = ['white', 'group', 'heat'];
const colorModeLabel = (m) => ({ white: t('Colour: white'), group: t('Colour: by group'), heat: t('Colour: activity heat') }[m]);
function setColorMode(m) {
  if (!COLOR_MODES.includes(m)) m = 'group';
  state.colorMode = m;
  store.set('sbg.colorMode', m);
  document.body.classList.toggle('colored', m === 'group');
  document.body.classList.toggle('heat', m === 'heat');
  $('#s-colormode').value = m;
  const b = $('#dock [data-a=color]');
  b.classList.toggle('on', m !== 'white');
  b.dataset.mode = m;
  b.title = `${colorModeLabel(m)} (C)`;
  b.setAttribute('aria-label', colorModeLabel(m));
}
const cycleColorMode = () => {
  const m = COLOR_MODES[(COLOR_MODES.indexOf(state.colorMode) + 1) % COLOR_MODES.length];
  setColorMode(m);
  toast(colorModeLabel(m));
};
let colorMix = 0, heatMix = 0;

// ── accretion: during time travel, new notes spiral in from the outer disc ──
const arrivals = new Map(); // note index -> start time (s)
const ARRIVAL_S = 1.6;
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
function stepArrivals() {
  if (!arrivals.size || !starPoints) return;
  const attr = starPoints.geometry.attributes.position;
  const a = attr.array;
  for (const [i, t0] of arrivals) {
    const k = Math.min(1, (time - t0) / ARRIVAL_S);
    const bx = basePos[i * 3], by = basePos[i * 3 + 1], bz = basePos[i * 3 + 2];
    if (k >= 1) { a[i * 3] = bx; a[i * 3 + 1] = by; a[i * 3 + 2] = bz; arrivals.delete(i); continue; }
    const e = 1 - easeOut(k); // 1 → 0
    const r = Math.hypot(bx, bz) * (1 + 0.9 * e);
    const ang = Math.atan2(bz, bx) - 1.8 * e; // falls in along a spiral, following the disc's rotation
    a[i * 3] = Math.cos(ang) * r;
    a[i * 3 + 1] = by * (1 - e) + 40 * e * Math.sin(i);
    a[i * 3 + 2] = Math.sin(ang) * r;
  }
  attr.needsUpdate = true;
}
function clearArrivals() {
  if (!arrivals.size || !starPoints) return;
  starPoints.geometry.attributes.position.array.set(basePos);
  starPoints.geometry.attributes.position.needsUpdate = true;
  arrivals.clear();
}
function randomNote() {
  if (!state.model || !state.model.notes.length) return;
  const pool = state.model.notes.filter((n) => n !== state.selected && focusCur[n.index] > 0.05);
  const list = pool.length ? pool : state.model.notes;
  selectNote(list[Math.floor(Math.random() * list.length)]);
}
async function screenshot() {
  // Render once more and read the canvas in the same task (no preserveDrawingBuffer needed).
  composer.render();
  const url = renderer.domElement.toDataURL('image/png');
  const r = await window.brain.saveImage(url);
  if (r && r.ok) toast(t('Saved: {p}', { p: r.path }));
  else if (r && !r.canceled) toast(t('Couldn’t save the image.'), true);
}
$('#dock').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const a = b.dataset.a;
  if (a === 'in') zoom(0.72);
  else if (a === 'out') zoom(1.38);
  else if (a === 'reset') resetView();
  else if (a === 'pause') setRotating(!state.rotating);
  else if (a === 'full') window.brain.toggleFullscreen();
  else if (a === 'random') randomNote();
  else if (a === 'color') cycleColorMode();
  else if (a === 'time') toggleTimeline();
  else if (a === 'shot') screenshot();
  else if (a === 'help') openSheet('help');
});

// ───────────────────────── time travel ─────────────────────────
let tlPlay = null;
function toggleTimeline(force) {
  const on = force != null ? force : !(state.timeline && state.timeline.on);
  const el = $('#timeline');
  if (!on || !state.stats || !state.stats.N) {
    state.timeline = null;
    el.hidden = true;
    stopPlay();
    $('#dock [data-a=time]').classList.remove('on');
    applyFocus();
    return;
  }
  const created = state.stats.created;
  const min = created.reduce((a, b) => Math.min(a, b), Date.now()), max = Date.now();
  state.timeline = { on: true, at: max, min, max };
  const r = $('#tl-range');
  r.min = 0; r.max = 1000; r.value = 1000;
  el.hidden = false;
  $('#dock [data-a=time]').classList.add('on');
  updateTimeline();
  r.focus();
}
function updateTimeline() {
  const tl = state.timeline;
  if (!tl) return;
  const k = +$('#tl-range').value / 1000;
  tl.at = tl.min + (tl.max - tl.min) * k;
  const count = state.stats.created.filter((c) => c <= tl.at).length;
  $('#tl-out').textContent = `${fdate(tl.at, { day: 'numeric', month: 'short', year: 'numeric' })} · ${fmt(count)}`;
  applyFocus();
}
function stopPlay() { clearInterval(tlPlay); tlPlay = null; $('#tl-play').textContent = '▶'; $('#tl-play').setAttribute('aria-label', t('Play')); }
$('#tl-range').addEventListener('input', () => { stopPlay(); updateTimeline(); });
$('#tl-play').addEventListener('click', () => {
  if (tlPlay) { stopPlay(); return; }
  const r = $('#tl-range');
  if (+r.value >= 1000) r.value = 0;
  $('#tl-play').textContent = '❚❚';
  $('#tl-play').setAttribute('aria-label', t('Pause'));
  tlPlay = setInterval(() => {
    r.value = Math.min(1000, +r.value + 3);
    updateTimeline();
    if (+r.value >= 1000) stopPlay();
  }, 33);
});
$('#tl-close').addEventListener('click', () => toggleTimeline(false));

// ───────────────────────── chip bar (active filter / search highlight) ─────────────────────────
function renderChipbar() {
  const bar = $('#chipbar');
  if (!filterActive() || !filterMatch) { bar.innerHTML = ''; return; }
  const f = state.filter;
  const parts = [];
  if (f.query) parts.push(`“${esc(f.query)}”`);
  f.tags.forEach((tg) => parts.push('#' + esc(tg)));
  if (f.orphans) parts.push(t('orphans'));
  if (f.days) parts.push(t('last {n} days', { n: f.days }));
  if (f.hidden.length) parts.push(tn(f.hidden.length, '{n} group hidden', '{n} groups hidden'));
  bar.innerHTML = `<button class="pill on" data-act="filters" title="${t('Edit filters')}">${parts.join(' · ')} · ${tn(filterMatch.size, '{n} note', '{n} notes')}</button>
    <button class="pill" data-act="clear" aria-label="${t('Clear filters')}">${t('Clear')} <kbd>Esc</kbd></button>`;
}
$('#chipbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'clear') clearFilters();
  else openModal('filters');
});
function setFilter(patch) {
  Object.assign(state.filter, patch);
  computeFilter();
  applyFocus();
  renderChipbar();
}
function clearFilters() {
  state.filter = { query: '', tags: [], hidden: [], orphans: false, days: 0 };
  setFilter({});
  if (modal.classList.contains('open') && modalMode === 'filters') renderModal();
}

// ───────────────────────── modal: Home / Statistics / Pages / Filters ─────────────────────────
const modal = $('#modal'), q = $('#q'), mBody = $('#m-body');
let modalMode = 'home', hits = [], hitIdx = 0, modalOpener = null;
const MODES = ['home', 'stats', 'pages', 'filters'];
function openModal(mode, focusSearch = false) {
  if (!state.data.length) return;
  if (!modal.classList.contains('open')) modalOpener = document.activeElement;
  modalMode = MODES.includes(mode) ? mode : 'home';
  hideGreet();
  closeSheets();
  modal.classList.add('open');
  for (const b of document.querySelectorAll('#m-tabs button')) b.setAttribute('aria-selected', b.dataset.mode === modalMode ? 'true' : 'false');
  $('#m-date').textContent = fdate(Date.now(), { day: 'numeric', month: 'short', year: 'numeric' });
  if (!focusSearch) { q.value = ''; $('#q-clear').hidden = true; }
  renderSwitch();
  renderModal();
  setTimeout(() => (focusSearch ? q.focus() : $('#m-tabs [aria-selected=true]').focus()), 0);
}
function closeModal() {
  if (!modal.classList.contains('open')) return;
  modal.classList.remove('open');
  q.blur();
  if (modalOpener && modalOpener.isConnected) modalOpener.focus();
}
function searchFor(text) {
  if (!modal.classList.contains('open')) openModal('home', true);
  q.value = text;
  $('#q-clear').hidden = !text;
  renderModal();
  q.focus();
}
$('#m-close').addEventListener('click', closeModal);
modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
$('#m-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openModal(b.dataset.mode); });
$('#home-btn').addEventListener('click', () => openModal('home'));
$('#pages-btn').addEventListener('click', () => openModal('pages'));
$('#search-btn').addEventListener('click', () => openModal('home', true));
$('#q-clear').addEventListener('click', () => { q.value = ''; $('#q-clear').hidden = true; renderModal(); q.focus(); });
const renderDebounced = debounce(() => renderModal(), 80);
q.addEventListener('input', () => { $('#q-clear').hidden = !q.value; renderDebounced(); });
q.addEventListener('keydown', (e) => {
  if (hits.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    hitIdx = (hitIdx + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
    [...mBody.querySelectorAll('.h')].forEach((el, i) => { el.classList.toggle('on', i === hitIdx); el.setAttribute('aria-selected', i === hitIdx ? 'true' : 'false'); if (i === hitIdx) el.scrollIntoView({ block: 'nearest' }); });
  } else if (e.key === 'Enter' && e.shiftKey && q.value.trim()) {
    // Shift+Enter: highlight every result on the map
    setFilter({ query: q.value.trim() });
    closeModal();
  } else if (e.key === 'Enter' && hits[hitIdx]) { const n = hits[hitIdx]; closeModal(); selectNote(n); }
  else if (e.key === 'Escape') { e.preventDefault(); if (q.value) { q.value = ''; $('#q-clear').hidden = true; renderModal(); } else closeModal(); }
  e.stopPropagation();
});
function activate(el) {
  const ds = el.dataset;
  if (ds.mode === 'orphans') { closeModal(); setFilter({ orphans: true }); return; }
  if (ds.mode) { openModal(ds.mode); return; }
  if (ds.q) { searchFor(ds.q); return; }
  if (ds.hl) { setFilter({ query: q.value.trim() }); closeModal(); return; }
  closeModal();
  if (ds.id) { const n = findById(ds.id); if (n) selectNote(n); }
  else if (ds.c) { const c = state.model.consts.find((x) => x.key === ds.c); if (c) focusConst(c); }
}
mBody.addEventListener('click', (e) => {
  const tgl = e.target.closest('[data-ftag],[data-fgroup],[data-fdays],[data-forph],[data-fclear]');
  if (tgl) { filterClick(tgl); return; }
  const el = e.target.closest('[data-id],[data-c],[data-q],[data-mode],[data-hl]');
  if (el) activate(el);
});
// Keyboard activation for every clickable row (Enter / Space).
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role=button][tabindex]:not(button)')) {
    e.preventDefault();
    e.target.click();
  }
});

function renderSwitch() {
  const act = activeVaults();
  let html = '';
  if (state.data.length > 1) {
    html += state.data.map((v, i) => `<button class="seg ${act.length === 1 && act[0] === i ? 'on' : ''}" data-v="${i}">${esc(v.name)}</button>`).join('');
    html += `<button class="seg ${act.length === state.data.length ? 'on' : ''}" data-v="all">${t('All')}</button>`;
  }
  html += `<span class="seg-label sr-only">${t('Group by')}</span><button class="seg sep ${state.groupBy === 'folder' ? 'on' : ''}" data-g="folder" aria-pressed="${state.groupBy === 'folder'}">${t('Folder')}</button><button class="seg ${state.groupBy === 'tag' ? 'on' : ''}" data-g="tag" aria-pressed="${state.groupBy === 'tag'}">${t('Tag')}</button>`;
  $('#m-switch').innerHTML = html;
}
$('#m-switch').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.g) { state.groupBy = b.dataset.g; store.set('sbg.group', state.groupBy); state.filter.hidden = []; rebuild(true); }
  else if (b.dataset.v) {
    state.selPaths = b.dataset.v === 'all' ? null : [state.data[+b.dataset.v].path];
    store.set('sbg.selPaths', state.selPaths);
    rebuild(true);
  }
  renderSwitch();
  renderModal();
});

function snippet(text, query) {
  if (!query) return esc(text.slice(0, 180)) + (text.length > 180 ? '…' : '');
  // Accent-insensitive match that keeps the original text.
  const flat = [], map = [];
  for (let i = 0; i < text.length && flat.length < 6000; i++) {
    const c = text[i].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const ch of c) { flat.push(ch); map.push(i); }
  }
  const at = flat.join('').indexOf(query);
  if (at < 0) return esc(text.slice(0, 180)) + (text.length > 180 ? '…' : '');
  const s = map[at], e = map[Math.min(at + query.length - 1, map.length - 1)] + 1;
  const a = Math.max(0, s - 70), b = Math.min(text.length, e + 140);
  return (a > 0 ? '…' : '') + esc(text.slice(a, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>' + esc(text.slice(e, b)) + (b < text.length ? '…' : '');
}
function renderModal() {
  if (!state.model) return;
  const raw = q.value.trim();
  if (raw) {
    const r = search(state.model.notes, raw);
    hits = r.hits;
    hitIdx = 0;
    const tagLine = (n) => (n.tags.length ? ' · <span class="tg">' + n.tags.slice(0, 3).map((x) => '#' + esc(x)).join(' ') + '</span>' : '');
    mBody.innerHTML = hits.length
      ? `<div class="hits-head"><span>${tn(r.all.length, '{n} result', '{n} results')}</span><button class="btn ghost" data-hl="1">${t('Highlight on map')} <kbd>Shift</kbd><kbd>Enter</kbd></button></div>
        <div class="hits" role="listbox" aria-label="${t('Results')}">${hits.map((n, i) => `<div class="h ${i === 0 ? 'on' : ''}" role="option" aria-selected="${i === 0}" tabindex="-1" data-id="${esc(n.id)}"><b style="--gc:${n.c.css}"><i></i>${esc(n.title)}</b><span>${esc(n.vaultName)} · ${esc(n.c.label)}${tagLine(n)}</span><p>${snippet(n.text, r.words[0] || '')}</p></div>`).join('')}</div>`
      : `<p class="muted">${t('Nothing matches “{q}”.', { q: esc(raw) })}</p>`;
    return;
  }
  hits = [];
  if (modalMode === 'stats') mBody.innerHTML = renderStatsHtml(state.stats);
  else if (modalMode === 'pages') mBody.innerHTML = pagesList();
  else if (modalMode === 'filters') mBody.innerHTML = filtersHtml();
  else mBody.innerHTML = homeHtml();
}
function pagesList() {
  return `<div class="pages">${state.model.consts.map((c) => `
    <h4><a data-c="${esc(c.key)}" tabindex="0" role="button">${esc(c.label)}</a><span>${tn(c.notes.length, '{n} note', '{n} notes')} · ${tn(c.ideas, '{n} idea', '{n} ideas')}</span></h4>
    <div class="pl">${[...c.notes].sort((a, b) => a.title.localeCompare(b.title)).map((n) => `<a data-id="${esc(n.id)}" tabindex="0" role="button" style="--gc:${c.css}"><i></i>${esc(n.title)}</a>`).join('')}</div>`).join('')}</div>`;
}
function homeHtml() {
  const recent = store.get('sbg.recent', []).map((r) => ({ n: findById(r.id), t: r.t })).filter((x) => x.n).slice(0, 4);
  const recentHtml = recent.map(({ n, t: when }) => `<div class="item" data-id="${esc(n.id)}" tabindex="0" role="button"><b>${esc(n.title)}</b><span>${t('Opened {when}', { when: ago(when) })} · ${esc(n.c.label)}</span></div>`).join('');
  const editedHtml = [...state.model.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 4)
    .map((n) => `<div class="item" data-id="${esc(n.id)}" tabindex="0" role="button"><b>${esc(n.title)}</b><span>${t('Edited {when}', { when: ago(n.mtime) })} · ${esc(n.c.label)}</span></div>`).join('');
  const pins = state.pins.map(findById).filter(Boolean);
  const pinsHtml = pins.length ? `<div class="chips">${pins.map((n) => `<button class="chip" data-id="${esc(n.id)}">★ ${esc(n.title)}</button>`).join('')}</div>` : '';
  return renderHomeHtml(state.stats, { recentHtml, editedHtml, pinsHtml });
}
function filtersHtml() {
  const f = state.filter, S = state.stats;
  const tags = S.tags.all.slice(0, 40).map((x) => `<button class="chip ${f.tags.includes(x.t) ? 'on' : ''}" data-ftag="${esc(x.t)}" aria-pressed="${f.tags.includes(x.t)}">#${esc(x.t)} <small>${fmt(x.v)}</small></button>`).join('');
  const groups = state.model.consts.map((c) => `<div class="legend-row ${f.hidden.includes(c.key) ? 'off' : ''}" data-fgroup="${esc(c.key)}" tabindex="0" role="button" aria-pressed="${!f.hidden.includes(c.key)}"><span style="--gc:${c.css}"><i></i>${esc(c.label)}</span><span>${fmt(c.notes.length)}</span></div>`).join('');
  const days = [[0, t('Any time')], [7, t('7 days')], [30, t('30 days')], [90, t('90 days')], [365, t('1 year')]]
    .map(([d, l]) => `<button class="seg ${f.days === d ? 'on' : ''}" data-fdays="${d}" aria-pressed="${f.days === d}">${l}</button>`).join('');
  const count = filterMatch ? filterMatch.size : state.model.notes.length;
  return `<p class="hint">${t('Notes that don’t match are dimmed on the map. Hidden groups disappear.')} <b>${tn(count, '{n} note matches', '{n} notes match')}</b>.</p>
    <div class="fgrid">
      <section class="box"><div class="cap">${t('Tags')}</div>${tags ? `<div class="chips">${tags}</div>` : `<p class="muted">${t('No note has tags yet.')}</p>`}</section>
      <section class="box"><div class="cap">${t('Groups (legend)')}</div>${groups}</section>
    </div>
    <div class="grid2">
      <section class="box"><div class="cap">${t('Edited in the last…')}</div><div class="chips">${days}</div></section>
      <section class="box"><div class="cap">${t('Connections')}</div><label class="toggle"><input type="checkbox" data-forph="1" ${f.orphans ? 'checked' : ''}><span></span>${t('Only orphans ({n})', { n: fmt(S.network.orphans) })}</label></section>
    </div>
    ${filterActive() ? `<button class="btn wide" data-fclear="1">${t('Clear filters')}</button>` : ''}`;
}
function filterClick(el) {
  const f = state.filter;
  if (el.dataset.ftag) { const tg = el.dataset.ftag; setFilter({ tags: f.tags.includes(tg) ? f.tags.filter((x) => x !== tg) : [...f.tags, tg] }); }
  else if (el.dataset.fgroup) { const k = el.dataset.fgroup; setFilter({ hidden: f.hidden.includes(k) ? f.hidden.filter((x) => x !== k) : [...f.hidden, k] }); }
  else if (el.dataset.fdays != null) setFilter({ days: +el.dataset.fdays });
  else if (el.dataset.forph) setFilter({ orphans: el.checked });
  else if (el.dataset.fclear) { clearFilters(); return; }
  const y = mBody.scrollTop;
  renderModal();
  mBody.scrollTop = y;
}

// ───────────────────────── greeting ─────────────────────────
// The greeting types itself out line by line, at an even pace, like someone writing it.
let greetTimers = [];
const greetLater = (fn, ms) => greetTimers.push(setTimeout(fn, ms));
function typeLines(lines, done) {
  let li = 0, ci = 0;
  const tick = () => {
    const L = lines[li];
    if (!L) { done(); return; }
    ci++;
    L.el.textContent = L.text.slice(0, ci);
    L.el.classList.add('typing');
    if (ci < L.text.length) { greetLater(tick, L.ms * (/[.,;:·]/.test(L.text[ci - 1]) ? 6 : 1)); return; }
    li++; ci = 0;
    greetLater(() => { L.el.classList.remove('typing'); tick(); }, L.after);
  };
  tick();
}
function showGreet({ instant = false } = {}) {
  greetTimers.forEach(clearTimeout);
  greetTimers = [];
  const h = new Date().getHours();
  const hello = h < 12 ? t('Good morning') : h < 20 ? t('Good afternoon') : t('Good evening');
  const title = state.profile.name ? `${hello}, ${state.profile.name}.` : `${hello}.`;
  const last = store.get('sbg.lastVisit', 0);
  const changed = last ? state.model.notes.filter((n) => n.mtime > last).length : 0;
  const since = last ? t('Since your last visit · {when}', { when: ago(last) }) : t('First visit');
  const msg = !last
    ? t('Every star is one of your notes; every group, a region of the galaxy. Press ? for shortcuts.')
    : changed ? tn(changed, '{n} note changed while you were away.', '{n} notes changed while you were away.')
      : t('Nothing changed while you were away; the map is as you left it.');
  store.set('sbg.lastVisit', Date.now());
  $('#g-sr').textContent = `${title} ${since}. ${msg}`; // screen readers get it once, not letter by letter
  const lines = [
    { el: $('#g-title'), text: title, ms: 62, after: 420 },
    { el: $('#g-since'), text: since, ms: 24, after: 300 },
    { el: $('#g-msg'), text: msg, ms: 20, after: 1400 },
  ];
  const finish = () => {
    greetLater(hideGreet, 9000);
    const hint = $('#hintbar');
    hint.classList.remove('out');
    greetLater(() => hint.classList.add('out'), 7000);
  };
  if (instant || still()) { for (const L of lines) L.el.textContent = L.text; finish(); return; }
  for (const L of lines) L.el.textContent = '';
  greetLater(() => typeLines(lines, finish), 700);
}
function hideGreet() { $('#greet').classList.add('out'); }

// ───────────────────────── keyboard ─────────────────────────
const openSheetEl = () => document.querySelector('.scrim.open');
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const hasData = state.data.length > 0;
  if ((e.ctrlKey || e.metaKey) && (k === 'k' || k === 'f' || k === 'p')) {
    e.preventDefault();
    if (!hasData) return;
    closeSheets();
    if (modal.classList.contains('open')) { q.select(); q.focus(); } else openModal(k === 'p' ? 'pages' : 'home', k !== 'p');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === ',') { e.preventDefault(); closeModal(); openSheet('settings'); return; }
  const sheet = openSheetEl();
  if (sheet) {
    if (e.key === 'Escape') { if (sheet === modal) closeModal(); else closeSheets(); }
    else if (e.key === 'Tab') trapFocus(e, sheet);
    return;
  }
  if (e.target.closest && e.target.closest('input, textarea, select')) {
    if (e.key === 'Escape' && e.target.id === 'tl-range') toggleTimeline(false);
    return;
  }
  if (!hasData || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === ' ') {
    if (e.defaultPrevented || e.repeat) return;
    if (e.target.closest && e.target.closest('button, a, [role=button]')) return; // Space still presses a focused button
    e.preventDefault();
    openModal('home');
    return;
  }
  if (e.key === '/') { e.preventDefault(); openModal('home', true); }
  else if (e.key === '?') openSheet('help');
  else if (e.key === 'Escape') {
    if (state.timeline) toggleTimeline(false);
    else if (state.selected) closePanel();
    else if (filterActive()) clearFilters();
    else resetView();
  } else if (e.key === 'Home') resetView();
  else if (k === 'b') flyToBlackHole();
  else if (k === 'r') setRotating(!state.rotating);
  else if (k === 'c') cycleColorMode();
  else if (k === 'a') randomNote();
  else if (k === 'p') openModal('pages');
  else if (k === 's') screenshot();
  else if (k === 't') toggleTimeline();
  else if (k === 'f') { if (state.selected) togglePin(); else openModal('filters'); }
  else if (k === 'h') document.body.classList.toggle('cine');
  else if (state.selected && (k === '1' || k === '2' || k === '0')) setDepth(k === '0' ? Infinity : +k);
  else if (k === '+' || k === '=') zoom(0.72);
  else if (k === '-') zoom(1.38);
});
// Toolbar buttons clicked with the mouse let go of focus, so Space means "Home" again instead of re-pressing them.
// (Time travel keeps it: there Space plays and pauses.)
document.addEventListener('click', (e) => {
  const b = e.detail > 0 && e.target.closest && e.target.closest('#dock button, #top-right button, #home-btn, #back');
  if (b) b.blur();
});
function trapFocus(e, root) {
  const f = [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

// ───────────────────────── toasts ─────────────────────────
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, err ? 5200 : 3200);
}

// ───────────────────────── sheets: settings / help ─────────────────────────
let sheetOpener = null;
function openSheet(id) {
  closeSheets();
  closeModal();
  hideGreet();
  sheetOpener = document.activeElement;
  $('#' + id).classList.add('open');
  if (id === 'settings') renderSettings();
  setTimeout(() => { const f = $('#' + id).querySelector('input, select, button:not([data-close])'); if (f) f.focus(); }, 0);
}
function closeSheets() {
  let was = false;
  document.querySelectorAll('#settings, #help').forEach((s) => { if (s.classList.contains('open')) was = true; s.classList.remove('open'); });
  if (was && sheetOpener && sheetOpener.isConnected) sheetOpener.focus();
}
for (const s of document.querySelectorAll('#settings, #help')) {
  s.addEventListener('mousedown', (e) => { if (e.target === s) closeSheets(); });
  s.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheets(); });
}
$('#settings-btn').addEventListener('click', () => openSheet('settings'));

const fmtCount = (n) => (n >= 5000 ? t('5,000+ notes') : tn(n, '{n} note', '{n} notes'));
function vaultRow(v, { suggestion = false } = {}) {
  const status = !v.exists ? t('Folder not found') : fmtCount(v.notes) + (v.obsidian ? '' : ' · ' + t('no .obsidian'));
  const actions = suggestion
    ? `<button class="btn primary" data-act="add">${t('Add')}</button>`
    : `${v.exists ? `<button class="btn ghost" data-act="open" title="${t('Open folder')}">${t('Open')}</button>` : ''}<button class="btn ghost" data-act="remove">${t('Remove')}</button>`;
  return `<div class="vault ${v.exists ? '' : 'missing'} ${suggestion ? 'sugg' : ''}" data-path="${esc(v.path)}">
    <div class="vi" aria-hidden="true"></div><div class="vt"><b>${esc(v.name)}</b><span title="${esc(v.path)}">${esc(status)} · ${esc(v.path)}</span></div>${actions}</div>`;
}
async function renderSettings() {
  $('#s-name').value = state.profile.name;
  $('#s-colormode').value = state.colorMode;
  $('#s-rotate').checked = state.rotating;
  $('#s-fps').checked = state.showFps;
  $('#s-quality').value = state.quality;
  $('#s-motion').value = motionPref;
  $('#s-lang').innerHTML = LANGS.map(([v, l]) => `<option value="${v}" ${state.profile.lang === v ? 'selected' : ''}>${v === 'auto' ? t('Automatic') : l}</option>`).join('');
  $('#s-ignore').value = (state.profile.ignore || []).join('\n');
  const [vaults, detected] = await Promise.all([window.brain.vaults(), window.brain.detectVaults()]);
  $('#s-vaults').innerHTML = vaults.length ? vaults.map((v) => vaultRow(v)).join('') : `<p class="muted">${t('No vaults yet.')}</p>`;
  const useful = detected.filter((v) => v.notes > 0);
  $('#s-detected').innerHTML = useful.length ? `<div class="sugg-cap">${t('Found in Obsidian')}</div><div class="vlist">` + useful.map((v) => vaultRow(v, { suggestion: true })).join('') + '</div>' : '';
}
async function vaultAction(e) {
  const b = e.target.closest('[data-act]') || (e.target.closest('.vault.sugg') && { dataset: { act: 'add' } });
  const row = e.target.closest('.vault');
  if (!b || !row) return;
  const p = row.dataset.path;
  const act = b.dataset.act;
  if (act === 'open') window.brain.openFolder(p);
  else if (act === 'add') await addVaultFlow(p);
  else if (act === 'remove') {
    // Two-step confirmation inside the app (no blocking dialogs).
    if (!b.classList.contains('danger')) {
      b.classList.add('danger');
      b.textContent = t('Remove?');
      setTimeout(() => { if (b.isConnected) { b.classList.remove('danger'); b.textContent = t('Remove'); } }, 3500);
      return;
    }
    await window.brain.removeVault(p);
    toast(t('“{name}” was removed from the map (nothing was deleted on disk).', { name: row.querySelector('b').textContent }));
    state.selPaths = null;
    store.set('sbg.selPaths', null);
    await reload(true);
    if ($('#settings').classList.contains('open')) renderSettings();
  }
}
$('#s-vaults').addEventListener('click', vaultAction);
$('#s-detected').addEventListener('click', vaultAction);
$('#w-detected').addEventListener('click', vaultAction);
$('#s-add').addEventListener('click', () => addVaultFlow());
$('#w-pick').addEventListener('click', () => addVaultFlow());
$('#w-demo').addEventListener('click', async () => {
  const r = await window.brain.addDemo();
  if (r && r.ok) { await reload(true); intro(); toast(t('Sample vault added. Remove it any time in Settings.')); }
});
async function saveName() {
  const r = await window.brain.setName($('#s-name').value);
  state.profile.name = r.name;
  $('#s-name').value = r.name;
  toast(t('Name saved.'));
}
$('#s-name-save').addEventListener('click', saveName);
$('#s-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); e.stopPropagation(); });
$('#s-colormode').addEventListener('change', (e) => setColorMode(e.target.value));
$('#s-rotate').addEventListener('change', (e) => setRotating(e.target.checked));
$('#s-fps').addEventListener('change', (e) => { state.showFps = e.target.checked; store.set('sbg.fps', state.showFps); updateSub(); });
$('#s-quality').addEventListener('change', (e) => { state.quality = e.target.value; store.set('sbg.quality', state.quality); applyQualityPreset(); });
function applyMotion() { document.body.classList.toggle('still', still()); }
$('#s-motion').addEventListener('change', (e) => { motionPref = e.target.value; store.set('sbg.motion', motionPref); applyMotion(); });
reducedMotion.addEventListener('change', applyMotion);
applyMotion();
$('#s-lang').addEventListener('change', async (e) => { const r = await window.brain.setLang(e.target.value); state.profile.lang = r.lang; switchLang(); });
$('#w-lang').addEventListener('change', async (e) => { const r = await window.brain.setLang(e.target.value); state.profile.lang = r.lang; switchLang(); renderWelcome(); });
$('#s-ignore-save').addEventListener('click', async () => {
  const list = $('#s-ignore').value.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
  state.profile.ignore = await window.brain.setIgnore(list);
  toast(t('Ignore list saved. Re-reading vaults…'));
  await reload(false);
});
function switchLang() {
  setLang(resolveLang(state.profile.lang));
  applyI18n();
  setRotating(state.rotating);
  setColorMode(state.colorMode);
  if (state.model) { buildConstLabels(); lastCam.force = true; }
  updateSub();
  renderChipbar();
  if ($('#settings').classList.contains('open')) renderSettings();
  if (modal.classList.contains('open')) { renderSwitch(); renderModal(); }
  if (state.selected) openPanel(state.selected);
}

let adding = false;
const ADD_ERRORS = { 'not-dir': 'That path is not a folder.', 'no-notes': 'That folder has no .md notes and is not an Obsidian vault.' };
async function addVaultFlow(p) {
  if (adding) return;
  adding = true;
  try {
    const r = await window.brain.addVault(p);
    if (r.canceled) return;
    if (!r.ok) { toast(t(ADD_ERRORS[r.error] || 'Couldn’t add that folder.'), true); return; }
    if (r.already) { toast(t('That vault is already on the map.')); return; }
    const first = !state.data.length;
    state.selPaths = null;
    store.set('sbg.selPaths', null);
    closeSheets();
    closeModal();
    await reload(true);
    const v = state.data.find((x) => x.path === r.path);
    toast(v ? t('“{name}” added · {n}', { name: v.name, n: tn(v.notes.length, '{n} note', '{n} notes') }) : t('Vault added.'));
    if (first) intro();
  } finally { adding = false; }
}

// ───────────────────────── welcome (no vaults) ─────────────────────────
async function renderWelcome() {
  $('#w-lang').innerHTML = LANGS.map(([v, l]) => `<option value="${v}" ${state.profile.lang === v ? 'selected' : ''}>${v === 'auto' ? t('Automatic') : l}</option>`).join('');
  const [vaults, detected] = await Promise.all([window.brain.vaults(), window.brain.detectVaults()]);
  const usable = detected.filter((v) => v.notes > 0);
  $('#w-detected').innerHTML = usable.length ? `<div class="sugg-cap">${t('Vaults found in Obsidian')}</div>` + usable.map((v) => vaultRow(v, { suggestion: true })).join('') : '';
  $('#w-pick').textContent = usable.length ? t('Choose another folder…') : t('Choose a folder…');
  $('#w-pick').classList.toggle('primary', !usable.length);
  const missing = vaults.filter((v) => !v.exists);
  $('#w-missing').hidden = !missing.length;
  $('#w-missing').innerHTML = missing.length ? `<div class="sugg-cap">${t('No longer found (moved or deleted?)')}</div>` + missing.map((v) => vaultRow(v)).join('') : '';
  setTimeout(() => (usable.length ? $('#w-detected .vault .btn') : $('#w-pick'))?.focus(), 50);
}
$('#w-missing').addEventListener('click', async (e) => { await vaultAction(e); if (!state.data.length) renderWelcome(); });

// ───────────────────────── drag & drop folders ─────────────────────────
let dragDepth = 0;
const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  for (const f of e.dataTransfer.files) {
    const p = window.brain.pathForFile(f);
    if (p) await addVaultFlow(p);
  }
});

// ───────────────────────── load & rebuild ─────────────────────────
function rebuild(resetCam) {
  const keepSel = state.selected && state.selected.id;
  const keepConst = state.focusedConst && state.focusedConst.key;
  const raw = buildModel(state.data, { active: activeVaults(), groupBy: state.groupBy, untaggedLabel: t('untagged') });
  // Convert plain positions/colours into three.js objects once.
  for (const c of raw.consts) {
    c.center = new THREE.Vector3(c.center.x, c.center.y, c.center.z);
    c.color = new THREE.Color().setHSL(c.hue, 0.62, 0.68);
    c.css = `#${c.color.getHexString()}`;
  }
  for (const n of raw.notes) n.pos = new THREE.Vector3(n.pos.x, n.pos.y, n.pos.z);
  raw.byId = new Map(raw.notes.map((n) => [n.id, n]));
  state.model = raw;
  state.stats = computeStats(raw);
  state.filter.hidden = state.filter.hidden.filter((k) => raw.consts.some((c) => c.key === k));
  buildObjects();
  buildConstLabels();
  const empty = state.data.length === 0;
  document.body.classList.toggle('no-data', empty);
  $('#welcome').hidden = !empty;
  if (empty) { renderWelcome(); closeModal(); hideGreet(); toggleTimeline(false); }
  updateSub();
  // Re-resolve selection by id; reset uniforms that point at old indices.
  state.selected = null;
  state.focusedConst = null;
  starMat.uniforms.uSel.value = -1;
  starMat.uniforms.uHover.value = -1;
  hoverNote = null;
  computeFilter();
  renderChipbar();
  if (state.timeline) toggleTimeline(true);
  if (resetCam) { resetView(); return; }
  const fc = keepConst && raw.consts.find((c) => c.key === keepConst);
  if (fc) { state.focusedConst = fc; setNoteLabels(fc.notes, null); }
  const again = findById(keepSel);
  if (again) selectNote(again, { fly: false });
  else { closePanel(false); if (!fc) setNoteLabels([], null); applyFocus(); }
  updateBack();
  if (modal.classList.contains('open')) renderModal();
}
// Never overlap scans; at most one extra scan is queued, and resetCam requests are merged.
let loading = null, rescan = false, pendingReset = false;
async function reload(resetCam) {
  pendingReset = pendingReset || !!resetCam;
  if (loading) { rescan = true; return loading; }
  const slow = setTimeout(() => document.body.classList.add('loading'), 180);
  loading = (async () => {
    try {
      let rounds = 0;
      do {
        rescan = false;
        state.data = await window.brain.scan();
      } while (rescan && ++rounds < 3);
      const reset = pendingReset;
      pendingReset = false;
      rebuild(reset);
      const errs = state.data.reduce((a, v) => a + (v.errors || 0), 0);
      if (errs) toast(tn(errs, '{n} file couldn’t be read and was skipped.', '{n} files couldn’t be read and were skipped.'), true);
      const tr = state.data.find((v) => v.truncated);
      if (tr) toast(t('“{name}” is very large: only the first 50,000 notes are shown.', { name: tr.name }), true);
    } catch (err) {
      console.error(err);
      toast(t('Couldn’t read the vaults: {e}', { e: err.message || err }), true);
    } finally {
      clearTimeout(slow);
      document.body.classList.remove('loading');
      loading = null;
      if (rescan) { rescan = false; reload(false); }
    }
  })();
  return loading;
}
window.brain.onChange(() => reload(false));
window.brain.onWatchLost((name) => toast(t('Live updates stopped for “{name}”. Press F5 to re-read.', { name }), true));

function updateSub() {
  const M = state.model;
  const n = M ? M.notes.length : 0;
  const act = activeVaults();
  let s = state.data.length ? `${tn(n, '{n} note', '{n} notes')} · ${act.length === 1 ? state.data[act[0]].name : tn(act.length, '{n} vault', '{n} vaults')}` : t('No vaults');
  if (state.showFps) s += ` · ${fps.shown} fps`;
  $('#sub').textContent = s;
}

// ───────────────────────── render loop & quality ─────────────────────────
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const scale = renderer.getDrawingBufferSize(new THREE.Vector2()).y * 2.2;
  starMat.uniforms.uScale.value = scale;
  ideaMat.uniforms.uScale.value = scale;
  dustMat.uniforms.uScale.value = scale * 0.4;
  orbitHeads.material.uniforms.uScale.value = scale;
  lastCam.force = true;
  for (const l of constLabels) l.w = 0;
}
window.addEventListener('resize', resize);
// GPU resets (driver update, sleep, too many GPU apps) lose the WebGL context: recover instead of freezing.
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast(t('The graphics card was reset. Restoring the galaxy…'), true); });
canvas.addEventListener('webglcontextrestored', () => location.reload());

// Quality ladder: pixel ratio is what matters (lens cost scales with pixels), steps help a little.
const DPR = window.devicePixelRatio || 1;
const LEVELS = [
  { pr: Math.min(DPR, 1.25), steps: 300 },
  { pr: Math.min(DPR, 1), steps: 240 },
  { pr: 0.8, steps: 200 },
  { pr: 0.65, steps: 160 },
];
const PRESETS = { high: 0, medium: 1, low: 3 };
const quality = { level: 0, acc: 0, n: 0, warm: 0, good: 0 };
function setLevel(l) {
  quality.level = l;
  renderer.setPixelRatio(LEVELS[l].pr);
  LU.uSteps.value = LEVELS[l].steps;
  resize();
}
function applyQualityPreset() {
  quality.acc = 0; quality.n = 0; quality.warm = 0;
  setLevel(state.quality in PRESETS ? PRESETS[state.quality] : 0);
}
function adaptQuality(dt) {
  if (state.quality !== 'auto' || document.hidden) return;
  quality.warm += dt;
  if (quality.warm < 4) return;
  quality.acc += dt;
  quality.n++;
  if (quality.acc < 2.5) return;
  const avg = quality.acc / quality.n;
  quality.acc = 0;
  quality.n = 0;
  if (avg > 1 / 40 && quality.level < LEVELS.length - 1) { setLevel(quality.level + 1); quality.good = 0; }
  else if (avg < 1 / 58 && quality.level > 0 && ++quality.good >= 4) { setLevel(quality.level - 1); quality.good = 0; } // recover when smooth again
}

const fps = { acc: 0, n: 0, shown: 60 };
function stepFps(dt) {
  fps.acc += dt;
  fps.n++;
  if (fps.acc >= 0.5) {
    fps.shown = Math.round(fps.n / fps.acc);
    fps.acc = 0;
    fps.n = 0;
    if (state.showFps) updateSub();
  }
}

// `spin` is the clock of everything that orbits (galaxy, dust, comets, the disc's swirl): it stops while paused.
let time = 0, spin = 0, lastNow = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - lastNow) / 1000, 0.05);
  lastNow = now;
  time += dt;
  const sdt = state.rotating ? dt : 0;
  spin += sdt;
  adaptQuality(dt);
  stepFps(dt);
  galaxy.rotation.y += ROT_SPEED() * sdt;
  galaxy.updateMatrixWorld();
  stepOrbits(still() ? sdt * 0.25 : sdt);

  stepFollow();
  stepFlight(dt);
  controls.update();
  stepZoom(dt);
  if (camera.position.length() < RS * 2.4) camera.position.setLength(RS * 2.4);
  camera.updateMatrixWorld();

  if (focusCur && starPoints) {
    let changed = false;
    const k = still() ? 1 : Math.min(1, dt * 4);
    for (let i = 0; i < focusCur.length; i++) {
      const d = focusTarget[i] - focusCur[i];
      if (Math.abs(d) > 0.002) { focusCur[i] += d * k; changed = true; } else focusCur[i] = focusTarget[i];
    }
    if (changed) {
      starPoints.geometry.attributes.aFocus.needsUpdate = true;
      for (let i = 0; i < ideaParent.length; i++) ideaFocus[i] = focusCur[ideaParent[i]];
      ideaPoints.geometry.attributes.aFocus.needsUpdate = true;
      lastCam.force = true;
    }
  }
  const kMix = Math.min(1, dt * 3);
  colorMix += ((state.colorMode === 'white' ? 0 : 1) - colorMix) * kMix;
  heatMix += ((state.colorMode === 'heat' ? 1 : 0) - heatMix) * kMix;
  starMat.uniforms.uColorMix.value = colorMix;
  ideaMat.uniforms.uColorMix.value = colorMix;
  starMat.uniforms.uHeatMix.value = heatMix;
  ideaMat.uniforms.uHeatMix.value = heatMix;
  stepArrivals();
  if (linkObj) linkMat.uniforms.uFade.value = Math.min(1, linkMat.uniforms.uFade.value + dt * 1.2);
  if (linesObj) linesMat.opacity = state.selected || state.focusedConst || filterMatch ? 0.45 : 1;
  starMat.uniforms.uTime.value = time;
  linkMat.uniforms.uTime.value = time;
  dustMat.uniforms.uTime.value = spin;

  LU.uTime.value = spin;
  LU.uCamPos.value.copy(camera.position);
  LU.uInvProj.value.copy(camera.projectionMatrixInverse);
  LU.uCamWorld.value.copy(camera.matrixWorld);
  LU.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  updateLabels();
  updateTooltip();
  composer.render();
}

// ───────────────────────── start ─────────────────────────
function intro() {
  $('#greet').classList.remove('out');
  showGreet();
  camera.position.set(0, 4200, 1600);
  controls.target.set(0, 0, 0);
  flyTo({ target: { type: 'origin' }, offset: DEFAULT_CAM.clone(), dur: 5.5 });
}
(async function start() {
  state.profile = await window.brain.profile();
  setLang(resolveLang(state.profile.lang));
  applyI18n();
  if (state.profile.platform === 'darwin') document.body.classList.add('mac');
  resize();
  applyQualityPreset();
  setRotating(state.rotating);
  setColorMode(state.colorMode);
  const shot = await window.brain.shotMode();
  await reload(false);
  document.body.classList.remove('booting');
  frame();
  window.addEventListener('beforeunload', () => store.set('sbg.lastVisit', Date.now()));
  if (shot) return runShot(shot);
  if (!state.data.length) {
    camera.position.set(0, 4200, 1600);
    flyTo({ target: { type: 'origin' }, offset: DEFAULT_CAM.clone().multiplyScalar(1.15), dur: 6 });
    return;
  }
  intro();
})();

// Developer screenshot mode (only reachable with --shot in unpackaged builds).
function runShot(shot) {
  hideGreet();
  $('#hintbar').classList.add('out');
  if (shot === 'settings' || shot === 'help') { openSheet(shot); return; }
  if (!state.data.length || !state.model.notes.length) return;
  controls.target.set(0, 0, 0);
  galaxy.updateMatrixWorld();
  if (shot === 'bh') camera.position.copy(bhView());
  else if (shot === 'greet') { $('#greet').classList.remove('out'); showGreet({ instant: true }); }
  else if (shot === 'home' || shot === 'stats' || shot === 'pages' || shot === 'filters') openModal(shot);
  else if (shot === 'search') { openModal('home', true); q.value = state.model.notes[0].title.split(/\s+/)[0]; renderModal(); }
  else if (shot === 'filter') { setFilter({ orphans: true }); }
  else if (shot === 'heat') {
    setColorMode('heat');
    const c = [...state.model.consts].sort((a, b) => b.notes.length - a.notes.length)[0];
    const w = worldOf(c.center);
    controls.target.copy(w);
    camera.position.copy(w).add(new THREE.Vector3(0, c.radius * 3.2, c.radius * 1.2 + 40));
    state.focusedConst = c; applyFocus(); setNoteLabels(c.notes, null); updateBack();
  }
  else if (shot === 'fall') { setColorMode('heat'); toggleTimeline(true); $('#tl-range').value = 0; updateTimeline(); setTimeout(() => $('#tl-play').click(), 1500); }
  else if (shot === 'timeline') { toggleTimeline(true); $('#tl-range').value = 550; updateTimeline(); }
  else if (shot === 'audit') {
    // Security self-test: open the most-linked note and dump what actually reached the DOM.
    const n = [...state.model.notes].sort((a, b) => b.deg - a.deg)[0];
    selectNote(n, { fly: false });
    setTimeout(() => console.log('AUDIT ' + JSON.stringify({ title: document.title, html: $('#p-body').innerHTML })), 3000);
  } else if (shot === 'note' || shot === 'note2') {
    const n = [...state.model.notes].sort((a, b) => b.deg - a.deg)[0];
    if (shot === 'note2') state.depth = 2;
    const w = worldOf(n.pos);
    controls.target.copy(w);
    camera.position.copy(w).add(new THREE.Vector3(0, shot === 'note2' ? 420 : 230, 80));
    selectNote(n, { fly: false });
  } else if (shot === 'const') {
    const c = state.model.consts[0];
    const w = worldOf(c.center);
    controls.target.copy(w);
    camera.position.copy(w).add(new THREE.Vector3(0, c.radius * 4, c.radius * 1.4 + 60));
    state.focusedConst = c;
    applyFocus();
    setNoteLabels(c.notes, null);
    updateBack();
  }
}
