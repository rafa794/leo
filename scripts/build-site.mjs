// Puts the website (website/) and the web version of the editor (built into site-dist/app) together
// for Cloudflare Pages. Run with `npm run site:build`; the result is site-dist/.
import { cpSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

cpSync('website', 'site-dist', { recursive: true });

// Cloudflare Pages serves files up to 25 MiB. The only bigger one is ONNX Runtime's wasm for Whisper,
// which transformers.js loads from the jsDelivr CDN in the browser anyway, so the web version doesn't need it.
const LIMIT = 25 * 1024 * 1024;
for (const f of readdirSync('site-dist/app/assets')) {
  const p = join('site-dist/app/assets', f);
  if (statSync(p).size <= LIMIT) continue;
  if (!/^ort-wasm.*\.wasm$/.test(f)) throw new Error(`${p} is over Cloudflare's 25 MiB limit`);
  rmSync(p);
  console.log(`left out ${f} (loaded from the CDN on the web)`);
}

// /app → /app/. No catch-all rewrite for /app/*: Cloudflare Pages applies _redirects BEFORE static files, so a
// "/app/* … 200" rule would answer every asset (CSS, images…) with the HTML page and the editor stays blank.
writeFileSync('site-dist/_redirects', ['/app /app/ 301', ''].join('\n'));

writeFileSync(
  'site-dist/_headers',
  [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '/app/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/app/mediapipe-wasm/*',
    '  Cache-Control: public, max-age=604800',
    '',
  ].join('\n'),
);
console.log('site-dist ready: website at /, editor at /app/');
