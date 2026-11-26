import type { Clip, MediaItem } from '../types';
import { isMediaClip } from '../types';
import { openInput } from './media';

/** Frames per second of each video file (measured once, then remembered). */
const cache = new Map<string, Promise<number | null>>();

export function videoFps(m: MediaItem): Promise<number | null> {
  if (m.kind !== 'video' || m.missing) return Promise.resolve(null);
  let p = cache.get(m.id);
  if (!p) {
    p = (async () => {
      try {
        const track = await openInput(m.file).getPrimaryVideoTrack();
        if (!track) return null;
        const stats = await track.computePacketStats(120);
        return stats.averagePacketRate || null;
      } catch {
        return null;
      }
    })();
    cache.set(m.id, p);
  }
  return p;
}

/** Highest frame rate among the videos used by these clips (also inside clips combinados). */
export async function sourceFps(clips: Clip[], media: MediaItem[]): Promise<number | null> {
  const ids = new Set<string>();
  const walk = (list: Clip[]) =>
    list.forEach((c) => {
      if (!isMediaClip(c)) return;
      if (c.type === 'video') ids.add(c.mediaId);
      if (c.compound) walk(c.compound.clips);
    });
  walk(clips);
  const rates = await Promise.all(media.filter((m) => ids.has(m.id)).map(videoFps));
  const ok = rates.filter((r): r is number => !!r);
  return ok.length ? Math.max(...ok) : null;
}

export const EXPORT_FPS = [24, 25, 30, 50, 60];

/** The export option that matches a camera rate (29.97 → 30, 59.94 → 60…). */
export const nearestFps = (fps: number) => EXPORT_FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
