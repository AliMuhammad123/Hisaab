// CreditFlow server: serves the app's files from public/ and the API under /api/.
// Run with: npm start (reads settings from a .env file next to package.json).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Db } from './lib/db.js';
import { HttpError, V, get } from './lib/http.js';
import * as Auth from './lib/auth.js';
import * as Business from './lib/business.js';
import * as Personal from './lib/personal.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MAX_BODY = 64 * 1024;

// ---------- settings ----------

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
const env = process.env;
const missing = ['DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`CreditFlow is not set up: ${missing.join(', ')} missing. Copy .env.sample to .env and fill it in.`);
  process.exit(1);
}
const cfg = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8080),
  // Secure cookies unless explicitly turned off for local testing over plain http.
  secureCookies: env.SECURE_COOKIES !== 'false',
  sessionDays: Number(env.SESSION_DAYS || 30),
  // Only trust X-Forwarded-For when a reverse proxy you control sits in front.
  trustProxy: env.TRUST_PROXY === 'true',
};
const db = new Db({
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ssl: env.DB_SSL === 'true',
});

// ---------- security headers ----------

const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

function baseHeaders(csp) {
  const h = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (cfg.secureCookies) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

// ---------- simple per-IP request limit ----------
// A backstop against floods; sign-in has its own stricter limits in auth.js.

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 300;
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  return ++h.count > MAX_REQUESTS;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
}, WINDOW_MS).unref();

function clientIp(req) {
  if (cfg.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (fwd.length) return fwd[fwd.length - 1].slice(0, 45);
  }
  return String(req.socket.remoteAddress || '0.0.0.0').slice(0, 45);
}

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  const send = (status, body) => {
    res.writeHead(status, { ...baseHeaders(APP_CSP), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');

  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(400, 'Bad request');
  }
  if (rel === '/') rel = '/index.html';
  // No hidden files (except .well-known for Android app links), no NUL bytes, nothing outside public/.
  const segments = rel.split('/').filter(Boolean);
  if (rel.includes('\0') || segments.some((s, i) => s.startsWith('.') && !(i === 0 && s === '.well-known'))) return send(404, 'Not found');
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep)) return send(404, 'Not found');
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return send(404, 'Not found');

  let info;
  try {
    info = await stat(file);
  } catch {
    return send(404, 'Not found');
  }
  if (!info.isFile()) return send(404, 'Not found');

  const etag = `"${createHash('sha1').update(`${info.size}-${info.mtimeMs}`).digest('base64url')}"`;
  const headers = { ...baseHeaders(APP_CSP), 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const body = await readFile(file);
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- API ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) return reject(new HttpError(415, 'Send the request as JSON.'));
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reject(new HttpError(413, 'The request is too large.'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'The request is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        resolve(data);
      } catch {
        reject(new HttpError(400, 'The request could not be read.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'The request could not be read.')));
  });
}

/**
 * "Today" in the user's own time zone, sent by the app. It is only accepted
 * when it is within a day of the server's date, so it cannot be used to move
 * entries far into the past or future.
 */
function clientToday(req) {
  const server = new Date().toISOString().slice(0, 10);
  const sent = req.headers['x-client-date'];
  if (typeof sent === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sent)) {
    const diff = Math.abs(Date.parse(`${sent}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`));
    if (diff <= 86_400_000) return sent;
  }
  return server;
}

/** Blocks requests that a browser marks as coming from another website. */
function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'This request was blocked.');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && origin !== 'null') {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'This request was blocked.');
    }
    if (host !== req.headers.host) throw new HttpError(403, 'This request was blocked.');
  }
  if (req.method !== 'GET' && origin === 'null') throw new HttpError(403, 'This request was blocked.');
}

/** A user who chose only one portal cannot reach the other one's data routes. */
function requirePortal(ctx, portal) {
  const mode = Auth.user(ctx).app_mode;
  if (mode !== 'both' && mode !== portal) {
    throw new HttpError(403, 'This part of the app is turned off for your account. Turn it on in Settings.');
  }
}

async function updateProfile(ctx, input) {
  const set = [];
  const params = [];
  if (Object.hasOwn(input, 'name')) {
    set.push('name = ?');
    params.push(V.text(input, 'name', 80, true, 'Your name'));
  }
  if (Object.hasOwn(input, 'app_mode')) {
    set.push('app_mode = ?');
    params.push(V.choice(input, 'app_mode', ['personal', 'business', 'both'], 'Portal choice'));
  }
  if (Object.hasOwn(input, 'country')) {
    const c = get(input, 'country');
    if (typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) throw new HttpError(422, 'Choose a country from the list.');
    set.push('country = ?');
    params.push(c);
  }
  if (Object.hasOwn(input, 'currency')) {
    const c = get(input, 'currency');
    if (typeof c !== 'string' || !/^[A-Z]{3}$/.test(c)) throw new HttpError(422, 'Choose a currency from the list.');
    set.push('currency = ?');
    params.push(c);
  }
  if (Object.hasOwn(input, 'strict_stop')) {
    set.push('strict_stop = ?');
    params.push(get(input, 'strict_stop') === true ? 1 : 0);
  }
  if (set.length) {
    params.push(Auth.uid(ctx));
    await ctx.db.run(`UPDATE users SET ${set.join(', ')} WHERE id = ?`, params);
    await Auth.refreshUser(ctx);
  }
  return Auth.publicUser(ctx);
}

/** Everything the app holds about the signed-in user, for download. */
async function exportAll(ctx) {
  const me = Auth.uid(ctx);
  const account = Auth.publicUser(ctx);
  delete account.csrf;
  return {
    exported_at: new Date().toISOString(),
    account,
    clients: await ctx.db.all('SELECT id, name, phone, email, notes, credit_limit, created_at FROM clients WHERE user_id = ?', [me]),
    credit_entries: await ctx.db.all('SELECT id, client_id, number, description, amount, invoice_date, due_date FROM invoices WHERE user_id = ?', [me]),
    payments: await ctx.db.all('SELECT id, invoice_id, amount, method, payment_date, reference FROM payments WHERE user_id = ?', [me]),
    monthly_plans: await ctx.db.all('SELECT month, income, mandatory, savings, investment, entertainment, other FROM budgets WHERE user_id = ?', [me]),
    personal_entries: await ctx.db.all('SELECT id, category, amount, entry_date, note, overridden FROM entries WHERE user_id = ?', [me]),
  };
}

async function route(ctx, method, path, query) {
  let id = null;
  const m = path.match(/^(\/[a-z/]+)\/(\d{1,15})$/);
  if (m) {
    path = `${m[1]}/:id`;
    id = Number(m[2]);
  }
  const body = () => readBody(ctx.req);

  switch (`${method} ${path}`) {
    // ----- account -----
    case 'POST /auth/register':
      return { user: await Auth.register(ctx, await body()) };
    case 'POST /auth/login':
      return { user: await Auth.login(ctx, await body()) };
    case 'POST /auth/logout':
      await Auth.logout(ctx);
      return { ok: true };
    case 'GET /auth/me':
      return { user: Auth.publicUser(ctx) };
    case 'PATCH /me':
      return { user: await updateProfile(ctx, await body()) };
    case 'POST /me/password':
      await Auth.changePassword(ctx, await body());
      return { ok: true };
    case 'POST /me/delete':
      await Auth.deleteAccount(ctx, await body());
      return { ok: true };
    case 'GET /me/export':
      return exportAll(ctx);

    // ----- business -----
    case 'GET /business/summary':
      requirePortal(ctx, 'business');
      return Business.summary(ctx);
    case 'GET /clients':
      requirePortal(ctx, 'business');
      return { clients: await Business.clients(ctx) };
    case 'POST /clients':
      requirePortal(ctx, 'business');
      return { client: await Business.saveClient(ctx, await body()) };
    case 'PATCH /clients/:id':
      requirePortal(ctx, 'business');
      return { client: await Business.saveClient(ctx, await body(), id) };
    case 'DELETE /clients/:id':
      requirePortal(ctx, 'business');
      await Business.deleteClient(ctx, id);
      return { ok: true };
    case 'GET /invoices': {
      requirePortal(ctx, 'business');
      const cid = query.has('client_id') ? V.id(query.get('client_id'), 'Client') : null;
      return { invoices: await Business.invoices(ctx, cid) };
    }
    case 'POST /invoices':
      requirePortal(ctx, 'business');
      return { invoice: await Business.addInvoice(ctx, await body()) };
    case 'DELETE /invoices/:id':
      requirePortal(ctx, 'business');
      await Business.deleteInvoice(ctx, id);
      return { ok: true };
    case 'GET /payments': {
      requirePortal(ctx, 'business');
      const iid = query.has('invoice_id') ? V.id(query.get('invoice_id'), 'Credit entry') : null;
      return { payments: await Business.payments(ctx, iid) };
    }
    case 'POST /payments':
      requirePortal(ctx, 'business');
      return { invoice: await Business.addPayment(ctx, await body()) };
    case 'DELETE /payments/:id':
      requirePortal(ctx, 'business');
      await Business.deletePayment(ctx, id);
      return { ok: true };

    // ----- personal -----
    case 'GET /personal/summary':
      requirePortal(ctx, 'personal');
      return Personal.summary(ctx, V.month(query.get('month') ?? ctx.today.slice(0, 7)));
    case 'PUT /budget':
      requirePortal(ctx, 'personal');
      return { budget: await Personal.saveBudget(ctx, await body()) };
    case 'POST /entries':
      requirePortal(ctx, 'personal');
      return Personal.addEntry(ctx, await body());
    case 'DELETE /entries/:id':
      requirePortal(ctx, 'personal');
      await Personal.deleteEntry(ctx, id);
      return { ok: true };
  }
  throw new HttpError(404, 'Not found.');
}

async function serveApi(req, res, url) {
  const ctx = { req, cfg, db, ip: clientIp(req), today: clientToday(req), user: null, session: null, setCookies: [] };
  let status = 200;
  let payload;
  try {
    checkOrigin(req);
    await Auth.load(ctx);
    const path = url.pathname.slice('/api'.length) || '/';
    // Anything that changes data needs the CSRF token, except sign-in and
    // sign-up, which have no session yet and are protected by a custom header.
    if (req.method !== 'GET' && path !== '/auth/login' && path !== '/auth/register') Auth.requireCsrf(ctx);
    payload = await route(ctx, req.method, path, url.searchParams);
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      payload = { error: e.message, ...e.extra };
    } else {
      console.error(`creditflow: ${req.method} ${url.pathname}:`, e);
      status = 500;
      payload = { error: 'Something went wrong on our side. Please try again.' };
    }
  }
  const body = JSON.stringify(payload);
  const headers = {
    ...baseHeaders(API_CSP),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  };
  if (ctx.setCookies.length) headers['Set-Cookie'] = ctx.setCookies;
  res.writeHead(status, headers);
  res.end(body);
}

// ---------- server ----------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (tooMany(clientIp(req))) {
      res.writeHead(429, { ...baseHeaders(API_CSP), 'Content-Type': 'application/json', 'Retry-After': '60' });
      return res.end(JSON.stringify({ error: 'Too many requests. Wait a minute and try again.' }));
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await serveApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('creditflow:', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

try {
  await db.one('SELECT 1 AS ok');
} catch (e) {
  console.error(`CreditFlow cannot reach the database: ${e.message}`);
  process.exit(1);
}
server.listen(cfg.port, cfg.host, () => {
  console.log(`CreditFlow running on http://${cfg.host}:${cfg.port}${cfg.secureCookies ? '' : ' (secure cookies OFF: local testing only)'}`);
});

const stop = () => server.close(() => db.end().finally(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
