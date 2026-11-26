import { useEditor, projectDuration } from '../store/editor';
import type { Clip, MediaClip, Track } from '../types';
import { renderFrame, type FrameSource, type HitBox } from './render';
import { releaseScrub, scrubFrame } from './scrub';
import { onSegmenterChange } from '../ai/segmenter';
import { flattenLeaves, leafGain, type Leaf } from './timeline';
import { getPreviewFx, onFxReady } from '../ai/voice';

type FxVoice = { node: AudioBufferSourceNode; gain: GainNode; startCtx: number; offset: number; rate: number; buffer: AudioBuffer };

/**
 * Real-time preview. Uses one <video>/<audio> element per playable leaf clip, kept in sync with
 * a master clock, and composites everything onto a canvas every animation frame.
 * Clips with a voice effect play their processed audio through Web Audio instead.
 */
class PreviewEngine {
  private canvas: HTMLCanvasElement | null = null;
  private elements = new Map<string, HTMLMediaElement>();
  private images = new Map<string, HTMLImageElement>();
  private pool = new Map<string, HTMLCanvasElement>();
  private fxVoices = new Map<string, FxVoice>();
  private audioCtx: AudioContext | null = null;
  private raf = 0;
  private clockStart = 0;
  private timeAtStart = 0;
  private dirty = true;
  private leaves: Leaf[] = [];
  private leavesClips: Clip[] | null = null;
  private leavesTracks: Track[] | null = null;
  /** elements that finished seeking but whose new frame hasn't been drawn yet */
  private undrawn = new Set<HTMLMediaElement>();
  private notReadySince: number | null = null;
  hits: HitBox[] = [];
  /** clip whose mask is being edited on the viewer (its selection frame isn't drawn) */
  maskClip: string | null = null;
  /** size of the selection handles, in canvas pixels (set by the preview from its CSS scale) */
  handlePx = 10;
  /** while trimming a clip: show this moment instead of the playhead's (the playhead doesn't move) */
  private showTime: number | null = null;

  /** True while the playhead is being dragged: fast small frames from the scrub decoder. */
  private scrubbing = false;
  private scrubRelease: ReturnType<typeof setTimeout> | null = null;

  beginScrub() {
    this.scrubbing = true;
    if (this.scrubRelease) clearTimeout(this.scrubRelease);
  }

  endScrub() {
    this.scrubbing = false;
    this.dirty = true;
    // keep the decoded frames a while (you may drag again); then free the memory
    if (this.scrubRelease) clearTimeout(this.scrubRelease);
    this.scrubRelease = setTimeout(() => {
      releaseScrub();
      this.scrubRelease = null;
    }, 20000);
  }

  /** Show the frame at time t in the preview without moving the playhead (null = back to the playhead). */
  showAt(t: number | null) {
    this.showTime = t;
    this.dirty = true;
  }

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.dirty = true;
    if (!this.raf) this.loop();
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas = null;
  }

  invalidate() {
    this.dirty = true;
  }

  play() {
    const s = useEditor.getState();
    const end = projectDuration(s.clips);
    if (end <= 0) return;
    if (s.time >= end - 0.05) s.setTime(0);
    this.timeAtStart = useEditor.getState().time;
    this.clockStart = performance.now();
    this.audioCtx ??= new AudioContext();
    this.audioCtx.resume().catch(() => {});
    s.setPlaying(true);
  }

  pause() {
    useEditor.getState().setPlaying(false);
    this.elements.forEach((el) => el.pause());
    this.stopFxVoices();
    this.dirty = true;
  }

  toggle() {
    if (useEditor.getState().playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const s = useEditor.getState();
    s.setTime(t);
    if (s.playing) {
      this.timeAtStart = Math.max(0, t);
      this.clockStart = performance.now();
    }
    this.dirty = true;
  }

  private getLeaves() {
    const { clips, tracks } = useEditor.getState();
    if (this.leavesClips !== clips || this.leavesTracks !== tracks) {
      this.leaves = flattenLeaves(clips, tracks);
      this.leavesClips = clips;
      this.leavesTracks = tracks;
    }
    return this.leaves;
  }

  private getElement(leaf: Leaf): HTMLMediaElement | null {
    const media = useEditor.getState().media.find((m) => m.id === leaf.clip.mediaId);
    if (!media || media.missing || !media.url) return null;
    let el = this.elements.get(leaf.key);
    if (!el || el.dataset.mediaId !== media.id) {
      el?.pause();
      el = document.createElement(leaf.clip.type === 'audio' ? 'audio' : 'video');
      el.dataset.mediaId = media.id;
      el.preload = 'auto';
      (el as HTMLVideoElement).playsInline = true;
      el.src = media.url;
      el.addEventListener('seeked', () => {
        // show this frame before seeking again (otherwise fast scrubbing never shows anything)
        this.undrawn.add(el!);
        this.dirty = true;
      });
      el.addEventListener('loadeddata', () => (this.dirty = true));
      this.elements.set(leaf.key, el);
    }
    return el;
  }

  private getImage(mediaId: string): HTMLImageElement | null {
    let img = this.images.get(mediaId);
    if (!img) {
      const media = useEditor.getState().media.find((m) => m.id === mediaId);
      if (!media || media.missing || !media.url) return null;
      img = new Image();
      img.onload = () => (this.dirty = true);
      img.src = media.url;
      this.images.set(mediaId, img);
    }
    return img;
  }

  private stopFxVoice(key: string) {
    const v = this.fxVoices.get(key);
    if (!v) return;
    try {
      v.node.stop();
    } catch {
      /* already stopped */
    }
    v.node.disconnect();
    this.fxVoices.delete(key);
  }

  private stopFxVoices() {
    for (const key of [...this.fxVoices.keys()]) this.stopFxVoice(key);
  }

  /** Plays the processed (voice effect) audio for a leaf through Web Audio. */
  private syncFx(leaf: Leaf, buffer: AudioBuffer, bufFrom: number, desired: number, vol: number) {
    const ctx = this.audioCtx;
    if (!ctx) return;
    const offset = desired - bufFrom;
    let v = this.fxVoices.get(leaf.key);
    if (v && v.buffer !== buffer) {
      this.stopFxVoice(leaf.key);
      v = undefined;
    }
    if (v) {
      const pos = v.offset + (ctx.currentTime - v.startCtx) * v.rate;
      if (Math.abs(pos - offset) > 0.3) {
        this.stopFxVoice(leaf.key);
        v = undefined;
      }
    }
    if (!v) {
      if (offset < 0 || offset >= buffer.duration) return;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = leaf.rate;
      const gain = ctx.createGain();
      node.connect(gain).connect(ctx.destination);
      node.start(0, offset);
      v = { node, gain, startCtx: ctx.currentTime, offset, rate: leaf.rate, buffer };
      this.fxVoices.set(leaf.key, v);
    }
    v.gain.gain.value = vol;
  }

  private sync(time: number, playing: boolean) {
    const { media } = useEditor.getState();
    const liveIds = new Set<string>();
    const fxLive = new Set<string>();
    for (const leaf of this.getLeaves()) {
      const clip = leaf.clip;
      if (clip.type === 'image') continue;
      liveIds.add(leaf.key);
      const el = this.getElement(leaf);
      if (!el) continue;
      const active = time >= leaf.t0 && time < leaf.t1;
      const desired = leaf.src0 + (time - leaf.t0) * leaf.rate;
      const rate = Math.min(16, Math.max(0.0625, leaf.rate));
      if (!playing && el.playbackRate !== rate) el.playbackRate = rate;
      const vol = Math.min(1, Math.max(0, leafGain(leaf, time)));
      el.volume = vol;

      // voice effect: play the processed audio via Web Audio and mute the element
      let fxActive = false;
      if (leaf.fx !== 'none' && !leaf.muted && !leaf.hidden) {
        const m = media.find((x) => x.id === clip.mediaId);
        const srcEnd = leaf.src0 + (leaf.t1 - leaf.t0) * leaf.rate;
        const entry = m?.hasAudio ? getPreviewFx(m, leaf.src0, srcEnd, leaf.fx) : undefined;
        if (entry?.status === 'ready' && entry.buffer) {
          fxActive = true;
          if (playing && active) {
            fxLive.add(leaf.key);
            this.syncFx(leaf, entry.buffer, entry.from, desired, vol);
          }
        }
      }
      el.muted = leaf.muted || leaf.hidden || fxActive;

      if (active) {
        if (playing) {
          // Keep in step without jumping: big drift → seek; small drift → speed up/slow down a bit.
          // (The main video itself drives the clock, see loop(), so it never needs this.)
          const drift = el.currentTime - desired;
          if (Math.abs(drift) > Math.max(0.35, 0.2 * rate)) {
            if (!el.seeking) el.currentTime = desired;
          } else {
            const target = Math.min(16, Math.max(0.0625, rate * (1 + Math.max(-0.08, Math.min(0.08, -drift * 0.6)))));
            if (Math.abs(el.playbackRate - target) > rate * 0.01) el.playbackRate = target;
          }
          if (el.paused) el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          if (!this.scrubbing && Math.abs(el.currentTime - desired) > 0.02 && !el.seeking && !this.undrawn.has(el)) el.currentTime = desired;
        }
      } else {
        if (!el.paused) el.pause();
        // pre-roll: get the next clip ready so there's no black flash at the cut
        const until = leaf.t0 - time;
        if (until > 0 && until < 1.5 && Math.abs(el.currentTime - leaf.src0) > 0.05 && !el.seeking) el.currentTime = leaf.src0;
      }
    }
    for (const key of [...this.fxVoices.keys()]) if (!fxLive.has(key)) this.stopFxVoice(key);
    // dispose elements of deleted clips
    for (const [id, el] of this.elements) {
      if (!liveIds.has(id)) {
        el.pause();
        el.removeAttribute('src');
        el.load();
        this.elements.delete(id);
        this.undrawn.delete(el);
      }
    }
  }

  private source = (clip: MediaClip, key: string): FrameSource | null => {
    if (clip.type === 'image') {
      const img = this.getImage(clip.mediaId);
      if (!img || !img.complete || !img.naturalWidth) return null;
      return { image: img, width: img.naturalWidth, height: img.naturalHeight };
    }
    const el = this.elements.get(key) as HTMLVideoElement | undefined;
    const elReady = !!el && el.readyState >= 2 && !!el.videoWidth;
    // dragging the playhead (or the <video> still catching up after it): fast scrub frames
    const elBehind = !!el && (el.seeking || Math.abs(el.currentTime - this.desiredSrc(key)) > 0.05);
    if (clip.type === 'video' && (this.scrubbing || (!useEditor.getState().playing && (!elReady || elBehind) && this.scrubActive))) {
      const media = useEditor.getState().media.find((m) => m.id === clip.mediaId);
      const f = media ? scrubFrame(media, this.desiredSrc(key), () => (this.dirty = true)) : null;
      if (f) return { image: f, width: f.width, height: f.height };
    }
    if (!el || !elReady) return null;
    return { image: el, width: el.videoWidth, height: el.videoHeight };
  };

  /** Source time a leaf should show now. */
  private desiredSrc(key: string) {
    const leaf = this.getLeaves().find((l) => l.key === key);
    if (!leaf) return 0;
    const t = this.currentTime;
    return leaf.src0 + (t - leaf.t0) * leaf.rate;
  }
  private currentTime = 0;
  /** scrub frames are used until the full-quality <video> frame is back after a drag */
  private get scrubActive() {
    return this.scrubRelease !== null;
  }

  /** Timeline time according to the playing main video (null if there's none to follow). */
  private masterTime(prev: number): number | null {
    let best: Leaf | null = null;
    for (const leaf of this.getLeaves()) {
      if (leaf.clip.type !== 'video' || leaf.hidden || prev < leaf.t0 || prev >= leaf.t1) continue;
      if (!best || (leaf.clip.trackId === 'main' && best.clip.trackId !== 'main')) best = leaf;
    }
    if (!best) return null;
    const el = this.elements.get(best.key);
    if (!el || el.paused || el.seeking || el.readyState < 3) return null;
    const t = best.t0 + (el.currentTime - best.src0) / best.rate;
    // ignore it right after a seek or when it's somewhere else
    if (t < best.t0 - 0.05 || t > best.t1 + 0.1 || Math.abs(t - prev) > 0.5 * Math.max(1, best.rate)) return null;
    return t;
  }

  /** True while a visible video at this time is still seeking/loading (its frame isn't available yet). */
  private waitingForFrames(time: number) {
    if (this.scrubbing) return false;
    for (const leaf of this.getLeaves()) {
      if (leaf.clip.type !== 'video' || leaf.hidden || time < leaf.t0 || time >= leaf.t1) continue;
      const el = this.elements.get(leaf.key);
      if (!el || el.seeking || el.readyState < 2) return true;
    }
    return false;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const s = useEditor.getState();
    let time = s.time;
    if (!s.playing && this.showTime !== null) time = this.showTime;
    this.currentTime = time;
    if (s.playing) {
      const now = performance.now();
      time = this.timeAtStart + (now - this.clockStart) / 1000;
      // The main video drives the clock: every decoded frame is shown, in order, even at 5x–10x.
      // If the computer can't decode that fast, playback goes a little slower instead of jumping.
      const master = this.masterTime(s.time);
      if (master !== null) {
        time = Math.max(s.time, master);
        this.timeAtStart = time;
        this.clockStart = now;
      }
      const end = projectDuration(s.clips);
      if (time >= end) {
        time = end;
        s.setTime(end);
        this.pause();
      } else s.setTime(time);
    }
    this.sync(time, s.playing);
    if (!this.canvas) {
      this.undrawn.clear();
      return;
    }
    if (!s.playing && !this.dirty) return;
    // Keep showing the previous frame while a video seeks (instead of flashing black),
    // unless it takes too long (e.g. a file that can't be decoded).
    if (this.waitingForFrames(time)) {
      const now = performance.now();
      this.notReadySince ??= now;
      if (now - this.notReadySince < 600) {
        this.dirty = true;
        return;
      }
    }
    this.notReadySince = null;
    this.dirty = false;
    const ctx = this.canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    this.hits = renderFrame(ctx, this.canvas.width, this.canvas.height, {
      time,
      tracks: s.tracks,
      clips: s.clips,
      settings: s.settings,
      getSource: this.source,
      pool: this.pool,
    });
    this.undrawn.clear();
    // selection box with corner handles (preview only)
    if (!s.playing) {
      const hp = this.handlePx;
      ctx.save();
      for (const h of this.hits) {
        if (!s.selectedIds.includes(h.clipId)) continue;
        if (h.clipId === this.maskClip && s.clips.some((c) => c.id === h.clipId && c.type !== 'text' && (c as { mask?: unknown }).mask)) continue;
        ctx.save();
        ctx.translate(h.cx, h.cy);
        ctx.rotate((h.rotation * Math.PI) / 180);
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = Math.max(1.5, hp / 5);
        ctx.strokeRect(-h.w / 2, -h.h / 2, h.w, h.h);
        ctx.fillStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, hp / 6);
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.beginPath();
          ctx.arc((sx * h.w) / 2, (sy * h.h) / 2, hp / 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        ctx.restore();
        // rotation handle (videos and photos), drawn in canvas space
        if (s.clips.some((c) => c.id === h.clipId && c.type !== 'text')) {
          const W = this.canvas.width;
          const H = this.canvas.height;
          const q = rotHandlePos(h, hp, W, H);
          const a = (h.rotation * Math.PI) / 180;
          const e = { x: h.cx + (h.h / 2) * Math.sin(a), y: h.cy - (h.h / 2) * Math.cos(a) };
          ctx.lineWidth = Math.max(1.5, hp / 5);
          ctx.strokeStyle = '#22d3ee';
          ctx.beginPath();
          ctx.moveTo(e.x, e.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(q.x, q.y, hp * 0.75, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(q.x, q.y, hp * 0.38, -Math.PI * 0.2, Math.PI * 1.3);
          ctx.strokeStyle = '#0b5563';
          ctx.lineWidth = Math.max(1, hp / 7);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  };
}

export const player = new PreviewEngine();

/**
 * Where the rotation handle goes: just above the box, or just inside its top edge when the box
 * fills the frame (the usual case for a full-screen video) so it's always reachable.
 */
export function rotHandlePos(h: HitBox, hp: number, W: number, H: number) {
  const a = (h.rotation * Math.PI) / 180;
  const at = (d: number) => ({ x: h.cx + d * Math.sin(a), y: h.cy - d * Math.cos(a) });
  const out = at(h.h / 2 + hp * 2.6);
  const m = hp * 1.2;
  if (out.x > m && out.x < W - m && out.y > m && out.y < H - m) return out;
  return at(Math.max(0, h.h / 2 - hp * 2.6));
}

// Redraw whenever the project changes
useEditor.subscribe((s, prev) => {
  if (
    s.clips !== prev.clips ||
    s.tracks !== prev.tracks ||
    s.settings !== prev.settings ||
    s.time !== prev.time ||
    s.media !== prev.media ||
    s.selectedIds !== prev.selectedIds ||
    s.playing !== prev.playing
  ) {
    player.invalidate();
  }
});

// Redraw once AI models / processed audio are ready
onSegmenterChange(() => player.invalidate());
onFxReady(() => player.invalidate());
