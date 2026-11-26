import { create } from 'zustand';
import type { Adjustments, AudioFx, Clip, MediaClip, MediaItem, ProjectSettings, TextClip, TextStyle, Track, TrackKind, Transform } from '../types';
import { isMediaClip } from '../types';
import { uid } from '../lib/util';
import { isAudioKind, sourceDuration } from '../lib/timeline';
import * as kf from '../lib/keyframes';
import { applyAttributes, type AttrGroup } from '../lib/attributes';

export const MAIN_TRACK = 'main';
const MIN_CLIP = 0.1;
export const MIN_ZOOM = 0.02; // px per second (3 h ≈ 216 px)
export const MAX_ZOOM = 400;

interface Snapshot {
  tracks: Track[];
  clips: Clip[];
  settings: ProjectSettings;
}

export interface ExportRequest {
  /** a single clip (normal or compound) */
  clipId?: string;
  /** several selected clips, exported together */
  clipIds?: string[];
}

export interface AddMediaOptions {
  trackId?: string;
  start?: number;
  /** always on an overlay track (stickers), never on the main track */
  overlay?: boolean;
  /** overrides for the new clips (e.g. duration and scale for stickers) */
  patch?: Partial<MediaClip>;
}

/** A parent level saved while editing inside a clip combinado. */
export interface CompoundLevel {
  id: string; // the compound clip being edited
  tracks: Track[];
  clips: Clip[];
  past: Snapshot[];
  future: Snapshot[];
  time: number;
  selectedIds: string[];
}

/** Puts the edited inner timeline back into its compound clip. */
function closeLevel(level: CompoundLevel, inner: { tracks: Track[]; clips: Clip[] }): { tracks: Track[]; clips: Clip[] } {
  const c = level.clips.find((x) => x.id === level.id);
  if (!c || c.type !== 'compound' || !c.compound) return { tracks: level.tracks, clips: level.clips };
  const used = new Set(inner.clips.map((x) => x.trackId));
  const tracks = inner.tracks.filter((t) => used.has(t.id));
  const duration = inner.clips.reduce((m, x) => Math.max(m, x.start + x.duration), 0);
  if (!inner.clips.length || duration < MIN_CLIP) return normalizeSnapshot(level.tracks, level.clips.filter((x) => x.id !== c.id));
  const old = c.compound.duration;
  const available = Math.max(MIN_CLIP, (duration - c.trimStart) / c.speed);
  // if the clip showed everything until the end, it grows/shrinks with its content
  const showedAll = c.trimStart + c.duration * c.speed >= old - 1e-3;
  const next: MediaClip = {
    ...c,
    duration: showedAll ? available : Math.min(c.duration, available),
    compound: { ...c.compound, tracks, clips: inner.clips, duration },
  };
  return normalizeSnapshot(level.tracks, level.clips.map((x) => (x.id === c.id ? next : x)));
}

/** The whole project timeline, even while editing inside a clip combinado (for saving / exporting). */
export function getRootTimeline(): { tracks: Track[]; clips: Clip[] } {
  const s = useEditor.getState();
  let cur = { tracks: s.tracks, clips: s.clips };
  for (let i = s.compoundStack.length - 1; i >= 0; i--) cur = closeLevel(s.compoundStack[i], cur);
  return cur;
}

export interface EditorState extends Snapshot {
  media: MediaItem[];
  time: number;
  playing: boolean;
  selectedIds: string[];
  clipboard: Clip[];
  /** what ⌘V pastes: timeline clips, or media items copied from the media bin */
  clipboardKind: 'clips' | 'media';
  mediaClipboard: string[];
  /** media bin selection (shared so keyboard shortcuts can use it) */
  mediaSelection: string[];
  /** last area the user clicked, so ⌘C / ⌘A act on the right thing */
  focusArea: 'media' | 'timeline';
  zoom: number; // px per second
  past: Snapshot[];
  future: Snapshot[];
  status: string | null;
  exportRequest: ExportRequest | null;
  /** clip combinado being edited (innermost last); empty = main timeline */
  compoundStack: CompoundLevel[];
  /** "Copiar atributos": the clip whose settings ⌥⌘V pastes */
  attrSource: MediaClip | null;

  // media
  addMedia: (item: MediaItem) => void;
  updateMedia: (id: string, patch: Partial<MediaItem>) => void;
  removeMedia: (id: string) => void;

  // history
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;

  // clips
  addMediaClip: (mediaId: string, opts?: AddMediaOptions) => void;
  addMediaClips: (mediaIds: string[], opts?: AddMediaOptions) => void;
  createCompound: () => void;
  ungroupCompound: (id: string) => void;
  toggleMute: (ids: string[]) => void;
  extractAudio: (ids: string[]) => void;
  setAudioFx: (ids: string[], fx: AudioFx) => void;
  addText: (text?: string, style?: Partial<TextStyle>) => void;
  addCaptions: (items: { start: number; end: number; text: string }[], style?: Partial<TextStyle>) => void;
  removeCaptions: () => void;
  updateClip: (id: string, patch: Partial<MediaClip> | Partial<TextClip>, commit?: boolean) => void;
  /** change position/size at the playhead (sets a keyframe if the clip is animated) */
  setTransform: (id: string, patch: Partial<Transform>, commit?: boolean) => void;
  /** set numeric settings at the playhead ('adjust.temp', 'volume'…); keyframed ones get a keyframe */
  setValues: (id: string, values: Record<string, number>, commit?: boolean) => void;
  toggleKeys: (id: string, paths: string[]) => void;
  clearKeys: (id: string, paths?: string[]) => void;
  moveKeys: (id: string, from: number, to: number, commit?: boolean) => void;
  deleteKeysAt: (id: string, s: number) => void;
  /** replace a media clip by a computed version of it */
  editMedia: (id: string, fn: (c: MediaClip, time: number) => MediaClip, commit?: boolean) => void;
  moveClip: (id: string, start: number, trackId: string) => void;
  normalize: () => void;
  splitAtPlayhead: () => void;
  deleteSelected: () => void;
  copySelected: () => void;
  copyMedia: (ids: string[]) => void;
  paste: () => void;
  duplicateSelected: () => void;

  // tracks
  toggleTrack: (id: string, key: 'muted' | 'hidden' | 'magnet') => void;
  /** put a clip on a brand-new track (dragging it above the top track) */
  moveToNewTrack: (clipIds: string[]) => void;
  /** delete a track and everything on it */
  removeTrack: (id: string) => void;

  // misc
  select: (ids: string[], additive?: boolean) => void;
  setMediaSelection: (ids: string[]) => void;
  setFocusArea: (a: 'media' | 'timeline') => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setZoom: (z: number) => void;
  setSettings: (s: Partial<ProjectSettings>) => void;
  setStatus: (s: string | null) => void;
  requestExport: (req: ExportRequest | null) => void;
  enterCompound: (id: string) => void;
  exitCompound: (levels?: number) => void;
  copyAttributes: (id: string) => void;
  pasteAttributes: (ids: string[], groups: AttrGroup[]) => void;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Montserrat',
  fontSize: 0.07,
  color: '#ffffff',
  bold: true,
  italic: false,
  strokeColor: '#000000',
  strokeWidth: 0.12,
  background: '',
  align: 'center',
  x: 0.5,
  y: 0.5,
  shadow: true,
  uppercase: false,
};

export const CAPTION_STYLE: Partial<TextStyle> = {
  fontSize: 0.055,
  y: 0.78,
  uppercase: true,
  strokeWidth: 0.16,
};

export const projectDuration = (clips: Clip[]) => clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

const overlaps = (clips: Clip[], trackId: string, start: number, dur: number, exclude: Set<string>) =>
  clips.some(
    (c) => c.trackId === trackId && !exclude.has(c.id) && start < c.start + c.duration - 1e-6 && start + dur > c.start + 1e-6,
  );

const trackEnd = (clips: Clip[], trackId: string) =>
  clips.filter((c) => c.trackId === trackId).reduce((m, c) => Math.max(m, c.start + c.duration), 0);

/** Inserts a new track at the right place for its kind and returns it. */
function createTrack(tracks: Track[], kind: TrackKind): { tracks: Track[]; track: Track } {
  const track: Track = { id: uid(), kind, muted: false, hidden: false };
  const next = [...tracks];
  if (kind === 'text') next.unshift(track);
  else if (kind === 'audio') next.push(track);
  else {
    // overlay video track: just above the top-most video track
    const firstVideo = next.findIndex((t) => t.kind === 'video');
    next.splice(firstVideo < 0 ? 0 : firstVideo, 0, track);
  }
  return { tracks: next, track };
}

/** Finds a track of the kind that is free in [start, start+dur), or creates a new one. */
function findOrCreateFreeTrack(tracks: Track[], clips: Clip[], kind: TrackKind, start: number, dur: number, exclude = new Set<string>()) {
  const candidates = tracks.filter((t) => t.kind === kind && t.id !== MAIN_TRACK);
  // search from the bottom-most (closest to main) for video, top for others
  const ordered = kind === 'video' ? [...candidates].reverse() : candidates;
  for (const t of ordered) if (!overlaps(clips, t.id, start, dur, exclude)) return { tracks, trackId: t.id };
  const { tracks: next, track } = createTrack(tracks, kind);
  return { tracks: next, trackId: track.id };
}

/** Lays out the main track contiguously (magnetic, like CapCut) and removes empty secondary tracks. */
function normalizeSnapshot(tracks: Track[], clips: Clip[]): { tracks: Track[]; clips: Clip[] } {
  const main = clips.filter((c) => c.trackId === MAIN_TRACK).sort((a, b) => a.start + a.duration / 2 - (b.start + b.duration / 2));
  let t = 0;
  const mainMap = new Map<string, number>();
  for (const c of main) {
    mainMap.set(c.id, t);
    t += c.duration;
  }
  // other tracks with the magnet on: no gaps between their clips (they start where their first clip is)
  for (const tr of tracks) {
    if (!tr.magnet || tr.id === MAIN_TRACK) continue;
    const list = clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start + a.duration / 2 - (b.start + b.duration / 2));
    let at = list.length ? Math.min(...list.map((c) => c.start)) : 0;
    for (const c of list) {
      mainMap.set(c.id, at);
      at += c.duration;
    }
  }
  const nextClips = clips.map((c) => (mainMap.has(c.id) && mainMap.get(c.id) !== c.start ? { ...c, start: mainMap.get(c.id)! } : c));
  const used = new Set(nextClips.map((c) => c.trackId));
  const nextTracks = tracks.filter((tr) => tr.id === MAIN_TRACK || used.has(tr.id));
  return { tracks: nextTracks, clips: nextClips };
}

/** Start value that makes normalize() insert a clip at position x of the main track. */
function mainInsertStart(clips: Clip[], x: number, dur: number) {
  const under = clips.find((c) => c.trackId === MAIN_TRACK && x >= c.start && x < c.start + c.duration);
  if (!under) return x;
  const center = under.start + under.duration / 2;
  return (x < center ? center - 0.001 : center + 0.001) - dur / 2;
}

function newMediaClip(media: MediaItem, trackId: string, start: number): MediaClip {
  return { ...clipDefaults(), type: media.kind, mediaId: media.id, trackId, start, duration: media.duration };
}

export const defaultAdjust = (): Adjustments => ({ temp: 0, tint: 0, saturation: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, fade: 0, vignette: 0, sharpen: 0, blur: 0 });

function clipDefaults(): Omit<MediaClip, 'type' | 'mediaId' | 'trackId' | 'start' | 'duration'> {
  return {
    id: uid(),
    trimStart: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    adjust: defaultAdjust(),
    removeBg: false,
  };
}

/** Places a media item on the timeline (pure). Returns the normalized result and the new clip. */
function placeMedia(tracks: Track[], clips: Clip[], m: MediaItem, opts: AddMediaOptions, time: number) {
  const kind: TrackKind = m.kind === 'audio' ? 'audio' : 'video';
  let trackId = tracks.some((t) => t.id === opts.trackId && t.kind === kind) ? opts.trackId : undefined;
  if (opts.overlay && trackId === MAIN_TRACK) trackId = undefined;
  let start = opts.start;
  const mainEmpty = !clips.some((c) => c.trackId === MAIN_TRACK);
  const dur = opts.patch?.duration ?? m.duration;

  if (opts.overlay) {
    if (start === undefined) start = time;
  } else if (kind === 'video' && (start === undefined || mainEmpty) && !trackId) {
    trackId = MAIN_TRACK; // "+" button or first clip: append to the main track
    start = trackEnd(clips, MAIN_TRACK);
  }
  if (start === undefined) start = time;
  if (trackId === MAIN_TRACK) {
    // magnetic main track: dropping over a clip inserts before/after it depending on the side
    start = mainInsertStart(clips, start, dur);
  } else if (!trackId || overlaps(clips, trackId, start, dur, new Set())) {
    const r = findOrCreateFreeTrack(tracks, clips, kind, start, dur);
    tracks = r.tracks;
    trackId = r.trackId;
  }
  const clip: MediaClip = { ...newMediaClip(m, trackId, trackId === MAIN_TRACK ? start : Math.max(0, start)), ...opts.patch };
  return { ...normalizeSnapshot(tracks, [...clips, clip]), clipId: clip.id };
}

/** Removes every clip using a media item, also inside compound clips. */
function stripMedia(list: Clip[], mediaId: string): Clip[] {
  return list
    .filter((c) => !(isMediaClip(c) && c.mediaId === mediaId))
    .map((c) => (c.type === 'compound' && c.compound ? { ...c, compound: { ...c.compound, clips: stripMedia(c.compound.clips, mediaId) } } : c));
}

/* ---------- editing several clips at once ---------- */

let linkedIds: string[] | null = null;
let fromInspector = false;
/** While several clips are selected in the inspector, edits made THERE go to all of them. */
export function setLinkedEdit(ids: string[] | null) {
  linkedIds = ids && ids.length > 1 ? ids : null;
}
/** The user is working in the inspector (true) or somewhere else, e.g. the preview or the timeline (false). */
export function setEditingInInspector(on: boolean) {
  fromInspector = on;
}
const linkedNow = () => (fromInspector ? linkedIds : null);

// things that belong to each clip and are never copied
const OWN = new Set(['id', 'trackId', 'start', 'duration', 'trimStart', 'mediaId', 'type', 'compound', 'keyframes', 'reversedFrom', 'caption', 'text']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Settings (as dotted paths) that differ between two versions of a clip. */
function changedPaths(a: Record<string, unknown>, b: Record<string, unknown>, prefix = '', out: string[] = []) {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!prefix && OWN.has(k)) continue;
    const path = prefix + k;
    if (path === 'stab.data') continue;
    const x = a[k];
    const y = b[k];
    if (isObj(x) && isObj(y)) changedPaths(x, y, path + '.', out);
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(path);
  }
  return out;
}

/** Copy what changed from `before` → `after` (one clip) onto another clip. */
function copyChange(before: MediaClip, after: MediaClip, other: MediaClip, time: number, media: MediaItem[]): MediaClip {
  let out = other;
  const tRef = Math.min(after.start + after.duration - 1e-3, Math.max(after.start, time));
  // also settings changed through keyframes (e.g. the inspector set a keyframe on the first clip)
  const paths = new Set(changedPaths(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>));
  for (const p of Object.keys({ ...before.keyframes, ...after.keyframes })) if (JSON.stringify(before.keyframes?.[p]) !== JSON.stringify(after.keyframes?.[p])) paths.add(p);
  for (const path of paths) {
    const raw = path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), after);
    if (path === 'speed') {
      // same piece of its own video, at the new speed
      let dur = (out.duration * out.speed) / after.speed;
      const max = sourceDuration(out, media.find((m) => m.id === out.mediaId));
      if (isFinite(max)) dur = Math.min(dur, (max - out.trimStart) / after.speed);
      out = { ...out, speed: after.speed, duration: Math.max(MIN_CLIP, dur) };
    } else if (path === 'stab') {
      // turned on/off: each clip keeps (or gets) its own camera analysis
      out = { ...out, stab: after.stab ? { ...after.stab, data: out.stab?.data } : undefined };
    } else if (typeof raw === 'number' || (raw === undefined && (before.keyframes?.[path] || after.keyframes?.[path]))) {
      const now = kf.valueAt(after, path, tRef);
      const keys = out.keyframes?.[path];
      if (keys?.length) {
        // it's animated there: move its whole animation by the same amount
        const delta = now - kf.valueAt(before, path, tRef);
        out = { ...out, keyframes: { ...out.keyframes, [path]: keys.map((k) => ({ t: k.t, v: k.v + delta })) } };
      } else out = kf.withPath(out, path, now);
    } else out = kf.withPath(out, path, raw === undefined ? undefined : structuredClone(raw));
  }
  return out;
}

export const useEditor = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot => {
    const { tracks, clips, settings } = get();
    return { tracks, clips, settings };
  };
  const checkpoint = () => set((s) => ({ past: [...s.past.slice(-99), snapshot()], future: [] }));
  const apply = (tracks: Track[], clips: Clip[]) => set(normalizeSnapshot(tracks, clips));

  return {
    media: [],
    tracks: [{ id: MAIN_TRACK, kind: 'video', muted: false, hidden: false }],
    clips: [],
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    time: 0,
    playing: false,
    selectedIds: [],
    clipboard: [],
    compoundStack: [],
    attrSource: null,
    clipboardKind: 'clips',
    mediaClipboard: [],
    mediaSelection: [],
    focusArea: 'timeline',
    zoom: 60,
    past: [],
    future: [],
    status: null,
    exportRequest: null,

    addMedia: (item) => set((s) => ({ media: [...s.media, item] })),
    updateMedia: (id, patch) => set((s) => ({ media: s.media.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
    removeMedia: (id) => {
      checkpoint();
      const { tracks, clips } = get();
      apply(tracks, stripMedia(clips, id));
      set((s) => ({ media: s.media.filter((m) => m.id !== id) }));
    },

    checkpoint,
    undo: () => {
      const { past } = get();
      if (!past.length) return;
      const prev = past[past.length - 1];
      set((s) => ({ ...prev, past: s.past.slice(0, -1), future: [snapshot(), ...s.future], selectedIds: [] }));
    },
    redo: () => {
      const { future } = get();
      if (!future.length) return;
      const next = future[0];
      set((s) => ({ ...next, future: s.future.slice(1), past: [...s.past, snapshot()], selectedIds: [] }));
    },

    addMediaClip: (mediaId, opts = {}) => get().addMediaClips([mediaId], opts),

    addMediaClips: (mediaIds, opts = {}) => {
      const { media, time } = get();
      const items = mediaIds.map((id) => media.find((m) => m.id === id)).filter((m): m is MediaItem => !!m);
      if (!items.length) return;
      checkpoint();
      let { tracks, clips } = get();
      const added: string[] = [];
      // clips of the same kind are chained one after another, in order
      const chain: Record<string, { start: number; trackId: string } | undefined> = {};
      for (const m of items) {
        const kind = m.kind === 'audio' ? 'audio' : 'video';
        const prev = chain[kind];
        const o = prev ? { ...opts, start: prev.start, trackId: prev.trackId } : opts;
        const r = placeMedia(tracks, clips, m, o, time);
        tracks = r.tracks;
        clips = r.clips;
        added.push(r.clipId);
        const placed = clips.find((c) => c.id === r.clipId)!;
        // "+" on videos keeps appending to the main track by itself
        if (!(kind === 'video' && opts.start === undefined && !opts.trackId && !opts.overlay)) chain[kind] = { start: placed.start + placed.duration, trackId: placed.trackId };
      }
      set({ tracks, clips, selectedIds: added, focusArea: 'timeline' });
    },

    createCompound: () => {
      const { selectedIds, clips, tracks } = get();
      const sel = clips.filter((c) => selectedIds.includes(c.id));
      if (!sel.length) return;
      checkpoint();
      const t0 = Math.min(...sel.map((c) => c.start));
      const t1 = Math.max(...sel.map((c) => c.start + c.duration));
      const used = new Set(sel.map((c) => c.trackId));
      const rest = clips.filter((c) => !selectedIds.includes(c.id));
      const allAudio = sel.every(isAudioKind);
      let destTracks = tracks;
      let trackId: string;
      if (allAudio) {
        const r = findOrCreateFreeTrack(tracks, rest, 'audio', t0, t1 - t0);
        destTracks = r.tracks;
        trackId = r.trackId;
      } else if (used.has(MAIN_TRACK)) {
        trackId = MAIN_TRACK;
      } else {
        const lowest = tracks.filter((t) => used.has(t.id) && t.kind === 'video').at(-1);
        if (lowest && !overlaps(rest, lowest.id, t0, t1 - t0, new Set())) trackId = lowest.id;
        else {
          const r = findOrCreateFreeTrack(tracks, rest, 'video', t0, t1 - t0);
          destTracks = r.tracks;
          trackId = r.trackId;
        }
      }
      const compound: MediaClip = {
        ...clipDefaults(),
        type: 'compound',
        mediaId: '',
        trackId,
        start: t0,
        duration: t1 - t0,
        compound: {
          kind: allAudio ? 'audio' : 'video',
          tracks: tracks.filter((t) => used.has(t.id)).map((t) => ({ ...t })),
          clips: sel.map((c) => ({ ...c, start: c.start - t0 })),
          duration: t1 - t0,
        },
      };
      apply(destTracks, [...rest, compound]);
      set({ selectedIds: [compound.id], status: 'Clip combinado creado' });
    },

    ungroupCompound: (id) => {
      const { clips } = get();
      const c = clips.find((x) => x.id === id);
      if (!c || c.type !== 'compound' || !c.compound) return;
      if (Math.abs(c.speed - 1) > 1e-6) {
        set({ status: 'Pon la velocidad a 1x para deshacer el clip combinado' });
        return;
      }
      checkpoint();
      let tracks = get().tracks;
      let rest = clips.filter((x) => x.id !== id);
      const offset = c.start - c.trimStart;
      const end = c.start + c.duration;
      const newIds: string[] = [];
      for (const ic of [...c.compound.clips].sort((a, b) => a.start - b.start)) {
        const s0 = ic.start + offset;
        const a = Math.max(s0, c.start);
        const b = Math.min(s0 + ic.duration, end);
        if (b - a < MIN_CLIP / 2) continue;
        const piece = { ...structuredClone(ic), id: uid(), start: a, duration: b - a } as Clip;
        if (isMediaClip(piece) && isMediaClip(ic)) {
          piece.trimStart = ic.trimStart + (a - s0) * ic.speed;
          piece.volume = ic.volume * c.volume;
          piece.muted = ic.muted || c.muted;
        }
        const innerKind = c.compound.tracks.find((t) => t.id === ic.trackId)?.kind ?? 'video';
        if (ic.trackId === MAIN_TRACK && c.trackId === MAIN_TRACK) piece.trackId = MAIN_TRACK;
        else {
          const r = findOrCreateFreeTrack(tracks, rest, innerKind, a, b - a);
          tracks = r.tracks;
          piece.trackId = r.trackId;
        }
        rest = [...rest, piece];
        newIds.push(piece.id);
      }
      apply(tracks, rest);
      set({ selectedIds: newIds });
    },

    toggleMute: (ids) => {
      const linked = linkedNow();
      if (linked && ids.some((i) => linked.includes(i))) ids = [...new Set([...ids, ...linked])];
      const { clips, tracks } = get();
      const targets = clips.filter((c): c is MediaClip => ids.includes(c.id) && isMediaClip(c));
      if (!targets.length) return;
      checkpoint();
      const mute = !targets.every((c) => c.muted);
      apply(
        tracks,
        clips.map((c) => (ids.includes(c.id) && isMediaClip(c) ? { ...c, muted: mute } : c)),
      );
      set({ status: mute ? 'Audio quitado' : 'Audio activado' });
    },

    extractAudio: (ids) => {
      let { clips, tracks } = get();
      const targets = clips.filter((c): c is MediaClip => ids.includes(c.id) && isMediaClip(c) && (c.type === 'video' || c.type === 'compound'));
      if (!targets.length) return;
      checkpoint();
      const added: string[] = [];
      for (const c of targets) {
        const r = findOrCreateFreeTrack(tracks, clips, 'audio', c.start, c.duration);
        tracks = r.tracks;
        const audio: MediaClip = {
          ...structuredClone(c),
          id: uid(),
          trackId: r.trackId,
          type: c.type === 'compound' ? 'compound' : 'audio',
          muted: false,
          removeBg: false,
        };
        if (audio.compound) audio.compound.kind = 'audio';
        clips = [...clips.map((x) => (x.id === c.id ? { ...x, muted: true } : x)), audio];
        added.push(audio.id);
      }
      apply(tracks, clips);
      set({ selectedIds: added, status: added.length > 1 ? `Audio de ${added.length} clips separado` : 'Audio separado en su propia pista' });
    },

    setAudioFx: (ids, fx) => {
      const linked = linkedNow();
      if (linked && ids.some((i) => linked.includes(i))) ids = [...new Set([...ids, ...linked])];
      const { clips, tracks } = get();
      checkpoint();
      apply(
        tracks,
        clips.map((c) => (ids.includes(c.id) && isMediaClip(c) ? { ...c, audioFx: fx } : c)),
      );
    },

    addText: (text = 'Escribe aquí', style) => {
      const { clips, time } = get();
      checkpoint();
      const dur = 3;
      const r = findOrCreateFreeTrack(get().tracks, clips, 'text', time, dur);
      const clip: TextClip = {
        id: uid(),
        type: 'text',
        trackId: r.trackId,
        start: time,
        duration: dur,
        text,
        style: { ...DEFAULT_TEXT_STYLE, ...style },
        animation: 'pop',
      };
      apply(r.tracks, [...clips, clip]);
      set({ selectedIds: [clip.id] });
    },

    addCaptions: (items, style) => {
      if (!items.length) return;
      checkpoint();
      const { clips } = get();
      const kept = clips.filter((c) => !(c.type === 'text' && c.caption));
      const { tracks, track } = createTrack(get().tracks, 'text');
      const caps: TextClip[] = items.map((it) => ({
        id: uid(),
        type: 'text',
        trackId: track.id,
        start: it.start,
        duration: Math.max(MIN_CLIP, it.end - it.start),
        text: it.text,
        caption: true,
        style: { ...DEFAULT_TEXT_STYLE, ...CAPTION_STYLE, ...style },
        animation: 'pop',
      }));
      apply(tracks, [...kept, ...caps]);
    },

    removeCaptions: () => {
      checkpoint();
      const { tracks, clips } = get();
      apply(
        tracks,
        clips.filter((c) => !(c.type === 'text' && c.caption)),
      );
    },

    updateClip: (id, patch, commit = true) => {
      if (commit) checkpoint();
      const { tracks, clips } = get();
      const target = clips.find((c) => c.id === id);
      // Caption style edits apply to all captions so they stay consistent
      const applyToAll = target?.type === 'text' && target.caption && 'style' in patch;
      let next = clips.map((c) => {
        if (c.id === id) return { ...c, ...patch } as Clip;
        if (applyToAll && c.type === 'text' && c.caption) return { ...c, style: { ...c.style, ...(patch as Partial<TextClip>).style } };
        return c;
      });
      // several clips selected in the inspector: the same change goes to all of them
      const linked = linkedNow();
      if (linked?.includes(id) && target && isMediaClip(target)) {
        const after = next.find((c) => c.id === id) as MediaClip;
        const { time, media } = get();
        const needAnalysis: string[] = [];
        next = next.map((c) => {
          if (c.id === id || !linked.includes(c.id) || !isMediaClip(c)) return c;
          const out = copyChange(target, after, c, time, media);
          if (out.stab?.on && !out.stab.data && out.type === 'video' && !(c.stab && !c.stab.data)) needAnalysis.push(c.id);
          return out;
        });
        // turning the stabilizer on: measure each clip's own camera shake
        if (needAnalysis.length) queueMicrotask(() => import('../lib/stabilize').then((m) => needAnalysis.forEach((cid) => void m.analyzeClip(cid))));
      }
      apply(tracks, next);
    },

    editMedia: (id, fn, commit = true) => {
      const { clips, time } = get();
      const c = clips.find((x) => x.id === id);
      if (!c || !isMediaClip(c)) return;
      get().updateClip(id, fn(c, time), commit);
    },
    setTransform: (id, patch, commit = true) =>
      get().setValues(id, Object.fromEntries(Object.entries(patch).map(([k, v]) => [`transform.${k}`, v as number])), commit),
    setValues: (id, values, commit = true) => get().editMedia(id, (c, t) => kf.setValues(c, t, values), commit),
    toggleKeys: (id, paths) =>
      get().editMedia(id, (c, t) => (t >= c.start && t < c.start + c.duration ? kf.toggleKeys(c, t, paths) : c)),
    clearKeys: (id, paths) => get().editMedia(id, (c, t) => kf.clearKeys(c, t >= c.start && t < c.start + c.duration ? t : c.start, paths)),
    moveKeys: (id, from, to, commit = true) => get().editMedia(id, (c) => kf.moveKeys(c, from, to), commit),
    deleteKeysAt: (id, s) => get().editMedia(id, (c) => kf.deleteKeysAt(c, s)),

    moveClip: (id, start, trackId) => {
      const { clips } = get();
      set({ clips: clips.map((c) => (c.id === id ? { ...c, start: Math.max(0, start), trackId } : c)) });
    },

    normalize: () => {
      const { tracks, clips } = get();
      apply(tracks, clips);
    },

    splitAtPlayhead: () => {
      const { clips, time, selectedIds } = get();
      const under = clips.filter((c) => time > c.start + MIN_CLIP / 2 && time < c.start + c.duration - MIN_CLIP / 2);
      const selected = under.filter((c) => selectedIds.includes(c.id));
      const onMain = under.filter((c) => c.trackId === MAIN_TRACK);
      const list = selected.length ? selected : onMain.length ? onMain : under;
      if (!list.length) return;
      checkpoint();
      const newIds: string[] = [];
      let next = [...clips];
      for (const c of list) {
        const left = time - c.start;
        const a = { ...c, duration: left } as Clip;
        const b = { ...c, id: uid(), start: time, duration: c.duration - left } as Clip;
        let pieces: Clip[] = [a, b];
        if (isMediaClip(c)) {
          (a as MediaClip).fadeOut = 0;
          (b as MediaClip).fadeIn = 0;
          (b as MediaClip).trimStart = c.trimStart + left * c.speed;
          // each piece keeps only its own keyframes: the cut ends the animation of the other piece
          pieces = [kf.pruneKeys(a as MediaClip), kf.pruneKeys(b as MediaClip)];
        }
        next = next.flatMap((x) => (x.id === c.id ? pieces : [x]));
        newIds.push(b.id);
      }
      apply(get().tracks, next);
      set({ selectedIds: newIds });
    },

    deleteSelected: () => {
      const { selectedIds, clips, tracks } = get();
      if (!selectedIds.length) return;
      checkpoint();
      apply(
        tracks,
        clips.filter((c) => !selectedIds.includes(c.id)),
      );
      set({ selectedIds: [] });
    },

    copySelected: () => {
      const { selectedIds, clips } = get();
      const sel = clips.filter((c) => selectedIds.includes(c.id));
      if (sel.length) set({ clipboard: sel.map((c) => structuredClone(c)), clipboardKind: 'clips', status: `${sel.length} clip(s) copiado(s)` });
    },

    copyMedia: (ids) => {
      if (!ids.length) return;
      set({ mediaClipboard: ids, clipboardKind: 'media', status: `${ids.length} archivo(s) copiado(s): pulsa ⌘V para pegarlos en la línea de tiempo` });
    },

    paste: () => {
      const { clipboard, time, clipboardKind, mediaClipboard } = get();
      if (clipboardKind === 'media') {
        // media copied from the bin: insert at the playhead, one after another
        get().addMediaClips(mediaClipboard, { trackId: MAIN_TRACK, start: time });
        return;
      }
      if (!clipboard.length) return;
      checkpoint();
      let { tracks, clips } = get();
      const minStart = Math.min(...clipboard.map((c) => c.start));
      const newIds: string[] = [];
      for (const src of clipboard) {
        const start = time + (src.start - minStart);
        let trackId = tracks.some((t) => t.id === src.trackId) ? src.trackId : MAIN_TRACK;
        if (trackId !== MAIN_TRACK && overlaps(clips, trackId, start, src.duration, new Set())) {
          const kind = tracks.find((t) => t.id === trackId)!.kind;
          const r = findOrCreateFreeTrack(tracks, clips, kind, start, src.duration);
          tracks = r.tracks;
          trackId = r.trackId;
        }
        const c = { ...structuredClone(src), id: uid(), start, trackId } as Clip;
        // on the main track, pasting inserts the clip after the clip under the playhead
        if (trackId === MAIN_TRACK) {
          const under = clips.find((x) => x.trackId === MAIN_TRACK && start >= x.start && start < x.start + x.duration);
          c.start = under ? under.start + under.duration / 2 + 0.001 - c.duration / 2 : start;
        }
        clips = [...clips, c];
        newIds.push(c.id);
      }
      apply(tracks, clips);
      set({ selectedIds: newIds });
    },

    duplicateSelected: () => {
      const { selectedIds, clips } = get();
      const sel = clips.filter((c) => selectedIds.includes(c.id));
      if (!sel.length) return;
      const end = Math.max(...sel.map((c) => c.start + c.duration));
      set({ clipboard: sel.map((c) => structuredClone(c)), clipboardKind: 'clips', time: end });
      get().paste();
    },

    toggleTrack: (id, key) => {
      if (key === 'magnet') checkpoint();
      const { tracks, clips } = get();
      apply(tracks.map((t) => (t.id === id ? { ...t, [key]: !t[key] } : t)), clips);
    },
    moveToNewTrack: (clipIds) => {
      const { tracks, clips } = get();
      const list = clips.filter((x) => clipIds.includes(x.id));
      if (!list.length) return;
      const kindOf = (c: Clip): TrackKind => (isAudioKind(c) ? 'audio' : c.type === 'text' ? 'text' : 'video');
      const kind = kindOf(list[0]);
      if (list.some((c) => kindOf(c) !== kind)) {
        set({ status: 'Para crear una pista nueva, arrastra clips del mismo tipo (vídeo, audio o texto)' });
        return;
      }
      const sorted = [...list].sort((a, b) => a.start - b.start);
      if (sorted.some((c, i) => i > 0 && c.start < sorted[i - 1].start + sorted[i - 1].duration - 1e-3)) {
        set({ status: 'Esos clips se pisan en el tiempo: no caben juntos en una sola pista' });
        return;
      }
      const r = createTrack(tracks, kind);
      apply(r.tracks, clips.map((x) => (clipIds.includes(x.id) ? { ...x, trackId: r.track.id, start: Math.max(0, x.start) } : x)));
      set({ selectedIds: clipIds, status: 'Pista nueva creada' });
    },
    removeTrack: (id) => {
      if (id === MAIN_TRACK) return;
      checkpoint();
      const { tracks, clips } = get();
      apply(tracks.filter((t) => t.id !== id), clips.filter((c) => c.trackId !== id));
      set({ selectedIds: [] });
    },

    select: (ids, additive = false) =>
      set((s) => ({ selectedIds: additive ? Array.from(new Set([...s.selectedIds, ...ids])) : ids })),
    setMediaSelection: (ids) => set({ mediaSelection: ids }),
    setFocusArea: (focusArea) => {
      if (get().focusArea !== focusArea) set({ focusArea });
    },
    setTime: (t) => set({ time: Math.max(0, t) }),
    setPlaying: (p) => set({ playing: p }),
    setZoom: (z) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) }),
    setSettings: (s) => {
      checkpoint();
      set((st) => ({ settings: { ...st.settings, ...s } }));
    },
    setStatus: (status) => set({ status }),
    requestExport: (exportRequest) => set({ exportRequest }),

    enterCompound: (id) => {
      const s = get();
      const c = s.clips.find((x) => x.id === id);
      if (!c || c.type !== 'compound' || !c.compound) return;
      const level: CompoundLevel = { id, tracks: s.tracks, clips: s.clips, past: s.past, future: s.future, time: s.time, selectedIds: s.selectedIds };
      let tracks = c.compound.tracks.map((t) => ({ ...t }));
      if (!tracks.some((t) => t.id === MAIN_TRACK)) tracks = [...tracks, { id: MAIN_TRACK, kind: 'video', muted: false, hidden: false }];
      const inside = s.time >= c.start && s.time < c.start + c.duration ? c.trimStart + (s.time - c.start) * c.speed : c.trimStart;
      set({
        compoundStack: [...s.compoundStack, level],
        ...normalizeSnapshot(tracks, c.compound.clips),
        past: [],
        future: [],
        selectedIds: [],
        time: Math.max(0, inside),
        playing: false,
        status: 'Editando el clip combinado · «Volver» para salir',
      });
    },

    exitCompound: (levels = 1) => {
      for (let i = 0; i < levels; i++) {
        const s = get();
        const level = s.compoundStack.at(-1);
        if (!level) return;
        const changed = s.past.length > 0;
        const back = closeLevel(level, { tracks: s.tracks, clips: s.clips });
        const c = level.clips.find((x) => x.id === level.id) as MediaClip | undefined;
        const local = s.time;
        const time = c ? Math.min(c.start + c.duration, Math.max(c.start, c.start + (local - c.trimStart) / c.speed)) : level.time;
        set({
          compoundStack: s.compoundStack.slice(0, -1),
          ...back,
          // one undo step in the parent brings back the clip as it was before entering
          past: changed ? [...level.past.slice(-99), { tracks: level.tracks, clips: level.clips, settings: s.settings }] : level.past,
          future: changed ? [] : level.future,
          selectedIds: back.clips.some((x) => x.id === level.id) ? [level.id] : [],
          time,
          playing: false,
          status: null,
        });
      }
    },

    copyAttributes: (id) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c || !isMediaClip(c)) return;
      set({ attrSource: structuredClone(c), status: 'Atributos copiados · selecciona otros clips y usa «Pegar atributos» (⌥⌘V)' });
    },

    pasteAttributes: (ids, groups) => {
      const src = get().attrSource;
      if (!src || !groups.length) return;
      checkpoint();
      const { clips, tracks, media } = get();
      let n = 0;
      const next = clips.map((c) => {
        if (!ids.includes(c.id) || !isMediaClip(c) || c.id === src.id) return c;
        n++;
        return applyAttributes(c, src, groups, media);
      });
      apply(tracks, next);
      set({ status: `Atributos pegados en ${n} clip${n === 1 ? '' : 's'}` });
    },
  };
});

export { trackEnd, overlaps, MIN_CLIP };
