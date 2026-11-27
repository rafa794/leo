// Leo for macOS (Electron). Same engine as Chrome, so the editor behaves exactly like in the browser.
const { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.ORION_DEV_URL; // e.g. http://localhost:5173 while developing
const ALLOWED_HOSTS = ['jamendo.com', 'freesound.org', 'wikimedia.org', 'ccmixter.org'];
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain', '.tflite': 'application/octet-stream', '.data': 'application/octet-stream', '.ico': 'image/x-icon',
};

// The app was called "Orion" before it became Leo. Its data (projects in IndexedDB, settings, cached AI models) lives
// in the "Orion" profile folder and under the app://orion origin: keep both, or people would open Leo to an empty
// project list. A --user-data-dir given on the command line (throwaway test profiles) still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'Orion'));

// app://orion/… serves the built editor (a real origin, so workers, WebAssembly and IndexedDB work). Keep the
// "orion" host: changing it would change the origin and hide everyone's saved projects.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

/** Free music / sound downloads (same as the dev server's /__download). */
async function downloadProxy(target) {
  let url;
  try {
    url = new URL(target ?? '');
  } catch {
    return new Response('URL no válida', { status: 400 });
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return new Response('Sitio no permitido', { status: 403 });
  const r = await net.fetch(url.toString(), { redirect: 'follow' });
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'content-length': r.headers.get('content-length') ?? '' } });
}

function serve(req) {
  const url = new URL(req.url);
  if (url.pathname === '/__download') return downloadProxy(url.searchParams.get('url'));
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) return new Response('No', { status: 403 });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return new Response(fs.readFileSync(file), { headers: { 'content-type': type } });
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: '#0e0e10',
    title: 'Leo',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadURL(DEV_URL || 'app://orion/');
  // links (licenses, docs…) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // projects save themselves: finish the last save before closing
  let closing = false;
  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    closing = true;
    win.webContents
      .executeJavaScript('window.__orionFlush ? window.__orionFlush() : null', true)
      .catch(() => {})
      .finally(() => win.destroy());
  });
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
}

/**
 * ⌘Z / ⌘C / ⌘V… go to the editor's own shortcuts (timeline copy/paste, undo…),
 * except while typing in a text box, where they do the normal text editing.
 */
function editItem(label, accelerator, key, nativeCmd, shift = false) {
  return {
    label,
    accelerator,
    click: (_item, w) => {
      if (!w) return;
      const js = `(() => {
        const a = document.activeElement;
        const typing = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
        if (!typing) window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', code: 'Key${key.toUpperCase()}', metaKey: true, shiftKey: ${shift}, bubbles: true }));
        return typing;
      })()`;
      w.webContents.executeJavaScript(js, true).then((typing) => typing && w.webContents[nativeCmd]());
    },
  };
}

/** Menu texts in each language of the editor (the editor tells us which one is picked). */
const MENU = {
  es: { about: 'Acerca de Leo · Invítame a un café', lang: 'Idioma…', edit: 'Edición', undo: 'Deshacer', redo: 'Rehacer', cut: 'Cortar', copy: 'Copiar', paste: 'Pegar', all: 'Seleccionar todo', view: 'Ver', full: 'Pantalla completa', reload: 'Recargar', dev: 'Herramientas de desarrollo', window: 'Ventana', help: 'Ayuda', suggest: 'Enviar una sugerencia…', licenses: 'Licencias y créditos', chromium: 'Licencias de Chromium' },
  en: { about: 'About Leo · Buy me a coffee', lang: 'Language…', edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', all: 'Select All', view: 'View', full: 'Full Screen', reload: 'Reload', dev: 'Developer Tools', window: 'Window', help: 'Help', suggest: 'Send a suggestion…', licenses: 'Licenses and credits', chromium: 'Chromium licenses' },
  fr: { about: 'À propos de Leo · Offre-moi un café', lang: 'Langue…', edit: 'Édition', undo: 'Annuler', redo: 'Rétablir', cut: 'Couper', copy: 'Copier', paste: 'Coller', all: 'Tout sélectionner', view: 'Présentation', full: 'Plein écran', reload: 'Recharger', dev: 'Outils de développement', window: 'Fenêtre', help: 'Aide', suggest: 'Envoyer une suggestion…', licenses: 'Licences et crédits', chromium: 'Licences de Chromium' },
  pt: { about: 'Sobre o Leo · Me paga um café', lang: 'Idioma…', edit: 'Editar', undo: 'Desfazer', redo: 'Refazer', cut: 'Recortar', copy: 'Copiar', paste: 'Colar', all: 'Selecionar tudo', view: 'Visualizar', full: 'Tela cheia', reload: 'Recarregar', dev: 'Ferramentas de desenvolvedor', window: 'Janela', help: 'Ajuda', suggest: 'Enviar uma sugestão…', licenses: 'Licenças e créditos', chromium: 'Licenças do Chromium' },
};
let menuLang = 'es';
const run = (js) => (_i, w) => (w ?? win)?.webContents.executeJavaScript(js, true);

function buildMenu() {
  const M = MENU[menuLang] ?? MENU.es;
  const about = { label: M.about, click: run('window.__orionShowAbout && window.__orionShowAbout()') };
  const language = { label: `🌐 ${M.lang}`, click: run('window.__orionShowLanguage && window.__orionShowLanguage()') };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Leo',
        submenu: [
          about,
          language,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: M.edit,
        submenu: [
          editItem(M.undo, 'CmdOrCtrl+Z', 'z', 'undo'),
          editItem(M.redo, 'Shift+CmdOrCtrl+Z', 'z', 'redo', true),
          { type: 'separator' },
          editItem(M.cut, 'CmdOrCtrl+X', 'x', 'cut'),
          editItem(M.copy, 'CmdOrCtrl+C', 'c', 'copy'),
          editItem(M.paste, 'CmdOrCtrl+V', 'v', 'paste'),
          editItem(M.all, 'CmdOrCtrl+A', 'a', 'selectAll'),
        ],
      },
      { label: M.view, submenu: [{ role: 'togglefullscreen', label: M.full }, { type: 'separator' }, { role: 'reload', label: M.reload }, { role: 'toggleDevTools', label: M.dev }] },
      { role: 'windowMenu', label: M.window },
      {
        role: 'help',
        label: M.help,
        submenu: [
          about,
          language,
          { label: M.suggest, click: run('window.__orionShowSuggestions && window.__orionShowSuggestions()') },
          { label: M.licenses, click: run('window.__orionShowLicenses && window.__orionShowLicenses()') },
          { label: M.chromium, click: () => shell.openPath(path.join(process.resourcesPath, 'LICENSES.chromium.html')) },
        ],
      },
    ]),
  );
}

ipcMain.on('orion:lang', (_e, lang) => {
  if (!MENU[lang] || lang === menuLang) return;
  menuLang = lang;
  buildMenu();
});

app.whenReady().then(() => {
  protocol.handle('app', serve);
  buildMenu();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => app.quit());
