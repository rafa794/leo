// Collects the licenses of every library that goes into Orion (and of the models, fonts and stickers it uses)
// into public/licenses.json, shown in the app under "Licencias y créditos". Runs before every build.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

// Node-only pieces that are never put inside the app (they'd only add noise)
const NOT_SHIPPED = [/^@img\//, /^sharp$/, /^onnxruntime-node$/, /^@capacitor\/android$/, /^@capacitor\/cli$/];

const seen = new Map();

function findPkgDir(name, fromDir) {
  try {
    return dirname(createRequire(join(fromDir, 'package.json')).resolve(`${name}/package.json`));
  } catch {
    let d = fromDir;
    while (true) {
      const cand = join(d, 'node_modules', name);
      if (existsSync(join(cand, 'package.json'))) return cand;
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
}

function licenseText(dir) {
  const f = readdirSync(dir).find((x) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(x));
  const notice = readdirSync(dir).find((x) => /^notice(\.(md|txt))?$/i.test(x));
  let text = f ? readFileSync(join(dir, f), 'utf8') : '';
  if (notice && notice !== f) text += '\n\n' + readFileSync(join(dir, notice), 'utf8');
  return text.trim();
}

function walk(name, fromDir) {
  if (NOT_SHIPPED.some((r) => r.test(name))) return;
  const dir = findPkgDir(name, fromDir);
  if (!dir) return;
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const key = `${pj.name}@${pj.version}`;
  if (seen.has(key)) return;
  let license = pj.license ?? pj.licenses ?? 'desconocida';
  if (Array.isArray(license)) license = license.map((l) => l.type ?? l).join(' OR ');
  if (typeof license === 'object') license = license.type;
  const author = typeof pj.author === 'string' ? pj.author : pj.author?.name;
  const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url;
  seen.set(key, { name: pj.name, version: pj.version, license, author: author ?? '', url: (pj.homepage ?? repo ?? '').replace(/^git\+/, '').replace(/\.git$/, ''), text: licenseText(dir) });
  for (const dep of Object.keys(pj.dependencies ?? {})) walk(dep, dir);
}

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const dep of Object.keys(rootPkg.dependencies ?? {})) walk(dep, root);
// the desktop app's engine
for (const dep of ['electron']) {
  const dir = findPkgDir(dep, root);
  if (dir) {
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    seen.set(`${pj.name}@${pj.version}`, {
      name: pj.name,
      version: pj.version,
      license: pj.license,
      author: 'Electron contributors / OpenJS Foundation',
      url: 'https://www.electronjs.org',
      text: licenseText(dir) + '\n\nIncluye Chromium y sus componentes; sus licencias completas van dentro de la app (LICENSES.chromium.html).',
    });
  }
}

const libraries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

// a few packages don't ship their license file: use the standard text of their license
const STD = {
  MIT: (who) => `MIT License\n\nCopyright (c) ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ISC: (who) => `ISC License\n\nCopyright (c) ${who}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};
const apacheFull = libraries.find((l) => l.license === 'Apache-2.0' && /Apache License\s+Version 2\.0/.test(l.text) && l.text.length > 8000)?.text ?? '';
const OWNERS = { 'onnxruntime-web': 'Microsoft Corporation', 'onnxruntime-common': 'Microsoft Corporation', '@mediapipe/tasks-vision': 'Google LLC' };
for (const l of libraries) {
  if (l.text) continue;
  const who = OWNERS[l.name] ?? (l.author || `the ${l.name} authors`);
  if (STD[l.license]) l.text = STD[l.license](who);
  else if (l.license === 'Apache-2.0' && apacheFull) l.text = `Copyright ${who}\n\n` + apacheFull;
}

const fluent = join(root, 'public', 'stickers', 'LICENSE-fluentui-emoji.txt');
const resources = [
  { name: 'Whisper (OpenAI) — subtítulos automáticos', license: 'MIT', url: 'https://github.com/openai/whisper', note: 'Modelos onnx-community/whisper-base, whisper-small y whisper-large-v3-turbo; se descargan la primera vez que generas subtítulos.' },
  { name: 'MediaPipe Selfie Multiclass (Google) — quitar fondo', license: 'Apache-2.0', url: 'https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter', note: 'Modelo selfie_multiclass_256x256; se descarga la primera vez que quitas el fondo.' },
  { name: 'RNNoise (Xiph.Org / Jean-Marc Valin) — aislar o quitar voz', license: 'BSD-3-Clause', url: 'https://github.com/xiph/rnnoise' },
  { name: 'OpenCV — estabilizador', license: 'Apache-2.0', url: 'https://opencv.org' },
  { name: 'Fluent Emoji (Microsoft) — stickers', license: 'MIT', url: 'https://github.com/microsoft/fluentui-emoji', text: existsSync(fluent) ? readFileSync(fluent, 'utf8').trim() : '' },
  { name: 'Fuentes Anton, Bebas Neue, Montserrat e Inter (Google Fonts)', license: 'OFL-1.1', url: 'https://fonts.google.com', note: 'SIL Open Font License 1.1.' },
  { name: 'Fuente Permanent Marker (Google Fonts)', license: 'Apache-2.0', url: 'https://fonts.google.com/specimen/Permanent+Marker' },
  { name: 'Música y efectos (Openverse: Jamendo, Freesound)', license: 'CC0 / CC BY', url: 'https://openverse.org', note: 'No van dentro de la app: se buscan y descargan cuando los eliges. Las pistas CC BY exigen citar al autor en tus vídeos (botón «Copiar créditos»).' },
];

const out = { generated: new Date().toISOString().slice(0, 10), app: { name: rootPkg.productName ?? 'Orion', version: rootPkg.version }, libraries, resources };
writeFileSync(join(root, 'public', 'licenses.json'), JSON.stringify(out));
console.log(`licenses.json: ${libraries.length} librerías, ${resources.length} recursos`);
