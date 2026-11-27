// Screenshots of Leo for promotion (website, social posts, AI video start/end frames):
//   npm run promo:shots -- path/to/picture-or-video [more files…]
// Opens the dev build in a throwaway profile (never your own projects), imports the files, puts them on the
// timeline with a filter and a title, and saves 16:9 (Mac/PC) and 9:16 (phone) pictures to promo/.
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const files = process.argv.slice(2).map((f) => resolve(f));
if (!files.length || files.some((f) => !existsSync(f))) {
  console.error('Usage: npm run promo:shots -- picture-or-video [more files…]');
  process.exit(1);
}
const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'promo');
mkdirSync(OUT, { recursive: true });
const TITLE = process.env.PROMO_TITLE ?? '¡GOLAZO!';
const FILTER = process.env.PROMO_FILTER ?? 'accion';

const profile = mkdtempSync(join(tmpdir(), 'orion-promo-'));
const app = await electron.launch({ args: [ROOT, `--user-data-dir=${profile}`], cwd: ROOT });
const optional = async (what, fn) => {
  try {
    await fn();
  } catch (e) {
    console.warn(`(skipped: ${what}) ${e.message.split('\n')[0]}`);
  }
};
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.warn('page error:', e.message));
  // sharp pictures: render at 3× (Mac 4800×2700, phone 1236×2196) so they stay crisp in a 1080p / 4K video
  const SCALE = Number(process.env.PROMO_SCALE ?? 3);
  const cdp = await page.context().newCDPSession(page);
  const setSize = async (width, height) => {
    await page.setViewportSize({ width, height });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: SCALE, mobile: false });
  };
  const shot = async (name) => {
    await page.waitForTimeout(700);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); // at device pixels (SCALE×)
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`promo/${name}.png`);
  };

  // ---- Mac / PC (16:9) ----
  await setSize(1600, 900);
  await page.locator('.lang-opt', { hasText: 'Español' }).click();
  await page.locator('.panel-body input[type=file]').first().setInputFiles(files);
  await page.locator('[data-media-id]').nth(files.length - 1).waitFor({ timeout: 60_000 });
  for (let i = 0; i < files.length; i++) await page.locator('[data-media-id]').nth(i).dblclick();
  const clip = page.locator('.tl-clip:not(.text)').first();
  await clip.waitFor();

  await optional('title', async () => {
    await page.locator('.left-tab', { hasText: 'Texto' }).click();
    await page.locator('.panel-body .btn, .panel-body button').filter({ hasText: /Añadir texto|Texto por defecto|Añadir/ }).first().click();
    const box = page.locator('.panel.right textarea').first();
    await box.waitFor({ timeout: 3000 });
    await box.fill(TITLE);
    await page.locator('.panel.right .field', { hasText: 'Tamaño' }).locator('input[type=range]').fill('150');
  });
  await page.locator('.left-tab', { hasText: 'Multimedia' }).click();
  await clip.click({ position: { x: 40, y: 30 } });
  await optional('filter', async () => {
    await page.locator('.main-tabs button', { hasText: /^Filtros$/ }).click();
    await page.locator('.panel.right .chip', { hasText: /^Todos$/ }).click();
    await page.locator(`.panel.right .look[data-look="${FILTER}"]`).click();
  });
  await page.waitForTimeout(3500); // let notices ("Formato del vídeo original…") fade out
  await shot('orion-mac-filtros');
  await optional('effects tab', async () => {
    await page.locator('.main-tabs button', { hasText: /^Efectos$/ }).click();
    await page.locator('.panel.right .chip', { hasText: /^Todos$/ }).click();
  });
  await shot('orion-mac-efectos');

  // ---- phone (9:16): the same app switches to the phone editor on a narrow window ----
  await setSize(412, 732);
  await page.locator('.m-app').first().waitFor();
  await optional('open project', async () => {
    if (await page.locator('.m-home').isVisible()) await page.locator('.m-project').first().click();
    await page.locator('.mt-clip').first().waitFor({ timeout: 30_000 });
  });
  await page.waitForTimeout(1200);
  await optional('select clip', () => page.locator('.mt-clip:not(.text)').first().click({ position: { x: 30, y: 30 } }));
  await shot('orion-movil');
  await optional('effects sheet', async () => {
    await page.locator('.m-tool[data-tool="effects"]').click();
    await page.locator('.m-sheet .look-grid').waitFor();
  });
  await shot('orion-movil-efectos');
} finally {
  await app.close();
  rmSync(profile, { recursive: true, force: true });
}
