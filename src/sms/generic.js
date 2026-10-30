import express from 'express';
import { config } from '../config.js';
import { getSetting } from '../settings.js';
import { createOtp, saveEmail, saveSms, verifyOtp } from '../store.js';
import { bearer, parseAddresses, safeEqual } from '../util.js';

/**
 * Provider-neutral SMS / OTP / Email API (Authorization: Bearer GENERIC_API_KEY).
 *   POST /generic/sms         { to, message, from? }
 *   POST /generic/otp/send    { to, channel?: 'sms'|'email', length?, ttl_seconds? }
 *   POST /generic/otp/verify  { to, code }
 *   POST /generic/email       { from, to, cc?, bcc?, subject, html?, text?, attachments?: [{filename, content(base64), content_type}] }
 */
const gError = (res, status, code, message) => res.status(status).json({ error: { code, message } });

export const router = express.Router();

router.use(['/sms', '/otp', '/email'], (req, res, next) => {
  if (!safeEqual(bearer(req), config.generic.apiKey)) return gError(res, 401, 'unauthorized', 'Invalid or missing API key');
  next();
});

router.post('/sms', (req, res) => {
  const b = req.body || {};
  if (!b.to) return gError(res, 400, 'missing_to', 'to is required');
  if (!b.message) return gError(res, 400, 'missing_message', 'message is required');
  const recipients = [].concat(b.to);
  const status = getSetting('sms.deliveryStatus');
  const data = recipients.map((to) => saveSms({ provider: 'generic', from: b.from || 'MOCK', to, body: String(b.message), status, meta: b.metadata || {} }));
  res.status(201).json({ data: data.map((s) => ({ id: s.id, to: s.to_addr, status: s.status })) });
});

router.post('/otp/send', (req, res) => {
  const b = req.body || {};
  if (!b.to) return gError(res, 400, 'missing_to', 'to is required');
  const channel = b.channel || (String(b.to).includes('@') ? 'email' : 'sms');
  const otp = createOtp({ provider: 'generic', recipient: b.to, channel, code: b.code, length: b.length || 6, ttlSeconds: b.ttl_seconds || config.otp.ttlSeconds });
  const name = getSetting('merchant.name');
  const text = b.message ? String(b.message).replace('{code}', otp.code) : `${otp.code} is your ${name} verification code.`;
  if (channel === 'email') {
    saveEmail({ provider: 'generic', from: { address: 'no-reply@mock.local', name }, to: parseAddresses(b.to), subject: `${name} verification code`, text, html: `<p>${text}</p>`, meta: { otp: otp.code } });
  } else {
    saveSms({ provider: 'generic', from: 'MOCK', to: b.to, body: text, meta: { otp: otp.code } });
  }
  res.status(201).json({ request_id: otp.id, expires_at: new Date(otp.expires_at).toISOString() });
});

router.post('/otp/verify', (req, res) => {
  const b = req.body || {};
  if (!b.to || !b.code) return gError(res, 400, 'missing_fields', 'to and code are required');
  const r = verifyOtp({ provider: 'generic', recipient: b.to, code: b.code });
  res.status(r.result === 'approved' ? 200 : 400).json({ verified: r.result === 'approved', status: r.result });
});

router.post('/email', (req, res) => {
  const b = req.body || {};
  const to = parseAddresses(b.to);
  if (!to.length) return gError(res, 400, 'missing_to', 'to is required');
  if (!b.from) return gError(res, 400, 'missing_from', 'from is required');
  if (!b.html && !b.text) return gError(res, 400, 'missing_content', 'html or text is required');
  const r = saveEmail({
    provider: 'generic',
    from: parseAddresses(b.from)[0],
    to,
    cc: parseAddresses(b.cc),
    bcc: parseAddresses(b.bcc),
    replyTo: parseAddresses(b.reply_to),
    subject: b.subject,
    text: b.text,
    html: b.html,
    attachments: (b.attachments || []).map((a) => ({ filename: a.filename, contentType: a.content_type, content: a.content })),
    meta: b.metadata || {},
  });
  res.status(201).json({ id: r.id, message_id: r.message_id, status: 'delivered' });
});
