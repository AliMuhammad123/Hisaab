// Accounts, passwords and sign-in sessions.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, V, get } from './http.js';

const scrypt = promisify(scryptCb);

const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 30;
const MAX_SIGNUPS_PER_IP = 10;
const WINDOW_MINUTES = 15;
const MIN_PASSWORD = 10;
const MAX_PASSWORD_BYTES = 200;

// scrypt cost: 2^15 x 8 x 3 uses about 32 MB per hash and meets the OWASP
// recommendation. The parameters are stored with each hash, so they can be raised
// later and old hashes upgrade themselves at the next sign-in.
const COST = { logN: 15, r: 8, p: 3 };
const KEYLEN = 64;

const USER_COLS = 'id, email, name, app_mode, country, currency, strict_stop';

// ---------- passwords ----------

export async function hashPassword(password, cost = COST) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost);
  return `scrypt$${cost.logN}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, rehash: false };
  const [, logN, r, p, salt, key] = parts;
  const cost = { logN: Number(logN), r: Number(r), p: Number(p) };
  if (!(cost.logN >= 10 && cost.logN <= 20 && cost.r >= 1 && cost.r <= 32 && cost.p >= 1 && cost.p <= 16)) {
    return { ok: false, rehash: false };
  }
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), cost, expected.length);
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  const rehash = cost.logN < COST.logN || cost.r < COST.r || cost.p < COST.p;
  return { ok, rehash };
}

function derive(password, salt, cost, keylen = KEYLEN) {
  const N = 2 ** cost.logN;
  return scrypt(password.normalize('NFKC'), salt, keylen, { N, r: cost.r, p: cost.p, maxmem: 256 * N * cost.r * cost.p + 1024 * 1024 });
}

// Checked when an email has no account, so a wrong email takes as long as a wrong password.
let dummyHash;
const dummy = async () => (dummyHash ??= await hashPassword(randomBytes(24).toString('base64')));

function checkPassword(input, key) {
  const p = get(input, key);
  if (typeof p !== 'string' || [...p].length < MIN_PASSWORD) {
    throw new HttpError(422, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (Buffer.byteLength(p) > MAX_PASSWORD_BYTES) throw new HttpError(422, 'Password is too long.');
  return p;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------- cookies ----------

/** With HTTPS the cookie gets the __Host- prefix, which browsers only accept when it is Secure, host-only and for the whole site. */
const cookieName = (cfg) => (cfg.secureCookies ? '__Host-cf_session' : 'cf_session');

function cookie(ctx, value, maxAgeSeconds) {
  const parts = [`${cookieName(ctx.cfg)}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict'];
  if (ctx.cfg.secureCookies) parts.push('Secure');
  ctx.setCookies.push(parts.join('; '));
}

function readCookie(ctx) {
  for (const part of (ctx.req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === cookieName(ctx.cfg)) return part.slice(i + 1).trim();
  }
  return '';
}

// ---------- endpoints ----------

export async function register(ctx, input) {
  requireAppHeader(ctx);
  const email = V.email(input);
  const name = V.text(input, 'name', 80, true, 'Your name');
  const password = checkPassword(input, 'password');

  const key = `register:${ctx.ip}`;
  await throttle(ctx, key, MAX_SIGNUPS_PER_IP);
  await recordAttempt(ctx, key);

  if (await ctx.db.one('SELECT id FROM users WHERE email = ?', [email])) {
    throw new HttpError(409, 'An account with this email already exists. Try signing in.');
  }
  let id;
  try {
    id = await ctx.db.insert('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', [email, await hashPassword(password), name]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this email already exists. Try signing in.');
    throw e;
  }
  return startSession(ctx, id);
}

export async function login(ctx, input) {
  requireAppHeader(ctx);
  const email = V.email(input);
  const password = typeof get(input, 'password') === 'string' ? get(input, 'password') : '';
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new HttpError(401, 'Email or password is incorrect.');

  await throttle(ctx, email, MAX_FAILS_PER_EMAIL);

  const row = await ctx.db.one('SELECT id, password_hash FROM users WHERE email = ?', [email]);
  const { ok, rehash } = await verifyPassword(password, row?.password_hash ?? (await dummy()));
  if (!row || !ok) {
    await recordAttempt(ctx, email);
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  if (rehash) await ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), row.id]);
  await ctx.db.run('DELETE FROM login_attempts WHERE email = ?', [email]);
  return startSession(ctx, Number(row.id));
}

export async function logout(ctx) {
  if (ctx.session) await ctx.db.run('DELETE FROM sessions WHERE id = ?', [ctx.session.id]);
  clearSession(ctx);
}

export async function changePassword(ctx, input) {
  const u = user(ctx);
  const row = await ctx.db.one('SELECT password_hash FROM users WHERE id = ?', [u.id]);
  const current = typeof get(input, 'current') === 'string' ? get(input, 'current') : '';
  if (!(await verifyPassword(current, row.password_hash)).ok) throw new HttpError(403, 'Your current password is incorrect.');
  const next = checkPassword(input, 'new');
  await ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), u.id]);
  // Sign out every other device.
  await ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [u.id, ctx.session.id]);
}

/** Permanently removes the account. Foreign keys cascade to every row the user owns. */
export async function deleteAccount(ctx, input) {
  const u = user(ctx);
  const row = await ctx.db.one('SELECT password_hash FROM users WHERE id = ?', [u.id]);
  const password = typeof get(input, 'password') === 'string' ? get(input, 'password') : '';
  if (!(await verifyPassword(password, row.password_hash)).ok) throw new HttpError(403, 'Password is incorrect. Your account was not deleted.');
  await ctx.db.run('DELETE FROM users WHERE id = ?', [u.id]);
  await ctx.db.run('DELETE FROM login_attempts WHERE email = ?', [u.email]);
  clearSession(ctx);
}

// ---------- session handling ----------

/** Loads the signed-in user from the session cookie, if there is a valid one. */
export async function load(ctx) {
  const token = readCookie(ctx);
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  const s = await ctx.db.one(
    'SELECT id, user_id, csrf_token FROM sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP()',
    [sha256(token)],
  );
  if (!s) return;
  const u = await ctx.db.one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [s.user_id]);
  if (u) {
    ctx.session = s;
    ctx.user = u;
  }
}

/** The signed-in user, or a 401 if nobody is signed in. */
export function user(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Please sign in.');
  return ctx.user;
}

export const uid = (ctx) => Number(user(ctx).id);

/** Every request that changes data must echo the session's CSRF token in a header. */
export function requireCsrf(ctx) {
  user(ctx);
  const sent = ctx.req.headers['x-csrf-token'];
  const a = Buffer.from(typeof sent === 'string' ? sent : '');
  const b = Buffer.from(ctx.session.csrf_token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(403, 'Your session has expired. Reload the page and try again.');
  }
}

export function publicUser(ctx) {
  const u = user(ctx);
  return {
    id: Number(u.id),
    email: u.email,
    name: u.name,
    app_mode: u.app_mode,
    country: u.country,
    currency: u.currency,
    strict_stop: Boolean(Number(u.strict_stop)),
    csrf: ctx.session.csrf_token,
  };
}

export async function refreshUser(ctx) {
  ctx.user = await ctx.db.one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [uid(ctx)]);
}

async function startSession(ctx, userId) {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const days = Math.max(1, ctx.cfg.sessionDays);
  await ctx.db.run('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  const sid = await ctx.db.insert(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))`,
    [userId, sha256(token), csrf, String(ctx.req.headers['user-agent'] || '').slice(0, 255), days],
  );
  cookie(ctx, token, days * 86400);
  ctx.session = { id: sid, user_id: userId, csrf_token: csrf };
  ctx.user = await ctx.db.one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [userId]);
  return publicUser(ctx);
}

function clearSession(ctx) {
  cookie(ctx, '', 0);
  ctx.user = null;
  ctx.session = null;
}

/** Sign-in and sign-up have no session yet, so they require a header that other sites cannot add. */
function requireAppHeader(ctx) {
  if (ctx.req.headers['x-requested-with'] !== 'creditflow') throw new HttpError(403, 'This request was blocked.');
}

async function throttle(ctx, key, maxForKey) {
  const since = `UTC_TIMESTAMP() - INTERVAL ${WINDOW_MINUTES} MINUTE`;
  const byKey = Number((await ctx.db.one(`SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND attempted_at > ${since}`, [key])).c);
  const byIp = Number((await ctx.db.one(`SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempted_at > ${since}`, [ctx.ip])).c);
  if (byKey >= maxForKey || byIp >= MAX_FAILS_PER_IP) {
    throw new HttpError(429, `Too many attempts. Wait ${WINDOW_MINUTES} minutes and try again.`);
  }
}

async function recordAttempt(ctx, key) {
  await ctx.db.run('INSERT INTO login_attempts (email, ip, attempted_at) VALUES (?, ?, UTC_TIMESTAMP())', [key.slice(0, 190), ctx.ip]);
  if (Math.random() < 0.02) await ctx.db.run('DELETE FROM login_attempts WHERE attempted_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
}
