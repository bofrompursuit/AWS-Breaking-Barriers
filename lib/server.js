// Minimal HTTP server (no framework). Locally this stands in for API Gateway + Lambda.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, loadStandards } from './store.js';
import { startSession, chat, providerInfo } from './agent.js';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
// On Vercel the filesystem is read-only except /tmp, which is per-instance and ephemeral.
const store = openStore(process.env.VERCEL ? "/tmp/exchange.db" : undefined);
const standards = loadStandards();
const ctx = { store, standards };

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d ? JSON.parse(d) : {})); });

const routes = {
  'GET /': (q, res) => send(res, 200, readFileSync(join(PUB, 'chat.html')), 'text/html'),
  'GET /review': (q, res) => send(res, 200, readFileSync(join(PUB, 'review.html')), 'text/html'),
  'GET /api/producers': (q, res) => send(res, 200, { producers: store.producers(), ...providerInfo(), standards: standards.length }),
  'POST /api/session': async (req, res) => {
    const { producerId, lang } = await body(req);
    if (!store.producer(producerId)) return send(res, 400, { error: 'unknown producer' });
    send(res, 200, startSession({ producerId, lang }));
  },
  'POST /api/chat': async (req, res) => {
    const { sessionId, message } = await body(req);
    try { send(res, 200, await chat(sessionId, String(message || '').slice(0, 4000), ctx)); }
    catch (e) { console.error(e); send(res, 500, { error: e.message }); }
  },
  'GET /api/records': (q, res) => send(res, 200, { records: store.records() }),
};

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) return routes[key](req, res);
  let m;
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/records\/([\w-]+)\/joined$/))) {
    const j = store.joined(m[1]);
    return j ? send(res, 200, { sql: store.JOIN_SQL, ...j }) : send(res, 404, { error: 'not found' });
  }
  if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/records\/([\w-]+)\/review$/))) {
    const r = store.reviewRecord(m[1], await body(req));
    return r ? send(res, 200, r) : send(res, 404, { error: 'not found' });
  }
  send(res, 404, { error: 'not found' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) createServer(handler).listen(process.env.PORT || 3000, () => console.log(`Producer Exchange running on http://localhost:${process.env.PORT || 3000}  (${JSON.stringify(providerInfo())}, ${standards.length} standard clauses)`));
