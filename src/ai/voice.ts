import { useSyncExternalStore } from 'react';
import type { AudioFx, MediaItem } from '../types';
import { decodeAudioRange } from '../lib/media';

const SR = 48000;
const PREROLL = 1; // seconds of audio fed before the range so the model is "warmed up"
export const MAX_FX_SECONDS = 30 * 60;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (e: Error) => void; progress?: (p: number) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (typeof e.data.progress === 'number') return p.progress?.(e.data.progress);
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.channels);
    };
  }
  return worker;
}

async function resample(buf: AudioBuffer, sr: number) {
  if (buf.sampleRate === sr) return buf;
  const ctx = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * sr), sr);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

/** Applies a voice effect to an AudioBuffer (returns a new 48 kHz buffer). */
export async function applyVoiceFx(buf: AudioBuffer, fx: Exclude<AudioFx, 'none'>, onProgress?: (p: number) => void): Promise<AudioBuffer> {
  const b = await resample(buf, SR);
  const channels = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i).slice());
  const id = nextId++;
  const result = await new Promise<Float32Array[]>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress: onProgress });
    getWorker().postMessage({ id, channels, mode: fx }, channels.map((c) => c.buffer));
  });
  const out = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: SR });
  result.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return out;
}

/** Decodes [from, to) of a media file, applying a voice effect if requested. */
export async function decodeWithFx(media: MediaItem, from: number, to: number, fx: AudioFx, onProgress?: (p: number) => void): Promise<AudioBuffer | null> {
  if (fx === 'none') return decodeAudioRange(media.file, from, to, onProgress);
  const pre = Math.min(PREROLL, from);
  // progress: reading the audio ≈ first quarter, the AI the rest
  const raw = await decodeAudioRange(media.file, from - pre, to, (p) => onProgress?.(p * 0.25));
  if (!raw) return null;
  onProgress?.(0.28);
  const processed = await applyVoiceFx(raw, fx, (p) => onProgress?.(0.3 + p * 0.7));
  const skip = Math.round(pre * SR);
  const len = Math.max(1, processed.length - skip);
  const out = new AudioBuffer({ length: len, numberOfChannels: processed.numberOfChannels, sampleRate: SR });
  for (let c = 0; c < processed.numberOfChannels; c++) out.copyToChannel(processed.getChannelData(c).subarray(skip), c);
  return out;
}

/* ---------- cache for the real-time preview ---------- */

type Entry = { status: 'processing' | 'ready' | 'error'; buffer?: AudioBuffer; from: number; to: number; progress: number };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
export const onFxReady = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const fxProcessingCount = () => [...cache.values()].filter((e) => e.status === 'processing').length;

/**
 * Returns the processed audio for a source range if it's ready; otherwise starts processing it
 * in the background and returns undefined (the preview plays the original meanwhile).
 */
export function getPreviewFx(media: MediaItem, from: number, to: number, fx: Exclude<AudioFx, 'none'>): Entry | undefined {
  // reuse any processed range that already covers this one (so trimming doesn't reprocess)
  const prefix = `${media.id}|${fx}|`;
  for (const [k, e] of cache) if (k.startsWith(prefix) && e.status !== 'error' && e.from <= from + 0.01 && e.to >= to - 0.01) return e;
  // process the whole file when it's short, otherwise whole minutes around the range
  const a = media.duration <= MAX_FX_SECONDS ? 0 : Math.max(0, Math.floor(from / 60) * 60);
  const b = media.duration <= MAX_FX_SECONDS ? media.duration : Math.min(media.duration, Math.ceil(to / 60) * 60);
  const key = `${prefix}${a.toFixed(2)}|${b.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (b - a > MAX_FX_SECONDS) {
    const e: Entry = { status: 'error', from: a, to: b, progress: 0 };
    cache.set(key, e);
    return e;
  }
  const entry: Entry = { status: 'processing', from: a, to: b, progress: 0 };
  cache.set(key, entry);
  listeners.forEach((l) => l());
  decodeWithFx(media, a, b, fx, (p) => {
    // tell the UI every whole percent
    if (Math.floor(p * 100) > Math.floor(entry.progress * 100)) {
      entry.progress = p;
      listeners.forEach((l) => l());
    }
  })
    .then((buffer) => {
      entry.status = buffer ? 'ready' : 'error';
      entry.buffer = buffer ?? undefined;
      entry.progress = 1;
    })
    .catch(() => (entry.status = 'error'))
    .finally(() => listeners.forEach((l) => l()));
  return entry;
}

/**
 * State of a voice effect for one video / audio file, for the progress bars:
 * null = not started yet, otherwise 'processing' (with 0..1 progress), 'ready' or 'error'.
 */
export function fxStatus(mediaId: string, fx: AudioFx): { status: Entry['status']; progress: number } | null {
  if (fx === 'none') return null;
  const prefix = `${mediaId}|${fx}|`;
  const list = [...cache].filter(([k]) => k.startsWith(prefix)).map(([, e]) => e);
  if (!list.length) return null;
  const busy = list.filter((e) => e.status === 'processing');
  if (busy.length) return { status: 'processing', progress: busy.reduce((a, e) => a + e.progress, 0) / busy.length };
  return list.some((e) => e.status === 'ready') ? { status: 'ready', progress: 1 } : { status: 'error', progress: 0 };
}

let version = 0;
onFxReady(() => version++);
/** Re-renders a component whenever a voice effect advances or finishes. */
export function useFxStatus(mediaId: string | undefined, fx: AudioFx | undefined) {
  useSyncExternalStore(onFxReady, () => version);
  return mediaId && fx ? fxStatus(mediaId, fx) : null;
}
