import type { AudioFx, Clip, MediaClip, MediaItem, Track } from '../types';
import { isMediaClip } from '../types';
import { valueAt } from './keyframes';

/** Volume envelope of one clip level, expressed in outer (timeline) time. */
export interface Envelope {
  start: number;
  end: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** volume keyframes, as a function of outer (timeline) time */
  vol?: (t: number) => number;
}

/**
 * A playable leaf (a real video/audio/image clip) after resolving every compound clip
 * it lives in. Source time at timeline time t is `src0 + (t - t0) * rate`.
 */
export interface Leaf {
  key: string; // unique path, e.g. "compoundId/clipId"
  clip: MediaClip;
  t0: number;
  t1: number;
  src0: number;
  rate: number;
  envelopes: Envelope[];
  muted: boolean;
  hidden: boolean;
  fx: AudioFx;
}

interface Mapping {
  A: number; // outer time of local time B
  B: number;
  r: number; // local seconds per outer second
  w0: number; // visible window in outer time
  w1: number;
}

const toOuter = (m: Mapping, u: number) => m.A + (u - m.B) / m.r;

export function envelopeGain(e: Envelope, t: number) {
  let v = e.vol ? e.vol(t) : e.volume;
  if (e.fadeIn > 0 && t < e.start + e.fadeIn) v *= Math.max(0, (t - e.start) / e.fadeIn);
  if (e.fadeOut > 0 && t > e.end - e.fadeOut) v *= Math.max(0, (e.end - t) / e.fadeOut);
  return v;
}

export const leafGain = (l: Leaf, t: number) => l.envelopes.reduce((g, e) => g * envelopeGain(e, t), 1);

export function flattenLeaves(
  clips: Clip[],
  tracks: Track[],
  path = '',
  // w0 = −∞: a clip can briefly sit below 0 s while its left edge is dragged (preview shows that frame)
  map: Mapping = { A: 0, B: 0, r: 1, w0: -Infinity, w1: Infinity },
  inherited: { envelopes: Envelope[]; muted: boolean; hidden: boolean; fx: AudioFx } = { envelopes: [], muted: false, hidden: false, fx: 'none' },
): Leaf[] {
  const out: Leaf[] = [];
  for (const c of clips) {
    if (!isMediaClip(c)) continue;
    const track = tracks.find((t) => t.id === c.trackId);
    const t0 = Math.max(map.w0, toOuter(map, c.start));
    const t1 = Math.min(map.w1, toOuter(map, c.start + c.duration));
    if (t1 <= t0 + 1e-9) continue;
    const env: Envelope = { start: toOuter(map, c.start), end: toOuter(map, c.start + c.duration), volume: c.volume, fadeIn: c.fadeIn / map.r, fadeOut: c.fadeOut / map.r };
    if (c.keyframes?.volume?.length) {
      const m = map;
      env.vol = (t) => Math.max(0, valueAt(c, 'volume', m.B + (t - m.A) * m.r));
    }
    const ctx = {
      envelopes: [...inherited.envelopes, env],
      muted: inherited.muted || !!track?.muted || !!c.muted,
      hidden: inherited.hidden || !!track?.hidden,
      fx: inherited.fx !== 'none' ? inherited.fx : (c.audioFx ?? 'none'),
    };
    if (c.type === 'compound' && c.compound) {
      const inner: Mapping = {
        A: toOuter(map, c.start),
        B: c.trimStart,
        r: map.r * c.speed,
        w0: t0,
        w1: t1,
      };
      out.push(...flattenLeaves(c.compound.clips, c.compound.tracks, `${path}${c.id}/`, inner, ctx));
    } else {
      const u0 = map.B + (t0 - map.A) * map.r;
      out.push({
        key: path + c.id,
        clip: c,
        t0,
        t1,
        src0: c.trimStart + (u0 - c.start) * c.speed,
        rate: map.r * c.speed,
        ...ctx,
      });
    }
  }
  return out;
}

/** Length of the source a clip reads from (Infinity for still images). */
export function sourceDuration(c: MediaClip, media?: MediaItem) {
  if (c.type === 'compound') return c.compound?.duration ?? c.duration;
  if (c.type === 'image') return Infinity;
  return media?.duration ?? c.duration;
}

/** Does this clip (or anything inside it) produce sound? */
export function clipHasAudio(c: MediaClip, media: MediaItem[]): boolean {
  if (c.type === 'compound') return !!c.compound?.clips.some((x) => isMediaClip(x) && clipHasAudio(x, media));
  if (c.type === 'image') return false;
  return !!media.find((m) => m.id === c.mediaId)?.hasAudio;
}

export const isAudioKind = (c: Clip) => c.type === 'audio' || (c.type === 'compound' && c.compound?.kind === 'audio');
