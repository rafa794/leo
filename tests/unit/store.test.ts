import { describe, expect, it } from 'vitest';
import { MAIN_TRACK } from '../../src/store/editor';
import { byStart, ed, fakeMedia, mediaClips, resetEditor } from './helpers';

describe('editor store', () => {
  it('adds clips one after another on the main track', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 6));
    ed().addMediaClips(['a', 'b']);
    const cs = mediaClips().sort(byStart);
    expect(cs.map((c) => c.trackId)).toEqual([MAIN_TRACK, MAIN_TRACK]);
    expect(cs[0].start).toBe(0);
    expect(cs[1].start).toBeCloseTo(4);
  });

  it('split at the playhead keeps total length and source continuity', () => {
    resetEditor(fakeMedia('a', 10));
    ed().addMediaClip('a');
    const id = mediaClips()[0].id;
    ed().select([id]);
    ed().setTime(3);
    ed().splitAtPlayhead();
    const [l, r] = mediaClips().sort(byStart);
    expect(l.duration).toBeCloseTo(3);
    expect(r.start).toBeCloseTo(3);
    expect(r.trimStart).toBeCloseTo(3);
    expect(l.duration + r.duration).toBeCloseTo(10);
  });

  it('undo and redo restore the timeline', () => {
    resetEditor(fakeMedia('a', 10));
    ed().addMediaClip('a');
    ed().select([mediaClips()[0].id]);
    ed().setTime(5);
    ed().splitAtPlayhead();
    expect(mediaClips().length).toBe(2);
    ed().undo();
    expect(mediaClips().length).toBe(1);
    ed().redo();
    expect(mediaClips().length).toBe(2);
  });

  it('deleting a clip on the main (magnet) track closes the gap', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 6));
    ed().addMediaClips(['a', 'b']);
    const [first] = mediaClips().sort(byStart);
    ed().select([first.id]);
    ed().deleteSelected();
    expect(mediaClips().length).toBe(1);
    expect(mediaClips()[0].start).toBe(0);
  });

  it('moveToNewTrack puts the clips on a new track above', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 6));
    ed().addMediaClips(['a', 'b']);
    const [, second] = mediaClips().sort(byStart);
    const tracksBefore = ed().tracks.length;
    ed().moveToNewTrack([second.id]);
    expect(ed().tracks.length).toBe(tracksBefore + 1);
    const moved = mediaClips().find((c) => c.id === second.id)!;
    expect(moved.trackId).not.toBe(MAIN_TRACK);
  });

  it('hiding and muting a track toggles its flags', () => {
    resetEditor(fakeMedia('a', 4));
    ed().addMediaClip('a');
    ed().toggleTrack(MAIN_TRACK, 'hidden');
    expect(ed().tracks.find((t) => t.id === MAIN_TRACK)!.hidden).toBe(true);
    ed().toggleTrack(MAIN_TRACK, 'hidden');
    ed().toggleTrack(MAIN_TRACK, 'muted');
    expect(ed().tracks.find((t) => t.id === MAIN_TRACK)!.muted).toBe(true);
  });

  it('compound clip: create, enter, exit and ungroup', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 6));
    ed().addMediaClips(['a', 'b']);
    ed().select(mediaClips().map((c) => c.id));
    ed().createCompound();
    const comp = mediaClips().find((c) => c.type === 'compound')!;
    expect(comp).toBeTruthy();
    expect(comp.duration).toBeCloseTo(10);
    ed().enterCompound(comp.id);
    expect(mediaClips().length).toBe(2);
    ed().exitCompound();
    expect(mediaClips().filter((c) => c.type === 'compound').length).toBe(1);
    ed().ungroupCompound(comp.id);
    expect(mediaClips().length).toBe(2);
  });

  it('text clips are added and editable', () => {
    resetEditor();
    ed().addText('GOL');
    const t = ed().clips.find((c) => c.type === 'text')!;
    expect(t.type === 'text' && t.text).toBe('GOL');
    ed().updateClip(t.id, { text: 'GOLAZO' });
    const t2 = ed().clips.find((c) => c.id === t.id)!;
    expect(t2.type === 'text' && t2.text).toBe('GOLAZO');
  });

  it('copy and paste attributes (color) to another clip', () => {
    resetEditor(fakeMedia('a', 4), fakeMedia('b', 6));
    ed().addMediaClips(['a', 'b']);
    const [a, b] = mediaClips().sort(byStart);
    ed().updateClip(a.id, { adjust: { ...a.adjust, saturation: 40 } });
    ed().copyAttributes(a.id);
    ed().pasteAttributes([b.id], ['adjust']);
    expect(mediaClips().find((c) => c.id === b.id)!.adjust.saturation).toBe(40);
  });
});
