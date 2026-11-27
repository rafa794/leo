import { useEffect, useState } from 'react';
import { Check, Loader2, Send, X } from 'lucide-react';
import { AUTHOR } from '../config/author';

let openFn: (() => void) | null = null;
/** Opens "Enviar una sugerencia" (also from the Mac app's Help menu). */
export function openSuggestions() {
  openFn?.();
}
(window as unknown as { __orionShowSuggestions?: () => void }).__orionShowSuggestions = () => openSuggestions();

const KINDS = [
  ['idea', '💡 Una idea'],
  ['bug', '🐞 Algo falla'],
  ['other', '💬 Otra cosa'],
] as const;

const VERSION = import.meta.env.VITE_APP_VERSION ?? '';
const platform = () => {
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'otro';
  return `${os}${/Electron/.test(ua) ? ' (app)' : ' (navegador)'}`;
};

/** Suggestions for future versions, sent to the developer's email. */
export default function SuggestionsDialog() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('idea');
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  useEffect(() => {
    openFn = () => {
      setState('idle');
      setOpen(true);
    };
    return () => {
      openFn = null;
    };
  }, []);
  if (!open) return null;

  const label = KINDS.find((k) => k[0] === kind)![1];
  const subject = `Leo · ${label.replace(/^\S+\s/, '')}`;
  const info = `Leo ${VERSION} · ${platform()}`;
  const canSend = text.trim().length >= 3 && (AUTHOR.web3formsKey || AUTHOR.suggestionsEmail);

  const send = async () => {
    if (!canSend) return;
    // no key yet: open the user's email program with everything filled in
    if (!AUTHOR.web3formsKey) {
      const body = `${text.trim()}\n\n${email ? `Mi email: ${email}\n` : ''}— ${info}`;
      window.open(`mailto:${AUTHOR.suggestionsEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
      setState('sent');
      return;
    }
    setState('sending');
    try {
      const r = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: AUTHOR.web3formsKey,
          subject,
          from_name: 'Leo — sugerencias',
          tipo: label,
          mensaje: text.trim(),
          email_para_responder: email.trim() || '(no lo ha dejado)',
          version: info,
          // with their email, "Reply" in your inbox goes straight to them
          ...(email.trim() ? { email: email.trim(), replyto: email.trim() } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      setState(r.ok && j.success !== false ? 'sent' : 'error');
      if (r.ok) setText('');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal" style={{ width: 'min(480px, 100%)' }}>
        <div className="modal-head">
          <b>Enviar una sugerencia</b>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </div>
        {state === 'sent' ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <Check size={28} style={{ color: '#4ade80' }} />
            <p>
              <b>¡Gracias!</b> {AUTHOR.web3formsKey ? 'Tu mensaje me ha llegado.' : 'Se ha abierto tu programa de correo con el mensaje listo: solo tienes que enviarlo.'}
            </p>
            <button className="btn small" onClick={() => setOpen(false)}>
              Cerrar
            </button>
          </div>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              ¿Qué te gustaría que tuviera la próxima versión? ¿Algo no funciona bien? Lo leo todo.
            </p>
            <div className="chips" style={{ marginBottom: 10 }}>
              {KINDS.map(([id, l]) => (
                <button key={id} className={`chip ${kind === id ? 'active' : ''}`} onClick={() => setKind(id)}>
                  {l}
                </button>
              ))}
            </div>
            <textarea
              className="input"
              rows={6}
              placeholder={kind === 'bug' ? 'Qué estabas haciendo y qué pasó…' : 'Me encantaría que Leo pudiera…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <input className="input" style={{ width: '100%', marginTop: 8 }} type="email" placeholder="Tu email (opcional, por si quieres respuesta)" value={email} onChange={(e) => setEmail(e.target.value)} />
            <p className="hint">Se adjunta la versión de Leo y el sistema ({info}). Nada más.</p>
            {state === 'error' && <p style={{ color: 'var(--danger)' }}>No se pudo enviar. ¿Tienes conexión? Inténtalo de nuevo.</p>}
            {!AUTHOR.web3formsKey && !AUTHOR.suggestionsEmail && <p className="hint" style={{ color: '#fbbf24' }}>(Falta configurar el correo de sugerencias en src/config/author.ts)</p>}
            <button className="btn primary block" disabled={!canSend || state === 'sending'} onClick={send}>
              {state === 'sending' ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Enviar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
