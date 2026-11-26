import { useEffect } from 'react';
import { useEditor } from '../store/editor';
import { player } from './player';
import { useLayout } from '../store/layout';
import { TRANSFORM_KEYS } from './keyframes';
import { openPasteAttributes } from '../components/PasteAttributes';

/** CapCut-like keyboard shortcuts. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target;
      if (el instanceof HTMLElement && el.closest('input, textarea, select, [contenteditable]')) return;
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const fps = s.settings.fps;

      if (k === ' ') {
        e.preventDefault();
        player.toggle();
      } else if ((mod && k === 'b') || (!mod && k === 's')) {
        e.preventDefault();
        s.splitAtPlayhead();
      } else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        if (s.focusArea === 'timeline') s.deleteSelected();
      } else if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        s.redo();
      } else if (mod && e.altKey && e.code === 'KeyC') {
        e.preventDefault();
        if (s.selectedIds.length === 1) s.copyAttributes(s.selectedIds[0]);
      } else if (mod && e.altKey && e.code === 'KeyV') {
        e.preventDefault();
        if (s.selectedIds.length) openPasteAttributes(s.selectedIds);
      } else if (mod && k === 'c') {
        e.preventDefault();
        // in the media bin: copy the files (⌘V inserts them at the playhead)
        if (s.focusArea === 'media' && s.mediaSelection.length) s.copyMedia(s.media.filter((m) => s.mediaSelection.includes(m.id)).map((m) => m.id));
        else s.copySelected();
      } else if (mod && k === 'x') {
        e.preventDefault();
        s.copySelected();
        s.deleteSelected();
      } else if (mod && k === 'v') {
        e.preventDefault();
        s.paste();
      } else if (mod && k === 'd') {
        e.preventDefault();
        s.duplicateSelected();
      } else if (mod && k === 'a') {
        e.preventDefault();
        if (s.focusArea === 'media') s.setMediaSelection(s.media.map((m) => m.id));
        else s.select(s.clips.map((c) => c.id));
      } else if (k === 'arrowleft' || k === 'arrowright') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / fps;
        player.seek(s.time + (k === 'arrowleft' ? -step : step));
      } else if (k === 'home') {
        player.seek(0);
      } else if (k === '+' || k === '=') {
        s.setZoom(s.zoom * 1.25);
      } else if (k === '-') {
        s.setZoom(s.zoom / 1.25);
      } else if (e.altKey && e.code === 'KeyG') {
        e.preventDefault();
        if (e.shiftKey) s.selectedIds.forEach((id) => s.ungroupCompound(id));
        else s.createCompound();
      } else if (!mod && k === 'm') {
        e.preventDefault();
        s.toggleMute(s.selectedIds);
      } else if (!mod && k === 'k') {
        e.preventDefault();
        if (s.selectedIds.length === 1) s.toggleKeys(s.selectedIds[0], TRANSFORM_KEYS);
        else s.setStatus('Selecciona un clip para ponerle un fotograma clave');
      } else if (!mod && k === 'f') {
        e.preventDefault();
        useLayout.getState().toggleFocus();
      } else if (k === 'escape') {
        // Esc with nothing selected leaves the clip combinado
        if (!s.selectedIds.length && s.compoundStack.length) s.exitCompound();
        s.select([]);
        s.setMediaSelection([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
