import type { Clip, MediaItem, Track } from '../types';
import { decodeWithFx } from '../ai/voice';
import { flattenLeaves, leafGain, type Leaf } from './timeline';
import { projectDuration } from '../store/editor';

export interface MixJob {
  clips: Clip[];
  tracks: Track[];
  media: MediaItem[];
}

export function audibleLeaves(job: MixJob): Leaf[] {
  return flattenLeaves(job.clips, job.tracks).filter((l) => {
    if (l.muted || l.hidden || l.clip.type === 'image') return false;
    const m = job.media.find((x) => x.id === l.clip.mediaId);
    return !!m?.hasAudio && l.envelopes.every((e) => e.volume > 0 || !!e.vol);
  });
}

/**
 * Mixes the timeline audio between [from, to) seconds into an AudioBuffer
 * (volume, speed, fades, mute, compound clips and voice effects applied).
 * Mixing in windows keeps memory low even for multi-hour projects.
 */
export async function mixTimelineAudio(
  job: MixJob,
  sampleRate: number,
  channels: number,
  range?: { from: number; to: number },
  onProgress?: (p: number) => void,
): Promise<AudioBuffer> {
  const from = range?.from ?? 0;
  const to = range?.to ?? Math.max(0.1, projectDuration(job.clips));
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil((to - from) * sampleRate)), sampleRate);
  const leaves = audibleLeaves(job).filter((l) => l.t1 > from && l.t0 < to);

  let i = 0;
  for (const l of leaves) {
    const m = job.media.find((x) => x.id === l.clip.mediaId)!;
    const a = Math.max(l.t0, from);
    const b = Math.min(l.t1, to);
    const srcA = l.src0 + (a - l.t0) * l.rate;
    const srcB = Math.min(m.duration, srcA + (b - a) * l.rate);
    const buf = srcB > srcA ? await decodeWithFx(m, srcA, srcB, l.fx) : null;
    onProgress?.(++i / leaves.length);
    if (!buf) continue;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = l.rate;
    const gain = ctx.createGain();
    const constant = l.envelopes.every((e) => e.fadeIn === 0 && e.fadeOut === 0 && !e.vol);
    if (constant) gain.gain.value = leafGain(l, a);
    else {
      // sample the (product of) volume envelopes every 20 ms
      const n = Math.max(2, Math.ceil((b - a) * 50) + 1);
      const curve = new Float32Array(n);
      for (let k = 0; k < n; k++) curve[k] = leafGain(l, a + ((b - a) * k) / (n - 1));
      gain.gain.setValueCurveAtTime(curve, a - from, Math.max(0.001, b - a));
    }
    src.connect(gain).connect(ctx.destination);
    src.start(a - from, 0, Math.min(buf.duration, srcB - srcA));
  }
  return ctx.startRendering();
}
