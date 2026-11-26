/// <reference lib="webworker" />
/**
 * Camera motion analysis for the stabilizer (runs off the main thread).
 *
 * Classic open-source video stabilization pipeline (same idea as OpenCV's videostab / vid.stab):
 *  1. decode the clip small (480 px wide) with WebCodecs (mediabunny)
 *  2. find corners in each frame (Shi-Tomasi, OpenCV goodFeaturesToTrack)
 *  3. follow them into the next frame (pyramidal Lucas-Kanade optical flow, OpenCV calcOpticalFlowPyrLK)
 *  4. fit the camera motion between the two frames — move + rotation + zoom — with RANSAC, so
 *     things that move on their own (players, the ball) are ignored and only the background counts
 *
 * The result is the camera motion between consecutive samples; smoothing it happens on the main thread.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import cvModule from '@techstark/opencv-js';

type CV = typeof cvModule & Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ANALYSIS_WIDTH = 640;
const MAX_SAMPLE_FPS = 30;

// NOTE: the OpenCV module is "thenable" (it has a .then), so it must never be passed to resolve()
// or returned from an async function — the Promise machinery would wait on it forever.
// It travels wrapped in { cv } instead.
let cvReady: Promise<{ cv: CV }> | null = null;
function loadCv(): Promise<{ cv: CV }> {
  cvReady ??= new Promise<{ cv: CV }>((resolve) => {
    const m = cvModule as Any;
    if (m.Mat) return resolve({ cv: m });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ cv: m });
    };
    m.onRuntimeInitialized = finish;
    // in case it initialized before we listened
    const poll = setInterval(() => {
      if (m.Mat) {
        clearInterval(poll);
        finish();
      }
    }, 50);
  });
  return cvReady;
}

/* ---------- similarity (move + rotate + zoom) fit with RANSAC ---------- */

interface Sim {
  a: number; // s·cosθ
  b: number; // s·sinθ
  tx: number;
  ty: number;
}

/** Least squares similarity q ≈ [a -b; b a]·p + t (complex-number regression). */
function fitSim(p: Float32Array, q: Float32Array, idx: number[]): Sim | null {
  const n = idx.length;
  if (n < 2) return null;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (const i of idx) {
    px += p[2 * i]; py += p[2 * i + 1];
    qx += q[2 * i]; qy += q[2 * i + 1];
  }
  px /= n; py /= n; qx /= n; qy /= n;
  let sxx = 0, a = 0, b = 0;
  for (const i of idx) {
    const ux = p[2 * i] - px, uy = p[2 * i + 1] - py;
    const vx = q[2 * i] - qx, vy = q[2 * i + 1] - qy;
    sxx += ux * ux + uy * uy;
    a += ux * vx + uy * vy;
    b += ux * vy - uy * vx;
  }
  if (sxx < 1e-9) return null;
  a /= sxx;
  b /= sxx;
  return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) };
}

function ransacSim(p: Float32Array, q: Float32Array, n: number, thresh: number): { sim: Sim; inliers: number } | null {
  if (n < 6) return null;
  let best: number[] = [];
  const t2 = thresh * thresh;
  const all = Array.from({ length: n }, (_, i) => i);
  // deterministic pseudo-random sampling (same result every time)
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < 250; it++) {
    const i = Math.floor(rnd() * n);
    let j = Math.floor(rnd() * n);
    if (i === j) j = (j + 1) % n;
    const m = fitSim(p, q, [i, j]);
    if (!m) continue;
    const s = Math.hypot(m.a, m.b);
    if (s < 0.8 || s > 1.25) continue; // cameras don't zoom that much between two frames
    const inl: number[] = [];
    for (let k = 0; k < n; k++) {
      const x = p[2 * k], y = p[2 * k + 1];
      const ex = m.a * x - m.b * y + m.tx - q[2 * k];
      const ey = m.b * x + m.a * y + m.ty - q[2 * k + 1];
      if (ex * ex + ey * ey < t2) inl.push(k);
    }
    if (inl.length > best.length) {
      best = inl;
      if (best.length > n * 0.85) break;
    }
  }
  if (best.length < Math.max(8, n * 0.25)) return null;
  // refine on all inliers, twice
  let sim = fitSim(p, q, best)!;
  for (let r = 0; r < 2; r++) {
    const inl = all.filter((k) => {
      const x = p[2 * k], y = p[2 * k + 1];
      const ex = sim.a * x - sim.b * y + sim.tx - q[2 * k];
      const ey = sim.b * x + sim.a * y + sim.ty - q[2 * k + 1];
      return ex * ex + ey * ey < t2;
    });
    if (inl.length >= 8) {
      sim = fitSim(p, q, inl) ?? sim;
      best = inl;
    }
  }
  return { sim, inliers: best.length };
}

/* ---------- analysis ---------- */

const cancelled = new Set<number>();

async function analyze(id: number, file: File, from: number, to: number) {
  const { cv } = await loadCv();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('El archivo no tiene vídeo');
  if (!(await track.canDecode())) throw new Error('Este dispositivo no puede decodificar este vídeo');
  const stats = await track.computePacketStats(120).catch(() => null);
  const srcFps = stats?.averagePacketRate || 30;
  const sampleFps = Math.min(MAX_SAMPLE_FPS, Math.round(srcFps));
  const dt = 1 / sampleFps;
  const W = ANALYSIS_WIDTH;
  const H = Math.max(2, Math.round((W * track.displayHeight) / track.displayWidth / 2) * 2);
  const sink = new CanvasSink(track, { width: W, height: H, fit: 'fill', poolSize: 2 });
  const times: number[] = [];
  // a quarter frame in, so rounding never lands on the previous frame
  const nudge = 0.25 / srcFps;
  const count0 = Math.max(2, Math.floor((to - from) / dt) + 1);
  for (let k = 0; k < count0; k++) times.push(from + k * dt + nudge);
  const n = times.length;
  // motion between sample i-1 and i: [dx, dy, da, ds] (dx/dy as a fraction of the frame size,
  // around the frame center; da in radians; ds = log of the zoom)
  // NaN = couldn't measure this step (filled in from its neighbours on the main thread)
  const motion = new Float32Array(n * 4).fill(NaN);
  motion.fill(0, 0, 4);
  const quality = new Float32Array(n);

  const center = { x: W / 2, y: H / 2 };
  // our own small canvas: copy each decoded frame here and read its pixels
  const work = new OffscreenCanvas(W, H);
  const wctx = work.getContext('2d', { willReadFrequently: true })!;
  const rgba = new cv.Mat(H, W, cv.CV_8UC4);
  const noMask = new cv.Mat();
  const win = new cv.Size(21, 21);
  const criteria = new cv.TermCriteria(3 /* COUNT + EPS */, 30, 0.01);
  let prev: Any = null;
  let i = 0;
  let lastReport = 0;
  try {
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (cancelled.has(id)) throw new Error('cancelled');
      if (!wc) {
        i++;
        continue;
      }
      wctx.drawImage(wc.canvas as CanvasImageSource, 0, 0, W, H);
      rgba.data.set(wctx.getImageData(0, 0, W, H).data);
      const curr = new cv.Mat();
      cv.cvtColor(rgba, curr, cv.COLOR_RGBA2GRAY);
      if (prev) {
        const corners = new cv.Mat();
        const next = new cv.Mat();
        const status = new cv.Mat();
        const err = new cv.Mat();
        const back = new cv.Mat();
        const status2 = new cv.Mat();
        const err2 = new cv.Mat();
        try {
          cv.goodFeaturesToTrack(prev, corners, 400, 0.005, 12, noMask, 3, false, 0.04);
          const count = corners.rows;
          if (count >= 8) {
            cv.calcOpticalFlowPyrLK(prev, curr, corners, next, status, err, win, 3, criteria);
            // forward-backward check: track back again and keep only points that return home
            cv.calcOpticalFlowPyrLK(curr, prev, next, back, status2, err2, win, 3, criteria);
            const st2 = status2.data as Uint8Array;
            const cb = back.data32F as Float32Array;
            const p = new Float32Array(count * 2);
            const q = new Float32Array(count * 2);
            let m = 0;
            const st = status.data as Uint8Array;
            const c0 = corners.data32F as Float32Array;
            const c1 = next.data32F as Float32Array;
            for (let k = 0; k < count; k++) {
              if (!st[k] || !st2[k]) continue;
              if (Math.hypot(cb[2 * k] - c0[2 * k], cb[2 * k + 1] - c0[2 * k + 1]) > 0.5) continue;
              p[2 * m] = c0[2 * k];
              p[2 * m + 1] = c0[2 * k + 1];
              q[2 * m] = c1[2 * k];
              q[2 * m + 1] = c1[2 * k + 1];
              m++;
            }
            const fit = ransacSim(p, q, m, 1.5);
            if (fit) {
              const { a, b, tx, ty } = fit.sim;
              // translation of the frame center: t_c = sR·c + t − c
              const tcx = a * center.x - b * center.y + tx - center.x;
              const tcy = b * center.x + a * center.y + ty - center.y;
              motion[4 * i] = tcx / W;
              motion[4 * i + 1] = tcy / H;
              motion[4 * i + 2] = Math.atan2(b, a);
              motion[4 * i + 3] = Math.log(Math.hypot(a, b));
              quality[i] = fit.inliers / Math.max(1, m);
            }
          }
        } finally {
          [corners, next, status, err, back, status2, err2].forEach((mat) => mat.delete());
        }
        prev.delete();
      }
      prev = curr;
      i++;
      const now = performance.now();
      if (now - lastReport > 250) {
        lastReport = now;
        postMessage({ type: 'progress', id, p: i / n });
      }
    }
  } finally {
    prev?.delete();
    rgba.delete();
    noMask.delete();
  }
  return { t0: from, dt, n, aspect: track.displayWidth / track.displayHeight, motion, quality };
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type !== 'analyze') return;
  try {
    const r = await analyze(msg.id, msg.file, msg.from, msg.to);
    postMessage({ type: 'done', id: msg.id, ...r }, { transfer: [r.motion.buffer, r.quality.buffer] });
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    cancelled.delete(msg.id);
  }
};
