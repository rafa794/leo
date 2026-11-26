import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end checks of the real app (built `dist/`), in a temporary profile that is deleted
 * afterwards — never your own projects. Uses the small test clips in public/_test.
 */
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CLIP1 = join(ROOT, 'public/_test/clip1.mp4');
const CLIP2 = join(ROOT, 'public/_test/clip2.mp4');

let app: ElectronApplication;
let page: Page;
let profile: string;
let downloads: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'orion-test-profile-'));
  downloads = mkdtempSync(join(tmpdir(), 'orion-test-out-'));
  // ORION_APP=release/mac-arm64/Orion.app/Contents/MacOS/Orion tests the packaged app instead of the dev build
  const packaged = process.env.ORION_APP;
  app = await electron.launch(
    packaged ? { executablePath: resolve(ROOT, packaged), args: [`--user-data-dir=${profile}`] } : { args: [ROOT, `--user-data-dir=${profile}`], cwd: ROOT },
  );
  // exported videos go to a temp folder instead of a save dialog
  await app.evaluate(({ session }, dir) => {
    session.defaultSession.on('will-download', (_e, item) => item.setSavePath(`${dir}/${item.getFilename()}`));
  }, downloads);
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.topbar');
});

test.afterAll(async () => {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
});

const clips = () => page.locator('.tl-clip');
const tab = (name: string) => page.locator('.main-tabs button', { hasText: new RegExp(`^${name}$`) });

test('first launch asks for the language', async () => {
  await expect(page.locator('.lang-screen.first')).toBeVisible();
  await expect(page.locator('.lang-opt')).toHaveCount(4);
  await page.locator('.lang-opt', { hasText: 'Español' }).click();
  await expect(page.locator('.lang-screen')).toHaveCount(0);
});

test('starts with an empty editor and no errors', async () => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(clips()).toHaveCount(0);
  await expect(page.getByText('Importar', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('imports two videos into the media panel', async () => {
  await page.locator('.panel-body input[type=file]').first().setInputFiles([CLIP1, CLIP2]);
  await expect(page.locator('[data-media-id]')).toHaveCount(2, { timeout: 30_000 });
});

test('adds them to the timeline', async () => {
  await page.locator('[data-media-id]').nth(0).dblclick();
  await page.locator('[data-media-id]').nth(1).dblclick();
  await expect(clips()).toHaveCount(2);
});

test('selecting a clip opens its properties with every tab', async () => {
  await clips().first().click({ position: { x: 30, y: 30 } });
  await expect(page.locator('.panel.right .title-main')).toHaveText(/clip1/);
  for (const name of ['Vídeo', 'Audio', 'Velocidad', 'Animación', 'Ajustar']) {
    await tab(name).click();
    await expect(tab(name)).toHaveClass(/active/);
  }
});

test('color sliders change the value', async () => {
  await tab('Ajustar').click();
  const slider = page.locator('.panel.right input.range.tone-saturation').first();
  await expect(slider).toBeVisible();
  await slider.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  const v = Number(await slider.inputValue());
  expect(v).toBeGreaterThan(0);
});

/** Moves a slider to a value like a user would (React sees a real input event). */
async function slideTo(row: ReturnType<Page['locator']>, where: 'min' | 'max') {
  await row.locator('input.range').evaluate((el: HTMLInputElement, w) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, w === 'max' ? el.max : el.min);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, where);
}
const prop = (label: string) => page.locator('.panel.right .prop', { has: page.locator('.prop-head span', { hasText: new RegExp(`^${label}$`) }) });
const shownNumber = async (label: string) => Number((await prop(label).locator('.num input').inputValue()).replace(',', '.'));

test('every slider reaches its whole range (number box agrees)', async () => {
  await clips().first().click({ position: { x: 30, y: 30 } });
  const expectMax: Record<string, number> = { Escala: 1000, 'Posición X': 200, 'Posición Y': 200, Girar: 180, Volumen: 200, Opacidad: 100 };
  const checked: string[] = [];
  for (const name of ['Vídeo', 'Audio', 'Ajustar']) {
    await tab(name).click();
    const rows = page.locator('.panel.right .prop');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      if (!(await row.locator('input.range').count()) || !(await row.locator('.num input').count()) || !(await row.isVisible())) continue;
      const label = (await row.locator('.prop-head span').first().textContent())!.trim();
      await row.scrollIntoViewIfNeeded();
      await slideTo(row, 'max');
      const atMax = Number((await row.locator('.num input').inputValue()).replace(',', '.'));
      const sliderMax = await row.locator('input.range').evaluate((el: HTMLInputElement) => Number(el.max));
      // log sliders (speed / scale) hold log(value)
      const isLog = await row.locator('input.range').evaluate((el: HTMLInputElement) => Number(el.step) === 0.001);
      expect(atMax, `${label}: number box at the slider's end`).toBeCloseTo(isLog ? Math.exp(sliderMax) : sliderMax, 0);
      if (expectMax[label] !== undefined) expect(atMax, `${label} max`).toBeCloseTo(expectMax[label], 0);
      await slideTo(row, 'min');
      checked.push(label);
    }
  }
  expect(checked).toEqual(expect.arrayContaining(['Escala', 'Posición X', 'Volumen', 'Temperatura']));
  await page.keyboard.press('Meta+z'); // leave the clip as it was (one undo per slider is fine too)
});

test('mask: pick a shape, sliders and dragging on the viewer move it', async () => {
  await clips().first().click({ position: { x: 30, y: 30 } });
  await tab('Vídeo').click();
  await page.getByRole('button', { name: 'Máscara', exact: true }).click();
  await page.locator('.shape', { hasText: 'Rectángulo' }).click();
  const overlay = page.locator('.mask-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.mask-shape')).toHaveCount(1);
  // slider covers −100…100 (it used to jump between two positions)
  await slideTo(prop('Posición X'), 'max');
  expect(await shownNumber('Posición X')).toBe(100);
  await slideTo(prop('Posición X'), 'min');
  expect(await shownNumber('Posición X')).toBe(-100);
  const box = prop('Posición X').locator('.num input');
  await box.fill('0');
  await box.press('Enter');
  // drag on the viewer: the mask moves (not the clip)
  const b = (await overlay.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + b.width * 0.2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await shownNumber('Posición X')).toBeGreaterThan(10);
  // resize with a corner handle
  const w0 = await shownNumber('Ancho');
  const corner = overlay.locator('.mask-handle').nth(2);
  const cb = (await corner.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + 40, cb.y + 30, { steps: 5 });
  await page.mouse.up();
  expect(await shownNumber('Ancho')).toBeGreaterThan(w0);
  // leaving the mask panel hides the overlay
  await page.getByRole('button', { name: 'Básico', exact: true }).click();
  await expect(overlay).toHaveCount(0);
});

test('split at the playhead, then undo and redo', async () => {
  await clips().first().click({ position: { x: 30, y: 30 } });
  // move the playhead into the first clip by clicking on the ruler
  const box = (await clips().first().boundingBox())!;
  await page.locator('.tl-ruler').click({ position: { x: box.x - (await page.locator('.tl-ruler').boundingBox())!.x + box.width / 2, y: 10 } });
  await page.getByTitle('Cortar en el cursor (S o ⌘B)').click();
  await expect(clips()).toHaveCount(3);
  await page.keyboard.press('Meta+z');
  await expect(clips()).toHaveCount(2);
  await page.keyboard.press('Meta+Shift+z');
  await expect(clips()).toHaveCount(3);
});

test('adds a text', async () => {
  await page.locator('.left-tab', { hasText: 'Texto' }).click();
  await page.locator('.panel-body .btn, .panel-body button').filter({ hasText: /Añadir texto|Texto por defecto|Añadir/ }).first().click();
  await expect(page.locator('.tl-clip.text')).toHaveCount(1);
});

test('hides and shows the main track', async () => {
  const eye = page.locator('.tl-head').first().getByTitle(/Ocultar pista/);
  await eye.click();
  await expect(page.locator('.tl-head').first().getByTitle(/Mostrar pista/)).toBeVisible();
  await page.locator('.tl-head').first().getByTitle(/Mostrar pista/).click();
});

test('exports an MP4 in the background', async () => {
  await page.locator('.topbar .btn.primary').click();
  await expect(page.locator('.modal')).toContainText('Exportar vídeo');
  await page.locator('.modal input.input').first().fill('orion-test');
  await page.locator('.modal .btn.primary').click();
  await expect(page.locator('.export-jobs .ej-row.done')).toHaveCount(1, { timeout: 90_000 });
  await expect.poll(() => {
    try {
      return statSync(join(downloads, 'orion-test.mp4')).size;
    } catch {
      return 0;
    }
  }, { timeout: 15_000 }).toBeGreaterThan(10_000);
});

test('the project is saved and listed in Proyectos', async () => {
  await expect(page.getByText('Guardado', { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.locator('.project-bar .btn').first().click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.modal-back').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
});

test('about, suggestions and licenses dialogs open (nothing is sent)', async () => {
  await page.locator('.coffee-btn').click();
  await expect(page.locator('.modal')).toContainText('Rafa');
  await page.getByText('Enviar una sugerencia').click();
  await expect(page.locator('.modal')).toContainText('Enviar una sugerencia');
  await expect(page.locator('.modal .btn.primary')).toBeDisabled(); // empty message
  await page.locator('.modal .icon-btn').first().click();
  await page.locator('.coffee-btn').click();
  await page.getByText('Licencias y créditos').click();
  await expect(page.locator('.modal')).toContainText('Licencias');
  await expect(page.locator('.modal')).toContainText('mediabunny');
  await page.locator('.modal .modal-head .icon-btn').first().click();
  await expect(page.locator('.modal')).toHaveCount(0);
});

test('voice isolation shows real progress and finishes', async () => {
  await page.locator('.left-tab', { hasText: 'Multimedia' }).click();
  await page.locator('.panel-body input[type=file]').first().setInputFiles([join(ROOT, 'public/_test/noisy.wav')]);
  await expect(page.locator('[data-media-id]')).toHaveCount(3, { timeout: 30_000 });
  await page.locator('[data-media-id]').nth(2).dblclick();
  const audioClip = page.locator('.tl-clip', { hasText: 'noisy.wav' });
  await expect(audioClip).toHaveCount(1);
  await audioClip.click({ position: { x: 20, y: 12 } });
  await tab('Audio').click();
  // remember every percentage the bar shows
  await page.evaluate(() => {
    const seen: number[] = ((window as unknown as { __pct: number[] }).__pct = []);
    new MutationObserver(() => {
      const el = document.querySelector('.fx-progress-box');
      const v = el?.getAttribute('aria-valuenow');
      if (v != null && seen[seen.length - 1] !== Number(v)) seen.push(Number(v));
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.locator('.panel.right .chip', { hasText: 'Aislar voz' }).click();
  await expect(page.locator('.panel.right .fx-done')).toBeVisible({ timeout: 60_000 });
  const seen = await page.evaluate(() => (window as unknown as { __pct: number[] }).__pct);
  // it went up and never back
  expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);
  await expect(audioClip.locator('.fx')).toContainText('Voz aislada');
  await expect(audioClip.locator('.clip-fx-progress')).toHaveCount(0);
  await page.locator('.panel.right .chip', { hasText: 'Original' }).click();
});

test('switching language translates the editor and back', async () => {
  const exportBtn = page.locator('.topbar .btn.primary');
  await page.locator('.lang-btn').click();
  await page.locator('.lang-opt', { hasText: 'English' }).click();
  await expect(exportBtn).toHaveText(/Export$/);
  await expect(page.locator('.coffee-btn')).toContainText('coffee');
  await expect(page.locator('.lang-btn')).toContainText('EN');
  // the Mac menus follow
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [])).toContain('Edit');
  // user content is never translated
  await expect(page.locator('.tl-clip:not(.text)').first()).toContainText('clip1.mp4');

  await page.locator('.lang-btn').click();
  await page.locator('.lang-opt', { hasText: 'Français' }).click();
  await expect(exportBtn).toHaveText(/Exporter/);

  await page.locator('.lang-btn').click();
  await page.locator('.lang-opt', { hasText: 'Português' }).click();
  await expect(exportBtn).toHaveText(/Exportar/);
  await expect(page.locator('.coffee-btn')).not.toContainText('Invítame');

  await page.locator('.lang-btn').click();
  await page.locator('.lang-opt', { hasText: 'Español' }).click();
  await expect(page.locator('.coffee-btn')).toContainText('Invítame a un café');
});

test('the language is remembered after restarting', async () => {
  await page.locator('.lang-btn').click();
  await page.locator('.lang-opt', { hasText: 'English' }).click();
  await page.reload();
  await page.waitForSelector('.topbar');
  await expect(page.locator('.lang-screen')).toHaveCount(0);
  await expect(page.locator('.topbar .btn.primary')).toHaveText(/Export$/, { timeout: 10_000 });
});

test('phone: home → new project → timeline, clip tools, split, sheets', async () => {
  // a phone-sized window switches to the mobile editor
  await page.setViewportSize({ width: 412, height: 900 });
  await expect(page.locator('.m-home')).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.m-new').click()]);
  await chooser.setFiles([CLIP1, CLIP2]);
  // straight to the timeline with both clips, nothing selected
  await expect(page.locator('.mt-clip')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.m-tool[data-tool="overlay"]')).toBeVisible();
  // swipe the timeline (scroll) = move the playhead
  await page.locator('.mt').evaluate((el) => {
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    el.scrollLeft = 140;
  });
  await expect.poll(() => page.evaluate(() => (document.querySelector('.mt-time b')?.textContent ?? ''))).not.toBe('00:00');
  // trimming: the edge sticks to the playhead when it gets close (magnet)
  await page.locator('.mt-clip').first().click({ position: { x: 30, y: 30 } });
  const dur = async () => Number((await page.locator('.mt-clip').first().locator('.mt-dur').textContent())!.replace('s', ''));
  const before = await dur();
  const head = (await page.locator('.mt-playhead').boundingBox())!;
  const handle = (await page.locator('.mt-clip').first().locator('.mt-handle.l').boundingBox())!;
  await page.mouse.move(handle.x + handle.width - 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x - 6, handle.y + handle.height / 2, { steps: 8 }); // stop a few px short
  await page.mouse.up();
  const t = await page.locator('.mt').evaluate((el) => el.scrollLeft / 70);
  await expect.poll(dur).toBeCloseTo(before - Math.round(t * 10) / 10, 1);
  // tap a clip → its tools; split at the playhead
  await page.locator('.mt-clip').first().click({ position: { x: 30, y: 30 } });
  await expect(page.locator('.m-tool[data-tool="split"]')).toBeVisible();
  await page.locator('.m-tool[data-tool="split"]').click();
  await expect(page.locator('.mt-clip')).toHaveCount(3);
  // a tool opens its panel as a sheet
  await page.locator('.m-tool[data-tool="speed"]').click();
  await expect(page.locator('.m-sheet')).toBeVisible();
  await page.locator('.m-sheet-head .icon-btn').click();
  await expect(page.locator('.m-sheet')).toHaveCount(0);
  // back to the general tools
  await page.locator('.m-back').click();
  await expect(page.locator('.m-tool[data-tool="text"]')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
});
