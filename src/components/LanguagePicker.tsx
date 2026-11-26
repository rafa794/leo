import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { getLang, LANGS, savedLang, setLang, systemLang, type Lang } from '../i18n';

let openFn: (() => void) | null = null;
/** Opens the language picker (globe button, Mac menu "Idioma"). */
export function openLanguagePicker() {
  openFn?.();
}
(window as unknown as { __orionShowLanguage?: () => void }).__orionShowLanguage = () => openLanguagePicker();

/**
 * The first screen of Orion: pick a language (Español, English, Français, Português).
 * Shown once; later it opens from the 🌐 button in the top bar.
 */
export default function LanguagePicker() {
  const [mode, setMode] = useState<'first' | 'change' | null>(() => (savedLang() ? null : 'first'));
  const [hover, setHover] = useState<Lang>(() => savedLang() ?? systemLang());
  useEffect(() => {
    openFn = () => {
      setHover(getLang());
      setMode('change');
    };
    return () => {
      openFn = null;
    };
  }, []);
  if (!mode) return null;

  const pick = (l: Lang) => {
    void setLang(l);
    setMode(null);
  };
  const shown = LANGS.find((l) => l.id === hover) ?? LANGS[0];

  return (
    <div className={`lang-screen ${mode}`} translate="no" onPointerDown={(e) => mode === 'change' && e.target === e.currentTarget && setMode(null)}>
      <div className="lang-card">
        {mode === 'change' && (
          <button className="icon-btn lang-close" onClick={() => setMode(null)} aria-label="Close">
            <X size={16} />
          </button>
        )}
        <div className="lang-logo">
          <div className="logo-dot">◆</div> Orion
        </div>
        <h1>{shown.hello}</h1>
        <p className="hint">{LANGS.filter((l) => l.id !== shown.id).map((l) => l.hello).join(' · ')}</p>
        <div className="lang-grid">
          {LANGS.map((l) => (
            <button
              key={l.id}
              className={`lang-opt ${hover === l.id ? 'focus' : ''} ${mode === 'change' && getLang() === l.id ? 'current' : ''}`}
              onMouseEnter={() => setHover(l.id)}
              onFocus={() => setHover(l.id)}
              onClick={() => pick(l.id)}
            >
              <span className="flag">{l.flag}</span>
              <span className="name">{l.name}</span>
              {mode === 'change' && getLang() === l.id && <Check size={15} className="tick" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
