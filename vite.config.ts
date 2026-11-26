import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * /__download?url=… downloads free music/sound files for the app. Some sites (e.g. Jamendo) don't
 * allow a web page to download their files directly, so the local server fetches them instead.
 * Only these public libraries are allowed.
 */
const ALLOWED_HOSTS = ['jamendo.com', 'freesound.org', 'wikimedia.org', 'ccmixter.org'];

function downloadProxy(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/__download?')) return next();
    const target = new URL(req.url, 'http://localhost').searchParams.get('url') ?? '';
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      res.statusCode = 400;
      return res.end('URL no válida');
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
      res.statusCode = 403;
      return res.end('Sitio no permitido');
    }
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) {
        res.statusCode = r.status;
        return res.end('No se pudo descargar');
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('content-type', r.headers.get('content-type') ?? 'application/octet-stream');
      res.setHeader('content-length', String(buf.length));
      res.end(buf);
    } catch (e) {
      res.statusCode = 502;
      res.end(String(e));
    }
  };
  return {
    name: 'orion-download-proxy',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

/** Test media in public/_test is only for development: keep it out of the built app. */
function dropTestMedia(): Plugin {
  return {
    name: 'orion-drop-test-media',
    apply: 'build',
    closeBundle: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(new URL('./dist/_test', import.meta.url), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), downloadProxy(), dropTestMedia()],
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  server: { port: 5173 },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  worker: { format: 'es' },
});
