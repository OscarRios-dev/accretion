// Agujero negro de Schwarzschild: trazado de geodésicas de luz por píxel.
// Unidades internas: radio de Schwarzschild = 1. El horizonte está en r = 1,
// la esfera de fotones en r = 1.5 y la órbita estable más interna (ISCO) en r = 3.
import * as THREE from 'three';

export const LensShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSky: { value: null },
    uCamPos: { value: new THREE.Vector3() },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uViewProj: { value: new THREE.Matrix4() },
    uRs: { value: 12 },
    uTime: { value: 0 },
    uDiskIn: { value: 3.0 },
    uDiskOut: { value: 8.0 },
    uInfl: { value: 10.0 },
    uDiskN: { value: new THREE.Vector3(0, 1, 0) },
    uDiskU: { value: new THREE.Vector3(1, 0, 0) },
    uDiskV: { value: new THREE.Vector3(0, 0, 1) },
    uSteps: { value: 300 },
    uDiskGain: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform samplerCube uSky;
    uniform vec3 uCamPos;
    uniform mat4 uInvProj, uCamWorld, uViewProj;
    uniform float uRs, uTime, uDiskIn, uDiskOut, uInfl, uDiskGain;
    uniform vec3 uDiskN, uDiskU, uDiskV;
    uniform int uSteps;
    varying vec2 vUv;

    float hash31(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 x) {
      vec3 i = floor(x), f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
                     mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
                     mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(3.1, 1.7, 5.3); a *= 0.5; }
      return s;
    }

    // Color aproximado de cuerpo negro (t ~ 0 rojo profundo, ~1 blanco cálido, >1.6 azulado).
    vec3 blackbody(float t) {
      t = clamp(t, 0.0, 2.6);
      vec3 c = vec3(1.0, 0.22, 0.03) * smoothstep(0.0, 0.45, t);
      c = mix(c, vec3(1.0, 0.55, 0.18), smoothstep(0.35, 0.85, t));
      c = mix(c, vec3(1.0, 0.86, 0.66), smoothstep(0.8, 1.35, t));
      c = mix(c, vec3(0.78, 0.86, 1.0), smoothstep(1.45, 2.4, t));
      return c;
    }

    vec4 disk(vec3 hp, float rr, vec3 dir) {
      float dx = dot(hp, uDiskU), dz = dot(hp, uDiskV);
      float ang = atan(dz, dx);
      float omega = pow(rr, -1.5);                 // rotación kepleriana
      float a = ang + uTime * omega * 2.6;
      vec3 q = vec3(cos(a) * 1.2, sin(a) * 1.2, rr * 3.2);
      float n = fbm(q * 1.4);
      float n2 = fbm(vec3(cos(a) * 3.0, sin(a) * 3.0, rr * 9.0));
      float streak = 0.55 + 0.9 * n * n + 0.3 * n2;

      float x = uDiskIn / rr;
      float T = 2.35 * pow(x, 0.75) * pow(max(1.0 - sqrt(x) * 0.985, 0.0), 0.25);
      float edgeIn = smoothstep(uDiskIn * 0.9, uDiskIn * 1.15, rr);
      float edgeOut = pow(1.0 - smoothstep(uDiskIn, uDiskOut, rr), 1.6);
      float dens = edgeIn * edgeOut * streak;

      // Doppler relativista + corrimiento al rojo gravitacional.
      vec3 vdir = normalize(uDiskU * dz - uDiskV * dx);
      float beta = clamp(sqrt(0.5 / max(rr - 1.0, 0.5)), 0.0, 0.7);
      float gam = inversesqrt(1.0 - beta * beta);
      float D = 1.0 / (gam * (1.0 - beta * dot(vdir, -dir)));
      float g = mix(1.0, D * sqrt(max(1.0 - 1.0 / rr, 0.02)), 0.45);

      float I = T * pow(g, 2.0) * 1.25 * uDiskGain;
      vec3 c = blackbody(T * g * 1.0 + 0.15) * I * (0.6 + 0.8 * n);
      return vec4(c, clamp(dens * 0.9, 0.0, 0.97));
    }

    vec3 accel(vec3 p, float h2) { float r = length(p); return -1.5 * h2 * p / pow(r, 5.0); }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vp /= vp.w;
      vec3 rd = normalize((uCamWorld * vec4(vp.xyz, 0.0)).xyz);
      vec3 ro = uCamPos / uRs;

      // Fuera de la esfera de influencia la luz va en línea recta.
      float R = uInfl;
      float b = dot(ro, rd);
      float c = dot(ro, ro) - R * R;
      float disc = b * b - c;
      if (c > 0.0 && (disc < 0.0 || b > 0.0)) { gl_FragColor = base; return; }

      vec3 p = c > 0.0 ? ro + rd * (-b - sqrt(disc)) : ro;
      vec3 v = rd;
      vec3 hv = cross(p, v);
      float h2 = dot(hv, hv);

      vec3 col = vec3(0.0);
      float trans = 1.0;
      bool captured = false;

      for (int i = 0; i < 600; i++) {
        if (i >= uSteps) break;
        float r = length(p);
        if (r < 1.0) { captured = true; break; }
        if (r > R * 1.01 && dot(p, v) > 0.0) break;

        float dt = clamp(0.055 * r, 0.012, 0.9);
        vec3 a0 = accel(p, h2);
        vec3 pn = p + v * dt + 0.5 * a0 * dt * dt;
        vec3 vn = v + 0.5 * (a0 + accel(pn, h2)) * dt;

        float s0 = dot(p, uDiskN), s1 = dot(pn, uDiskN);
        if (s0 * s1 < 0.0) {
          float t = s0 / (s0 - s1);
          vec3 hp = mix(p, pn, t);
          float rr = length(hp - uDiskN * dot(hp, uDiskN));
          if (rr > uDiskIn * 0.88 && rr < uDiskOut) {
            vec4 d = disk(hp, rr, normalize(mix(v, vn, t)));
            col += trans * d.rgb * d.a;
            trans *= 1.0 - d.a;
            if (trans < 0.015) break;
          }
        }
        p = pn;
        v = vn;
      }

      vec3 bg = vec3(0.0);
      if (!captured) {
        vec3 dir = normalize(v);
        vec4 clip = uViewProj * vec4(uCamPos + dir * 1.0e4, 1.0);
        vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
        if (clip.w > 0.0 && all(greaterThan(suv, vec2(0.001))) && all(lessThan(suv, vec2(0.999)))) {
          bg = texture2D(tDiffuse, suv).rgb;
        } else {
          bg = textureCube(uSky, dir).rgb;
        }
      }
      // Halo tenue de luz dispersa alrededor de la sombra.
      float rmin = length(cross(ro, rd));
      col += vec3(1.0, 0.72, 0.45) * 0.03 * exp(-max(rmin - 2.6, 0.0) * 0.9) * smoothstep(R, R * 0.5, rmin) * float(!captured);
      gl_FragColor = vec4(col + trans * bg, 1.0);
    }
  `,
};
