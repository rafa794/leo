/**
 * Who made Leo — shown in "Acerca de Leo · Invítame a un café". Edit these and rebuild the app.
 *
 * - photo: your picture at public/author.jpg (square works best). If it's missing, your initials are shown.
 * - paypalMe: your PayPal.me name (the part after paypal.me/). The coffee buttons open
 *   paypal.me/<name>/<amount>EUR with the amount already filled in; "Lo que quieras" lets them type any amount.
 *   Leave it empty until you have it: the buttons still show the thank-you animation.
 *   (No Bizum: it has no payment links for individuals, only a phone number, which must not be published.)
 * - thanksVideo: the clip played when someone picks a coffee (transparent WebM works best).
 * - suggestionsEmail: where suggestions arrive. web3formsKey: free key from https://web3forms.com (enter that
 *   same email, they send you the key). With the key, suggestions are sent from inside the app; without it,
 *   the user's email program opens with the message ready.
 */
export const AUTHOR = {
  name: 'Rafa Mendoza',
  photo: `${import.meta.env.BASE_URL}author.jpg`,
  hello: '¡Hola! Soy Rafa, quien hace Leo 👋',
  bio: 'Lo creé para editar mis vídeos sin pagar suscripciones. Leo es completamente gratis y siempre lo será: sin anuncios, sin marcas de agua y todo se procesa en tu ordenador.',
  ask: 'Si te ayuda y te apetece, invítame a algo. Desde 1 €, lo que tú quieras.',
  paypalMe: 'rafaLeoM794',
  currency: 'EUR',
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

/**
 * Card / Google Pay / Apple Pay through Stripe Payment Links (public links, no keys): one per coffee and one
 * where people type the amount. Create them at dashboard.stripe.com/payment-links.
 */
export const STRIPE_LINKS: { byAmount: Record<number, string>; custom: string } = {
  byAmount: {
    1: 'https://buy.stripe.com/8x25kFddS9QK0HBfhab7y00',
    3: 'https://buy.stripe.com/8x28wRgq41ke4XRc4Yb7y01',
    5: 'https://buy.stripe.com/3cIfZjddSfb4dun7OIb7y02',
    10: 'https://buy.stripe.com/cNibJ30r63sm1LF0mgb7y03',
  },
  custom: 'https://buy.stripe.com/bJe3cx8XC5Au4XR7OIb7y04',
};

/** Stripe link for this amount: the coffee's own link, or the "type your amount" one (null if not set up). */
export function cardUrl(amount?: number) {
  return (amount && STRIPE_LINKS.byAmount[amount]) || STRIPE_LINKS.custom || null;
}

/** Link that opens the payment with the amount filled in (null if PayPal.me isn't set yet). */
export function donateUrl(amount?: number) {
  if (!AUTHOR.paypalMe) return null;
  const base = `https://paypal.me/${AUTHOR.paypalMe.replace(/^https?:\/\/(www\.)?paypal\.me\//, '').replace(/\/+$/, '')}`;
  return amount && amount > 0 ? `${base}/${Math.round(amount * 100) / 100}${AUTHOR.currency}` : base;
}
