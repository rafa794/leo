/**
 * Orion in other languages.
 *
 * The app is written in Spanish, and Spanish is the key of every translation (src/i18n/<lang>.json,
 * made from src/i18n/strings.json — `node scripts/i18n-extract.mjs` lists the texts again after changes).
 * Instead of touching every component, the texts are swapped where they show up: a watcher translates
 * each text and tooltip as React puts it on screen. In Spanish nothing runs at all.
 *
 * Mark user content that must never be translated with translate="no" (clip names, typed text…).
 */
import { useSyncExternalStore } from 'react';

export type Lang = 'es' | 'en' | 'fr' | 'pt';

export const LANGS: { id: Lang; name: string; flag: string; hello: string }[] = [
  { id: 'es', name: 'Español', flag: '🇪🇸', hello: 'Elige tu idioma' },
  { id: 'en', name: 'English', flag: '🇬🇧', hello: 'Choose your language' },
  { id: 'fr', name: 'Français', flag: '🇫🇷', hello: 'Choisis ta langue' },
  { id: 'pt', name: 'Português', flag: '🇧🇷', hello: 'Escolha seu idioma' },
];

const KEY = 'orion.lang';
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
const loaders = import.meta.glob<{ default: Record<string, string> }>(['./en.json', './fr.json', './pt.json']);

let lang: Lang = 'es';
let dict: Record<string, string> = {};
type Pattern = { re: RegExp; to: string; order: number[] };
let patterns: Pattern[] = [];
let cache = new Map<string, string>();
const listeners = new Set<() => void>();

/** Language picked before (null = first launch: show the picker). */
export function savedLang(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return LANGS.some((l) => l.id === v) ? (v as Lang) : null;
  } catch {
    return null;
  }
}

/** Best guess from the system language, for the picker's highlight. */
export function systemLang(): Lang {
  const n = (navigator.language || 'es').slice(0, 2).toLowerCase();
  return (LANGS.find((l) => l.id === n)?.id ?? 'en') as Lang;
}

export const getLang = () => lang;
export const onLangChange = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
/** Current language, re-rendering when it changes. */
export const useLang = () => useSyncExternalStore(onLangChange, getLang);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function load(d: Record<string, string>) {
  dict = d;
  cache = new Map();
  patterns = Object.entries(d)
    .filter(([k]) => /\{\d\}/.test(k))
    // most specific (longest fixed text) first
    .sort((a, b) => b[0].replace(/\{\d\}/g, '').length - a[0].replace(/\{\d\}/g, '').length)
    .map(([k, to]) => {
      const order: number[] = [];
      const src = esc(k).replace(/\\\{(\d)\\\}/g, (_m, i) => (order.push(Number(i)), '([\\s\\S]+?)'));
      return { re: new RegExp(`^${src}$`), to, order };
    });
}

function lookup(core: string): string | undefined {
  const hit = dict[core];
  if (hit !== undefined) return hit;
  for (const p of patterns) {
    const m = p.re.exec(core);
    if (m) {
      const vals: Record<number, string> = {};
      p.order.forEach((idx, k) => (vals[idx] = m[k + 1]));
      return p.to.replace(/\{(\d)\}/g, (_x, i) => vals[Number(i)] ?? '');
    }
  }
  return undefined;
}

/** Translates one Spanish text into the current language (unknown texts stay as they are). */
export function t(text: string): string {
  if (lang === 'es' || !text || !/[A-Za-zÀ-ÿ]/.test(text)) return text;
  const c = cache.get(text);
  if (c !== undefined) return c;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const core = m[2].replace(/\s+/g, ' ');
  let out = lookup(core);
  // "Original del vídeo · 1280×720", "Vídeo · 3 clips": translate each part
  if (out === undefined && core.includes(' · ')) {
    const parts = core.split(' · ');
    const tr = parts.map((p) => lookup(p) ?? lookup(`${p} ·`)?.replace(/\s*·$/, '') ?? p);
    if (tr.some((p, i) => p !== parts[i])) out = tr.join(' · ');
  }
  const res = out === undefined ? text : m[1] + out + m[3];
  if (cache.size > 5000) cache.clear();
  cache.set(text, res);
  return res;
}

/* ---------- swapping the texts on screen ---------- */

const origText = new WeakMap<Text, string>();
const shownText = new WeakMap<Text, string>();
const origAttr = new WeakMap<Element, Map<string, { orig: string; shown: string }>>();
let observer: MutationObserver | null = null;

const skip = (el: Element | null) => !el || !!el.closest('[translate="no"], textarea, script, style, [contenteditable="true"]');

function doText(n: Text) {
  const cur = n.nodeValue ?? '';
  if (shownText.get(n) === cur) return; // our own change
  if (skip(n.parentElement)) return;
  origText.set(n, cur);
  const tr = t(cur);
  if (tr !== cur) {
    shownText.set(n, tr);
    n.nodeValue = tr;
  } else shownText.delete(n);
}

function doAttr(el: Element, name: string) {
  const cur = el.getAttribute(name);
  if (cur == null) return;
  let m = origAttr.get(el);
  const prev = m?.get(name);
  if (prev && prev.shown === cur) return;
  if (skip(el)) return;
  const tr = t(cur);
  if (!m) origAttr.set(el, (m = new Map()));
  m.set(name, { orig: cur, shown: tr });
  if (tr !== cur) el.setAttribute(name, tr);
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (skip(el)) return;
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null = el; n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else for (const a of ATTRS) if ((n as Element).hasAttribute(a)) doAttr(n as Element, a);
  }
}

/** Puts every text on screen back in Spanish (before showing another language). */
function restore(root: Element) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null = root; n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const tn = n as Text;
      const o = origText.get(tn);
      if (o !== undefined && shownText.get(tn) === tn.nodeValue) tn.nodeValue = o;
      shownText.delete(tn);
    } else {
      const m = origAttr.get(n as Element);
      m?.forEach((v, name) => {
        if ((n as Element).getAttribute(name) === v.shown) (n as Element).setAttribute(name, v.orig);
      });
      origAttr.delete(n as Element);
    }
  }
}

function watch() {
  observer?.disconnect();
  observer = null;
  if (lang === 'es') return;
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target as Text);
      else if (m.type === 'attributes') doAttr(m.target as Element, m.attributeName!);
      else m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// native dialogs (confirm / alert / prompt) too
const native = { alert: window.alert.bind(window), confirm: window.confirm.bind(window), prompt: window.prompt.bind(window) };
window.alert = (msg?: unknown) => native.alert(typeof msg === 'string' ? t(msg) : msg);
window.confirm = (msg?: string) => native.confirm(msg ? t(msg) : msg);
window.prompt = (msg?: string, def?: string) => native.prompt(msg ? t(msg) : msg, def);

/** Changes the language of the whole app (and remembers it). */
export async function setLang(next: Lang, remember = true) {
  if (remember) {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: just for this time */
    }
  }
  const d = next === 'es' ? {} : ((await loaders[`./${next}.json`]?.())?.default ?? {});
  restore(document.body);
  lang = next;
  load(d);
  document.documentElement.lang = next;
  walk(document.body);
  watch();
  // the Mac app's menus
  (window as unknown as { orionApp?: { setLanguage?: (l: string) => void } }).orionApp?.setLanguage?.(next);
  listeners.forEach((f) => f());
}

/** At start: the saved language (Spanish until one is picked). */
export function initI18n() {
  const l = savedLang();
  (window as unknown as { __orionSetLang?: (l: Lang) => void }).__orionSetLang = (x: Lang) => void setLang(x);
  if (l && l !== 'es') void setLang(l, false);
  else (window as unknown as { orionApp?: { setLanguage?: (l: string) => void } }).orionApp?.setLanguage?.('es');
}
