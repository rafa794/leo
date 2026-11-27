import { create } from 'zustand';

/**
 * The coffee reminder, kept polite: Leo asks ONCE, after the 10th video exported on this device, and never
 * again (nor at all) once the user says they already bought a coffee. Everything stays in this device's storage.
 */

export const NUDGE_AT = 10;
const COUNT_KEY = 'orion.exportCount';
const DONATED_KEY = 'orion.donated';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage blocked: the reminder just won't be remembered */
  }
}

/** Whether a finished export number `n` gets the reminder. */
export const shouldNudge = (n: number, donated: boolean) => !donated && n === NUDGE_AT;

export const useSupport = create<{ donated: boolean }>(() => ({ donated: read(DONATED_KEY) === '1' }));

/** "Ya he invitado": hides the reminder for good. */
export function markDonated() {
  write(DONATED_KEY, '1');
  useSupport.setState({ donated: true });
}

/** Counts a finished export; true if this one should show the coffee reminder. */
export function countExport(): boolean {
  const n = (Number(read(COUNT_KEY)) || 0) + 1;
  write(COUNT_KEY, String(n));
  return shouldNudge(n, useSupport.getState().donated);
}
