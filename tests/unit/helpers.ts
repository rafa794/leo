import { useEditor, MAIN_TRACK } from '../../src/store/editor';
import type { MediaClip, MediaItem } from '../../src/types';

/** A fake 10 s 1280×720 video (no real file: the store never reads it). */
export function fakeMedia(id = 'm1', duration = 10): MediaItem {
  return { id, name: `${id}.mp4`, kind: 'video', file: {} as File, url: '', duration, width: 1280, height: 720, hasAudio: true, thumbnails: [] };
}

/** Fresh editor with the given media already imported. */
export function resetEditor(...media: MediaItem[]) {
  const s = useEditor.getState();
  useEditor.setState({
    clips: [],
    tracks: s.tracks.filter((t) => t.id === MAIN_TRACK).map((t) => ({ ...t, hidden: false, muted: false })),
    media: [],
    selectedIds: [],
    time: 0,
    compoundStack: [],
  } as Partial<ReturnType<typeof useEditor.getState>>);
  for (const m of media) useEditor.getState().addMedia(m);
}

export const ed = () => useEditor.getState();
export const mediaClips = () => ed().clips.filter((c): c is MediaClip => c.type !== 'text');
export const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;
