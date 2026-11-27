import { AudioBufferSink, AudioBufferSource, BufferTarget, CanvasSink, CanvasSource, Mp4OutputFormat, Output, QUALITY_VERY_HIGH, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } from 'mediabunny';
import { MAIN_TRACK, useEditor } from '../store/editor';
import type { Clip, Key, KeyTracks, MediaClip, MediaItem } from '../types';
import { importFile, loadWaveform, openInput } from './media';

/**
 * Clip tools: "Congelar" (freeze frame) and "Revertir" (play a clip backwards).
 */

const find = (id: string) => useEditor.getState().clips.find((c) => c.id === id) as MediaClip | undefined;

/** The video clip to act on: the selected one under the playhead, else the main-track clip there. */
export function clipAtPlayhead(): MediaClip | null {
  const s = useEditor.getState();
  const t = s.time;
  const under = s.clips.filter((c): c is MediaClip => c.type === 'video' && t >= c.start && t < c.start + c.duration);
  return under.find((c) => s.selectedIds.includes(c.id)) ?? under.find((c) => c.trackId === MAIN_TRACK) ?? under[0] ?? null;
}

/* ---------------- Congelar ---------------- */

/**
 * Freezes the frame under the playhead for `seconds`: the clip is cut there and a still picture
 * (full quality, same position / color / crop as the clip) is put in between.
 */
export async function freezeFrame(seconds = 3) {
  const s = useEditor.getState();
  const clip = clipAtPlayhead();
  if (!clip) {
    s.setStatus('Pon la aguja sobre un clip de vídeo para congelar ese momento');
    return;
  }
  const media = s.media.find((m) => m.id === clip.mediaId);
  if (!media || media.missing) return;
  s.setStatus('Congelando fotograma…');
  const t = s.time;
  const srcT = clip.trimStart + (t - clip.start) * clip.speed;
  const track = await openInput(media.file).getPrimaryVideoTrack();
  if (!track) return;
  const frame = await new CanvasSink(track).getCanvas(Math.max(0, srcT));
  if (!frame) {
    s.setStatus('No se pudo leer ese fotograma');
    return;
  }
  const c = frame.canvas;
  const blob = 'convertToBlob' in c ? await (c as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.95 }) : await new Promise<Blob>((r) => (c as HTMLCanvasElement).toBlob((b) => r(b!), 'image/jpeg', 0.95));
  const base = media.name.replace(/\.[^.]+$/, '');
  const still = await importFile(new File([blob], `${base} congelado ${t.toFixed(1)}s.jpg`, { type: 'image/jpeg' }));
  still.generated = true;
  const st = useEditor.getState();
  st.checkpoint();
  st.addMedia(still);
  // cut the clip at the playhead (if not at its very start), then put the still picture in between
  const inside = t > clip.start + 0.05 && t < clip.start + clip.duration - 0.05;
  if (inside) {
    useEditor.setState({ selectedIds: [clip.id] });
    // (splitAtPlayhead acts on the selected clip under the playhead)
    const past = useEditor.getState().past;
    useEditor.getState().splitAtPlayhead();
    useEditor.setState({ past }); // one undo step for the whole freeze
  }
  const look: Partial<MediaClip> = {
    transform: { ...clip.transform },
    flipX: clip.flipX,
    flipY: clip.flipY,
    adjust: { ...clip.adjust },
    lut: clip.lut && { ...clip.lut },
    effect: clip.effect && { ...clip.effect },
    crop: clip.crop && { ...clip.crop },
    mask: clip.mask && { ...clip.mask },
    blend: clip.blend,
    opacity: clip.opacity,
    duration: seconds,
  };
  const past = useEditor.getState().past;
  useEditor.getState().addMediaClips([still.id], { trackId: clip.trackId === MAIN_TRACK ? MAIN_TRACK : undefined, start: t, patch: look });
  useEditor.setState({ past, status: `Fotograma congelado ${seconds} s` });
}

/* ---------------- Revertir ---------------- */

export interface ReverseJob {
  clipId: string;
  progress: number;
  label: string;
  ctrl: AbortController;
}
const jobs = new Map<string, ReverseJob>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export const onReverseJobs = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const reverseJob = (clipId: string) => jobs.get(clipId);
export const cancelReverse = (clipId: string) => jobs.get(clipId)?.ctrl.abort();

/** Undo "Revertir": back to the original video. */
export function unreverse(clipId: string) {
  const c = find(clipId);
  if (!c?.reversedFrom) return;
  useEditor.getState().updateClip(c.id, { mediaId: c.reversedFrom.mediaId, trimStart: c.reversedFrom.trimStart, reversedFrom: undefined, keyframes: c.keyframes && flipKeys(c.keyframes, c.trimStart, c.trimStart + c.duration * c.speed, c.reversedFrom.trimStart), stab: undefined });
}

/** Keyframes of a reversed piece [a, b] of the source, moved to the reversed file (which starts at `to`). */
function flipKeys(kf: KeyTracks, a: number, b: number, to: number): KeyTracks {
  const out: KeyTracks = {};
  for (const [p, keys] of Object.entries(kf)) {
    if (!keys?.length) continue;
    out[p] = keys.map((k): Key => ({ t: to + (b - k.t), v: k.v })).sort((x, y) => x.t - y.t);
  }
  return out;
}

/**
 * Plays the clip backwards: makes a reversed copy of the part of the video the clip uses
 * (picture and sound, full quality) and switches the clip to it. Takes a moment; undoable.
 */
export async function reverseClip(clipId: string) {
  const st0 = useEditor.getState();
  const clip = find(clipId);
  if (!clip || clip.type !== 'video' || jobs.has(clipId)) return;
  if (clip.reversedFrom) return unreverse(clipId);
  const media = st0.media.find((m) => m.id === clip.mediaId);
  if (!media || media.missing) return;
  const job: ReverseJob = { clipId, progress: 0, label: 'Preparando…', ctrl: new AbortController() };
  jobs.set(clipId, job);
  emit();
  try {
    const a = clip.trimStart;
    const b = Math.min(media.duration, clip.trimStart + clip.duration * clip.speed);
    const file = await makeReversed(media, a, b, job);
    const rev = await importFile(file);
    rev.generated = true;
    const st = useEditor.getState();
    st.addMedia(rev);
    loadWaveform(rev).then((w) => w && useEditor.getState().updateMedia(rev.id, { waveform: w }));
    const cur = find(clipId);
    if (cur) {
      st.updateClip(cur.id, {
        mediaId: rev.id,
        trimStart: 0,
        reversedFrom: { mediaId: cur.mediaId, trimStart: cur.trimStart },
        keyframes: cur.keyframes && flipKeys(cur.keyframes, a, b, 0),
        stab: undefined, // the camera motion has to be measured again on the reversed video
      });
      st.setStatus('Clip revertido');
    }
  } catch (e) {
    if (!job.ctrl.signal.aborted) useEditor.getState().setStatus(e instanceof Error ? e.message : 'No se pudo revertir');
  } finally {
    jobs.delete(clipId);
    emit();
  }
}

const yieldToUI = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

async function makeReversed(media: MediaItem, a: number, b: number, job: ReverseJob): Promise<File> {
  const input = openInput(media.file);
  const vtrack = await input.getPrimaryVideoTrack();
  if (!vtrack) throw new Error('El archivo no tiene vídeo');
  const atrack = media.hasAudio ? await input.getPrimaryAudioTrack() : null;
  const W = vtrack.displayWidth;
  const H = vtrack.displayHeight;
  const stats = await vtrack.computePacketStats(120).catch(() => null);
  const fps = Math.min(120, Math.max(1, Math.round(stats?.averagePacketRate ?? 30)));
  const dt = 1 / fps;
  const n = Math.max(1, Math.round((b - a) * fps));
  const quality = QUALITY_VERY_HIGH;
  const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H, quality });
  if (!vcodec) throw new Error('Este equipo no puede codificar vídeo de este tamaño');
  const acodec = atrack ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000, quality }) : null;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vsrc = new CanvasSource(canvas, { codec: vcodec, quality });
  output.addVideoTrack(vsrc, { frameRate: fps });
  const asrc = acodec ? new AudioBufferSource({ codec: acodec, quality }) : null;
  if (asrc) output.addAudioTrack(asrc);
  await output.start();

  // picture: decode short pieces from the end backwards and write their frames in reverse order
  const sink = new CanvasSink(vtrack, { poolSize: 0 });
  const CHUNK = Math.max(4, Math.round(fps / 8)); // frames per piece (keeps memory low with 4K)
  let written = 0;
  for (let end = n; end > 0; end -= CHUNK) {
    if (job.ctrl.signal.aborted) throw new Error('cancelled');
    const start = Math.max(0, end - CHUNK);
    const times = Array.from({ length: end - start }, (_, i) => a + (start + i + 0.5) * dt);
    const frames: (HTMLCanvasElement | OffscreenCanvas)[] = [];
    for await (const wc of sink.canvasesAtTimestamps(times)) if (wc) frames.push(wc.canvas);
    for (let i = frames.length - 1; i >= 0; i--) {
      ctx.drawImage(frames[i] as CanvasImageSource, 0, 0, W, H);
      await vsrc.add(written * dt, dt);
      written++;
    }
    job.progress = written / n;
    job.label = `Invirtiendo ${Math.round(job.progress * 100)}%`;
    emit();
    await yieldToUI();
  }

  // sound: decode the piece, flip it, encode
  if (asrc && atrack) {
    const chunks: AudioBuffer[] = [];
    for await (const { buffer } of new AudioBufferSink(atrack).buffers(a, b)) chunks.push(buffer);
    if (chunks.length) {
      const sr = chunks[0].sampleRate;
      const chs = chunks[0].numberOfChannels;
      const len = chunks.reduce((m, c) => m + c.length, 0);
      const outBuf = new AudioBuffer({ length: Math.max(1, len), numberOfChannels: chs, sampleRate: sr });
      for (let ch = 0; ch < chs; ch++) {
        const dst = outBuf.getChannelData(ch);
        let off = 0;
        for (const c of chunks) {
          dst.set(c.getChannelData(Math.min(ch, c.numberOfChannels - 1)), off);
          off += c.length;
        }
        dst.reverse();
      }
      // the encoder wants standard audio: 48 kHz stereo (cameras and phones use all sorts)
      const off = new OfflineAudioContext(2, Math.max(1, Math.ceil((outBuf.length * 48000) / sr)), 48000);
      const node = off.createBufferSource();
      node.buffer = outBuf;
      node.connect(off.destination);
      node.start();
      await asrc.add(await off.startRendering());
    }
  }
  job.label = 'Guardando…';
  emit();
  await output.finalize();
  const base = media.name.replace(/\.[^.]+$/, '');
  return new File([output.target.buffer!], `${base} (revertido).mp4`, { type: 'video/mp4' });
}

export const isReversible = (c: Clip | undefined): c is MediaClip => !!c && c.type === 'video';
