import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {bundle} from './build.mjs';

// Minimal stand-in for `vercel dev`: serves public/ and routes /api/<name> to api/<name>.js.
const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT ?? 5173);
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};

await bundle({botId: false});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handler = (await import(path.join(root, 'api', `${path.basename(url.pathname)}.js`)))[req.method];
      if (!handler) return res.writeHead(405).end();
      const response = await handler(new Request(url, {method: req.method, headers: req.headers}));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const file = path.join(root, 'public', path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(path.join(root, 'public'))) return res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream'});
    res.end(body);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error);
    if (res.headersSent) return res.destroy();
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end(String(error.message));
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
