import {
  AudioBufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  type StreamTargetChunk,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import type { Clip, MediaClip, MediaItem, ProjectSettings, Track } from '../types';
import { openInput } from './media';
import { withTimeout } from './util';
import { renderFrame, type FrameSource } from './render';
import { audibleLeaves, mixTimelineAudio } from './audioMix';
import { flattenLeaves } from './timeline';
import { MAIN_TRACK, projectDuration } from '../store/editor';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  quality: 'medium' | 'high' | 'very-high';
}

export interface ExportJob {
  clips: Clip[];
  tracks: Track[];
  media: MediaItem[];
  settings: ProjectSettings;
}

const AUDIO_WINDOW = 30; // seconds of audio mixed at a time

/** A job that contains only one clip (normal or compound), moved to t = 0. */
export function singleClipJob(job: ExportJob, clipId: string): ExportJob {
  const clip = job.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error('Clip no encontrado');
  const track = job.tracks.find((t) => t.id === clip.trackId);
  const kind = track?.kind ?? 'video';
  const trackId = kind === 'video' ? MAIN_TRACK : 'solo';
  return {
    ...job,
    clips: [{ ...clip, start: 0, trackId } as Clip],
    tracks: [{ id: trackId, kind, muted: false, hidden: false }],
  };
}

/** Length of the video: hidden tracks (and silent audio tracks) don't make it longer. */
export function exportDuration(clips: Clip[], tracks: Track[]) {
  const counts = new Set(tracks.filter((t) => !t.hidden && !(t.kind === 'audio' && t.muted)).map((t) => t.id));
  return clips.reduce((m, c) => (counts.has(c.trackId) ? Math.max(m, c.start + c.duration) : m), 0);
}

/** A job with only the selected clips, keeping their tracks and relative timing, moved to t = 0. */
export function selectionJob(job: ExportJob, ids: string[]): ExportJob {
  const sel = job.clips.filter((c) => ids.includes(c.id));
  if (!sel.length) throw new Error('No hay clips seleccionados');
  const t0 = Math.min(...sel.map((c) => c.start));
  const used = new Set(sel.map((c) => c.trackId));
  return {
    ...job,
    clips: sel.map((c) => ({ ...c, start: c.start - t0 }) as Clip),
    // chosen on purpose: export them even if their track is hidden
    tracks: job.tracks.filter((t) => used.has(t.id)).map((t) => ({ ...t, hidden: false })),
  };
}

/** First H.264 profile this device can encode at this size ("avc1.PPCCLL"), or null. */
async function pickAvcProfile(width: number, height: number, fps: number): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const mbps = (width * height * fps) / 256; // macroblocks per second
  const level = mbps <= 108000 ? '1F' : mbps <= 245760 ? '28' : mbps <= 522240 ? '2A' : mbps <= 983040 ? '33' : '34';
  const bitrate = Math.round(width * height * fps * 0.12);
  for (const profile of ['6400', '4D40', '42E0']) {
    const codec = `avc1.${profile}${level}`;
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (r.supported) return codec;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const EXPORT_PREFIX = 'orion-export-';

/**
 * Where the video is written while it's made: a file on disk (the app's private storage), so even
 * multi-GB 4K videos don't have to fit in memory. Falls back to memory if that storage isn't available.
 */
async function diskTarget() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const name = `${EXPORT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`;
    const fh = await root.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    return {
      target: new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true }),
      file: () => fh.getFile(),
      remove: () => root.removeEntry(name).catch(() => {}),
    };
  } catch {
    return null;
  }
}

/** Deletes old export files from the app's private storage (the videos were already saved for you). */
export async function cleanupExportFiles(olderThanMs = 6 * 3600_000) {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    const now = Date.now();
    for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) {
      if (!name.startsWith(EXPORT_PREFIX)) continue;
      const t = Number(name.slice(EXPORT_PREFIX.length).split('-')[0]);
      if (!t || now - t > olderThanMs) await root.removeEntry(name).catch(() => {});
    }
  } catch {
    /* not important */
  }
}

/** Removes one export file (when you close it in the exports list). */
export async function removeExportFile(name: string) {
  if (!name.startsWith(EXPORT_PREFIX)) return;
  try {
    await (await navigator.storage.getDirectory()).removeEntry(name);
  } catch {
    /* already gone */
  }
}

/** Gives the browser a moment to handle clicks and draw (not slowed down in background tabs, unlike setTimeout). */
const yieldToUI = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

type FramePuller = { next: () => Promise<FrameSource | null>; close: () => void };

/** Frame-accurate decoding using WebCodecs (mediabunny), with a <video> seek fallback. */
async function createPuller(clip: MediaClip, media: MediaItem, times: number[]): Promise<FramePuller> {
  if (clip.type === 'image') {
    const img = new Image();
    img.src = media.url;
    await img.decode();
    const src = { image: img, width: img.naturalWidth, height: img.naturalHeight };
    return { next: async () => src, close: () => {} };
  }
  try {
    const track = await openInput(media.file).getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('fallback');
    const sink = new CanvasSink(track, { poolSize: 2 });
    const iter = sink.canvasesAtTimestamps(times)[Symbol.asyncIterator]();
    let last: FrameSource | null = null;
    // make sure this device's decoder really answers (otherwise use the <video> fallback)
    let first: IteratorResult<{ canvas: HTMLCanvasElement | OffscreenCanvas } | null> | null = await withTimeout(iter.next(), 8000).catch(() => {
      void iter.return?.(undefined);
      throw new Error('fallback');
    });
    return {
      next: async () => {
        const r = first ?? (await withTimeout(iter.next(), 20000, 'El decodificador de vídeo de este dispositivo no responde'));
        first = null;
        if (!r.done && r.value) last = { image: r.value.canvas, width: r.value.canvas.width, height: r.value.canvas.height };
        return last;
      },
      close: () => void iter.return?.(undefined),
    };
  } catch {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = media.url;
    await new Promise((r, j) => {
      v.onloadeddata = r;
      v.onerror = j;
    });
    let i = 0;
    return {
      next: async () => {
        const t = times[i++] ?? times[times.length - 1];
        if (Math.abs(v.currentTime - t) > 0.001) {
          v.currentTime = t;
            await withTimeout(new Promise((r) => (v.onseeked = r)), 20000, 'No se pudo leer el vídeo');
        }
        return { image: v, width: v.videoWidth, height: v.videoHeight };
      },
      close: () => v.removeAttribute('src'),
    };
  }
}

export async function exportVideo(
  job: ExportJob,
  opts: ExportOptions,
  onProgress: (p: number, label: string) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const { clips, tracks, media } = job;
  const { width, height, fps } = opts;
  const duration = exportDuration(clips, tracks);
  if (duration <= 0) throw new Error('No hay nada visible que exportar (¿pistas ocultas?)');
  const used = new Set(flattenLeaves(clips, tracks).map((l) => l.clip.mediaId));
  const lost = media.filter((m) => m.missing && used.has(m.id));
  if (lost.length) throw new Error(`Faltan ${lost.length} vídeo(s): elige su carpeta en el aviso de arriba antes de exportar (${lost.map((m) => m.name).join(', ')})`);
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const quality = opts.quality === 'medium' ? QUALITY_MEDIUM : opts.quality === 'very-high' ? QUALITY_VERY_HIGH : QUALITY_HIGH;

  // H.264 is what every social network expects. Some phones only encode its simpler profiles,
  // so try High → Main → Baseline before falling back to other codecs.
  const avcString = await pickAvcProfile(width, height, fps);
  const videoCodec = avcString ? 'avc' : await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height, quality });
  if (!videoCodec) throw new Error('Tu navegador no puede codificar vídeo. Usa Google Chrome actualizado.');
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000, quality });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  // written straight to disk; 'reserve' still puts the index at the start (good for uploading to social networks)
  const disk = await diskTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: disk ? 'reserve' : 'in-memory' }), target: disk?.target ?? new BufferTarget() });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality, ...(avcString && videoCodec === 'avc' ? { fullCodecString: avcString } : {}) });
  output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: totalFrames + 30 });

  const hasAudio = audioCodec && audibleLeaves(job).length > 0;
  const audioSource = hasAudio ? new AudioBufferSource({ codec: audioCodec!, quality }) : null;
  // (AAC ≈ 47 and Opus 50 packets per second)
  if (audioSource) output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(duration * 52) + 200 });
  await output.start();

  // ---- one frame puller per visible leaf clip (compound clips are resolved into their leaves)
  const leaves = flattenLeaves(clips, tracks).filter((l) => !l.hidden && l.clip.type !== 'audio');
  const pullers = new Map<string, { p: FramePuller; f0: number; f1: number }>();
  const current = new Map<string, FrameSource | null>();
  for (const l of leaves) {
    const m = media.find((x) => x.id === l.clip.mediaId);
    if (!m) continue;
    const f0 = Math.ceil(l.t0 * fps - 1e-6);
    const f1 = Math.ceil(l.t1 * fps - 1e-6);
    const times: number[] = [];
    for (let f = f0; f < f1; f++) times.push(Math.max(0, Math.min(m.duration - 0.001, l.src0 + (f / fps - l.t0) * l.rate)));
    pullers.set(l.key, { p: await createPuller(l.clip, m, times), f0, f1 });
  }
  const pool = new Map<string, HTMLCanvasElement>();

  // ---- audio, mixed lazily in windows
  let mixed: AudioBuffer | null = null;
  let mixedFrom = -1;
  let audioSec = 0;
  const audioChunk = async (sec: number) => {
    if (sec >= duration) return null;
    const w = Math.floor(sec / AUDIO_WINDOW) * AUDIO_WINDOW;
    if (w !== mixedFrom) {
      onProgress(sec / duration, 'Mezclando audio…');
      mixed = await mixTimelineAudio(job, 48000, 2, { from: w, to: Math.min(duration, w + AUDIO_WINDOW) });
      mixedFrom = w;
    }
    const buf = mixed!;
    const sr = buf.sampleRate;
    const s0 = Math.round((sec - w) * sr);
    const len = Math.min(sr, buf.length - s0, Math.round((duration - sec) * sr));
    if (len <= 0) return null;
    const chunk = new AudioBuffer({ length: len, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
    for (let ch = 0; ch < buf.numberOfChannels; ch++) chunk.copyToChannel(buf.getChannelData(ch).subarray(s0, s0 + len), ch);
    return chunk;
  };

  let lastYield = performance.now();
  try {
    for (let f = 0; f < totalFrames; f++) {
      if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      const t = f / fps;
      for (const [key, { p, f0, f1 }] of pullers) if (f >= f0 && f < f1) current.set(key, await p.next());
      renderFrame(ctx, width, height, {
        time: t,
        tracks,
        clips,
        settings: job.settings,
        getSource: (_c, key) => current.get(key) ?? null,
        pool,
      });
      await videoSource.add(t, 1 / fps);

      // keep audio roughly in step with video
      while (audioSource && audioSec <= t + 1 && audioSec < duration) {
        const chunk = await audioChunk(audioSec);
        audioSec++;
        if (chunk) await audioSource.add(chunk);
      }
      if (f % 5 === 0) onProgress(f / totalFrames, `Renderizando ${f}/${totalFrames} fotogramas`);
      // let the editor breathe: exports run in the background while you keep editing
      if (performance.now() - lastYield > 12) {
        await yieldToUI();
        lastYield = performance.now();
      }
    }
    while (audioSource && audioSec < duration) {
      const chunk = await audioChunk(audioSec++);
      if (chunk) await audioSource.add(chunk);
    }
    onProgress(1, 'Finalizando archivo…');
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    await disk?.remove();
    throw e;
  } finally {
    pullers.forEach(({ p }) => p.close());
  }
  if (disk) return await disk.file(); // a file on disk: no size limit
  return new Blob([(output.target as BufferTarget).buffer!], { type: 'video/mp4' });
}
