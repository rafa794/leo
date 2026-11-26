import type { MediaClip, MaskShape } from '../types';
import { registerProjectExtra } from './project';

/**
 * GPU "color pass" for one clip (WebGL2, built into the browser — free).
 * Applies in a single shader: color adjustments (temp, tint, highlights…), a LUT,
 * chroma key and a shape mask. Used by both the preview and the exporter.
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

void main() {
  vec4 s = texture(tex, uv);
  vec3 c = s.rgb;
  float a = s.a;
  if (shp > 0.0) {
    vec3 b = (texture(tex, uv + vec2(px.x, 0)).rgb + texture(tex, uv - vec2(px.x, 0)).rgb + texture(tex, uv + vec2(0, px.y)).rgb + texture(tex, uv - vec2(0, px.y)).rgb) * 0.25;
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
  return !!(adj || (c.lut && c.lut.intensity > 0 && luts.has(c.lut.id)) || c.chroma?.on || c.mask);
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
    for (const n of ['tex', 'lut', 'px', 'size', 'temp', 'tint', 'sat', 'bri', 'con', 'hil', 'sha', 'whi', 'bla', 'vib', 'fade', 'vig', 'shp', 'lutAmt', 'lutSize', 'keyOn', 'keyCol', 'keySim', 'keySoft', 'maskType', 'mC', 'mS', 'mRot', 'mFeather', 'mRound', 'mInv'])
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
  run(c: MediaClip, image: CanvasImageSource, srcW: number, srcH: number, outW: number, outH: number): HTMLCanvasElement | null {
    try {
      if (!this.init()) return null;
    } catch (e) {
      console.warn('Orion: WebGL color pass disabled', e);
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
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

export const colorPass = new ColorPass();
export const lutName = (id: string) => luts.get(id)?.name ?? id;
export const hasLut = (id: string) => luts.has(id);
