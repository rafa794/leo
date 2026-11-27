import { describe, expect, it } from 'vitest';
import { busyLabels, syncTasks, useBusy, whenIdle } from '../../src/lib/busy';

describe('background tasks', () => {
  it('mirrors jobs per kind and resolves when everything is done', async () => {
    syncTasks('erase', 'Borrando objetos', [{ id: 'c1', progress: 0.5 }]);
    syncTasks('reverse', 'Revirtiendo un clip', [{ id: 'c2', progress: 0 }]);
    expect(useBusy.getState().tasks.map((t) => t.id)).toEqual(['erase:c1', 'reverse:c2']);
    expect(busyLabels()).toBe('Borrando objetos, Revirtiendo un clip');
    let idle = false;
    const p = whenIdle().then(() => (idle = true));
    syncTasks('erase', 'Borrando objetos', []);
    await Promise.resolve();
    expect(idle).toBe(false);
    syncTasks('reverse', 'Revirtiendo un clip', []);
    await p;
    expect(idle).toBe(true);
  });
});
