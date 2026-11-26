// Collects every user-visible Spanish text in the app into src/i18n/strings.json (the translation keys).
// Run: node scripts/i18n-extract.mjs
import ts from 'typescript-js';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src/components', 'src/mobile', 'src/App.tsx', 'src/lib', 'src/store', 'src/ai', 'src/config'];
const files = [];
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).forEach((f) => walk(join(p, f))) : /\.(tsx?|)$/.test(p) && !p.endsWith('.d.ts') && files.push(p));
roots.forEach(walk);

const TEXT_ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label', 'hint', 'desc', 'description', 'text', 'tip', 'tooltip', 'empty', 'note', 'help', 'sub', 'caption', 'message'];
const out = new Set();
const human = (s) => /[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(s) && (/[A-ZÁÉÍÓÚÑ¿¡áéíóúñ]/.test(s) || /\s/.test(s.trim())) && !/^(https?:|data:|\/|\.\/|#|rgba?\(|var\(|[a-z-]+:)/.test(s.trim());
const looksCss = (s) => /^[a-z0-9_-]+$/.test(s.trim()) || /^[a-z0-9_-]+(\s+[a-z0-9_-]+)*$/.test(s.trim()) && /-|^(btn|icon|row|chip|link|hint|active|small|primary|block|sm|dim|top|on|off)\b/.test(s.trim()); // class names, ids
// inside className / style / key… (not text)
const inNonTextAttr = (n) => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return !TEXT_ATTRS.includes(p.name.getText());
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
};
const skipCall = new Set(['require', 'import', 'getElementById', 'querySelector', 'querySelectorAll', 'closest', 'addEventListener', 'removeEventListener', 'getItem', 'setItem', 'createElement', 'postMessage', 'fetch', 'matchMedia']);

for (const f of files) {
  const src = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isJsxText(n)) {
      const t = n.text.replace(/\s+/g, ' ').trim();
      if (t && human(t)) out.add(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const p = n.parent;
      const inCall = p && ts.isCallExpression(p) && skipCall.has(p.expression.getText(src).split('.').pop());
      const attr = p && ts.isJsxAttribute(p) ? p.name.getText(src) : null;
      const isKey = p && (ts.isPropertyAssignment(p) && p.name === n);
      const inType = p && (ts.isLiteralTypeNode(p) || ts.isElementAccessExpression(p));
      const okAttr = !attr || TEXT_ATTRS.includes(attr);
      const t = n.text.replace(/\s+/g, ' ').trim();
      if (!inCall && !isKey && !inType && okAttr && !inNonTextAttr(n) && t && human(t) && !looksCss(t) && !t.includes('\n')) out.add(t);
    } else if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      n.templateSpans.forEach((sp, i) => (s += `{${i}}` + sp.literal.text));
      const t = s.replace(/\s+/g, ' ').trim();
      if (!inNonTextAttr(n) && human(t.replace(/\{\d+\}/g, '')) && !looksCss(t.replace(/\{\d+\}/g, ''))) out.add(t);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
const list = [...out].filter((s) => s.length > 1 && !/^[\d\s.:·×%{}()-]+$/.test(s)).sort();
writeFileSync('src/i18n/strings.json', JSON.stringify(list, null, 1) + '\n');
console.log(list.length, 'texts');
