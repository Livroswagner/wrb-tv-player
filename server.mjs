import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { onRequestPost, handleStreamProxy } from './functions/api/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3050;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url.split('?')[0];

  // Stream Proxy Route
  if (urlPath === '/api/stream' || urlPath === '/stream' || (urlPath.startsWith('/api') && req.url.includes('url='))) {
    try {
      const fullUrl = `http://localhost:${PORT}${req.url}`;
      const forwardHeaders = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) forwardHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const whatwgReq = new Request(fullUrl, {
        method: req.method,
        headers: forwardHeaders
      });
      const response = await handleStreamProxy(whatwgReq);

      const respHeaders = {};
      for (const [k, v] of response.headers.entries()) {
        respHeaders[k] = v;
      }
      res.writeHead(response.status, respHeaders);

      if (response.body && req.method !== 'HEAD') {
        Readable.fromWeb(response.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      console.error('Stream Proxy Error:', err);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erro no proxy de stream: ' + err.message);
    }
    return;
  }

  // API Route (POST Xtream Codes)
  if (urlPath === '/.netlify/functions/api' || urlPath === '/api' || urlPath.startsWith('/api')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const fullUrl = `http://localhost:${PORT}${req.url}`;
        const forwardHeaders = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) forwardHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const whatwgReq = new Request(fullUrl, {
          method: req.method,
          headers: forwardHeaders,
          body: req.method === 'POST' ? body : undefined
        });

        const response = await onRequestPost({ request: whatwgReq });
        const data = await response.text();
        const respHeaders = {};
        for (const [k, v] of response.headers.entries()) {
          respHeaders[k] = v;
        }
        res.writeHead(response.status, respHeaders);
        res.end(data);
      } catch (err) {
        console.error('API Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Erro interno do servidor' }));
      }
    });
    return;
  }

  // Static files
  let safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Não encontrado');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`WRB-TV Player rodando em http://localhost:${PORT}`);
});
