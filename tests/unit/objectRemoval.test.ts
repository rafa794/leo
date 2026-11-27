import { describe, expect, it } from 'vitest';
import { cropAround, maskBox, scaleMask } from '../../src/lib/objectRemoval';

describe('borrar objetos: mask helpers', () => {
  it('finds the painted box', () => {
    const w = 10, h = 8;
    const m = new Uint8Array(w * h);
    m[2 * w + 3] = 255;
    m[5 * w + 7] = 255;
    expect(maskBox(m, w, h)).toEqual({ x0: 3, y0: 2, x1: 8, y1: 6 });
    expect(maskBox(new Uint8Array(w * h), w, h)).toBeNull();
  });
  it('crops at least 512 px around the painting, inside the picture', () => {
    const c = cropAround({ x0: 3800, y0: 2100, x1: 3830, y1: 2150 }, 3840, 2160);
    expect(c.w).toBe(512);
    expect(c.h).toBe(512);
    expect(c.x + c.w).toBeLessThanOrEqual(3840);
    expect(c.y + c.h).toBeLessThanOrEqual(2160);
    expect(c.x).toBeLessThanOrEqual(3800);
    // a big painting gets 2.5× room, never more than the picture
    const big = cropAround({ x0: 100, y0: 100, x1: 700, y1: 500 }, 1280, 720);
    expect(big).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });
  it('resizes a mask (nearest neighbour)', () => {
    const m = new Uint8Array([255, 0, 0, 255]);
    expect(Array.from(scaleMask(m, 2, 2, 4, 2))).toEqual([255, 255, 0, 0, 0, 0, 255, 255]);
  });
});
