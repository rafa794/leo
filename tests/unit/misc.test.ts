import { describe, expect, it } from 'vitest';
import { clamp, formatTime } from '../../src/lib/util';
import { envelopeGain } from '../../src/lib/timeline';

describe('utils', () => {
  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });
  it('formatTime shows minutes and seconds', () => {
    expect(formatTime(65)).toMatch(/01:05/);
  });
  it('fade envelope goes 0 → 1 → 0', () => {
    const e = { start: 0, end: 10, fadeIn: 2, fadeOut: 2, volume: 1 } as unknown as Parameters<typeof envelopeGain>[0];
    expect(envelopeGain(e, 0)).toBeCloseTo(0);
    expect(envelopeGain(e, 5)).toBeCloseTo(1);
    expect(envelopeGain(e, 10)).toBeCloseTo(0, 1);
  });
});
