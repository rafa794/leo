import { BufferTarget, CanvasSink, Conversion, Mp4OutputFormat, Output, QUALITY_VERY_HIGH } from 'mediabunny';
import { useEditor } from '../store/editor';
import type { Key, KeyTracks, MediaClip, MediaItem } from '../types';
import { importFile, loadWaveform, openInput } from './media';

/**
 * "Borrar objetos" (beta): the user paints what to remove on a frame of the clip; MI-GAN (src/ai/inpaint.worker.ts)
 * fills it in. On a photo it makes a new picture; on a video it repaints the same area on every frame of the part the
 * clip uses (works best with a steady camera and things that stay in place: logos, a person standing, a bin…).
 * Both make new media inside the project (`generated`), switch the clip to it, and can be undone.
 */

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (v: Uint8ClampedArray | null) => void; reject: (e: Error) => void }>();
const base = () => new URL(import.meta.env.BASE_URL, location.href).href;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../ai/inpaint.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; rgba?: Uint8ClampedArray; error?: string }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.resolve(e.data.rgba ?? null);
    else w.reject(new Error(e.data.error || 'No se pudo borrar'));
  };
  worker.onerror = (e) => {
    waiting.forEach((w) => w.reject(new Error(e.message || 'No se pudo cargar el borrador')));
    waiting.clear();
    worker = null;
  };
  return worker;
}

function call(msg: Record<string, unknown>, transfer: Transferable[] = []) {
  const id = ++seq;
  return new Promise<Uint8ClampedArray | null>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id, base: base() }, transfer);
  });
}

/** Loads the model ahead of time (the first use takes a few seconds). */
export const warmupEraser = () => call({ warmup: true }).then(() => undefined);

/** Bounding box of the painted area (null if nothing is painted). */
export function maskBox(mask: Uint8Array, w: number, h: number) {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * The square-ish area sent to the model: the painted box with plenty of surroundings (the model needs context to
 * guess what is behind), at least 512 px, inside the picture. Keeps 4K frames fast.
 */
export function cropAround(box: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number) {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const side = Math.min(Math.max(w, h), Math.max(512, Math.round(Math.max(bw, bh) * 2.5)));
  const cw = Math.min(w, side);
  const ch = Math.min(h, side);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const x = Math.round(Math.max(0, Math.min(w - cw, cx - cw / 2)));
  const y = Math.round(Math.max(0, Math.min(h - ch, cy - ch / 2)));
  return { x, y, w: cw, h: ch };
}

/** Fills the painted area of a canvas (in place). `mask` is the canvas size, 255 = erase. */
export async function eraseOnCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, mask: Uint8Array) {
  const w = canvas.width;
  const h = canvas.height;
  const box = maskBox(mask, w, h);
  if (!box) return;
  const c = cropAround(box, w, h);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const img = ctx.getImageData(c.x, c.y, c.w, c.h);
  const m = new Uint8Array(c.w * c.h);
  for (let y = 0; y < c.h; y++) m.set(mask.subarray((c.y + y) * w + c.x, (c.y + y) * w + c.x + c.w), y * c.w);
  const out = await call({ width: c.w, height: c.h, rgba: img.data, mask: m }, [img.data.buffer, m.buffer]);
  if (out) ctx.putImageData(new ImageData(new Uint8ClampedArray(out), c.w, c.h), c.x, c.y);
}

/* ---------------- jobs (progress shown in the dialog) ---------------- */

export interface EraseJob {
  clipId: string;
  progress: number;
  label: string;
  ctrl: AbortController;
}
const jobs = new Map<string, EraseJob>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export const onEraseJobs = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const eraseJob = (clipId: string) => jobs.get(clipId);
export const cancelErase = (clipId: string) => jobs.get(clipId)?.ctrl.abort();

const find = (id: string) => useEditor.getState().clips.find((c) => c.id === id) as MediaClip | undefined;

/** Keyframes (source time) moved to a file that starts at source second `a`. */
function shiftKeys(kf: KeyTracks | undefined, a: number): KeyTracks | undefined {
  if (!kf) return kf;
  const out: KeyTracks = {};
  for (const [p, keys] of Object.entries(kf)) if (keys?.length) out[p] = keys.map((k): Key => ({ t: k.t - a, v: k.v }));
  return out;
}

/** The source frame the editor shows for this clip at the playhead (full size), for painting the mask on. */
export async function sourceFrame(clip: MediaClip, media: MediaItem, time: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  if (media.kind === 'image') {
    const img = new Image();
    img.src = media.url;
    await img.decode();
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return canvas;
  }
  const t = Math.max(0, Math.min(media.duration - 0.001, clip.trimStart + (Math.max(clip.start, Math.min(time, clip.start + clip.duration - 0.001)) - clip.start) * clip.speed));
  const track = await openInput(media.file).getPrimaryVideoTrack();
  if (!track) throw new Error('No se pudo leer el vídeo');
  const frame = await new CanvasSink(track).getCanvas(t);
  if (!frame) throw new Error('No se pudo leer ese fotograma');
  canvas.width = frame.canvas.width;
  canvas.height = frame.canvas.height;
  canvas.getContext('2d')!.drawImage(frame.canvas, 0, 0);
  return canvas;
}

/** Photo: erase and switch the clip to the new picture. `mask` is the photo's size. */
export async function eraseInImage(clipId: string, mask: Uint8Array) {
  const st = useEditor.getState();
  const clip = find(clipId);
  const media = clip && st.media.find((m) => m.id === clip.mediaId);
  if (!clip || !media) return;
  const canvas = await sourceFrame(clip, media, st.time);
  await eraseOnCanvas(canvas, mask);
  const png = /\.png$/i.test(media.name);
  const type = png ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), type, 0.95));
  const name = `${media.name.replace(/\.[^.]+$/, '')} (sin objetos).${png ? 'png' : 'jpg'}`;
  const item = await importFile(new File([blob], name, { type }));
  item.generated = true;
  const s = useEditor.getState();
  s.checkpoint();
  s.addMedia(item);
  s.updateClip(clipId, { mediaId: item.id }, false);
  s.setStatus('Objeto borrado');
}

/**
 * Video: repaints the area on every frame of the part of the video the clip uses (sound copied as is), then switches
 * the clip to the new file. Slow on purpose-free hardware: about the model's time per frame.
 */
export async function eraseInVideo(clipId: string, mask: Uint8Array, maskW: number, maskH: number) {
  const st0 = useEditor.getState();
  const clip = find(clipId);
  const media = clip && st0.media.find((m) => m.id === clip.mediaId);
  if (!clip || !media || media.kind !== 'video' || jobs.has(clipId)) return;
  const job: EraseJob = { clipId, progress: 0, label: 'Cargando el modelo…', ctrl: new AbortController() };
  jobs.set(clipId, job);
  emit();
  try {
    await warmupEraser();
    const a = clip.trimStart;
    const b = Math.min(media.duration, clip.trimStart + clip.duration * clip.speed);
    const input = openInput(media.file);
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    let canvas: OffscreenCanvas | null = null;
    let scaled: Uint8Array | null = null;
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start: a, end: b },
      video: {
        forceTranscode: true,
        bitrate: QUALITY_VERY_HIGH,
        process: async (sample) => {
          if (job.ctrl.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
          const w = sample.displayWidth;
          const h = sample.displayHeight;
          if (!canvas || canvas.width !== w || canvas.height !== h) {
            canvas = new OffscreenCanvas(w, h);
            scaled = scaleMask(mask, maskW, maskH, w, h);
          }
          const ctx = canvas.getContext('2d')!;
          sample.draw(ctx, 0, 0, w, h);
          await eraseOnCanvas(canvas, scaled!);
          return canvas;
        },
      },
    });
    if (!conversion.isValid) throw new Error('Este vídeo no se puede procesar en este dispositivo');
    conversion.onProgress = (p) => {
      job.progress = p;
      job.label = `Borrando… ${Math.round(p * 100)} %`;
      emit();
    };
    job.ctrl.signal.addEventListener('abort', () => void conversion.cancel());
    await conversion.execute();
    const buf = (output.target as BufferTarget).buffer!;
    const item = await importFile(new File([buf], `${media.name.replace(/\.[^.]+$/, '')} (sin objetos).mp4`, { type: 'video/mp4' }));
    item.generated = true;
    const st = useEditor.getState();
    st.addMedia(item);
    loadWaveform(item).then((wf) => wf && useEditor.getState().updateMedia(item.id, { waveform: wf }));
    const cur = find(clipId);
    if (cur) {
      st.checkpoint();
      st.updateClip(cur.id, { mediaId: item.id, trimStart: 0, keyframes: shiftKeys(cur.keyframes, a), stab: undefined, reversedFrom: undefined }, false);
      st.setStatus('Objeto borrado del vídeo');
    }
  } catch (e) {
    if (!job.ctrl.signal.aborted) useEditor.getState().setStatus(e instanceof Error ? e.message : 'No se pudo borrar');
  } finally {
    jobs.delete(clipId);
    emit();
  }
}

/** Nearest-neighbour resize of a mask (the painting is done on one frame; video frames may be another size). */
export function scaleMask(mask: Uint8Array, w: number, h: number, W: number, H: number) {
  if (w === W && h === H) return mask;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    for (let x = 0; x < W; x++) out[y * W + x] = mask[sy + Math.min(w - 1, Math.floor((x * w) / W))];
  }
  return out;
}
