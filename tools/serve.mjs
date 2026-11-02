/**
 * Zero-dependency static file server for local testing.
 *
 * XAMPP is the primary target (http://localhost/power-surge-circuit/), but this
 * exists so the game can be tested without Apache running and so automated QA
 * can boot an isolated instance on a spare port.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8099);
const host = process.argv[3] || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.join(root, pathname);
  // Refuse to serve anything outside the project directory.
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Not found: ${pathname}`);
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`Power Surge Circuit test server: http://${host}:${port}/`);
  console.log(`Serving ${root}`);
});
