// Puts the website (website/) and the web version of the editor (built into site-dist/app) together
// for Cloudflare Pages. Run with `npm run site:build`; the result is site-dist/.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';

cpSync('website', 'site-dist', { recursive: true });

// ---- one page per language (/es/, /fr/, /pt/) so search engines index every language ----
// The landing page is written in English; its inline script holds the translations (const T = {...}).
const SITE = 'https://leo.rafael-mendoza.com';
const LOCALES = { es: 'es_ES', fr: 'fr_FR', pt: 'pt_BR' };
const html = readFileSync('website/index.html', 'utf8');
const tStart = html.indexOf('const T = {');
const tEnd = html.indexOf('\n    };\n', tStart);
if (tStart < 0 || tEnd < 0) throw new Error('website/index.html: translations (const T = {...}) not found');
const T = vm.runInNewContext(`(${html.slice(tStart + 'const T = '.length, tEnd + 6)})`);

// free, cookieless visit counter (Cloudflare Web Analytics) on the website only — never inside the editor (/app/).
// The token comes from the Cloudflare Pages environment variable CF_ANALYTICS_TOKEN (no token = no counter).
const token = (process.env.CF_ANALYTICS_TOKEN ?? '').trim();
if (token && !/^[a-f0-9]{32}$/i.test(token)) throw new Error('CF_ANALYTICS_TOKEN does not look like a Web Analytics token');
const withAnalytics = (page) =>
  token
    ? page
        .replace('<!-- analytics -->', `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${token}"}'></script>`)
        .replace(/(data-i="foot\.privacy") hidden/, '$1')
    : page;

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (t) => esc(t).replace(/"/g, '&quot;');
function translate(lang) {
  const d = T[lang];
  let out = html;
  let swapped = 0;
  out = out.replace(/<(\w+)([^>]*\bdata-i="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g, (all, tag, attrs, key, inner) => {
    if (inner.includes(`<${tag}`)) throw new Error(`data-i="${key}": nested <${tag}> can't be translated at build time`);
    if (d[key] === undefined) return all;
    swapped++;
    return `<${tag}${attrs}>${/\bdata-html\b/.test(attrs) ? d[key] : esc(d[key])}</${tag}>`;
  });
  if (swapped < 20) throw new Error(`${lang}: only ${swapped} texts translated`);
  const url = `${SITE}/${lang}/`;
  const set = (re, value) => {
    if (!re.test(out)) throw new Error(`${lang}: ${re} not found`);
    out = out.replace(re, value);
  };
  set(/<html lang="en">/, `<html lang="${lang}" data-page="${lang}">`);
  set(/<title>[^<]*<\/title>/, `<title>${esc(d['meta.title'])}</title>`);
  set(/(<meta name="description" content=")[^"]*"/, `$1${attr(d['meta.desc'])}"`);
  set(/(<meta property="og:title" content=")[^"]*"/, `$1${attr(d['meta.title'])}"`);
  set(/(<meta property="og:description" content=")[^"]*"/, `$1${attr(d['meta.desc'])}"`);
  set(/(<meta property="og:url" content=")[^"]*"/, `$1${url}"`);
  set(/(<meta property="og:locale" content=")[^"]*"/, `$1${LOCALES[lang]}"`);
  set(/(<link rel="canonical" href=")[^"]*"/, `$1${url}"`);
  // the page lives one folder down: relative files (icon, screenshot) are one level up
  out = out.replace(/\b(src|href)="(?!https?:|mailto:|\/|#|\.\.\/)([^"]+)"/g, '$1="../$2"');
  return out;
}
for (const lang of Object.keys(LOCALES)) {
  mkdirSync(`site-dist/${lang}`, { recursive: true });
  writeFileSync(`site-dist/${lang}/index.html`, withAnalytics(translate(lang)));
}
writeFileSync('site-dist/index.html', withAnalytics(html));
console.log(`language pages: ${Object.keys(LOCALES).map((l) => `/${l}/`).join(' ')} · visit counter: ${token ? 'on' : 'off (no CF_ANALYTICS_TOKEN)'}`);

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

// No long "immutable" cache: if a file is asked for while a deploy is still spreading, Cloudflare may answer with
// a page instead, and a year-long cache would keep that wrong answer (the web editor went blank once).
writeFileSync(
  'site-dist/_headers',
  ['/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', ''].join('\n'),
);
console.log('site-dist ready: website at /, editor at /app/');
