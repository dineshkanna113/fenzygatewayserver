import { config } from './config.js';
import { q, parseJson } from './db.js';
import { emit } from './events.js';
import { extractLinks, extractOtp, fmtAddress, genOtp, htmlToText, phoneKey, rand } from './util.js';

/* ----------------------------- SMS inbox ----------------------------- */

export function saveSms({ provider, channel = 'sms', from, to, body, status = 'delivered', meta = {}, id }) {
  const row = {
    id: id || `sms_${rand(16)}`,
    provider,
    channel,
    from_addr: from || null,
    to_addr: String(to),
    to_key: phoneKey(to) || String(to).toLowerCase(),
    body: body || '',
    otp: meta.otp || extractOtp(body),
    status,
    meta: JSON.stringify(meta),
    created_at: Date.now(),
  };
  q(`INSERT INTO sms (id, provider, channel, from_addr, to_addr, to_key, body, otp, status, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.provider, row.channel, row.from_addr, row.to_addr, row.to_key, row.body, row.otp, row.status, row.meta, row.created_at,
  );
  emit('sms', { id: row.id, provider, to: row.to_addr });
  return formatSms(row);
}

export function setSmsStatus(id, status) {
  q('UPDATE sms SET status = ? WHERE id = ?').run(status, id);
}

export const formatSms = (r) => r && { ...r, meta: parseJson(r.meta, {}) };

/* ---------------------------- Email inbox ---------------------------- */

export function saveEmail({ provider, messageId, from, to = [], cc = [], bcc = [], replyTo = [], subject, text, html, headers = {}, attachments = [], meta = {}, size }) {
  const id = `eml_${rand(16)}`;
  const plain = text || (html ? htmlToText(html) : '');
  const all = [...to, ...cc, ...bcc];
  const row = {
    id,
    provider,
    message_id: messageId || `<${id}@mock-gateway>`,
    from_addr: from ? fmtAddress(from) : null,
    to_addrs: JSON.stringify(to),
    cc_addrs: JSON.stringify(cc),
    bcc_addrs: JSON.stringify(bcc),
    reply_to: JSON.stringify(replyTo),
    rcpt: ',' + all.map((a) => a.address.toLowerCase()).join(',') + ',',
    subject: subject || '',
    text: plain,
    html: html || null,
    otp: meta.otp || extractOtp(subject, plain),
    links: JSON.stringify(extractLinks(html, plain)),
    headers: JSON.stringify(headers),
    meta: JSON.stringify(meta),
    size: size ?? Buffer.byteLength((html || '') + plain),
    created_at: Date.now(),
  };
  q(`INSERT INTO emails (id, provider, message_id, from_addr, to_addrs, cc_addrs, bcc_addrs, reply_to, rcpt, subject, text, html, otp, links, headers, meta, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.provider, row.message_id, row.from_addr, row.to_addrs, row.cc_addrs, row.bcc_addrs, row.reply_to, row.rcpt,
    row.subject, row.text, row.html, row.otp, row.links, row.headers, row.meta, row.size, row.created_at,
  );
  for (const a of attachments) {
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || '', a.encoding || 'base64');
    q('INSERT INTO email_attachments (id, email_id, filename, content_type, size, content) VALUES (?, ?, ?, ?, ?, ?)').run(
      `att_${rand(14)}`, id, a.filename || 'attachment', a.contentType || 'application/octet-stream', content.length, content,
    );
  }
  emit('email', { id, provider, to: to.map((a) => a.address), subject: row.subject });
  return { id, message_id: row.message_id };
}

export function formatEmail(r, { full = false } = {}) {
  if (!r) return null;
  const out = {
    id: r.id,
    provider: r.provider,
    message_id: r.message_id,
    from: r.from_addr,
    to: parseJson(r.to_addrs, []),
    cc: parseJson(r.cc_addrs, []),
    bcc: parseJson(r.bcc_addrs, []),
    reply_to: parseJson(r.reply_to, []),
    subject: r.subject,
    otp: r.otp,
    links: parseJson(r.links, []),
    has_html: !!r.html,
    size: r.size,
    created_at: r.created_at,
    snippet: (r.text || '').slice(0, 160),
  };
  if (full) {
    out.text = r.text;
    out.html = r.html;
    out.headers = parseJson(r.headers, {});
    out.meta = parseJson(r.meta, {});
    out.attachments = q('SELECT id, filename, content_type, size FROM email_attachments WHERE email_id = ?').all(r.id);
  }
  return out;
}

/* -------------------------------- OTPs -------------------------------- */

/**
 * Creates (or reuses, when reuse=true and one is still pending) an OTP for a recipient.
 * scope lets one provider keep separate pools (e.g. Twilio Verify service SID).
 */
export function createOtp({ provider, scope = '', recipient, code, length = 6, ttlSeconds = config.otp.ttlSeconds, channel = 'sms', data = {}, reuse = false }) {
  const key = normalizeRecipient(recipient);
  const now = Date.now();
  if (reuse) {
    const existing = q(`SELECT * FROM otps WHERE provider = ? AND scope = ? AND recipient = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`).get(provider, scope, key, now);
    if (existing) return formatOtp(existing);
  }
  q(`UPDATE otps SET status = 'superseded', updated_at = ? WHERE provider = ? AND scope = ? AND recipient = ? AND status = 'pending'`).run(now, provider, scope, key);
  const row = {
    id: `otp_${rand(16)}`,
    provider,
    scope,
    recipient: key,
    code: String(code || genOtp(length)),
    status: 'pending',
    attempts: 0,
    channel,
    data: JSON.stringify(data),
    expires_at: now + ttlSeconds * 1000,
    created_at: now,
    updated_at: now,
  };
  q(`INSERT INTO otps (id, provider, scope, recipient, code, status, attempts, channel, data, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.provider, row.scope, row.recipient, row.code, row.status, row.attempts, row.channel, row.data, row.expires_at, row.created_at, row.updated_at,
  );
  emit('otp', { id: row.id, provider, recipient: key });
  return formatOtp(row);
}

/** @returns {{result: 'approved'|'invalid'|'expired'|'not_found'|'max_attempts'|'already_verified', otp?}} */
export function verifyOtp({ provider, scope = '', recipient, code }) {
  const key = normalizeRecipient(recipient);
  const row = q(`SELECT * FROM otps WHERE provider = ? AND scope = ? AND recipient = ? AND status IN ('pending', 'approved', 'expired', 'max_attempts') ORDER BY created_at DESC LIMIT 1`).get(provider, scope, key);
  if (!row) return { result: 'not_found' };
  const now = Date.now();
  if (row.status === 'approved') return { result: 'already_verified', otp: formatOtp(row) };
  if (row.status === 'max_attempts') return { result: 'max_attempts', otp: formatOtp(row) };
  if (row.status === 'expired' || row.expires_at <= now) {
    q("UPDATE otps SET status = 'expired', updated_at = ? WHERE id = ?").run(now, row.id);
    return { result: 'expired', otp: formatOtp({ ...row, status: 'expired' }) };
  }
  const attempts = row.attempts + 1;
  if (String(code) === row.code) {
    q("UPDATE otps SET status = 'approved', attempts = ?, updated_at = ? WHERE id = ?").run(attempts, now, row.id);
    emit('otp', { id: row.id, provider, recipient: key, status: 'approved' });
    return { result: 'approved', otp: formatOtp({ ...row, status: 'approved', attempts }) };
  }
  const status = attempts >= config.otp.maxAttempts ? 'max_attempts' : 'pending';
  q('UPDATE otps SET status = ?, attempts = ?, updated_at = ? WHERE id = ?').run(status, attempts, now, row.id);
  return { result: status === 'max_attempts' ? 'max_attempts' : 'invalid', otp: formatOtp({ ...row, status, attempts }) };
}

export function latestOtp({ provider, scope = '', recipient }) {
  const row = q('SELECT * FROM otps WHERE provider = ? AND scope = ? AND recipient = ? ORDER BY created_at DESC LIMIT 1').get(provider, scope, normalizeRecipient(recipient));
  return row ? formatOtp(row) : null;
}

export function setOtpStatus(id, status) {
  q('UPDATE otps SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
}

export function normalizeRecipient(r) {
  const s = String(r || '').trim();
  if (s.includes('@')) return s.toLowerCase();
  return phoneKey(s) || s;
}

const formatOtp = (r) => ({ ...r, data: typeof r.data === 'string' ? parseJson(r.data, {}) : r.data });
