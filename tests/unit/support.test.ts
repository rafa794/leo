import { describe, expect, it } from 'vitest';
import { NUDGE_AT, shouldNudge } from '../../src/lib/support';

describe('coffee reminder', () => {
  it('asks only once, on the 10th export', () => {
    const asked = Array.from({ length: 50 }, (_, i) => i + 1).filter((n) => shouldNudge(n, false));
    expect(asked).toEqual([NUDGE_AT]);
    expect(NUDGE_AT).toBe(10);
  });
  it('never asks someone who already bought a coffee', () => {
    expect(shouldNudge(NUDGE_AT, true)).toBe(false);
  });
});
