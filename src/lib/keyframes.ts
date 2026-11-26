import type { Key, KeyTracks, MediaClip } from '../types';

/**
 * Keyframes for ANY numeric setting of a clip ("fotogramas clave").
 * Each property path ('transform.x', 'adjust.temp', 'volume', 'mask.w'…) has its own list of keys.
 * Key times are in SOURCE seconds, so they stay on the same moment of the footage when the clip
 * is cut, trimmed or sped up.
 */

/** Two keyframes closer than this (source seconds) are the same one. */
export const KF_EPS = 1 / 60;

export const TRANSFORM_KEYS = ['transform.x', 'transform.y', 'transform.scale', 'transform.rotation'];

/** Timeline time → time inside the clip's source. */
export const srcTime = (c: MediaClip, t: number) => c.trimStart + (t - c.start) * c.speed;
/** Source time → timeline time. */
export const timelineTime = (c: MediaClip, src: number) => c.start + (src - c.trimStart) / c.speed;

/* ---------- generic paths ---------- */

export function getPath(obj: unknown, path: string): number {
  let o = obj as Record<string, unknown> | undefined;
  for (const p of path.split('.')) o = o?.[p] as Record<string, unknown> | undefined;
  return typeof o === 'number' ? o : 0;
}

/** Immutable set of a nested value. Missing objects along the path are created. */
export function withPath<T>(obj: T, path: string, v: unknown): T {
  const [head, ...rest] = path.split('.');
  const o = (obj ?? {}) as Record<string, unknown>;
  return { ...o, [head]: rest.length ? withPath(o[head], rest.join('.'), v) : v } as T;
}

/* ---------- evaluation ---------- */

const geometric = (path: string) => path === 'transform.scale';

export function interp(keys: Key[], s: number, path = ''): number {
  if (s <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (s >= last.t) return last.v;
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= s) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const u = (s - a.t) / (b.t - a.t || 1);
  // zooms feel even when the scale changes geometrically
  if (geometric(path) && a.v > 0 && b.v > 0) return a.v * Math.pow(b.v / a.v, u);
  return a.v + (b.v - a.v) * u;
}

const tracksOf = (c: MediaClip): [string, Key[]][] => Object.entries(c.keyframes ?? {}).filter((e): e is [string, Key[]] => !!e[1]?.length);

/** Is source time s inside the part of the source this clip shows? */
const inRange = (c: MediaClip, s: number) => s >= c.trimStart - KF_EPS && s <= c.trimStart + c.duration * c.speed + KF_EPS;

/**
 * Keyframes that count for this clip: only those inside its visible part.
 * After a cut (or trimming an edge) the keyframes left outside have NO effect,
 * so each piece only animates with its own keyframes.
 */
export const liveKeys = (c: MediaClip, path: string) => (c.keyframes?.[path] ?? []).filter((k) => inRange(c, k.t));
const liveTracks = (c: MediaClip): [string, Key[]][] => tracksOf(c).map(([p, ks]) => [p, ks.filter((k) => inRange(c, k.t))] as [string, Key[]]).filter(([, ks]) => ks.length > 0);

/** Drops the keyframes outside the clip's visible part (used when cutting a clip in two). */
export function pruneKeys(c: MediaClip): MediaClip {
  if (!c.keyframes) return c;
  let out = c;
  for (const [p, keys] of tracksOf(c)) {
    const left = keys.filter((k) => inRange(c, k.t));
    if (left.length !== keys.length) out = setTrack(out, p, left);
  }
  return out;
}

export const hasKeys = (c: MediaClip, paths?: string[]) => tracksOf(c).some(([p]) => !paths || paths.includes(p));

/** Value of a property at timeline time t (keyframed or not). */
export function valueAt(c: MediaClip, path: string, t: number) {
  const keys = liveKeys(c, path);
  return keys.length ? interp(keys, srcTime(c, t), path) : getPath(c, path);
}

/** The clip with every keyframed property evaluated at timeline time t. */
export function animated(c: MediaClip, t: number): MediaClip {
  const tracks = liveTracks(c);
  if (!tracks.length) return c;
  const s = srcTime(c, t);
  let out = c;
  for (const [path, keys] of tracks) out = withPath(out, path, interp(keys, s, path));
  return out;
}

/** Sorted, de-duplicated source times of the clip's keyframes (optionally only some properties). */
export function keyTimes(c: MediaClip, paths?: string[]): number[] {
  const all = liveTracks(c)
    .filter(([p]) => !paths || paths.includes(p))
    .flatMap(([, ks]) => ks.map((k) => k.t))
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (!out.length || t - out[out.length - 1] >= KF_EPS) out.push(t);
  return out;
}

/** Key times inside the visible part of the clip. */
export const visibleKeyTimes = keyTimes;

export const hasKeyAt = (c: MediaClip, path: string, s: number) => !!c.keyframes?.[path]?.some((k) => Math.abs(k.t - s) < KF_EPS);

function upsert(keys: Key[] | undefined, k: Key, eps = KF_EPS): Key[] {
  const out = (keys ?? []).filter((x) => Math.abs(x.t - k.t) >= eps);
  out.push(k);
  return out.sort((a, b) => a.t - b.t);
}

function setTrack(c: MediaClip, path: string, keys: Key[] | undefined): MediaClip {
  const kf = { ...(c.keyframes ?? {}) } as KeyTracks;
  if (keys?.length) kf[path] = keys;
  else delete kf[path];
  return { ...c, keyframes: Object.keys(kf).length ? kf : undefined };
}

/* ---------- edits (all return a full updated clip) ---------- */

/**
 * Change values at timeline time t. A property that already has keyframes gets a keyframe at t
 * (CapCut behaviour); otherwise the value changes for the whole clip.
 */
export function setValues(c: MediaClip, t: number, values: Record<string, number>, forceKey = false): MediaClip {
  const s = srcTime(c, t);
  let out = c;
  for (const [path, v] of Object.entries(values)) {
    if (forceKey || liveKeys(c, path).length) out = setTrack(out, path, upsert(out.keyframes?.[path], { t: s, v }));
    else out = withPath(out, path, v);
  }
  return out;
}

/** ◆ button: add keys for these properties at t, or remove them if they are all there already. */
export function toggleKeys(c: MediaClip, t: number, paths: string[]): MediaClip {
  const s = srcTime(c, t);
  const allOn = paths.every((p) => hasKeyAt(c, p, s));
  let out = c;
  for (const p of paths) {
    if (allOn) {
      const left = c.keyframes![p]!.filter((k) => Math.abs(k.t - s) >= KF_EPS);
      // removing the last one leaves the value where it was at this moment
      if (!left.length) out = withPath(out, p, valueAt(c, p, t));
      out = setTrack(out, p, left);
    } else out = setTrack(out, p, upsert(out.keyframes?.[p], { t: s, v: valueAt(c, p, t) }));
  }
  return out;
}

/** Remove the keyframes of these properties (all if omitted), keeping the value at time t. */
export function clearKeys(c: MediaClip, t: number, paths?: string[]): MediaClip {
  let out = c;
  for (const [p] of tracksOf(c)) {
    if (paths && !paths.includes(p)) continue;
    out = setTrack(withPath(out, p, valueAt(c, p, t)), p, undefined);
  }
  return out;
}

/** Move every keyframe at source time `from` to `to` (dragging a diamond in the timeline). */
export function moveKeys(c: MediaClip, from: number, to: number): MediaClip {
  let out = c;
  for (const [p, keys] of tracksOf(c)) {
    const moving = keys.filter((k) => Math.abs(k.t - from) < KF_EPS);
    if (!moving.length) continue;
    const rest = keys.filter((k) => Math.abs(k.t - from) >= KF_EPS && Math.abs(k.t - to) >= KF_EPS);
    out = setTrack(out, p, [...rest, ...moving.map((k) => ({ t: to, v: k.v }))].sort((a, b) => a.t - b.t));
  }
  return out;
}

/** Delete every keyframe at source time s. */
export function deleteKeysAt(c: MediaClip, s: number): MediaClip {
  let out = c;
  for (const [p, keys] of tracksOf(c)) {
    if (!keys.some((k) => Math.abs(k.t - s) < KF_EPS)) continue;
    const left = keys.filter((k) => Math.abs(k.t - s) >= KF_EPS);
    if (!left.length) out = withPath(out, p, keys[0].v);
    out = setTrack(out, p, left);
  }
  return out;
}

/**
 * Live motion recording: while the video plays and the user drags, write keys for `values`
 * at the playhead, about one every 0.12 s, replacing older keys in the recorded stretch.
 */
export type Recording = { start: number | null; fixed: number | null; head: number | null; mine: Set<number> };
export const newRecording = (): Recording => ({ start: null, fixed: null, head: null, mine: new Set() });
const REC_STEP = 0.12;

export function recordValues(c: MediaClip, t: number, values: Record<string, number>, rec: Recording): MediaClip {
  const s = srcTime(c, t);
  rec.start ??= s;
  const lo = rec.start;
  let out = c;
  for (const [p, v] of Object.entries(values)) {
    let keys = (out.keyframes?.[p] ?? []).filter((k) => rec.mine.has(k.t) || k.t < lo - 1e-4 || k.t > s + 1e-4);
    // the newest key moves along until it is old enough to stay
    if (rec.head !== null && rec.head !== rec.fixed) keys = keys.filter((k) => k.t !== rec.head);
    keys = upsert(keys, { t: s, v }, 1e-4);
    out = setTrack(out, p, keys);
  }
  if (rec.head !== null && rec.head !== rec.fixed) rec.mine.delete(rec.head);
  rec.mine.add(s);
  rec.head = s;
  if (rec.fixed === null || s - rec.fixed >= REC_STEP * c.speed) rec.fixed = s;
  return out;
}
