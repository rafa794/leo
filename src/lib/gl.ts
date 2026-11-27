import type { MediaClip, MaskShape } from '../types';
import { registerProjectExtra } from './project';
import { effectDef } from './effects';

/**
 * GPU "color pass" for one clip (WebGL2, built into the browser — free).
 * Applies in a single shader: color adjustments (temp, tint, highlights…), a LUT,
 * chroma key, a shape mask and the video effects ("Efectos", lib/effects.ts). Used by both the preview and the exporter.
 */

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 o;
uniform sampler2D tex;
uniform sampler3D lut;
uniform vec2 px;          // 1 / size
uniform vec2 size;        // processed size in pixels
uniform float temp, tint, sat, bri, con, hil, sha, whi, bla, vib, fade, vig, shp;
uniform float lutAmt, lutSize;
uniform int keyOn; uniform vec3 keyCol; uniform float keySim, keySoft;
uniform int maskType; uniform vec2 mC, mS; uniform float mRot, mFeather, mRound; uniform int mInv;
uniform int fx; uniform float fxA, fxT; // effect code (lib/effects.ts), intensity 0..1, its own time in seconds

const vec3 W = vec3(0.2126, 0.7152, 0.0722);
vec2 cbcr(vec3 c) { return vec2(-0.1146 * c.r - 0.3854 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4542 * c.g - 0.0458 * c.b); }

float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdStar(vec2 p, float r) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  float rf = 0.45;
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
float dot2(vec2 v) { return dot(v, v); }
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}

float maskAlpha() {
  // point in pixels relative to the mask center, rotated into mask space
  vec2 q = (uv - 0.5 - mC) * size;
  float a = radians(mRot);
  q = mat2(cos(a), sin(a), -sin(a), cos(a)) * q;
  vec2 hs = max(mS * size * 0.5, vec2(1.0));
  float d; // > 0 inside, in pixels
  if (maskType == 1) d = -q.y;
  else if (maskType == 2) d = hs.y - abs(q.y);
  else if (maskType == 3) { vec2 n = q / hs; d = (1.0 - length(n)) * min(hs.x, hs.y); }
  else if (maskType == 4) d = -sdBox(q, hs, mRound * min(hs.x, hs.y));
  else if (maskType == 5) { vec2 n = vec2(q.x, -q.y) / hs; d = -sdStar(n, 1.0) * min(hs.x, hs.y); }
  else { vec2 n = vec2(q.x, -q.y) / hs; n.y += 0.55; n *= 0.85; d = -sdHeart(n) * min(hs.x, hs.y); }
  float f = max(1.0, mFeather * length(size) * 0.25);
  float m = smoothstep(-f, f, d);
  return mInv == 1 ? 1.0 - m : m;
}

/* ---------- effects ---------- */
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float aspect() { return size.y / size.x; }

// where to read the picture from (distortions)
vec2 warp(vec2 p) {
  if (fx == 5) { // glitch: some horizontal bands jump sideways
    float k = floor(fxT * 12.0);
    float band = floor(p.y * 14.0);
    if (hash(vec2(band, k)) > 1.0 - 0.35 * fxA) p.x += (hash(vec2(band + 3.0, k)) - 0.5) * 0.16 * fxA;
  } else if (fx == 6) { // vhs: the picture wobbles a little
    p.x += sin(p.y * 180.0 + fxT * 9.0) * 0.0012 * fxA + (hash(vec2(floor(p.y * size.y / 4.0), floor(fxT * 30.0))) - 0.5) * 0.003 * fxA;
  } else if (fx == 8) { // temblor: jumps around, zoomed in so the borders never show
    float k = floor(fxT * 20.0);
    vec2 o = (vec2(hash(vec2(k, 1.0)), hash(vec2(k, 2.0))) - 0.5) * 0.05 * fxA;
    p = (p - 0.5) * (1.0 - 0.06 * fxA) + 0.5 + o;
  } else if (fx == 9) { // latido: zoom that beats
    float b = pow(0.5 + 0.5 * sin(fxT * 6.2832 * 1.2), 3.0);
    p = (p - 0.5) * (1.0 - 0.12 * fxA * b) + 0.5;
  } else if (fx == 10) { // onda
    p.x += sin(p.y * 18.0 + fxT * 4.0) * 0.018 * fxA;
    p.y += cos(p.x * 14.0 + fxT * 3.0) * 0.012 * fxA;
  } else if (fx == 12) { // espejo: the left half, mirrored
    p.x = p.x < 0.5 ? p.x : 1.0 - p.x;
  } else if (fx == 13) { // caleidoscopio: four mirrored copies
    p = 1.0 - abs(1.0 - 2.0 * p);
    p = 0.5 + (p - 0.5) * 0.9;
  } else if (fx == 14) { // pantalla dividida: three strips of the middle of the picture
    p.y = 0.333 + fract(p.y * 3.0) * 0.333;
  } else if (fx == 15) { // ojo de pez
    vec2 d = p - 0.5;
    float r = length(d * vec2(1.0, aspect()));
    p = 0.5 + d * (1.0 - 0.55 * fxA * (1.0 - smoothstep(0.0, 0.75, r)));
  }
  return p;
}

vec4 fetch(vec2 p) {
  if (fx == 1) { // desenfoque (disc of 16 samples)
    vec4 s = vec4(0);
    float r = 0.03 * fxA;
    for (int i = 0; i < 16; i++) {
      float an = float(i) * 2.39996;
      float d = sqrt((float(i) + 0.5) / 16.0);
      s += texture(tex, p + vec2(cos(an) * aspect(), sin(an)) * d * r);
    }
    return s / 16.0;
  }
  if (fx == 2) { // desenfoque de zoom
    vec4 s = vec4(0);
    vec2 d = (p - 0.5) * 0.14 * fxA;
    for (int i = 0; i < 12; i++) s += texture(tex, p - d * float(i) / 11.0);
    return s / 12.0;
  }
  if (fx == 3) { // pixelado
    float b = mix(0.006, 0.07, fxA);
    vec2 cell = vec2(b * aspect(), b);
    return texture(tex, (floor(p / cell) + 0.5) * cell);
  }
  if (fx == 4 || fx == 5 || fx == 6) { // color fringes
    float o = fx == 4 ? 0.014 * fxA * (0.65 + 0.35 * sin(fxT * 3.0))
            : fx == 6 ? 0.005 * fxA
            : 0.02 * fxA * step(0.6, hash(vec2(floor(fxT * 12.0), 9.0)));
    vec4 m = texture(tex, p);
    return vec4(texture(tex, p + vec2(o, 0)).r, m.g, texture(tex, p - vec2(o, 0)).b, m.a);
  }
  return texture(tex, p);
}

float edges(vec2 p) {
  vec2 e = 1.5 / size;
  float l = dot(texture(tex, p - vec2(e.x, 0)).rgb, W), r = dot(texture(tex, p + vec2(e.x, 0)).rgb, W);
  float t = dot(texture(tex, p - vec2(0, e.y)).rgb, W), b = dot(texture(tex, p + vec2(0, e.y)).rgb, W);
  return clamp(length(vec2(r - l, b - t)) * 3.0, 0.0, 1.0);
}

vec3 effectColor(vec3 c, vec2 p) {
  if (fx == 6) { // vhs: lines, a bit of noise, washed colors
    c *= 1.0 - 0.14 * fxA * step(0.5, fract(uv.y * size.y / 3.0));
    c += (hash(uv * size + fract(fxT * 7.0) * 91.0) - 0.5) * 0.08 * fxA;
    c = mix(c, vec3(dot(c, W)) * vec3(1.05, 1.0, 0.92), 0.25 * fxA);
  } else if (fx == 7) { // grano de película
    c += (hash(uv * size + fract(fxT * 13.0) * 100.0) - 0.5) * 0.2 * fxA;
    c *= 1.0 - 0.05 * fxA * hash(vec2(floor(fxT * 12.0), 3.0));
  } else if (fx == 11) { // destellos
    float ph = fract(fxT * 1.2);
    c = mix(c, vec3(1.0), fxA * 0.85 * exp(-ph * 9.0));
  } else if (fx == 16) { // neón: glowing outlines in shifting colors
    vec3 hue = 0.55 + 0.45 * cos(fxT * 1.5 + p.xyx * 4.0 + vec3(0, 2, 4));
    c = mix(c, c * 0.15 + hue * edges(p) * 1.8, fxA);
  } else if (fx == 17) { // cómic: few colors and dark lines
    float n = mix(10.0, 3.0, fxA);
    c = floor(c * n + 0.5) / n;
    c *= 1.0 - smoothstep(0.15, 0.4, edges(p)) * fxA * 0.85;
  } else if (fx == 18) { // duotono
    float L = dot(c, W);
    c = mix(c, mix(vec3(0.17, 0.05, 0.38), vec3(1.0, 0.66, 0.28), L), fxA);
  } else if (fx == 19) { // negativo
    c = mix(c, 1.0 - c, fxA);
  } else if (fx == 20) { // resplandor: the bright parts glow
    vec3 g = vec3(0);
    for (int i = 0; i < 12; i++) {
      float an = float(i) * 2.39996;
      float d = sqrt((float(i) + 0.5) / 12.0) * 0.035;
      g += max(texture(tex, p + vec2(cos(an) * aspect(), sin(an)) * d).rgb - 0.55, 0.0);
    }
    c += g / 12.0 * 2.6 * fxA;
  } else if (fx == 21) { // barras de cine
    if (abs(uv.y - 0.5) > 0.5 - 0.13 * fxA) c = vec3(0);
  } else if (fx == 22) { // arcoíris
    vec3 hue = 0.5 + 0.5 * cos(6.2832 * (uv.x * 0.6 + uv.y * 0.3 - fxT * 0.25) + vec3(0, 2.1, 4.2));
    c = mix(c, c * (0.45 + hue), 0.6 * fxA);
  }
  return c;
}

void main() {
  vec2 st = fx > 0 ? warp(uv) : uv;
  vec4 s = fx > 0 ? fetch(st) : texture(tex, uv);
  vec3 c = s.rgb;
  float a = s.a;
  if (shp > 0.0) {
    vec3 b = (texture(tex, st + vec2(px.x, 0)).rgb + texture(tex, st - vec2(px.x, 0)).rgb + texture(tex, st + vec2(0, px.y)).rgb + texture(tex, st - vec2(0, px.y)).rgb) * 0.25;
    c += (c - b) * shp * 3.0;
  }
  if (keyOn == 1) {
    float d = distance(cbcr(c), cbcr(keyCol));
    a *= smoothstep(keySim, keySim + keySoft + 0.001, d);
    // remove the green/blue spill on the edges
    float spill = 1.0 - smoothstep(keySim, keySim + keySoft + 0.08, d);
    c = mix(c, vec3(dot(c, W)), spill * 0.8);
  }
  c.r += temp * 0.08; c.b -= temp * 0.08;
  c.g -= tint * 0.08;
  c *= exp2(bri * 0.9);
  float L = dot(c, W);
  c += hil * 0.3 * smoothstep(0.45, 1.0, L);
  c += sha * 0.3 * (1.0 - smoothstep(0.0, 0.55, L));
  c += whi * 0.2 * smoothstep(0.7, 1.0, L);
  c += bla * 0.15 * (1.0 - smoothstep(0.0, 0.3, L));
  c = (c - 0.5) * (1.0 + con * 0.8) + 0.5;
  L = dot(c, W);
  c = mix(vec3(L), c, 1.0 + sat);
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(L), c, 1.0 + vib * (1.0 - clamp(chroma, 0.0, 1.0)));
  c = mix(c, c * 0.75 + 0.14, fade);
  c = clamp(c, 0.0, 1.0);
  if (lutAmt > 0.0) {
    vec3 lc = c * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize;
    c = mix(c, texture(lut, lc).rgb, lutAmt);
  }
  if (fx > 0) c = clamp(effectColor(c, st), 0.0, 1.0);
  if (fx == 21 && abs(uv.y - 0.5) > 0.5 - 0.13 * fxA) a = 1.0; // the bars are solid, even over a cut-out
  if (vig > 0.0) c *= 1.0 - vig * smoothstep(0.35, 1.0, length((uv - 0.5) * 1.414));
  if (maskType > 0) a *= maskAlpha();
  o = vec4(c * a, a);
}`;

/* ---------- LUTs ---------- */

interface LutData {
  name: string;
  size: number;
  data: Float32Array; // RGBA, r fastest
}
const luts = new Map<string, LutData>();
const lutListeners = new Set<() => void>();
export const onLutsChange = (f: () => void) => (lutListeners.add(f), () => void lutListeners.delete(f));

function makeLut(name: string, f: (r: number, g: number, b: number) => [number, number, number], size = 17): LutData {
  const data = new Float32Array(size * size * size * 4);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [R, G, B] = f(r / (size - 1), g / (size - 1), b / (size - 1));
        data[i++] = Math.min(1, Math.max(0, R));
        data[i++] = Math.min(1, Math.max(0, G));
        data[i++] = Math.min(1, Math.max(0, B));
        data[i++] = 1;
      }
  return { name, size, data };
}
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sCurve = (x: number, k: number) => x + k * (x - 0.5) * (1 - Math.abs(2 * x - 1));

/** Built-in looks, made by code (no files, no licenses). */
export const BUILTIN_LUTS: [string, string][] = [
  ['cine', 'Cine (naranja y azul)'],
  ['calido', 'Cálido'],
  ['frio', 'Frío'],
  ['vivo', 'Vivo (césped verde)'],
  ['vintage', 'Vintage'],
  ['bn', 'Blanco y negro'],
  ['noche', 'Partido nocturno'],
  ['suave', 'Piel suave'],
  ['rosa', 'Rosa pastel'],
  ['dorada', 'Hora dorada'],
  ['bosque', 'Bosque'],
  ['cielo', 'Cielo azul'],
  ['atardecer', 'Atardecer'],
  ['accion', 'Acción'],
  ['mate', 'Mate'],
  ['western', 'Western'],
  ['polaroid', 'Polaroid'],
  ['setenta', 'Años 70'],
  ['cruzado', 'Proceso cruzado'],
  ['noir', 'Noir'],
  ['sepia', 'Sepia'],
  ['selenio', 'Selenio'],
  ['neonoche', 'Neón nocturno'],
  ['luna', 'Luz de luna'],
  ['comida', 'Apetitoso'],
  ['invierno', 'Invierno'],
];

/** The filter gallery ("Filtros"): categories of the built-in looks. */
export const FILTER_GROUPS: [string, string[]][] = [
  ['Destacado', ['cine', 'vivo', 'dorada', 'mate', 'noir', 'polaroid']],
  ['Retrato', ['suave', 'rosa', 'dorada', 'calido']],
  ['Paisaje', ['vivo', 'bosque', 'cielo', 'atardecer']],
  ['Películas', ['cine', 'accion', 'mate', 'western']],
  ['Retro', ['vintage', 'polaroid', 'setenta', 'cruzado']],
  ['Blanco y negro', ['bn', 'noir', 'sepia', 'selenio']],
  ['Noche', ['noche', 'neonoche', 'luna']],
  ['Frío y cálido', ['frio', 'invierno', 'calido', 'comida']],
];
luts.set('cine', makeLut('Cine', (r, g, b) => {
  const l = lum(r, g, b);
  const t = l < 0.5 ? (0.5 - l) * 2 : 0;
  const w = l > 0.5 ? (l - 0.5) * 2 : 0;
  return [sCurve(r, 0.25) - t * 0.08 + w * 0.08, sCurve(g, 0.25) + t * 0.02 + w * 0.02, sCurve(b, 0.25) + t * 0.12 - w * 0.08];
}));
luts.set('calido', makeLut('Cálido', (r, g, b) => [r * 1.06 + 0.02, g * 1.01, b * 0.88]));
luts.set('frio', makeLut('Frío', (r, g, b) => [r * 0.9, g * 0.99, b * 1.08 + 0.02]));
luts.set('vivo', makeLut('Vivo', (r, g, b) => {
  const l = lum(r, g, b);
  const k = 1.35;
  return [sCurve(l + (r - l) * k, 0.18), sCurve(l + (g - l) * k * 1.08, 0.18), sCurve(l + (b - l) * k, 0.18)];
}));
luts.set('vintage', makeLut('Vintage', (r, g, b) => {
  const l = lum(r, g, b);
  return [0.08 + 0.85 * (l + (r - l) * 0.7) + 0.04, 0.08 + 0.82 * (l + (g - l) * 0.7), 0.1 + 0.7 * (l + (b - l) * 0.7)];
}));
luts.set('bn', makeLut('B/N', (r, g, b) => {
  const l = sCurve(lum(r, g, b), 0.3);
  return [l, l, l];
}));
luts.set('noche', makeLut('Nocturno', (r, g, b) => [sCurve(0.03 + r * 1.12, 0.12) * 0.97, sCurve(0.03 + g * 1.12, 0.12), sCurve(0.04 + b * 1.12, 0.12) * 1.03]));

const mixc = (a: number, b: number, t: number) => a + (b - a) * t;
const satur = (r: number, g: number, b: number, k: number): [number, number, number] => {
  const l = lum(r, g, b);
  return [l + (r - l) * k, l + (g - l) * k, l + (b - l) * k];
};
const look = (id: string, name: string, f: (r: number, g: number, b: number) => [number, number, number]) => luts.set(id, makeLut(name, f));
look('suave', 'Piel suave', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.9);
  return [0.05 + R * 0.95 + 0.02, 0.05 + G * 0.93 + 0.01, 0.06 + B * 0.9];
});
look('rosa', 'Rosa pastel', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.8);
  return [0.08 + R * 0.92 + 0.03, 0.06 + G * 0.88, 0.08 + B * 0.9 + 0.03];
});
look('dorada', 'Hora dorada', (r, g, b) => {
  const l = lum(r, g, b);
  return [sCurve(r * 1.08 + 0.04, 0.12), sCurve(g * 1.0 + 0.02, 0.12), sCurve(b * 0.82, 0.12) + (1 - l) * 0.03];
});
look('bosque', 'Bosque', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 1.15);
  return [sCurve(R * 0.96, 0.15), sCurve(G * 1.08, 0.15), sCurve(B * 0.95, 0.15)];
});
look('cielo', 'Cielo azul', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 1.15);
  const blueish = Math.max(0, b - (r + g) / 2);
  return [sCurve(R - blueish * 0.15, 0.12), sCurve(G + blueish * 0.05, 0.12), sCurve(B + blueish * 0.2, 0.12)];
});
look('atardecer', 'Atardecer', (r, g, b) => {
  const l = lum(r, g, b);
  return [sCurve(r * 1.1 + 0.03, 0.15), sCurve(g * 0.95 + 0.01, 0.15), sCurve(b * 0.85 + (1 - l) * 0.08, 0.15)];
});
look('accion', 'Acción', (r, g, b) => {
  const l = lum(r, g, b);
  const sh = l < 0.5 ? (0.5 - l) * 2 : 0;
  const [R, G, B] = satur(r, g, b, 0.85);
  return [sCurve(R, 0.4) - sh * 0.06 + 0.02, sCurve(G, 0.4) + sh * 0.03, sCurve(B, 0.4) + sh * 0.1 - 0.03];
});
look('mate', 'Mate', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.85);
  return [0.1 + R * 0.84, 0.1 + G * 0.84, 0.12 + B * 0.82];
});
look('western', 'Western', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.6);
  return [sCurve(R * 1.08 + 0.04, 0.2), sCurve(G * 0.98 + 0.02, 0.2), sCurve(B * 0.75, 0.2)];
});
look('polaroid', 'Polaroid', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.85);
  return [0.06 + R * 0.9 + 0.03, 0.04 + G * 0.92 + 0.02, 0.1 + B * 0.8];
});
look('setenta', 'Años 70', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.75);
  return [0.08 + sCurve(R, 0.1) * 0.88 + 0.06, 0.06 + sCurve(G, 0.1) * 0.85 + 0.02, 0.04 + sCurve(B, 0.1) * 0.7];
});
look('cruzado', 'Proceso cruzado', (r, g, b) => [sCurve(r, 0.35) * 1.05, sCurve(g, 0.2) * 1.05 + 0.02, mixc(0.18, 0.75, b)]);
look('noir', 'Noir', (r, g, b) => {
  const l = sCurve(sCurve(lum(r, g, b), 0.4), 0.3);
  return [l, l, l];
});
look('sepia', 'Sepia', (r, g, b) => {
  const l = lum(r, g, b);
  return [l * 1.07 + 0.05, l * 0.9 + 0.03, l * 0.68 + 0.02];
});
look('selenio', 'Selenio', (r, g, b) => {
  const l = sCurve(lum(r, g, b), 0.2);
  return [l * 0.94, l * 0.98, l * 1.05 + 0.03];
});
look('neonoche', 'Neón nocturno', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 1.3);
  const l = lum(r, g, b);
  return [sCurve(R * 1.05 + (1 - l) * 0.05, 0.25), sCurve(G * 0.9, 0.25), sCurve(B * 1.1 + (1 - l) * 0.1, 0.25)];
});
look('luna', 'Luz de luna', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.5);
  return [sCurve(R * 0.85, 0.15), sCurve(G * 0.93 + 0.02, 0.15), sCurve(B * 1.05 + 0.06, 0.15)];
});
look('comida', 'Apetitoso', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 1.25);
  return [sCurve(R * 1.05 + 0.02, 0.12), sCurve(G * 1.01 + 0.01, 0.12), sCurve(B * 0.9, 0.12)];
});
look('invierno', 'Invierno', (r, g, b) => {
  const [R, G, B] = satur(r, g, b, 0.7);
  return [0.03 + R * 0.88, 0.04 + G * 0.95, 0.06 + B * 1.04];
});

/** Parses an Adobe/Resolve .cube file (the common free LUT format). */
export async function importCube(file: File): Promise<string> {
  const text = await file.text();
  let size = 0;
  const vals: number[] = [];
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [k, ...rest] = line.split(/\s+/);
    if (k === 'LUT_3D_SIZE') size = Number(rest[0]);
    else if (k === 'DOMAIN_MIN') min = rest.map(Number);
    else if (k === 'DOMAIN_MAX') max = rest.map(Number);
    else if (/^[-\d.]/.test(k) && rest.length >= 2) vals.push(Number(k), Number(rest[0]), Number(rest[1]));
  }
  if (!size || vals.length < size ** 3 * 3) throw new Error('El archivo .cube no es un LUT 3D válido');
  const data = new Float32Array(size ** 3 * 4);
  for (let i = 0; i < size ** 3; i++) {
    for (let ch = 0; ch < 3; ch++) data[i * 4 + ch] = (vals[i * 3 + ch] - min[ch]) / (max[ch] - min[ch] || 1);
    data[i * 4 + 3] = 1;
  }
  const id = `cube:${file.name}:${size}:${vals.length}`;
  luts.set(id, { name: file.name.replace(/\.cube$/i, ''), size, data });
  importedLuts.set(id, file.name.replace(/\.cube$/i, ''));
  lutListeners.forEach((f) => f());
  return id;
}
export const importedLuts = new Map<string, string>();

// imported LUTs travel with the project
registerProjectExtra(
  'luts',
  () => [...importedLuts.keys()].map((id) => ({ id, ...luts.get(id)! })),
  (v) => {
    for (const l of (v as (LutData & { id: string })[]) ?? []) {
      if (luts.has(l.id)) continue;
      luts.set(l.id, { name: l.name, size: l.size, data: l.data });
      importedLuts.set(l.id, l.name);
    }
    lutListeners.forEach((f) => f());
  },
);

/* ---------- the pass ---------- */

const MASK_TYPES: Record<MaskShape, number> = { linear: 1, mirror: 2, circle: 3, rect: 4, star: 5, heart: 6 };

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Does this clip need the GPU pass at all? (otherwise it's drawn directly, faster) */
export function needsColorPass(c: MediaClip) {
  const a = c.adjust;
  const adj = a.temp || a.tint || a.saturation || a.brightness || a.contrast || a.highlights || a.shadows || a.whites || a.blacks || a.vibrance || a.fade || a.vignette || a.sharpen;
  return !!(adj || (c.lut && c.lut.intensity > 0 && luts.has(c.lut.id)) || c.chroma?.on || c.mask || (c.effect && c.effect.intensity > 0 && effectDef(c.effect.id)));
}

class ColorPass {
  canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutLoaded = '';
  private u: Record<string, WebGLUniformLocation | null> = {};
  failed = false;

  private init() {
    if (this.gl || this.failed) return !!this.gl;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) {
      this.failed = true;
      return false;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['tex', 'lut', 'px', 'size', 'temp', 'tint', 'sat', 'bri', 'con', 'hil', 'sha', 'whi', 'bla', 'vib', 'fade', 'vig', 'shp', 'lutAmt', 'lutSize', 'keyOn', 'keyCol', 'keySim', 'keySoft', 'maskType', 'mC', 'mS', 'mRot', 'mFeather', 'mRound', 'mInv', 'fx', 'fxA', 'fxT'])
      this.u[n] = gl.getUniformLocation(prog, n);
    this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0, 0, 0, 1]));
    gl.uniform1i(this.u.tex, 0);
    gl.uniform1i(this.u.lut, 1);
    this.canvas = canvas;
    this.gl = gl;
    this.prog = prog;
    return true;
  }

  /** Processes one frame of the clip; returns a canvas to draw (or null if WebGL isn't available). */
  run(c: MediaClip, image: CanvasImageSource, srcW: number, srcH: number, outW: number, outH: number, t = 0): HTMLCanvasElement | null {
    try {
      if (!this.init()) return null;
    } catch (e) {
      console.warn('Leo: WebGL color pass disabled', e);
      this.failed = true;
      return null;
    }
    const gl = this.gl!;
    const u = this.u;
    // process at the size it will be shown (never more than the source)
    const w = Math.max(1, Math.round(Math.min(srcW, outW, 4096)));
    const h = Math.max(1, Math.round(Math.min(srcH, outH, 4096)));
    if (this.canvas!.width !== w || this.canvas!.height !== h) {
      this.canvas!.width = w;
      this.canvas!.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource);

    const a = c.adjust;
    const k = (v: number) => v / 100;
    gl.uniform2f(u.px, 1 / srcW, 1 / srcH);
    gl.uniform2f(u.size, w, h);
    gl.uniform1f(u.temp, k(a.temp));
    gl.uniform1f(u.tint, k(a.tint));
    gl.uniform1f(u.sat, k(a.saturation));
    gl.uniform1f(u.bri, k(a.brightness));
    gl.uniform1f(u.con, k(a.contrast));
    gl.uniform1f(u.hil, k(a.highlights));
    gl.uniform1f(u.sha, k(a.shadows));
    gl.uniform1f(u.whi, k(a.whites));
    gl.uniform1f(u.bla, k(a.blacks));
    gl.uniform1f(u.vib, k(a.vibrance));
    gl.uniform1f(u.fade, k(a.fade));
    gl.uniform1f(u.vig, k(a.vignette));
    gl.uniform1f(u.shp, k(a.sharpen));

    const lut = c.lut && c.lut.intensity > 0 ? luts.get(c.lut.id) : undefined;
    gl.uniform1f(u.lutAmt, lut ? k(c.lut!.intensity) : 0);
    if (lut) {
      gl.activeTexture(gl.TEXTURE1);
      if (this.lutLoaded !== c.lut!.id) {
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, lut.data);
        this.lutLoaded = c.lut!.id;
      }
      gl.uniform1f(u.lutSize, lut.size);
    }

    const ch = c.chroma;
    gl.uniform1i(u.keyOn, ch?.on ? 1 : 0);
    if (ch?.on) {
      gl.uniform3f(u.keyCol, ...hexRgb(ch.color));
      gl.uniform1f(u.keySim, 0.02 + k(ch.intensity) * 0.3);
      gl.uniform1f(u.keySoft, k(ch.shadow) * 0.2);
    }
    const m = c.mask;
    gl.uniform1i(u.maskType, m ? MASK_TYPES[m.shape] : 0);
    if (m) {
      gl.uniform2f(u.mC, m.x, m.y);
      gl.uniform2f(u.mS, m.w, m.h);
      gl.uniform1f(u.mRot, m.rotation);
      gl.uniform1f(u.mFeather, k(m.feather));
      gl.uniform1f(u.mRound, k(m.round));
      gl.uniform1i(u.mInv, m.invert ? 1 : 0);
    }
    const fx = c.effect && c.effect.intensity > 0 ? effectDef(c.effect.id) : undefined;
    gl.uniform1i(u.fx, fx ? fx.code : 0);
    gl.uniform1f(u.fxA, fx ? k(c.effect!.intensity) : 0);
    gl.uniform1f(u.fxT, fx ? t * (c.effect!.speed || 1) : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

export const colorPass = new ColorPass();
export const lutName = (id: string) => luts.get(id)?.name ?? id;
export const hasLut = (id: string) => luts.has(id);
