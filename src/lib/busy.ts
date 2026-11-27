import { create } from 'zustand';

/**
 * Long jobs that run in the background while you keep editing (erasing objects in a video, reversing a clip,
 * measuring camera shake…). They show in the bottom-right card with their progress, and an export started while one
 * is running waits for it ("exportaremos cuando termine"), so the video includes its result.
 */
export interface BusyTask {
  id: string;
  label: string;
  progress: number;
  cancel?: () => void;
}

export const useBusy = create<{ tasks: BusyTask[] }>(() => ({ tasks: [] }));

export function beginTask(id: string, label: string, cancel?: () => void) {
  useBusy.setState((s) => ({ tasks: [...s.tasks.filter((t) => t.id !== id), { id, label, progress: 0, cancel }] }));
}

export function updateTask(id: string, patch: Partial<Pick<BusyTask, 'label' | 'progress'>>) {
  useBusy.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function endTask(id: string) {
  useBusy.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
}

/** What is still running, as one sentence ("Borrando objetos, Revirtiendo un clip"). */
export const busyLabels = (tasks = useBusy.getState().tasks) => [...new Set(tasks.map((t) => t.label))].join(', ');

/** Resolves when nothing is running in the background any more. */
export function whenIdle(): Promise<void> {
  if (!useBusy.getState().tasks.length) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useBusy.subscribe((s) => {
      if (s.tasks.length) return;
      off();
      resolve();
    });
  });
}

/** Replaces all tasks of one kind (each module mirrors its own job list here whenever it changes). */
export function syncTasks(kind: string, label: string, items: { id: string; progress: number; cancel?: () => void }[]) {
  useBusy.setState((s) => ({
    tasks: [...s.tasks.filter((t) => !t.id.startsWith(`${kind}:`)), ...items.map((i) => ({ id: `${kind}:${i.id}`, label, progress: i.progress, cancel: i.cancel }))],
  }));
}
