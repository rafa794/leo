/**
 * Cloudflare Pages Function for the web version (orion…/app/__download?url=…).
 * Some free music / sound libraries don't let a web page download their files directly, so this
 * fetches them instead — only from these public libraries (same list as the Mac app and the dev server).
 */
const ALLOWED_HOSTS = ['jamendo.com', 'freesound.org', 'wikimedia.org', 'ccmixter.org'];
const allowed = (u) => u.protocol === 'https:' && ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));

export async function onRequestGet({ request }) {
  let url;
  try {
    url = new URL(new URL(request.url).searchParams.get('url') ?? '');
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }
  if (!allowed(url)) return new Response('Site not allowed', { status: 403 });
  const r = await fetch(url.toString(), { redirect: 'follow' });
  if (!r.ok) return new Response('Download failed', { status: r.status });
  return new Response(r.body, {
    headers: {
      'content-type': r.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    },
  });
}
