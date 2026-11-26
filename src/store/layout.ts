import { create } from 'zustand';

/** Size and visibility of the editor panels. Remembered between sessions. */
export interface LayoutState {
  leftW: number; // width of the left panel content (without the 64 px tab rail)
  rightW: number;
  timelineH: number;
  leftOpen: boolean;
  rightOpen: boolean;
  leftTab: LeftTab;
  /** phone / narrow window: preview height in px */
  previewH: number;
}

export type LeftTab = 'media' | 'audio' | 'text' | 'stickers' | 'captions';
/** On narrow screens (phones, small windows) panels open as sheets from the bottom. */
export const COMPACT_QUERY = '(max-width: 820px)';

export const RAIL_W = 64;
export const LEFT_MIN = 220;
export const RIGHT_MIN = 220;
export const PANEL_MAX = 720;
const KEY = 'orion.layout.v1';
const DEFAULTS: LayoutState = { leftW: 276, rightW: 340, timelineH: 300, leftOpen: true, rightOpen: true, leftTab: 'media', previewH: 0 };

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* private window or blocked storage: use defaults */
  }
  return DEFAULTS;
}

export const useLayout = create<LayoutState & { sheet: null | 'left' | 'props'; set: (p: Partial<LayoutState & { sheet: null | 'left' | 'props' }>) => void; toggleFocus: () => void }>((set, get) => ({
  ...load(),
  sheet: null,
  set: (p) => set(p),
  /** "Ampliar visor": hide both side panels, or bring them back */
  toggleFocus: () => {
    const { leftOpen, rightOpen } = get();
    const open = !(leftOpen || rightOpen);
    set({ leftOpen: open, rightOpen: open });
  },
}));

useLayout.subscribe((s) => {
  try {
    const { leftW, rightW, timelineH, leftOpen, rightOpen, leftTab, previewH } = s;
    localStorage.setItem(KEY, JSON.stringify({ leftW, rightW, timelineH, leftOpen, rightOpen, leftTab, previewH }));
  } catch {
    /* ignore */
  }
});

import { useSyncExternalStore } from 'react';
const mq = typeof window !== 'undefined' ? window.matchMedia(COMPACT_QUERY) : null;
/** True on phones and narrow windows. */
export function useCompact() {
  return useSyncExternalStore(
    (cb) => {
      mq?.addEventListener('change', cb);
      return () => mq?.removeEventListener('change', cb);
    },
    () => !!mq?.matches,
  );
}
