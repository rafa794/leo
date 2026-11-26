import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { MediaItem, MediaKind } from '../types';
import { uid, withTimeout } from './util';

const IMAGE_DEFAULT_DURATION = 5;
const THUMB_COUNT = 12;
const WAVE_POINTS = 1500;

export function detectKind(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  return null;
}

/** Opens a mediabunny Input for a file. Cached per file so we decode efficiently. */
const inputCache = new WeakMap<File, Input>();
export function openInput(file: File): Input {
  let input = inputCache.get(file);
  if (!input) {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    inputCache.set(file, input);
  }
  return input;
}

function loadElementMeta(url: string, kind: 'video' | 'audio') {
  return new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () =>
      resolve({
        duration: el.duration,
        width: (el as HTMLVideoElement).videoWidth || 0,
        height: (el as HTMLVideoElement).videoHeight || 0,
      });
    el.onerror = () => reject(new Error('No se pudo leer el archivo'));
    el.src = url;
  });
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen'));
    img.src = url;
  });
}

function canvasToDataUrl(src: CanvasImageSource, w: number, h: number, type: 'image/jpeg' | 'image/png' = 'image/jpeg') {
  const c = document.createElement('canvas');
  const th = 60;
  c.height = th;
  c.width = Math.max(1, Math.round((w / h) * th));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL(type, 0.7);
}

async function videoThumbnails(file: File, duration: number, count = THUMB_COUNT): Promise<string[]> {

  try {
    const input = openInput(file);
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('no decode');
    const sink = new CanvasSink(track, { height: 60, poolSize: 1 });
    const times = Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
    const out: string[] = [];
    const it = sink.canvasesAtTimestamps(times)[Symbol.asyncIterator]();
    try {
      for (;;) {
        // a decoder that doesn't answer in time → use the <video> fallback below
        const r = await withTimeout(it.next(), 6000);
        if (r.done) break;
        if (r.value) out.push(canvasToDataUrl(r.value.canvas, r.value.canvas.width, r.value.canvas.height));
      }
    } finally {
      void it.return?.(undefined);
    }
    return out;
  } catch {
    // Fallback: seek a <video> element
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.src = url;
    await withTimeout(new Promise((r) => (v.onloadeddata = r)), 15000).catch(() => {});
    const out: string[] = [];
    for (let i = 0; i < count && v.readyState >= 2; i++) {
      v.currentTime = (duration * (i + 0.5)) / count;
      const ok = await withTimeout(new Promise((r) => (v.onseeked = r)), 5000).then(() => true, () => false);
      if (ok) out.push(canvasToDataUrl(v, v.videoWidth, v.videoHeight));
    }
    URL.revokeObjectURL(url);
    return out;
  }
}

/** Computes waveform peaks by streaming-decoding the audio. */
async function computeWaveform(file: File, duration: number): Promise<number[] | undefined> {
  const peaks = new Array<number>(WAVE_POINTS).fill(0);
  try {
    const input = openInput(file);
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw new Error('no decode');
    const sink = new AudioBufferSink(track);
    const it = sink.buffers()[Symbol.asyncIterator]();
    for (;;) {
      const r = await withTimeout(it.next(), 8000);
      if (r.done) break;
      const { buffer, timestamp } = r.value;
      const data = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      for (let i = 0; i < data.length; i += 64) {
        const t = timestamp + i / sr;
        const idx = Math.min(WAVE_POINTS - 1, Math.floor((t / duration) * WAVE_POINTS));
        const v = Math.abs(data[i]);
        if (v > peaks[idx]) peaks[idx] = v;
      }
    }
  } catch {
    try {
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const data = buf.getChannelData(0);
      const step = data.length / WAVE_POINTS;
      for (let p = 0; p < WAVE_POINTS; p++) {
        let m = 0;
        for (let i = Math.floor(p * step); i < Math.floor((p + 1) * step); i += 16) m = Math.max(m, Math.abs(data[i]));
        peaks[p] = m;
      }
    } catch {
      return undefined;
    }
  }
  const max = Math.max(0.01, ...peaks);
  return peaks.map((p) => p / max);
}

async function detectHasAudio(file: File): Promise<boolean> {
  try {
    const track = await withTimeout(openInput(file).getPrimaryAudioTrack(), 8000);
    return !!track;
  } catch {
    return true;
  }
}

export async function importFile(file: File): Promise<MediaItem> {
  const kind = detectKind(file);
  if (!kind) throw new Error(`Formato no soportado: ${file.name}`);
  const url = URL.createObjectURL(file);
  const base = { id: uid(), name: file.name, kind, file, url };

  if (kind === 'image') {
    const img = await loadImage(url);
    return {
      ...base,
      duration: IMAGE_DEFAULT_DURATION,
      width: img.naturalWidth,
      height: img.naturalHeight,
      hasAudio: false,
      // PNG keeps transparency (stickers, logos)
      thumbnails: [canvasToDataUrl(img, img.naturalWidth, img.naturalHeight, 'image/png')],
    };
  }

  const meta = await loadElementMeta(url, kind);
  const hasAudio = kind === 'audio' ? true : await detectHasAudio(file);
  const item: MediaItem = {
    ...base,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    hasAudio,
    thumbnails: kind === 'video' ? await videoThumbnails(file, meta.duration) : [],
  };
  return item;
}

/** Long videos get more thumbnails (one every ~20 s, up to 240) in the background. */
export async function loadMoreThumbnails(item: MediaItem) {
  if (item.kind !== 'video') return undefined;
  const count = Math.min(240, Math.ceil(item.duration / 20));
  if (count <= THUMB_COUNT) return undefined;
  try {
    return await videoThumbnails(item.file, item.duration, count);
  } catch {
    return undefined;
  }
}

/** Waveform is computed lazily after import so the UI isn't blocked. */
export async function loadWaveform(item: MediaItem) {
  if (!item.hasAudio) return undefined;
  return computeWaveform(item.file, item.duration);
}

/**
 * Decodes the audio of a source between [from, to) seconds into a single AudioBuffer.
 * Used for export mixing and for transcription.
 */
export async function decodeAudioRange(file: File, from: number, to: number, onProgress?: (p: number) => void): Promise<AudioBuffer | null> {
  try {
    const track = await openInput(file).getPrimaryAudioTrack();
    if (!track) return null;
    if (!(await track.canDecode())) throw new Error('no decode');
    const sink = new AudioBufferSink(track);
    const parts: { buffer: AudioBuffer; timestamp: number }[] = [];
    for await (const wb of sink.buffers(from, to)) {
      parts.push(wb);
      onProgress?.(Math.min(1, (wb.timestamp + wb.duration - from) / Math.max(1e-6, to - from)));
    }
    if (!parts.length) return null;
    const sr = parts[0].buffer.sampleRate;
    const ch = parts[0].buffer.numberOfChannels;
    const length = Math.max(1, Math.ceil((to - from) * sr));
    const out = new AudioBuffer({ length, numberOfChannels: ch, sampleRate: sr });
    for (const p of parts) {
      const offset = Math.round((p.timestamp - from) * sr);
      for (let c = 0; c < ch; c++) {
        const src = p.buffer.getChannelData(Math.min(c, p.buffer.numberOfChannels - 1));
        const dst = out.getChannelData(c);
        let s = 0;
        let d = offset;
        if (d < 0) {
          s = -d;
          d = 0;
        }
        const n = Math.min(src.length - s, length - d);
        if (n > 0) dst.set(src.subarray(s, s + n), d);
      }
    }
    return out;
  } catch {
    // Fallback: decode the whole file with WebAudio and slice
    try {
      const ctx = new OfflineAudioContext(2, 1, 48000);
      const full = await ctx.decodeAudioData(await file.arrayBuffer());
      const sr = full.sampleRate;
      const s0 = Math.floor(from * sr);
      const len = Math.max(1, Math.min(full.length - s0, Math.ceil((to - from) * sr)));
      const out = new AudioBuffer({ length: len, numberOfChannels: full.numberOfChannels, sampleRate: sr });
      for (let c = 0; c < full.numberOfChannels; c++) out.getChannelData(c).set(full.getChannelData(c).subarray(s0, s0 + len));
      return out;
    } catch {
      return null;
    }
  }
}
