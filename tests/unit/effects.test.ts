import { describe, expect, it } from 'vitest';
import { EFFECTS, EFFECT_GROUPS, effectDef } from '../../src/lib/effects';

describe('effects catalog', () => {
  it('has unique ids and shader codes', () => {
    expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(EFFECTS.length);
    expect(new Set(EFFECTS.map((e) => e.code)).size).toBe(EFFECTS.length);
    expect(EFFECTS.every((e) => e.code > 0 && e.intensity > 0 && e.intensity <= 100)).toBe(true);
  });
  it('every gallery group lists known effects, and every effect is in a group', () => {
    const grouped = EFFECT_GROUPS.flatMap(([, ids]) => ids);
    expect(grouped.every((id) => effectDef(id))).toBe(true);
    expect(EFFECTS.every((e) => grouped.includes(e.id))).toBe(true);
  });
});
