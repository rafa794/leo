import { createRoot } from 'react-dom/client';
import App from './App';
import LanguagePicker from './components/LanguagePicker';
import { initI18n } from './i18n';
import './styles.css';

// Running as the Mac app (Electron): room for the window buttons, draggable title bar
if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('is-app', /Mac/.test(navigator.platform) ? 'is-mac' : 'is-other');

initI18n();
// which version is running (handy when checking a deploy or a bug report)
document.documentElement.dataset.version = import.meta.env.VITE_APP_VERSION ?? '';
// a model left over from a feature that was tried and removed (smooth slow motion): free the space
void globalThis.caches?.delete('orion-models-v1').catch(() => {});
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <LanguagePicker />
  </>,
);

// Dev-only helpers for debugging from the browser console
if (import.meta.env.DEV) {
  Promise.all([import('./store/editor'), import('./lib/importFiles'), import('./lib/player')]).then(([s, i, p]) => {
    Object.assign(window, { __orion: { store: s.useEditor, importFiles: i.importFiles, player: p.player } });
  });
}
