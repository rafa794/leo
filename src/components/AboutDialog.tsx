import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Heart, Lightbulb, X } from 'lucide-react';
import { AUTHOR, TREATS, donateUrl } from '../config/author';
import { openLicenses } from './LicensesDialog';
import { openSuggestions } from './SuggestionsDialog';

let openFn: (() => void) | null = null;
/** Opens "Acerca de Orion · Invítame a un café" (also from the Mac app's menu and the ☕ button). */
export function openAbout() {
  openFn?.();
}
(window as unknown as { __orionShowAbout?: () => void }).__orionShowAbout = () => openAbout();

const VERSION = import.meta.env.VITE_APP_VERSION ?? '';

/** Confetti over the whole dialog (no library: a small canvas animation). */
function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const W = (c.width = c.offsetWidth * devicePixelRatio);
    const H = (c.height = c.offsetHeight * devicePixelRatio);
    const colors = ['#fbbf24', '#f97316', '#22d3ee', '#a855f7', '#4ade80', '#f43f5e', '#ffffff'];
    const parts = Array.from({ length: 160 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.3,
      y: H * 0.55,
      vx: (Math.random() - 0.5) * 18 * devicePixelRatio,
      vy: (-Math.random() * 22 - 8) * devicePixelRatio,
      r: (Math.random() * 6 + 4) * devicePixelRatio,
      a: Math.random() * Math.PI,
      va: (Math.random() - 0.5) * 0.3,
      col: colors[Math.floor(Math.random() * colors.length)],
    }));
    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.55 * devicePixelRatio;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.a += p.va;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
        ctx.restore();
      }
      if (parts.some((p) => p.y < H + 40)) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="confetti" />;
}

/** About + support the developer: photo, a few words and the coffee menu. */
export default function AboutDialog() {
  const [open, setOpen] = useState(false);
  const [photoOk, setPhotoOk] = useState(true);
  const [custom, setCustom] = useState('');
  const [thanks, setThanks] = useState<{ emoji: string; label: string; amount?: number } | null>(null);
  const [bizum, setBizum] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    openFn = () => {
      setThanks(null);
      setBizum(false);
      setOpen(true);
    };
    return () => {
      openFn = null;
    };
  }, []);
  if (!open) return null;

  const initials = AUTHOR.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // pick a treat: the thank-you dance + confetti on top and, at the same time, how to pay below
  const give = (emoji: string, label: string, amount?: number) => {
    setBizum(false);
    setCopied(false);
    setThanks({ emoji, label, amount });
  };
  const customAmount = Math.max(0, Number(custom.replace(',', '.')) || 0);

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal about">
        <button className="icon-btn about-close" onClick={() => setOpen(false)}>
          <X size={16} />
        </button>

        {thanks ? (
          <div className="thanks">
            <Confetti />
            {AUTHOR.thanksVideo && <video className="thanks-video" src={AUTHOR.thanksVideo} autoPlay loop muted playsInline />}
            <div className="thanks-text">
              <b>¡GRACIAS! {thanks.emoji}</b>
              <span>{thanks.label}</span>
            </div>
            <div className="pay-choice">
              <b>¿Cómo quieres pagar?</b>
              <div className="pay-buttons">
                {donateUrl() && (
                  <button className="pay-btn paypal" onClick={() => window.open(donateUrl(thanks.amount)!, '_blank', 'noopener')}>
                    <span className="pay-logo">P</span>
                    PayPal
                  </button>
                )}
                {AUTHOR.bizumPhone && (
                  <button className={`pay-btn bizum-btn ${bizum ? 'active' : ''}`} onClick={() => setBizum(true)}>
                    <span className="pay-logo">B</span>
                    Bizum
                  </button>
                )}
              </div>
              {bizum && AUTHOR.bizumPhone && (
                <div className="bizum-info">
                  <span>
                    Envía{thanks.amount ? <b> {thanks.amount} € </b> : ' lo que quieras '}por Bizum al
                  </span>
                  <b className="bizum-number" translate="no">
                    {AUTHOR.bizumPhone.replace(/(\d{3})(?=\d)/g, '$1 ')}
                  </b>
                  <button className="btn small" onClick={() => void navigator.clipboard?.writeText(AUTHOR.bizumPhone).then(() => setCopied(true)).catch(() => {})}>
                    {copied ? 'Copiado ✓' : 'Copiar número'}
                  </button>
                  <span className="hint">Solo en España, desde la app de tu banco.</span>
                </div>
              )}
              <button className="link" onClick={() => setThanks(null)}>
                Volver
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="about-top">
              <div className="about-logo">◆</div>
              <div>
                <b style={{ fontSize: 18 }}>Orion</b>
                <div className="hint">Editor de vídeo gratis{VERSION ? ` · versión ${VERSION}` : ''}</div>
              </div>
            </div>
            <div className="about-me">
              {photoOk && AUTHOR.photo ? (
                <img src={AUTHOR.photo} alt={AUTHOR.name} className="about-photo" onError={() => setPhotoOk(false)} />
              ) : (
                <div className="about-photo initials">{initials || '☺'}</div>
              )}
              <div>
                <b>{AUTHOR.hello}</b>
                <div className="hint" style={{ marginTop: 2 }}>
                  {AUTHOR.name}
                </div>
              </div>
            </div>
            <p className="about-text">{AUTHOR.bio}</p>
            <p className="about-text">
              <b>{AUTHOR.ask}</b>
            </p>

            <div className="treats">
              {TREATS.map((t) => (
                <button key={t.amount} className="treat" onClick={() => give(t.emoji, `${t.name} · ${t.amount} €`, t.amount)}>
                  <span className="treat-emoji">{t.emoji}</span>
                  <span className="treat-name">{t.name}</span>
                  <b>{t.amount} €</b>
                </button>
              ))}
            </div>
            <div className="treat-custom">
              <span>💛 Lo que tú quieras</span>
              <span className="num">
                <input inputMode="decimal" placeholder="15" value={custom} onChange={(e) => setCustom(e.target.value)} />
                <i>€</i>
              </span>
              <button className="btn small primary" disabled={customAmount < 1} title={customAmount < 1 ? 'Mínimo 1 €' : ''} onClick={() => give('💛', `${customAmount} €`, customAmount)}>
                Invitar
              </button>
            </div>
            <div className="about-links">
              <button
                className="link"
                onClick={() => {
                  setOpen(false);
                  openSuggestions();
                }}
              >
                <Lightbulb size={12} /> Enviar una sugerencia
              </button>
              {AUTHOR.website && (
                <a href={AUTHOR.website} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} /> Web
                </a>
              )}
              <button
                className="link"
                onClick={() => {
                  setOpen(false);
                  openLicenses();
                }}
              >
                Licencias y créditos
              </button>
              <span className="hint">
                Hecho con <Heart size={11} style={{ verticalAlign: -1 }} /> y software libre
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
