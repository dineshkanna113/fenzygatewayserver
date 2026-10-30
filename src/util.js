import crypto from 'node:crypto';
import { config } from './config.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function rand(n, alphabet = B62) {
  // Rejection sampling keeps the distribution uniform.
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b < max) out += alphabet[b % alphabet.length];
      if (out.length === n) break;
    }
  }
  return out;
}

export const randHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
export const randDigits = (n) => rand(n, '0123456789');
export const uuid = () => crypto.randomUUID();

export const hmac = (alg, key, data, enc = 'hex') => crypto.createHmac(alg, key).update(data).digest(enc);
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export const nowMs = () => Date.now();
export const nowSec = () => Math.floor(Date.now() / 1000);

export function parseBasic(req) {
  const h = req.headers.authorization || '';
  if (!/^basic /i.test(h)) return null;
  const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return { user: decoded, pass: '' };
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export const digits = (s) => String(s ?? '').replace(/\D+/g, '');

/** Last 10 digits are used for matching so +91 98765 43210, 919876543210 and 9876543210 all match. */
export const phoneKey = (s) => digits(s).slice(-10);

export function extractOtp(...texts) {
  const text = texts.filter(Boolean).join('\n');
  if (!text) return null;
  const keyword = /(?:otp|one[\s-]?time|code|pin|passcode|password|verification|verify)[^0-9]{0,40}?(\d{4,8})\b/i.exec(text);
  if (keyword) return keyword[1];
  const any = /(?<![\d.,:/-])(\d{4,8})(?![\d.,:/-])/.exec(text);
  return any ? any[1] : null;
}

export function extractLinks(html, text) {
  const links = new Set();
  if (html) for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) links.add(decodeEntities(m[1]));
  for (const m of `${text || ''}`.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) links.add(m[0]);
  return [...links].filter((l) => /^https?:/i.test(l)).slice(0, 100);
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** JSON that is safe to inline inside a <script> tag. */
export const inlineJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function genOtp(length = 6) {
  const n = Math.min(Math.max(parseInt(length, 10) || 6, 4), 9);
  return String(crypto.randomInt(10 ** (n - 1), 10 ** n));
}

export function luhn(num) {
  const d = digits(num);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function toInt(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

export function toBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export const rfc2822 = (ms = Date.now()) => new Date(ms).toUTCString().replace('GMT', '+0000');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.values(v);
  return [v];
}

/** Parses "Name <a@b.c>", {email,name}, {Email,Name} or plain strings into addresses. */
export function parseAddresses(v) {
  const out = [];
  for (const item of asArray(v)) {
    if (!item) continue;
    if (typeof item === 'object') {
      const email = item.email || item.Email || item.address;
      if (email) out.push({ address: String(email).trim(), name: item.name || item.Name || '' });
      continue;
    }
    for (const part of String(item).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const p = part.trim();
      if (!p) continue;
      const m = /^(.*)<([^>]+)>\s*$/.exec(p);
      if (m) out.push({ address: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, '') });
      else out.push({ address: p, name: '' });
    }
  }
  return out;
}

export const fmtAddress = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function write(level, msg, extra) {
  if (LEVELS[level] < (LEVELS[config.logLevel] ?? 20)) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
export const log = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};

/** Express async wrapper so thrown errors reach the error handler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function baseUrl() {
  return config.publicUrl;
}
