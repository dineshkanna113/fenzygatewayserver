import express from 'express';
import { config } from '../config.js';
import { getSetting } from '../settings.js';
import { createOtp, latestOtp, saveSms, verifyOtp } from '../store.js';
import { digits, randHex, safeEqual } from '../util.js';
import { enqueue } from '../webhooks.js';

/**
 * MSG91 mock — https://docs.msg91.com
 * Base URL: {PUBLIC_URL}/msg91  (replaces https://control.msg91.com)  e.g. POST /msg91/api/v5/flow
 * Auth: `authkey` header (or authkey query param).
 */
const P = 'msg91';
const cfg = () => config.msg91;

const ok = (res, extra) => res.json({ type: 'success', ...extra });
const err = (res, message, status = 200, code) => res.status(status).json({ type: 'error', message, ...(code ? { code } : {}) });

function params(req) {
  return { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
}

function auth(req, res, next) {
  const key = req.headers.authkey || req.query.authkey || req.body?.authkey;
  if (!safeEqual(key, cfg().authKey)) return err(res, 'Authentication failure', 401, '201');
  next();
}

/** "919876543210" -> "+919876543210"; 10-digit numbers get +91. */
function normalizeMobile(m) {
  const d = digits(m);
  if (d.length === 10) return `+91${d}`;
  return `+${d}`;
}

function render(templateId, vars) {
  const tpl = cfg().templates[templateId];
  if (tpl) return tpl.replace(/##(\w+)##/g, (_, k) => vars[k] ?? vars[k.toLowerCase()] ?? vars[k.toUpperCase()] ?? `##${k}##`);
  const shown = Object.entries(vars).filter(([k]) => !['mobiles', 'mobile'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', ');
  return `[MSG91 template ${templateId || 'n/a'}] ${shown}`;
}

function dlr(requestId, mobile, status = 'delivered') {
  const url = getSetting('msg91.dlrUrl');
  if (!url) return;
  const code = status === 'delivered' ? '1' : '2';
  enqueue({
    provider: P,
    event: 'dlr',
    ref: requestId,
    url,
    body: JSON.stringify({ data: [{ requestId, userId: 'mock', senderId: cfg().senderId, report: [{ date: new Date().toISOString().replace('T', ' ').slice(0, 19), number: digits(mobile), status: code, desc: status.toUpperCase() }] }] }),
    delayMs: 800,
  });
}

function send(mobile, body, meta) {
  const requestId = randHex(12);
  const status = getSetting('sms.deliveryStatus');
  saveSms({ provider: P, from: meta.sender || cfg().senderId, to: normalizeMobile(mobile), body, status, meta: { request_id: requestId, ...meta } });
  dlr(requestId, mobile, status);
  return requestId;
}

export const router = express.Router();
router.use('/api', auth);

// Flow API (templates with variables)
router.post(['/api/v5/flow', '/api/v5/flow/'], (req, res) => {
  const b = req.body || {};
  const templateId = b.template_id || b.flow_id;
  if (!templateId) return err(res, 'template_id is required', 400);
  const recipients = Array.isArray(b.recipients) ? b.recipients : b.mobiles ? [{ mobiles: b.mobiles, ...b }] : [];
  if (!recipients.length) return err(res, 'recipients are required', 400);
  let requestId = null;
  for (const r of recipients) {
    for (const m of String(r.mobiles || r.mobile || '').split(',').filter(Boolean)) {
      if (digits(m).length < 10) return err(res, `Invalid mobile number ${m}`, 400);
      const vars = { ...r };
      delete vars.mobiles;
      const otp = Object.entries(vars).find(([k, v]) => /otp|code/i.test(k) && /^\d{4,8}$/.test(String(v)))?.[1];
      requestId = send(m, render(templateId, vars), { template_id: templateId, vars, sender: b.sender, ...(otp ? { otp: String(otp) } : {}) });
    }
  }
  ok(res, { message: requestId });
});

// OTP API
router.all(['/api/v5/otp', '/api/v5/otp/'], (req, res) => {
  const p = params(req);
  const mobile = p.mobile;
  if (!mobile || digits(mobile).length < 10) return err(res, 'Mobile no. is invalid', 400);
  const len = Math.min(Math.max(parseInt(p.otp_length, 10) || 4, 4), 9);
  const expiryMin = Math.min(Math.max(parseInt(p.otp_expiry, 10) || 15, 1), 1440);
  const otp = createOtp({ provider: P, recipient: mobile, code: p.otp, length: len, ttlSeconds: expiryMin * 60, data: { template_id: p.template_id || null } });
  const vars = { ...p, otp: otp.code, OTP: otp.code };
  const body = p.template_id && cfg().templates[p.template_id] ? render(p.template_id, vars) : `${otp.code} is your ${getSetting('merchant.name')} verification code. It is valid for ${expiryMin} minutes.`;
  const requestId = send(mobile, body, { template_id: p.template_id || null, otp: otp.code, kind: 'otp' });
  ok(res, { request_id: requestId });
});

router.all(['/api/v5/otp/verify', '/api/v5/otp/verify/'], (req, res) => {
  const p = params(req);
  if (!p.mobile || !p.otp) return err(res, 'mobile and otp are required', 400);
  const r = verifyOtp({ provider: P, recipient: p.mobile, code: p.otp });
  switch (r.result) {
    case 'approved':
      return ok(res, { message: 'OTP verified success' });
    case 'already_verified':
      return err(res, 'Mobile no. already verified');
    case 'expired':
      return err(res, 'OTP expired');
    case 'max_attempts':
      return err(res, 'Max limit reached for this otp verification');
    case 'not_found':
      return err(res, 'OTP not found or already verified');
    default:
      return err(res, 'OTP not match');
  }
});

router.all(['/api/v5/otp/retry', '/api/v5/otp/retry/'], (req, res) => {
  const p = params(req);
  const otp = p.mobile && latestOtp({ provider: P, recipient: p.mobile });
  if (!otp || otp.status !== 'pending') return err(res, 'No OTP request found to retry');
  const voice = /voice/i.test(p.retrytype || '');
  send(p.mobile, `${voice ? '[Voice call] ' : ''}${otp.code} is your ${getSetting('merchant.name')} verification code.`, { otp: otp.code, kind: 'otp_retry' });
  ok(res, { message: 'retry send successfully' });
});

// Legacy send APIs
router.all('/api/sendhttp.php', (req, res) => {
  const p = params(req);
  if (!p.mobiles || !p.message) return res.status(400).type('text').send('Mobile or message missing');
  let id;
  for (const m of String(p.mobiles).split(',').filter(Boolean)) id = send(m, p.message, { sender: p.sender, route: p.route });
  res.type('text').send(id);
});

router.post('/api/v2/sendsms', (req, res) => {
  const b = req.body || {};
  let id;
  for (const s of b.sms || []) for (const m of [].concat(s.to || [])) id = send(m, s.message, { sender: b.sender, route: b.route });
  if (!id) return err(res, 'sms array is required', 400);
  ok(res, { message: id });
});

router.use('/api', (req, res) => err(res, `The mock gateway does not implement ${req.method} ${req.path}`, 404));
