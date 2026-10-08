/**
 * Minimal static file server for the connection-test page in `client/`.
 *
 * Exists so the page is served from a real origin (http://localhost:5173) rather
 * than opened as a `file://` URL. Browsers send `Origin: null` for `file://`,
 * which cannot be allow-listed for credentialed CORS, so the refresh cookie
 * would never be sent and the test would fail for the wrong reason.
 *
 *   node scripts/serve-client.mjs [port]
 *
 * Development helper only — no caching, compression or hardening.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 5173);
const rootDir = resolve(import.meta.dirname, '..', 'client');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url ?? '/', `http://localhost:${port}`);
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname);

    // `normalize` collapses `..` segments; the prefix check then rejects any
    // path that still points outside the client directory.
    const target = normalize(join(rootDir, relative));
    if (!target.startsWith(rootDir)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(target);
    if (!info.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Connection test page: http://localhost:${port}`);
  console.log(`Serving from: ${rootDir}`);
  console.log('Ensure this origin is listed in CORS_ORIGINS.');
});
