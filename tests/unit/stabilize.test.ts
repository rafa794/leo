import { describe, expect, it } from 'vitest';
import { stabPath } from '../../src/lib/stabilize';
import type { Stabilization } from '../../src/types';

/** Camera that pans slowly to the right with random hand shake. */
function shakyData(n = 300, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const motion: number[] = [];
  for (let i = 0; i < n; i++) motion.push(i ? 0.001 + rnd() * 0.02 : 0, i ? rnd() * 0.02 : 0, i ? rnd() * 0.004 : 0, 0);
  return { t0: 0, dt: 1 / 30, aspect: 16 / 9, motion };
}

describe('stabilizer path', () => {
  const base: Stabilization = { on: true, mode: 'smooth', strength: 50, crop: 8, data: shakyData() };

  it('removes most of the shake', () => {
    const p = stabPath(base)!;
    expect(p.removed).toBeGreaterThan(0.6);
  });

  it('stronger smoothing removes at least as much', () => {
    const weak = stabPath({ ...base, strength: 10 })!;
    const strong = stabPath({ ...base, strength: 90 })!;
    expect(strong.removed).toBeGreaterThanOrEqual(weak.removed - 0.02);
  });

  it('never moves the picture beyond the crop margin (no black borders)', () => {
    for (const mode of ['smooth', 'tripod'] as const) {
      const p = stabPath({ ...base, mode })!;
      const room = p.zoom - 1;
      for (let i = 0; i < p.corr.length / 4; i++) {
        expect(Math.abs(p.corr[4 * i])).toBeLessThanOrEqual(room / 2 + 1e-6);
        expect(Math.abs(p.corr[4 * i + 1])).toBeLessThanOrEqual(room / 2 + 1e-6);
      }
    }
  });

  it('returns null without analysis data', () => {
    expect(stabPath({ ...base, data: undefined })).toBeNull();
  });
});
