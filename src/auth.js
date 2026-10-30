import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { bearer, hmac, log, parseBasic, safeEqual } from './util.js';

/**
 * Dashboard sessions: a signed, HttpOnly cookie issued by the /login page.
 * Basic auth and Bearer ADMIN_API_TOKEN keep working for scripts and CI.
 */
const COOKIE = 'mg_session';
const SESSION_TTL_MS = 12 * 3600_000;
const LOCKOUT = { maxFailures: 5, windowMs: 15 * 60_000 };
const PUBLIC = path.resolve(import.meta.dirname, '../public');

// Persist the signing secret so sessions survive restarts; rotating ADMIN_PASSWORD invalidates them.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let row = q("SELECT value FROM settings WHERE key = '_session_secret'").get();
  if (!row) {
    q("INSERT OR IGNORE INTO settings (key, value) VALUES ('_session_secret', ?)").run(crypto.randomBytes(32).toString('hex'));
    row = q("SELECT value FROM settings WHERE key = '_session_secret'").get();
  }
  return row.value;
}
const SECRET = sessionSecret();
const signingKey = () => `${SECRET}:${config.admin.password}`;

function issue(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${hmac('sha256', signingKey(), payload, 'base64url')}`;
}

function verify(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, hmac('sha256', signingKey(), payload, 'base64url'))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s.exp > Date.now() && s.u === config.admin.username ? s : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieAttrs(req, maxAgeSec) {
  return [`Path=/`, `Max-Age=${maxAgeSec}`, 'HttpOnly', 'SameSite=Lax', ...(req.secure ? ['Secure'] : [])].join('; ');
}

export function sessionOf(req) {
  return verify(readCookie(req, COOKIE));
}

/**
 * Accepts: Bearer ADMIN_API_TOKEN, HTTP Basic, or a dashboard session cookie.
 * Cookie-authenticated writes must carry X-Requested-With (blocks cross-site form posts).
 */
export function adminAuth(req, res, next) {
  const token = bearer(req);
  if (token && config.admin.token && safeEqual(token, config.admin.token)) return next();
  const basic = parseBasic(req);
  if (basic && safeEqual(basic.user, config.admin.username) && safeEqual(basic.pass, config.admin.password)) return next();
  const session = sessionOf(req);
  if (session) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'mock-gateway') {
      return res.status(403).json({ error: 'Missing X-Requested-With header' });
    }
    req.adminUser = session.u;
    return next();
  }
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
    return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  res.status(401).json({ error: 'Admin authentication required' });
}

/* ------------------------------ lockout ------------------------------ */

const failures = new Map();
function lockedFor(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (Date.now() - f.first > LOCKOUT.windowMs) {
    failures.delete(ip);
    return 0;
  }
  return f.count >= LOCKOUT.maxFailures ? Math.ceil((f.first + LOCKOUT.windowMs - Date.now()) / 60_000) : 0;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > LOCKOUT.windowMs) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count += 1;
  if (failures.size > 10_000) failures.clear();
}

/* ------------------------------- routes ------------------------------- */

const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/dashboard');

export const router = express.Router();

router.get('/login', (req, res) => {
  if (sessionOf(req)) return res.redirect(302, safeNext(req.query.next));
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});

router.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const next = safeNext(req.body?.next);
  const back = (error, extra = '') => res.redirect(303, `/login?error=${error}${extra}&next=${encodeURIComponent(next)}`);
  const locked = lockedFor(req.ip);
  if (locked) return back('locked', `&minutes=${locked}`);
  const { username = '', password = '' } = req.body || {};
  if (!(safeEqual(username, config.admin.username) && safeEqual(password, config.admin.password))) {
    recordFailure(req.ip);
    log.warn('dashboard login failed', { ip: req.ip, username: String(username).slice(0, 64) });
    return lockedFor(req.ip) ? back('locked', `&minutes=${Math.ceil(LOCKOUT.windowMs / 60_000)}`) : back('invalid');
  }
  failures.delete(req.ip);
  log.info('dashboard login', { ip: req.ip, username });
  res.setHeader('Set-Cookie', `${COOKIE}=${issue(username)}; ${cookieAttrs(req, SESSION_TTL_MS / 1000)}`);
  res.redirect(303, next);
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req, 0)}`);
  if (!/text\/html/.test(req.headers.accept || '')) return res.json({ ok: true });
  res.redirect(303, '/login?error=signed_out');
});

router.get('/api/session', (req, res) => {
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  res.json({ username: s.u, expires_at: s.exp });
});
