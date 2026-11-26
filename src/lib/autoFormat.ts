import { useEditor } from '../store/editor';
import type { MediaItem } from '../types';

/**
 * The video format starts as the ORIGINAL size of your first video (e.g. a GoPro's almost square
 * 8:7, a phone's vertical 9:16…) instead of always 16:9. You can still pick another one at the top.
 */

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Size of the first video (or photo) used in the timeline. */
export function originalSize(): { width: number; height: number; name: string } | null {
  const s = useEditor.getState();
  const byId = new Map(s.media.map((m) => [m.id, m]));
  const first = [...s.clips]
    .filter((c) => c.type === 'video' || c.type === 'image')
    .sort((a, b) => a.start - b.start)
    .map((c) => ('mediaId' in c ? byId.get(c.mediaId) : undefined))
    .find((m): m is MediaItem => !!m && m.width > 0 && m.height > 0);
  const m = first ?? s.media.find((x) => x.kind === 'video' && x.width > 0);
  return m ? { width: even(m.width), height: even(m.height), name: m.name } : null;
}

let chosenByUser = false;
/** The user picked a format by hand: don't change it automatically anymore (this session). */
export const markFormatChosen = () => (chosenByUser = true);

let started = false;
export function initAutoFormat() {
  if (started) return;
  started = true;
  useEditor.subscribe((s, prev) => {
    // only when the first clips arrive in an empty timeline (a new project)
    // (opening a saved project also fills an empty timeline, but with no undo history: leave it alone)
    if (chosenByUser || prev.clips.length > 0 || s.clips.length === 0 || s.compoundStack.length || !s.past.length) return;
    const size = originalSize();
    if (!size) return;
    if (size.width === s.settings.width && size.height === s.settings.height) return;
    // after the current update finishes
    queueMicrotask(() => {
      useEditor.getState().setSettings({ width: size.width, height: size.height });
      useEditor.getState().setStatus(`Formato del vídeo original: ${size.width}×${size.height}`);
    });
  });
}
