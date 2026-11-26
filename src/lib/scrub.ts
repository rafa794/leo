import { CanvasSink, type InputVideoTrack } from 'mediabunny';
import type { MediaItem } from '../types';
import { openInput } from './media';

/**
 * Fast frames while dragging the playhead (like CapCut).
 *
 * A <video> element re-decodes from the previous keyframe on EVERY seek, which is slow with long-GOP
 * camera files (4K HEVC GoPro). Here a WebCodecs decoder is kept running instead:
 *  - going forward it just keeps decoding from where it is (almost free);
 *  - going backward it decodes the second before the target in one go and keeps those frames,
 *    so stepping back frame by frame is instant;
 *  - while a frame is on its way, the nearest one already decoded is shown (never black).
 * Frames are decoded small (preview size); the full-quality frame comes back when you let go.
 */

const SCRUB_WIDTH = 960;
const CACHE_FRAMES = 160;
const AHEAD = 1.5; // seconds decoded ahead when moving forward
const BEHIND = 1.0; // seconds decoded at once when moving backward

interface Frame {
  t: number;
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

class ScrubSource {
  private track: InputVideoTrack | null = null;
  private sink: CanvasSink | null = null;
  private ready: Promise<void>;
  private frames: Frame[] = []; // sorted by time
  private target = 0;
  private running = false;
  private iter: AsyncIterator<{ canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number } | null> | null = null;
  private iterPos = -Infinity; // timestamp of the last frame produced by iter
  private iterEnd = -Infinity;
  frameDur = 1 / 30;
  failed = false;
  onFrame: (() => void) | null = null;

  constructor(private media: MediaItem) {
    this.ready = (async () => {
      try {
        const track = await openInput(media.file).getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) throw new Error('no decode');
        this.track = track;
        const w = Math.min(SCRUB_WIDTH, track.displayWidth);
        const h = Math.max(2, Math.round((w * track.displayHeight) / track.displayWidth / 2) * 2);
        // poolSize 0: every frame gets its own canvas, so cached frames are never overwritten
        this.sink = new CanvasSink(track, { width: w, height: h, fit: 'fill', poolSize: 0 });
        const stats = await track.computePacketStats(60).catch(() => null);
        if (stats?.averagePacketRate) this.frameDur = 1 / stats.averagePacketRate;
      } catch {
        this.failed = true;
      }
    })();
  }

  /** Best frame we have for time t (exact if cached, else the nearest), and asks for t. */
  get(t: number): HTMLCanvasElement | OffscreenCanvas | null {
    this.target = t;
    if (!this.running && !this.failed) void this.pump();
    return this.nearest(t)?.canvas ?? null;
  }

  private nearest(t: number): Frame | null {
    const f = this.frames;
    if (!f.length) return null;
    // the frame on screen at t is the last one starting at or before t
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= t + 1e-4) lo = mid;
      else hi = mid - 1;
    }
    const a = f[lo];
    if (a.t <= t + 1e-4) return a;
    return f[0];
  }

  private has(t: number) {
    const n = this.nearest(t);
    return !!n && n.t <= t + 1e-4 && t - n.t < this.frameDur * 1.5;
  }

  private add(fr: Frame) {
    const f = this.frames;
    let i = f.length;
    while (i > 0 && f[i - 1].t > fr.t) i--;
    if (i > 0 && Math.abs(f[i - 1].t - fr.t) < 1e-4) return;
    f.splice(i, 0, fr);
    // forget the frames furthest from where you are
    while (f.length > CACHE_FRAMES) {
      if (Math.abs(f[0].t - this.target) > Math.abs(f[f.length - 1].t - this.target)) f.shift();
      else f.pop();
    }
  }

  private async closeIter() {
    const it = this.iter;
    this.iter = null;
    this.iterPos = -Infinity;
    this.iterEnd = -Infinity;
    await it?.return?.(undefined);
  }

  private async pump() {
    this.running = true;
    try {
      await this.ready;
      if (!this.sink) return;
      let restarts = 0;
      let lastTarget = NaN;
      while (!this.has(this.target)) {
        const t = this.target;
        if (t !== lastTarget) {
          lastTarget = t;
          restarts = 0;
        }
        // keep going forward with the running decoder if the target is just ahead of it
        if (!(this.iter && t >= this.iterPos - 1e-4 && t <= this.iterEnd)) {
          await this.closeIter();
          if (++restarts > 2) break; // can't get closer (e.g. before the first frame)
          const goingBack = t < this.iterPos || this.frames.some((f) => f.t > t);
          const start = Math.max(0, goingBack ? t - BEHIND : t);
          this.iterEnd = t + AHEAD;
          this.iter = this.sink.canvases(start, this.iterEnd)[Symbol.asyncIterator]();
          this.iterPos = start - 1e-3;
        }
        const r = await this.iter!.next();
        if (r.done || !r.value) {
          await this.closeIter();
          // past the end of the file: show the last frame
          if (this.frames.length && t > this.frames[this.frames.length - 1].t) break;
          continue;
        }
        this.iterPos = r.value.timestamp;
        this.add({ t: r.value.timestamp, canvas: r.value.canvas });
        if (Math.abs(r.value.timestamp - this.target) < this.frameDur * 2) this.onFrame?.();
      }
      this.onFrame?.();
    } catch {
      await this.closeIter();
    } finally {
      this.running = false;
    }
  }

  dispose() {
    void this.closeIter();
    this.frames = [];
  }
}

const sources = new Map<string, ScrubSource>();

/** A small, fast frame of this video at source time t for scrubbing (null if not available). */
export function scrubFrame(media: MediaItem, t: number, onFrame: () => void) {
  if (media.missing || media.kind !== 'video') return null;
  let s = sources.get(media.id);
  if (!s) {
    s = new ScrubSource(media);
    sources.set(media.id, s);
  }
  s.onFrame = onFrame;
  if (s.failed) return null;
  return s.get(t);
}

/** Free the decoders and cached frames (e.g. some seconds after you stop scrubbing). */
export function releaseScrub() {
  sources.forEach((s) => s.dispose());
  sources.clear();
}
