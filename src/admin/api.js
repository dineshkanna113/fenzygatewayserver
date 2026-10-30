import express from 'express';
import { config } from '../config.js';
import { db, objects, parseJson, q } from '../db.js';
import { bus } from '../events.js';
import { simulate } from '../payments/checkout.js';
import { adapters, checkoutIdFor, checkoutUrlFor } from '../payments/registry.js';
import { allSettings, setSettings } from '../settings.js';
import { formatEmail, formatSms, normalizeRecipient } from '../store.js';
import { baseUrl, log, phoneKey, toInt } from '../util.js';
import { formatRow, getWebhook, retryWebhook } from '../webhooks.js';

/**
 * Admin / test-automation API. Auth: HTTP Basic (ADMIN_USERNAME/ADMIN_PASSWORD) or Bearer ADMIN_API_TOKEN.
 */
export const router = express.Router();

const limitOf = (req, d = 50) => Math.min(Math.max(toInt(req.query.limit) || d, 1), 500);

/* -------------------------------- SMS -------------------------------- */

function smsQuery(req) {
  const where = [];
  const args = [];
  if (req.query.to) {
    const key = phoneKey(req.query.to) || String(req.query.to).toLowerCase();
    where.push('to_key = ?');
    args.push(key);
  }
  if (req.query.provider) {
    where.push('provider = ?');
    args.push(req.query.provider);
  }
  if (req.query.q) {
    where.push('(body LIKE ? OR to_addr LIKE ?)');
    args.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  if (req.query.since) {
    where.push('created_at >= ?');
    args.push(toInt(req.query.since) || Date.parse(req.query.since) || 0);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

router.get('/sms', (req, res) => {
  const { sql, args } = smsQuery(req);
  const rows = db.prepare(`SELECT * FROM sms ${sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limitOf(req));
  res.json({ data: rows.map(formatSms) });
});

router.get('/sms/latest', (req, res) => {
  const { sql, args } = smsQuery(req);
  const row = db.prepare(`SELECT * FROM sms ${sql} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...args);
  return row ? res.json(formatSms(row)) : res.status(404).json({ error: 'No matching SMS' });
});

router.get('/sms/:id', (req, res) => {
  const row = q('SELECT * FROM sms WHERE id = ?').get(req.params.id);
  return row ? res.json(formatSms(row)) : res.status(404).json({ error: 'Not found' });
});

router.delete('/sms/:id', (req, res) => {
  q('DELETE FROM sms WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

/* -------------------------------- OTPs -------------------------------- */

router.get('/otps', (req, res) => {
  const args = [];
  let sql = 'SELECT * FROM otps';
  if (req.query.recipient) {
    sql += ' WHERE recipient = ?';
    args.push(normalizeRecipient(req.query.recipient));
  }
  const rows = db.prepare(`${sql} ORDER BY created_at DESC LIMIT ?`).all(...args, limitOf(req));
  res.json({ data: rows.map((r) => ({ ...r, data: parseJson(r.data, {}), expired: r.expires_at < Date.now() })) });
});

/* ------------------------------- Emails ------------------------------- */

function emailQuery(req) {
  const where = [];
  const args = [];
  if (req.query.to) {
    where.push('rcpt LIKE ?');
    args.push(`%,${String(req.query.to).toLowerCase()},%`);
  }
  if (req.query.provider) {
    where.push('provider = ?');
    args.push(req.query.provider);
  }
  if (req.query.subject) {
    where.push('subject LIKE ?');
    args.push(`%${req.query.subject}%`);
  }
  if (req.query.q) {
    where.push('(subject LIKE ? OR text LIKE ? OR rcpt LIKE ? OR from_addr LIKE ?)');
    for (let i = 0; i < 4; i++) args.push(`%${req.query.q}%`);
  }
  if (req.query.since) {
    where.push('created_at >= ?');
    args.push(toInt(req.query.since) || Date.parse(req.query.since) || 0);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

router.get('/emails', (req, res) => {
  const { sql, args } = emailQuery(req);
  const rows = db.prepare(`SELECT * FROM emails ${sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limitOf(req));
  res.json({ data: rows.map((r) => formatEmail(r)) });
});

router.get('/emails/latest', (req, res) => {
  const { sql, args } = emailQuery(req);
  const row = db.prepare(`SELECT * FROM emails ${sql} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...args);
  return row ? res.json(formatEmail(row, { full: true })) : res.status(404).json({ error: 'No matching email' });
});

router.get('/emails/:id', (req, res) => {
  const row = q('SELECT * FROM emails WHERE id = ?').get(req.params.id);
  return row ? res.json(formatEmail(row, { full: true })) : res.status(404).json({ error: 'Not found' });
});

router.get('/emails/:id/html', (req, res) => {
  const row = q('SELECT html, text FROM emails WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('Not found');
  // Rendered in a sandboxed iframe on the dashboard; block scripts and remote loads besides images.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src * data:; sandbox");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (row.html) return res.type('html').send(row.html);
  res.type('text').send(row.text || '');
});

router.get('/emails/:id/attachments/:aid', (req, res) => {
  const a = q('SELECT * FROM email_attachments WHERE id = ? AND email_id = ?').get(req.params.aid, req.params.id);
  if (!a) return res.status(404).send('Not found');
  res.setHeader('Content-Disposition', `attachment; filename="${String(a.filename).replace(/["\r\n]/g, '_')}"`);
  res.type(a.content_type || 'application/octet-stream').send(Buffer.from(a.content));
});

router.delete('/emails/:id', (req, res) => {
  q('DELETE FROM emails WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

/* ------------------------------ Payments ------------------------------ */

function formatCheckout(r) {
  return { ...r, customer: parseJson(r.customer, null), checkout_url: baseUrl() + checkoutUrlFor(r.provider, r.id), checkout_id: checkoutIdFor(r.provider, r.id) };
}

router.get('/payments', (req, res) => {
  const where = [];
  const args = [];
  for (const k of ['provider', 'status']) {
    if (req.query[k]) {
      where.push(`${k} = ?`);
      args.push(req.query[k]);
    }
  }
  if (req.query.q) {
    where.push('(id LIKE ? OR reference LIKE ? OR description LIKE ? OR customer LIKE ?)');
    for (let i = 0; i < 4; i++) args.push(`%${req.query.q}%`);
  }
  const rows = db.prepare(`SELECT * FROM checkouts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limitOf(req));
  res.json({ data: rows.map(formatCheckout) });
});

function findCheckout(id) {
  return q('SELECT * FROM checkouts WHERE id = ?').get(id)
    || q("SELECT * FROM checkouts WHERE id IN (?, ?, ?) OR reference = ? ORDER BY created_at DESC LIMIT 1").get(`cf:${id}`, `ppv1:${id}`, `ppv2:${id}`, id);
}

function descendants(id, depth = 0) {
  if (depth > 3) return [];
  const rows = objects.childRows(id);
  return rows.flatMap((r) => [{ id: r.id, type: r.type, created_at: r.created_at, data: r.data }, ...descendants(r.id, depth + 1)]);
}

router.get('/payments/:id', (req, res) => {
  const c = findCheckout(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const root = objects.row(c.id);
  const related = descendants(c.id).filter((o) => !['pm_sim', 'pi_sim', 'cs_line_items', 'event'].includes(o.type));
  const webhooks = q('SELECT * FROM webhooks WHERE ref = ? ORDER BY created_at ASC, rowid ASC').all(c.id).map(formatRow);
  res.json({ ...formatCheckout(c), object: root?.data || null, related, webhooks });
});

router.post('/payments/:id/simulate', (req, res) => {
  const c = findCheckout(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const out = simulate(c.provider, checkoutIdFor(c.provider, c.id), req.body || {});
  if (out.error && !out.status) return res.status(400).json(out);
  log.info('payment simulated', { provider: c.provider, id: c.id, status: out.status });
  res.json(out);
});

router.post('/payments/:id/refund', (req, res) => {
  const c = findCheckout(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const adapter = adapters[c.provider];
  const out = adapter.refund(checkoutIdFor(c.provider, c.id), toInt(req.body?.amount));
  if (out.error) return res.status(400).json(out);
  res.json(out);
});

/* ------------------------------ Webhooks ------------------------------ */

router.get('/webhooks', (req, res) => {
  const where = [];
  const args = [];
  for (const k of ['provider', 'status', 'ref', 'event']) {
    if (req.query[k]) {
      where.push(`${k} = ?`);
      args.push(req.query[k]);
    }
  }
  const rows = db.prepare(`SELECT * FROM webhooks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limitOf(req));
  res.json({ data: rows.map(formatRow) });
});

router.get('/webhooks/:id', (req, res) => {
  const w = getWebhook(req.params.id);
  return w ? res.json(w) : res.status(404).json({ error: 'Not found' });
});

router.post('/webhooks/:id/retry', (req, res) => {
  const w = retryWebhook(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.error) return res.status(400).json(w);
  res.json(w);
});

/* --------------------------- Settings / meta --------------------------- */

router.get('/settings', (req, res) => res.json({ data: allSettings() }));

router.put('/settings', (req, res) => {
  const r = setSettings(req.body || {});
  if (!r.ok) return res.status(400).json(r);
  res.json({ data: allSettings() });
});

router.get('/stats', (req, res) => {
  const count = (sql) => q(sql).get().n;
  res.json({
    sms: count('SELECT COUNT(*) n FROM sms'),
    emails: count('SELECT COUNT(*) n FROM emails'),
    payments: count('SELECT COUNT(*) n FROM checkouts'),
    paid: count("SELECT COUNT(*) n FROM checkouts WHERE status = 'paid'"),
    webhooks: count('SELECT COUNT(*) n FROM webhooks'),
    webhooks_failed: count("SELECT COUNT(*) n FROM webhooks WHERE status IN ('failed', 'retrying')"),
  });
});

router.get('/config', (req, res) => {
  const b = baseUrl();
  const smtpHost = new URL(b).hostname;
  res.json({
    public_url: b,
    providers: [
      { name: 'Razorpay', base_url: `${b}/razorpay`, sdk: `${b}/razorpay/v1/checkout.js`, credentials: { key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret, webhook_secret: config.razorpay.webhookSecret } },
      { name: 'Stripe', base_url: b, note: 'stripe-node: { host, port, protocol }. Also at /stripe', credentials: { secret_key: config.stripe.secretKey, publishable_key: config.stripe.publishableKey, webhook_secret: config.stripe.webhookSecret } },
      { name: 'Cashfree', base_url: `${b}/cashfree/pg`, sdk: `${b}/cashfree/js/v3/cashfree.js`, credentials: { app_id: config.cashfree.appId, secret_key: config.cashfree.secretKey } },
      { name: 'PhonePe v1', base_url: `${b}/phonepe`, credentials: { merchant_id: config.phonepe.merchantId, salt_key: config.phonepe.saltKey, salt_index: config.phonepe.saltIndex } },
      { name: 'PhonePe v2', base_url: `${b}/phonepe`, sdk: `${b}/phonepe/checkout.js`, credentials: { client_id: config.phonepe.clientId, client_secret: config.phonepe.clientSecret, client_version: config.phonepe.clientVersion, webhook_username: config.phonepe.webhookUsername, webhook_password: config.phonepe.webhookPassword } },
      { name: 'Generic payments', base_url: `${b}/generic`, credentials: { api_key: config.generic.apiKey, api_secret: config.generic.apiSecret, webhook_secret: config.generic.webhookSecret } },
      { name: 'Twilio', base_url: `${b}/twilio`, credentials: { account_sid: config.twilio.accountSid, auth_token: config.twilio.authToken } },
      { name: 'MSG91', base_url: `${b}/msg91`, credentials: { authkey: config.msg91.authKey } },
      { name: 'Generic SMS / OTP / Email', base_url: `${b}/generic`, credentials: { api_key: config.generic.apiKey } },
      { name: 'SMTP', base_url: `smtp://${smtpHost}:${config.smtp.port}`, credentials: config.smtp.username ? { username: config.smtp.username, password: config.smtp.password } : { note: 'any username/password accepted' } },
      { name: 'SendGrid', base_url: `${b}/sendgrid`, credentials: { api_key: config.sendgrid.apiKey } },
      { name: 'Resend', base_url: `${b}/resend`, credentials: { api_key: config.resend.apiKey } },
      { name: 'AWS SES', base_url: `${b}/ses`, credentials: { access_key_id: config.ses.accessKeyId || '(any)', note: 'signatures are not verified' } },
    ],
  });
});

router.post('/reset', (req, res) => {
  const scope = req.body?.scope || 'all';
  const tables = {
    sms: ['sms'],
    emails: ['email_attachments', 'emails'],
    otps: ['otps'],
    payments: ['checkouts', 'objects', 'idempotency'],
    webhooks: ['webhooks'],
  };
  const list = scope === 'all' ? Object.values(tables).flat() : tables[scope];
  if (!list) return res.status(400).json({ error: `scope must be one of all, ${Object.keys(tables).join(', ')}` });
  for (const t of list) db.exec(`DELETE FROM ${t}`);
  log.warn('data reset', { scope });
  res.json({ ok: true, cleared: list });
});

/* ------------------------------ Live stream ------------------------------ */

router.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const onEvent = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('event', onEvent);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
});

/* ------------------------------ Retention ------------------------------ */

export function startRetention() {
  const run = () => {
    if (!config.retentionDays) return;
    const cutoff = Date.now() - config.retentionDays * 86_400_000;
    const r = [
      q('DELETE FROM sms WHERE created_at < ?').run(cutoff).changes,
      q('DELETE FROM emails WHERE created_at < ?').run(cutoff).changes,
      q('DELETE FROM otps WHERE created_at < ?').run(cutoff).changes,
      q('DELETE FROM checkouts WHERE created_at < ?').run(cutoff).changes,
      q('DELETE FROM objects WHERE created_at < ?').run(cutoff).changes,
      q('DELETE FROM webhooks WHERE created_at < ?').run(cutoff).changes,
      q('DELETE FROM idempotency WHERE created_at < ?').run(Date.now() - 86_400_000).changes,
    ].reduce((a, b) => a + b, 0);
    if (r) log.info('retention cleanup', { deleted: r, days: config.retentionDays });
  };
  run();
  const t = setInterval(run, 3_600_000);
  t.unref?.();
}
