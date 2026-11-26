/**
 * Who made Orion — shown in "Acerca de Orion · Invítame a un café". Edit these and rebuild the app.
 *
 * - photo: your picture at public/author.jpg (square works best). If it's missing, your initials are shown.
 * - paypalMe: your PayPal.me name (the part after paypal.me/). The coffee buttons open
 *   paypal.me/<name>/<amount>EUR with the amount already filled in; "Lo que quieras" lets them type any amount.
 *   Leave it empty until you have it: the buttons still show the thank-you animation.
 * - bizumPhone: optional, Spain only. Only shown after pressing "Bizum (España)".
 * - thanksVideo: the clip played when someone picks a coffee (transparent WebM works best).
 * - suggestionsEmail: where suggestions arrive. web3formsKey: free key from https://web3forms.com (enter that
 *   same email, they send you the key). With the key, suggestions are sent from inside the app; without it,
 *   the user's email program opens with the message ready.
 */
export const AUTHOR = {
  name: 'Rafa Mendoza',
  photo: `${import.meta.env.BASE_URL}author.jpg`,
  hello: '¡Hola! Soy Rafa, quien hace Orion 👋',
  bio: 'Lo creé para editar mis vídeos sin pagar suscripciones. Orion es completamente gratis y siempre lo será: sin anuncios, sin marcas de agua y todo se procesa en tu ordenador.',
  ask: 'Si te ayuda y te apetece, invítame a algo. Desde 1 €, lo que tú quieras.',
  paypalMe: '',
  currency: 'EUR',
  bizumPhone: '',
  website: '',
  thanksVideo: `${import.meta.env.BASE_URL}support/dance.webm`,
  suggestionsEmail: 'rafamendo1994@gmail.com',
  web3formsKey: 'fd33d176-6aa4-42f2-90b2-56c0052dd733',
};

/** The coffee menu. */
export const TREATS = [
  { emoji: '☕', name: 'Un café', amount: 1 },
  { emoji: '🥛', name: 'Un café con leche', amount: 3 },
  { emoji: '🍵', name: 'Un té matcha', amount: 5 },
  { emoji: '🥤', name: 'Un frappé de cafetería', amount: 10 },
];

/** Link that opens the payment with the amount filled in (null if PayPal.me isn't set yet). */
export function donateUrl(amount?: number) {
  if (!AUTHOR.paypalMe) return null;
  const base = `https://paypal.me/${AUTHOR.paypalMe.replace(/^https?:\/\/(www\.)?paypal\.me\//, '').replace(/\/+$/, '')}`;
  return amount && amount > 0 ? `${base}/${Math.round(amount * 100) / 100}${AUTHOR.currency}` : base;
}
