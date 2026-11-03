// Minimal HTTP server (no framework). Locally this stands in for API Gateway + Lambda.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openStore, loadStandards } from './store.js';
import { startSession, chat, providerInfo, SessionError } from './agent.js';
import { seedSampleRecords } from './samples.js';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
// On Vercel the filesystem is read-only except /tmp, which is per-instance and ephemeral.
const store = openStore(process.env.VERCEL ? "/tmp/exchange.db" : undefined);
const standards = loadStandards();
const ctx = { store, standards };
// Hosted storage starts empty on every new instance, so seed labeled sample records for the reviewer view.
if (process.env.VERCEL || process.env.SAMPLE_RECORDS === '1') seedSampleRecords(store, standards);

// ---- Access control -------------------------------------------------------------------------
// DEMO_PASSWORD gates the whole app (chat + model spend). REVIEW_PASSWORD additionally gates the
// reviewer view and record APIs. Both use HTTP Basic auth (any username). Locally both are optional;
// on a hosted deployment (VERCEL set) the app refuses to serve until they are configured.
const HOSTED = !!process.env.VERCEL;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || '';
const REVIEW_PASSWORD = process.env.REVIEW_PASSWORD || '';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
function basicPassword(req) {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1);
}
// Returns true if the request may proceed; otherwise sends 401/503 and returns false.
// `accepted` lists the passwords that unlock this path (a browser sends one credential per request,
// so the reviewer password also opens the demo pages instead of requiring both).
function authorize(req, res, accepted, realm, envName) {
  const passwords = accepted.filter(Boolean);
  if (!passwords.length) {
    if (!HOSTED) return true;
    send(res, 503, { error: `Server not configured: set ${envName}.` });
    return false;
  }
  const given = basicPassword(req);
  if (given !== null && passwords.some((p) => safeEqual(given, p))) return true;
  res.writeHead(401, { 'www-authenticate': `Basic realm="${realm}", charset="UTF-8"`, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'authentication required' }));
  return false;
}

// ---- Rate limiting (per instance; a coarse guard against runaway model spend) -------------------
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.CHAT_RATE_LIMIT || 60); // chat turns per IP per 10 minutes
const hits = new Map();
function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return recent.length > RATE_MAX;
}

// ---- Helpers --------------------------------------------------------------------------------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
class BadRequest extends Error {}
const MAX_BODY_BYTES = 64 * 1024;
const body = (req) => new Promise((ok, fail) => {
  let d = '';
  req.on('data', (c) => {
    d += c;
    if (d.length > MAX_BODY_BYTES) { fail(new BadRequest('request body too large')); req.destroy(); }
  });
  req.on('end', () => {
    if (!d) return ok({});
    try { ok(JSON.parse(d)); } catch { fail(new BadRequest('request body is not valid JSON')); }
  });
  req.on('error', fail);
});

const routes = {
  'GET /': (q, res) => send(res, 200, readFileSync(join(PUB, 'chat.html')), 'text/html; charset=utf-8'),
  'GET /review': (q, res) => send(res, 200, readFileSync(join(PUB, 'review.html')), 'text/html; charset=utf-8'),
  'GET /api/producers': (q, res) => send(res, 200, { producers: store.producers(), ...providerInfo(), standards: standards.length }),
  'POST /api/session': async (req, res) => {
    const { producerId, lang } = await body(req);
    if (!store.producer(producerId)) return send(res, 400, { error: 'unknown producer' });
    send(res, 200, startSession({ producerId, lang }));
  },
  'POST /api/chat': async (req, res) => {
    if (rateLimited(req)) return send(res, 429, { error: 'Too many messages. Please wait a few minutes and try again.' });
    const { sessionId, message } = await body(req);
    try { send(res, 200, await chat(sessionId, String(message || '').slice(0, 4000), ctx)); }
    catch (e) {
      if (e instanceof SessionError) return send(res, 409, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'The assistant is unavailable right now. Please try again.' });
    }
  },
  'GET /api/records': (q, res) => send(res, 200, { records: store.records() }),
};

const isReviewPath = (path) => path === '/review' || path.startsWith('/api/records');

export async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    if (url.pathname !== '/healthz') {
      const ok = isReviewPath(url.pathname)
        ? authorize(req, res, [REVIEW_PASSWORD], 'review', 'REVIEW_PASSWORD')
        : authorize(req, res, [DEMO_PASSWORD, REVIEW_PASSWORD], 'demo', 'DEMO_PASSWORD');
      if (!ok) return;
    }
    if (key === 'GET /healthz') return send(res, 200, { ok: true });
    if (routes[key]) return await routes[key](req, res);
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
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || 3000;
  createServer(handler).listen(port, host, () => console.log(`Producer Exchange running on http://${host}:${port}  (${JSON.stringify(providerInfo())}, ${standards.length} standard clauses)`));
}
