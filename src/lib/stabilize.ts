import { useEditor } from '../store/editor';
import type { MediaClip, StabData, Stabilization } from '../types';

/**
 * Estabilizador de vídeo (open source pipeline, see ai/stabilize.worker.ts for the motion analysis).
 *
 * 1. The worker measures how the camera moved between frames.
 * 2. Here the camera path is smoothed (or locked, "cámara fija") and the difference between the
 *    real path and the smooth one becomes a small move / turn / zoom of the picture per frame.
 * 3. The picture is zoomed a bit (the "recorte") and the correction is limited so the borders of the
 *    video never show — when a shake is bigger than the margin, the path bends just enough.
 */

export const STAB_DEFAULT: Stabilization = { on: true, mode: 'smooth', strength: 50, crop: 8 };

/* ---------------- analysis jobs ---------------- */

interface Job {
  id: number;
  clipId: string;
  progress: number;
  error?: string;
}
let worker: Worker | null = null;
let nextId = 1;
const jobs = new Map<string, Job>(); // by clip id
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export const onStabJobs = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const stabJob = (clipId: string) => jobs.get(clipId);

type Done = { type: 'done'; id: number; t0: number; dt: number; n: number; aspect: number; motion: Float32Array };
const resolvers = new Map<number, { resolve: (d: Done) => void; reject: (e: Error) => void; touch: () => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../ai/stabilize.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (e) => {
      for (const r of resolvers.values()) r.reject(new Error(`No se pudo iniciar el estabilizador (${e.message || 'error'})`));
    };
    worker.onmessage = (e) => {
      const m = e.data;
      const r = resolvers.get(m.id);
      if (!r) return;
      if (m.type === 'progress') {
        r.touch();
        for (const j of jobs.values()) if (j.id === m.id) j.progress = m.p;
        emit();
      } else if (m.type === 'done') r.resolve(m as Done);
      else if (m.type === 'error') r.reject(new Error(m.error));
    };
  }
  return worker;
}

/** Measures the camera motion of a clip (its visible part plus a little margin). */
export async function analyzeClip(clipId: string) {
  const st = useEditor.getState();
  const clip = st.clips.find((c) => c.id === clipId) as MediaClip | undefined;
  const media = clip && st.media.find((m) => m.id === clip.mediaId);
  if (!clip || clip.type !== 'video' || !media || media.missing) return;
  if (jobs.has(clipId)) return;
  const from = Math.max(0, clip.trimStart - 1);
  const to = Math.min(media.duration, clip.trimStart + clip.duration * clip.speed + 1);
  const job: Job = { id: nextId++, clipId, progress: 0 };
  jobs.set(clipId, job);
  emit();
  try {
    const done = await new Promise<Done>((resolve, reject) => {
      let last = performance.now();
      // a decoder that stops answering (some phones / emulators) shouldn't hang forever
      const watchdog = setInterval(() => {
        if (performance.now() - last > 30000) {
          clearInterval(watchdog);
          getWorker().postMessage({ type: 'cancel', id: job.id });
          reject(new Error('El análisis no avanza (el decodificador de vídeo no responde)'));
        }
      }, 2000);
      resolvers.set(job.id, {
        resolve: (d) => (clearInterval(watchdog), resolve(d)),
        reject: (e) => (clearInterval(watchdog), reject(e)),
        touch: () => (last = performance.now()),
      });
      getWorker().postMessage({ type: 'analyze', id: job.id, file: media.file, from, to });
    });
    const data: StabData = {
      t0: done.t0,
      dt: done.dt,
      aspect: done.aspect,
      motion: Array.from(fillGaps(done.motion), (v) => Math.round(v * 1e6) / 1e6),
    };
    const s = useEditor.getState();
    // every clip of the same video covered by this analysis gets it (e.g. the pieces of a cut)
    for (const c of s.clips) {
      if (c.type !== 'video' || c.mediaId !== clip.mediaId) continue;
      if (c.id !== clipId && !c.stab) continue;
      const a = c.trimStart;
      const b = c.trimStart + c.duration * c.speed;
      if (a < from - 1e-3 || b > to + 1e-3) continue;
      s.updateClip(c.id, { stab: { ...(c.stab ?? STAB_DEFAULT), data } }, false);
    }
    jobs.delete(clipId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'cancelled') jobs.delete(clipId);
    else job.error = msg;
  } finally {
    resolvers.delete(job.id);
    emit();
  }
}

/**
 * Steps that couldn't be measured (blur, a flash, a frame with no detail) get the motion of their
 * neighbours instead of "no motion" — a zero would leave a jump in the camera path.
 */
function fillGaps(m: Float32Array): Float32Array {
  const n = m.length / 4;
  const ok = (i: number) => !Number.isNaN(m[4 * i]);
  const out = Float32Array.from(m);
  for (let i = 1; i < n; i++) {
    if (ok(i)) continue;
    let a = i - 1;
    while (a > 0 && !ok(a)) a--;
    let b = i + 1;
    while (b < n && !ok(b)) b++;
    for (let ch = 0; ch < 4; ch++) {
      const va = a > 0 && ok(a) ? m[4 * a + ch] : NaN;
      const vb = b < n ? m[4 * b + ch] : NaN;
      const w = (i - a) / (b - a);
      out[4 * i + ch] = Number.isNaN(va) ? (Number.isNaN(vb) ? 0 : vb) : Number.isNaN(vb) ? va : va + (vb - va) * w;
    }
  }
  return out;
}

export function cancelAnalysis(clipId: string) {
  const j = jobs.get(clipId);
  if (!j) return;
  getWorker().postMessage({ type: 'cancel', id: j.id });
  jobs.delete(clipId);
  emit();
}

/** Is the visible part of the clip inside the analyzed range? */
export function stabCovers(c: MediaClip) {
  const d = c.stab?.data;
  if (!d) return false;
  const end = d.t0 + (d.motion.length / 4 - 1) * d.dt;
  return c.trimStart >= d.t0 - 0.05 && c.trimStart + c.duration * c.speed <= end + 0.05;
}

/* ---------------- smoothing: smoothest camera path inside the crop margin ---------------- */

/**
 * Banded (pentadiagonal) symmetric matrix  M = c·I + λ1·D1ᵀD1 + λ2·D2ᵀD2,
 * factorized once (Cholesky) and then solved many times in O(n).
 */
function bandSolver(n: number, c: number, l1: number, l2: number) {
  const d0 = new Float64Array(n);
  const d1 = new Float64Array(n); // M[i][i-1]
  const d2 = new Float64Array(n); // M[i][i-2]
  for (let i = 0; i < n; i++) d0[i] = c;
  // D1ᵀD1: [1, 2, …, 2, 1] on the diagonal, −1 beside it
  for (let i = 0; i < n - 1; i++) {
    d0[i] += l1;
    d0[i + 1] += l1;
    d1[i + 1] -= l1;
  }
  // D2ᵀD2 from each row (1, −2, 1)
  for (let i = 0; i < n - 2; i++) {
    d0[i] += l2;
    d0[i + 1] += 4 * l2;
    d0[i + 2] += l2;
    d1[i + 1] -= 2 * l2;
    d1[i + 2] -= 2 * l2;
    d2[i + 2] += l2;
  }
  // Cholesky M = L·Lᵀ with L lower, bandwidth 2
  const L0 = new Float64Array(n);
  const L1 = new Float64Array(n);
  const L2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    L2[i] = i >= 2 ? d2[i] / L0[i - 2] : 0;
    L1[i] = i >= 1 ? (d1[i] - (i >= 2 ? L2[i] * L1[i - 1] : 0)) / L0[i - 1] : 0;
    L0[i] = Math.sqrt(Math.max(1e-12, d0[i] - L1[i] * L1[i] - L2[i] * L2[i]));
  }
  const y = new Float64Array(n);
  return (b: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) y[i] = (b[i] - (i >= 1 ? L1[i] * y[i - 1] : 0) - (i >= 2 ? L2[i] * y[i - 2] : 0)) / L0[i];
    for (let i = n - 1; i >= 0; i--) out[i] = (y[i] - (i + 1 < n ? L1[i + 1] * out[i + 1] : 0) - (i + 2 < n ? L2[i + 2] * out[i + 2] : 0)) / L0[i];
  };
}

/**
 * Smoothest path S near X with |S − X| ≤ margin everywhere (ADMM, like the "L1 optimal camera path" idea):
 *   minimize ½·|S − X|² + ½·λ1·|S′|² + ½·λ2·|S″|²   subject to the margin.
 * λ1 makes it still (cámara fija), λ2 makes it smooth (follows pans gently).
 */
function smoothInTube(X: Float64Array, margin: Float64Array, l1: number, l2: number): Float64Array {
  const n = X.length;
  if (n < 3) return Float64Array.from(X);
  // ADMM step size matched to the problem's scale (otherwise it barely moves for strong smoothing)
  const rho = Math.max(1, Math.sqrt(l2) + Math.sqrt(l1));
  const solve = bandSolver(n, 1 + rho, l1, l2);
  const S = new Float64Array(n);
  const Z = Float64Array.from(X);
  const U = new Float64Array(n);
  const rhs = new Float64Array(n);
  for (let it = 0; it < 3000; it++) {
    for (let i = 0; i < n; i++) rhs[i] = X[i] + rho * (Z[i] - U[i]);
    solve(rhs, S);
    let primal = 0;
    let dual = 0;
    for (let i = 0; i < n; i++) {
      const v = S[i] + U[i];
      const z = Math.min(X[i] + margin[i], Math.max(X[i] - margin[i], v));
      dual = Math.max(dual, Math.abs(z - Z[i]));
      Z[i] = z;
      U[i] += S[i] - z;
      primal = Math.max(primal, Math.abs(S[i] - z));
    }
    // converged to well under a hundredth of a pixel
    if (it > 30 && primal < 2e-6 && dual < 2e-6) break;
  }
  return Z; // always inside the margin
}

/** Does the zoomed + corrected picture still cover the whole frame? (aspect = w/h) */
function covers(u: number, v: number, a: number, zoom: number, aspect: number) {
  const tx = u * aspect;
  const ty = v;
  const c = Math.cos(-a);
  const s = Math.sin(-a);
  const hw = aspect / 2 + 1e-6;
  const hh = 0.5 + 1e-6;
  for (const [px, py] of [[-aspect / 2, -0.5], [aspect / 2, -0.5], [aspect / 2, 0.5], [-aspect / 2, 0.5]]) {
    const dx = px - tx;
    const dy = py - ty;
    const qx = (c * dx - s * dy) / zoom;
    const qy = (s * dx + c * dy) / zoom;
    if (Math.abs(qx) > hw || Math.abs(qy) > hh) return false;
  }
  return true;
}

/** Final safety: shrink a correction (towards none) until the borders don't show. */
function limit(u: number, v: number, a: number, zoom: number, aspect: number): [number, number, number] {
  if (covers(u, v, a, zoom, aspect)) return [u, v, a];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const m = (lo + hi) / 2;
    if (covers(u * m, v * m, a * m, zoom, aspect)) lo = m;
    else hi = m;
  }
  return [u * lo, v * lo, a * lo];
}

export interface StabPath {
  zoom: number;
  /** per sample: u, v (fraction of the frame), angle (rad), log zoom (unused, 0) */
  corr: Float32Array;
  /** how much of the shake is removed on average (0..1), for the UI */
  removed: number;
}

const cache = new WeakMap<StabData, Map<string, StabPath>>();

export function stabPath(stab: Stabilization): StabPath | null {
  const d = stab.data;
  if (!d) return null;
  const key = `${stab.mode}|${stab.strength}|${stab.crop}`;
  let m = cache.get(d);
  if (!m) cache.set(d, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;

  const n = d.motion.length / 4;
  const zoom = 1 + Math.max(0, stab.crop) / 100;
  const fps = 1 / d.dt;
  // camera path = sum of the motions (x, y as a fraction of the frame, angle in radians)
  const X = [0, 1, 2].map(() => new Float64Array(n));
  for (let i = 1; i < n; i++) for (let ch = 0; ch < 3; ch++) X[ch][i] = X[ch][i - 1] + d.motion[4 * i + ch];

  // how smooth: "suave/fuerte" follow the camera moves; "cámara fija" stays still
  let l1: number;
  let l2: number;
  if (stab.mode === 'tripod') {
    l1 = Math.pow(4 * fps, 2);
    l2 = Math.pow(0.6 * fps, 4);
  } else {
    const sigma = (0.15 + 2.6 * Math.pow(stab.strength / 100, 1.5)) * fps; // ~ seconds of smoothing
    l1 = 0;
    l2 = Math.pow(sigma, 4);
  }

  // the zoom gives a margin; turning uses part of it, moving the rest
  const room = zoom - 1;
  const turnCost = Math.max(d.aspect, 1 / d.aspect); // margin used per radian of turn
  const angMargin = new Float64Array(n).fill((0.3 * room) / turnCost);
  const Sa = smoothInTube(X[2], angMargin, l1, l2);
  const ca = new Float64Array(n);
  for (let i = 0; i < n; i++) ca[i] = Sa[i] - X[2][i];
  const moveMargin = new Float64Array(n);
  for (let i = 0; i < n; i++) moveMargin[i] = Math.max(0, (room - Math.abs(ca[i]) * turnCost) / 2) * 0.98;
  const Sx = smoothInTube(X[0], moveMargin, l1, l2);
  const Sy = smoothInTube(X[1], moveMargin, l1, l2);

  const corr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = limit(Sx[i] - X[0][i], Sy[i] - X[1][i], ca[i], zoom, d.aspect);
    corr[4 * i] = r[0];
    corr[4 * i + 1] = r[1];
    corr[4 * i + 2] = r[2];
  }

  // shake removed: compare the picture's jolts (frame-to-frame acceleration; smooth pans have almost none)
  let before = 0;
  let after = 0;
  for (let i = 2; i < n; i++) {
    for (const ch of [0, 1]) {
      const at = (k: number) => X[ch][k];
      const fx = (k: number) => X[ch][k] + corr[4 * k + ch];
      before += Math.abs(at(i) - 2 * at(i - 1) + at(i - 2));
      after += Math.abs(fx(i) - 2 * fx(i - 1) + fx(i - 2));
    }
  }
  const out: StabPath = { zoom, corr, removed: before > 1e-9 ? Math.max(0, 1 - after / before) : 0 };
  m.set(key, out);
  return out;
}

/** Correction to draw at source time s: move (u, v), turn (a) and zoom (k), or null. */
export function stabAt(c: MediaClip, s: number): { u: number; v: number; a: number; k: number } | null {
  const st = c.stab;
  if (!st?.on || !st.data || c.type !== 'video') return null;
  const p = stabPath(st);
  if (!p) return null;
  const n = p.corr.length / 4;
  const f = Math.max(0, Math.min(n - 1, (s - st.data.t0) / st.data.dt));
  const i = Math.floor(f);
  const j = Math.min(n - 1, i + 1);
  const w = f - i;
  const at = (ch: number) => p.corr[4 * i + ch] * (1 - w) + p.corr[4 * j + ch] * w;
  return { u: at(0), v: at(1), a: at(2), k: p.zoom };
}
