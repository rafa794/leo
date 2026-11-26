import { create } from 'zustand';
import { cleanupExportFiles, exportVideo, removeExportFile, type ExportJob, type ExportOptions } from './exporter';
import { saveFile } from './platform';

/**
 * Exports run in the background, one after another, while you keep editing.
 * Each export uses a snapshot of the project taken when you pressed "Exportar",
 * so later edits don't change a video that is already being made.
 */

export interface ExportTask {
  id: number;
  name: string; // file name without extension
  opts: ExportOptions;
  job: ExportJob;
  state: 'queued' | 'running' | 'saving' | 'done' | 'error' | 'cancelled';
  progress: number;
  label: string;
  startedAt?: number;
  result?: { url: string; size: number; where: string; uri?: string; secs: number; file?: string };
  error?: string;
  ctrl: AbortController;
}

export const useExports = create<{ tasks: ExportTask[] }>(() => ({ tasks: [] }));

let nextId = 1;
const patch = (id: number, p: Partial<ExportTask>) =>
  useExports.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) }));

export function enqueueExport(job: ExportJob, opts: ExportOptions, name: string) {
  const task: ExportTask = { id: nextId++, name: name || 'video', opts, job, state: 'queued', progress: 0, label: 'En cola…', ctrl: new AbortController() };
  useExports.setState((s) => ({ tasks: [...s.tasks, task] }));
  void runNext();
  return task.id;
}

export function cancelExport(id: number) {
  const t = useExports.getState().tasks.find((x) => x.id === id);
  if (!t) return;
  t.ctrl.abort();
  if (t.state === 'queued') patch(id, { state: 'cancelled', label: 'Cancelada' });
}

export function dismissExport(id: number) {
  const t = useExports.getState().tasks.find((x) => x.id === id);
  if (t?.result) {
    const r = t.result;
    setTimeout(() => {
      URL.revokeObjectURL(r.url);
      if (r.file) void removeExportFile(r.file);
    }, 60_000);
  }
  useExports.setState((s) => ({ tasks: s.tasks.filter((x) => x.id !== id) }));
}

export const exportsRunning = () => useExports.getState().tasks.some((t) => t.state === 'running' || t.state === 'queued' || t.state === 'saving');

// export files left from earlier sessions (already saved for you) are cleaned up
void cleanupExportFiles();

let busy = false;
async function runNext() {
  if (busy) return;
  const task = useExports.getState().tasks.find((t) => t.state === 'queued');
  if (!task) return;
  busy = true;
  const t0 = performance.now();
  patch(task.id, { state: 'running', startedAt: Date.now(), label: 'Preparando…' });
  try {
    let lastUi = 0;
    const blob = await exportVideo(
      task.job,
      task.opts,
      (p, label) => {
        const now = performance.now();
        if (now - lastUi < 200 && p < 1) return; // don't re-render the panel on every frame
        lastUi = now;
        const elapsed = (now - t0) / 1000;
        const eta = p > 0.02 ? (elapsed / p) * (1 - p) : 0;
        patch(task.id, { progress: p, label: eta ? `${label} · quedan ~${fmt(eta)}` : label });
      },
      task.ctrl.signal,
    );
    patch(task.id, { state: 'saving', progress: 1, label: 'Guardando…' });
    const saved = await saveFile(blob, `${task.name}.mp4`);
    patch(task.id, {
      state: 'done',
      label: 'Listo',
      result: { url: URL.createObjectURL(blob), size: blob.size, where: saved.where, uri: saved.uri, secs: (performance.now() - t0) / 1000, file: blob instanceof File ? blob.name : undefined },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError' || task.ctrl.signal.aborted) patch(task.id, { state: 'cancelled', label: 'Cancelada' });
    else patch(task.id, { state: 'error', error: e instanceof Error ? e.message : String(e), label: 'Error' });
  } finally {
    busy = false;
    void runNext();
  }
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min ${r.toString().padStart(2, '0')} s` : `${r} s`;
}
