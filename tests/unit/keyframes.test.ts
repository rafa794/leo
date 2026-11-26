import { describe, expect, it } from 'vitest';
import * as kf from '../../src/lib/keyframes';
import { ed, fakeMedia, mediaClips, resetEditor } from './helpers';

describe('keyframes', () => {
  it('interpolates linearly between keys and holds the ends', () => {
    const keys = [
      { t: 1, v: 0 },
      { t: 3, v: 10 },
    ];
    expect(kf.interp(keys, 0)).toBe(0);
    expect(kf.interp(keys, 2)).toBe(5);
    expect(kf.interp(keys, 9)).toBe(10);
  });

  it('interpolates scale geometrically (even zoom)', () => {
    const keys = [
      { t: 0, v: 1 },
      { t: 2, v: 4 },
    ];
    expect(kf.interp(keys, 1, 'transform.scale')).toBeCloseTo(2);
  });

  it('withPath / getPath work on nested values without mutating', () => {
    const o = { transform: { x: 1 } };
    const n = kf.withPath(o, 'transform.y', 5);
    expect(kf.getPath(n, 'transform.y')).toBe(5);
    expect(kf.getPath(n, 'transform.x')).toBe(1);
    expect(o).toEqual({ transform: { x: 1 } });
  });

  it('source time and timeline time are inverse, with speed', () => {
    resetEditor(fakeMedia());
    ed().addMediaClip('m1');
    const c = { ...mediaClips()[0], start: 2, trimStart: 1, speed: 2 };
    expect(kf.srcTime(c, 4)).toBe(5);
    expect(kf.timelineTime(c, kf.srcTime(c, 3.3))).toBeCloseTo(3.3);
  });

  it('a key added before a split does not affect the new right part', () => {
    resetEditor(fakeMedia());
    ed().addMediaClip('m1');
    const id = mediaClips()[0].id;
    ed().setTime(1);
    ed().select([id]);
    ed().toggleKeys(id, ['transform.x']); // the diamond button
    ed().setValues(id, { 'transform.x': 0.3 });
    ed().setTime(2);
    ed().setValues(id, { 'transform.x': -0.3 });
    expect(Object.keys(mediaClips()[0].keyframes ?? {})).toContain('transform.x');
    ed().setTime(5);
    ed().select([id]);
    ed().splitAtPlayhead();
    const [left, right] = [...mediaClips()].sort((a, b) => a.start - b.start);
    expect(kf.liveKeys(left, 'transform.x').length).toBe(2);
    expect(kf.liveKeys(right, 'transform.x').length).toBe(0);
    expect(right.keyframes?.['transform.x']?.length ?? 0).toBe(0);
  });
});
