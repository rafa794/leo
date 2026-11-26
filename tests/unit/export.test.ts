// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { exportDuration, selectionJob, singleClipJob } from '../../src/lib/exporter';
import { EXPORT_FPS, nearestFps } from '../../src/lib/fps';
import { MAIN_TRACK } from '../../src/store/editor';
import { byStart, ed, fakeMedia, mediaClips, resetEditor } from './helpers';

const job = () => {
  const s = ed();
  return { clips: s.clips, tracks: s.tracks, media: s.media, settings: s.settings };
};

describe('export helpers', () => {
  it('nearestFps picks the closest export rate', () => {
    expect(nearestFps(29.97)).toBe(30);
    expect(nearestFps(59.94)).toBe(60);
    expect(nearestFps(23.976)).toBe(24);
    expect(EXPORT_FPS).toContain(25);
  });

  it('hidden tracks do not make the video longer', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 20));
    ed().addMediaClip('a');
    const tracksBefore = ed().tracks.map((t) => t.id);
    ed().addMediaClip('b', { start: 0, trackId: undefined });
    let b = mediaClips().find((c) => c.mediaId === 'b')!;
    if (b.trackId === MAIN_TRACK) {
      ed().moveToNewTrack([b.id]);
      b = mediaClips().find((c) => c.mediaId === 'b')!;
    }
    expect(tracksBefore).toContain(MAIN_TRACK);
    const long = exportDuration(ed().clips, ed().tracks);
    expect(long).toBeGreaterThanOrEqual(20);
    ed().toggleTrack(b.trackId, 'hidden');
    expect(exportDuration(ed().clips, ed().tracks)).toBeCloseTo(4);
  });

  it('selectionJob moves the selection to 0 and unhides its tracks', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 6));
    ed().addMediaClips(['a', 'b']);
    const [, b] = mediaClips().sort(byStart);
    ed().toggleTrack(MAIN_TRACK, 'hidden');
    const j = selectionJob(job(), [b.id]);
    expect(j.clips.length).toBe(1);
    expect(j.clips[0].start).toBe(0);
    expect(j.tracks.every((t) => !t.hidden)).toBe(true);
  });

  it('singleClipJob exports just that clip from 0', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 6));
    ed().addMediaClips(['a', 'b']);
    const [, b] = mediaClips().sort(byStart);
    const j = singleClipJob(job(), b.id);
    expect(j.clips).toHaveLength(1);
    expect(j.clips[0].start).toBe(0);
    expect(() => singleClipJob(job(), 'nope')).toThrow();
  });
});
