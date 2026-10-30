import express from 'express';
import { config } from '../config.js';
import { objects, parseJson, q } from '../db.js';
import { getSetting } from '../settings.js';
import { createOtp, saveEmail, saveSms, setOtpStatus, setSmsStatus, verifyOtp } from '../store.js';
import { hmac, parseBasic, randHex, rfc2822, safeEqual, toInt } from '../util.js';
import { enqueue } from '../webhooks.js';

/**
 * Twilio mock — Programmable Messaging (2010-04-01) + Verify v2.
 * Base URL: {PUBLIC_URL}/twilio   e.g. POST /twilio/2010-04-01/Accounts/{AccountSid}/Messages.json
 *                                       POST /twilio/v2/Services/{ServiceSid}/Verifications
 */
const P = 'twilio';
const cfg = () => config.twilio;

const twError = (res, status, code, message) =>
  res.status(status).json({ code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status });

function auth(req, res, next) {
  const b = parseBasic(req);
  if (!b || !safeEqual(b.user, cfg().accountSid) || !safeEqual(b.pass, cfg().authToken)) {
    return twError(res, 401, 20003, 'Authenticate');
  }
  if (req.params.sid && req.params.sid !== cfg().accountSid) {
    return twError(res, 404, 20404, `The requested resource ${req.path} was not found`);
  }
  next();
}

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)) */
export function twilioSignature(url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return hmac('sha1', cfg().authToken, data, 'base64');
}

// Twilio magic test numbers (https://www.twilio.com/docs/iam/test-credentials)
const MAGIC_TO = {
  '+15005550001': [21211, "The 'To' number +15005550001 is not a valid phone number."],
  '+15005550002': [21612, "The 'To' phone number: +15005550002, is not currently reachable using the 'From' phone number via SMS."],
  '+15005550003': [21408, 'Permission to send an SMS has not been enabled for the region indicated by the \'To\' number.'],
  '+15005550004': [21610, 'Attempt to send to unsubscribed recipient'],
  '+15005550009': [21614, "'To' number is not a valid mobile number"],
};

const E164 = /^\+[1-9]\d{6,14}$/;
const stripChannel = (s) => String(s || '').replace(/^(whatsapp|messenger|sms):/i, '');

function messageResource(m) {
  const base = `/2010-04-01/Accounts/${m.account_sid}/Messages/${m.sid}`;
  return { ...m, uri: `${base}.json`, subresource_uris: { media: `${base}/Media.json`, feedback: `${base}/Feedback.json` } };
}

function scheduleStatus(m, smsId, callbackUrl) {
  const final = getSetting('sms.deliveryStatus');
  const steps = ['sent', final];
  steps.forEach((status, i) => {
    setTimeout(() => {
      m.status = status;
      m.date_updated = rfc2822();
      if (status === 'sent') m.date_sent = rfc2822();
      if (status !== 'delivered' && status !== 'sent') {
        m.error_code = 30003;
        m.error_message = 'Unreachable destination handset';
      }
      objects.put(P, 'message', m.sid, m);
      setSmsStatus(smsId, status);
      if (callbackUrl) {
        const params = {
          AccountSid: m.account_sid,
          ApiVersion: '2010-04-01',
          From: m.from,
          MessageSid: m.sid,
          MessageStatus: status,
          SmsSid: m.sid,
          SmsStatus: status,
          To: m.to,
          ...(m.error_code ? { ErrorCode: String(m.error_code) } : {}),
          ...(m.messaging_service_sid ? { MessagingServiceSid: m.messaging_service_sid } : {}),
        };
        enqueue({
          provider: P,
          event: `message.${status}`,
          ref: m.sid,
          url: callbackUrl,
          contentType: 'application/x-www-form-urlencoded',
          body: new URLSearchParams(params).toString(),
          headers: { 'X-Twilio-Signature': twilioSignature(callbackUrl, params) },
        });
      }
    }, 400 + i * 800).unref?.();
  });
}

export const router = express.Router();

router.post('/2010-04-01/Accounts/:sid/Messages.json', auth, (req, res) => {
  const b = req.body || {};
  const toRaw = b.To;
  if (!toRaw) return twError(res, 400, 21604, "A 'To' phone number is required.");
  const to = stripChannel(toRaw);
  const channel = /^whatsapp:/i.test(toRaw) ? 'whatsapp' : 'sms';
  if (!E164.test(to)) return twError(res, 400, 21211, `Invalid 'To' Phone Number: ${toRaw}`);
  if (MAGIC_TO[to]) return twError(res, 400, ...MAGIC_TO[to]);
  if (!b.From && !b.MessagingServiceSid) return twError(res, 400, 21603, "A 'From' phone number is required.");
  if (b.From === '+15005550001') return twError(res, 400, 21212, "The 'From' number +15005550001 is not a valid phone number, shortcode, or alphanumeric sender ID.");
  const body = b.Body ?? '';
  if (!body && !b.MediaUrl && !b.ContentSid) return twError(res, 400, 21602, 'Message body is required.');
  if (body.length > 1600) return twError(res, 400, 21617, 'The concatenated message body exceeds the 1600 character limit.');
  const sid = `SM${randHex(16)}`;
  const now = rfc2822();
  const m = {
    account_sid: cfg().accountSid,
    api_version: '2010-04-01',
    body,
    date_created: now,
    date_sent: null,
    date_updated: now,
    direction: 'outbound-api',
    error_code: null,
    error_message: null,
    from: b.From || (channel === 'whatsapp' ? `whatsapp:${cfg().defaultFrom}` : cfg().defaultFrom),
    messaging_service_sid: b.MessagingServiceSid || null,
    num_media: String([].concat(b.MediaUrl || []).length),
    num_segments: String(Math.max(1, Math.ceil(body.length / 153))),
    price: null,
    price_unit: 'USD',
    sid,
    status: b.MessagingServiceSid && !b.From ? 'accepted' : 'queued',
    to: toRaw,
  };
  objects.put(P, 'message', sid, m);
  const sms = saveSms({ provider: P, channel, from: stripChannel(m.from), to, body, status: 'queued', meta: { sid, media: [].concat(b.MediaUrl || []), content_sid: b.ContentSid || null, content_variables: b.ContentVariables || null } });
  scheduleStatus(m, sms.id, b.StatusCallback);
  res.status(201).json(messageResource(m));
});

router.get('/2010-04-01/Accounts/:sid/Messages.json', auth, (req, res) => {
  const pageSize = Math.min(toInt(req.query.PageSize) || 50, 1000);
  let msgs = objects.list(P, 'message', { limit: 1000 });
  if (req.query.To) msgs = msgs.filter((m) => m.to === req.query.To);
  if (req.query.From) msgs = msgs.filter((m) => m.from === req.query.From);
  const uri = `/2010-04-01/Accounts/${cfg().accountSid}/Messages.json`;
  res.json({
    messages: msgs.slice(0, pageSize).map(messageResource),
    end: Math.min(pageSize, msgs.length) - 1,
    first_page_uri: `${uri}?PageSize=${pageSize}&Page=0`,
    next_page_uri: null,
    page: 0,
    page_size: pageSize,
    previous_page_uri: null,
    start: 0,
    uri: `${uri}?PageSize=${pageSize}&Page=0`,
  });
});

router.get('/2010-04-01/Accounts/:sid/Messages/:msid.json', auth, (req, res) => {
  const m = objects.get(req.params.msid, 'message');
  return m ? res.json(messageResource(m)) : twError(res, 404, 20404, `The requested resource ${req.path} was not found`);
});

router.post('/2010-04-01/Accounts/:sid/Messages/:msid.json', auth, (req, res) => {
  const m = objects.get(req.params.msid, 'message');
  if (!m) return twError(res, 404, 20404, `The requested resource ${req.path} was not found`);
  if (req.body?.Status === 'canceled') {
    if (!['queued', 'accepted', 'scheduled'].includes(m.status)) return twError(res, 400, 30409, 'Message cannot be canceled');
    m.status = 'canceled';
  }
  if (req.body?.Body === '') m.body = '';
  objects.put(P, 'message', m.sid, m);
  res.json(messageResource(m));
});

router.delete('/2010-04-01/Accounts/:sid/Messages/:msid.json', auth, (req, res) => res.status(204).end());

/* --------------------------------- Verify --------------------------------- */

function verification(otp, svc, extra = {}) {
  const d = otp.data || {};
  return {
    sid: d.sid,
    service_sid: svc,
    account_sid: cfg().accountSid,
    to: d.to,
    channel: otp.channel,
    status: { pending: 'pending', approved: 'approved', expired: 'expired', max_attempts: 'max_attempts_reached', canceled: 'canceled', superseded: 'canceled' }[otp.status] || otp.status,
    valid: otp.status === 'approved',
    lookup: {},
    amount: null,
    payee: null,
    send_code_attempts: d.attempts || [],
    date_created: new Date(otp.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    date_updated: new Date(otp.updated_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sna: null,
    url: `https://verify.twilio.com/v2/Services/${svc}/Verifications/${d.sid}`,
    ...extra,
  };
}

const verifyAuth = (req, res, next) => {
  const b = parseBasic(req);
  if (!b || !safeEqual(b.user, cfg().accountSid) || !safeEqual(b.pass, cfg().authToken)) return twError(res, 401, 20003, 'Authenticate');
  if (!/^VA[0-9a-f]{32}$/i.test(req.params.svc) && !/^VA/.test(req.params.svc)) return twError(res, 404, 20404, `The requested resource /Services/${req.params.svc} was not found`);
  next();
};

router.post('/v2/Services/:svc/Verifications', verifyAuth, (req, res) => {
  const b = req.body || {};
  const channel = (b.Channel || 'sms').toLowerCase();
  if (!b.To) return twError(res, 400, 60200, 'Invalid parameter `To`');
  if (!['sms', 'call', 'email', 'whatsapp'].includes(channel)) return twError(res, 400, 60200, 'Invalid parameter `Channel`');
  const to = String(b.To).trim();
  if (channel === 'email' ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) : !E164.test(to)) return twError(res, 400, 60200, 'Invalid parameter `To`: ' + to);
  if (MAGIC_TO[to]) return twError(res, 400, 60200, 'Invalid parameter `To`: ' + to);
  const svc = req.params.svc;
  const prev = objects.findBy(P, 'verification_index', `${svc}:${to.toLowerCase()}`);
  const otp = createOtp({
    provider: P,
    scope: svc,
    recipient: to,
    channel,
    code: b.CustomCode,
    length: 6,
    reuse: !b.CustomCode,
    data: { sid: `VE${randHex(16)}`, to, attempts: [] },
  });
  const data = otp.data;
  data.attempts = [...(prev?.attempts && prev.otp_id === otp.id ? prev.attempts : data.attempts || []), { attempt_sid: `VL${randHex(16)}`, channel, time: new Date().toISOString() }];
  objects.put(P, 'verification_index', `twv:${otp.id}`, { otp_id: otp.id, attempts: data.attempts }, { lookup: `${svc}:${to.toLowerCase()}` });
  objects.put(P, 'verification', data.sid, { otp_id: otp.id, svc });
  const text = `Your ${getSetting('merchant.name')} verification code is: ${otp.code}`;
  if (channel === 'email') {
    saveEmail({
      provider: 'twilio-verify',
      from: { address: 'no-reply@verify.mock', name: `${getSetting('merchant.name')} Verify` },
      to: [{ address: to, name: '' }],
      subject: `Your ${getSetting('merchant.name')} verification code`,
      text,
      html: `<p>${text}</p>`,
      meta: { otp: otp.code, verification_sid: data.sid },
    });
  } else {
    saveSms({ provider: 'twilio-verify', channel, from: 'Verify', to, body: channel === 'call' ? `[Voice call] ${text}` : text, meta: { otp: otp.code, verification_sid: data.sid } });
  }
  res.status(201).json(verification(otp, svc, { send_code_attempts: data.attempts }));
});

function findVerification(svc, sidOrTo) {
  const ref = /^VE/.test(sidOrTo) ? objects.get(sidOrTo, 'verification') : null;
  const idx = ref ? objects.get(`twv:${ref.otp_id}`) : objects.findBy(P, 'verification_index', `${svc}:${String(sidOrTo).toLowerCase()}`);
  if (!idx) return null;
  return { otpId: idx.otp_id, attempts: idx.attempts };
}

router.get('/v2/Services/:svc/Verifications/:sid', verifyAuth, (req, res) => {
  const v = findVerification(req.params.svc, req.params.sid);
  const row = v && rowOf(v.otpId);
  return row ? res.json(verification(row, req.params.svc, { send_code_attempts: v.attempts })) : twError(res, 404, 20404, `The requested resource /Services/${req.params.svc}/Verifications/${req.params.sid} was not found`);
});

router.post('/v2/Services/:svc/Verifications/:sid', verifyAuth, (req, res) => {
  const v = findVerification(req.params.svc, req.params.sid);
  const row = v && rowOf(v.otpId);
  if (!row) return twError(res, 404, 20404, `The requested resource /Services/${req.params.svc}/Verifications/${req.params.sid} was not found`);
  const status = req.body?.Status;
  if (!['canceled', 'approved'].includes(status)) return twError(res, 400, 60200, 'Invalid parameter `Status`');
  setOtpStatus(row.id, status);
  res.json(verification(rowOf(row.id), req.params.svc, { send_code_attempts: v.attempts }));
});

router.post(['/v2/Services/:svc/VerificationCheck', '/v2/Services/:svc/VerificationChecks'], verifyAuth, (req, res) => {
  const b = req.body || {};
  const svc = req.params.svc;
  if (!b.Code) return twError(res, 400, 60200, 'Invalid parameter `Code`');
  let to = b.To;
  if (!to && b.VerificationSid) {
    const v = findVerification(svc, b.VerificationSid);
    to = v && rowOf(v.otpId)?.data?.to;
  }
  if (!to) return twError(res, 404, 20404, `The requested resource /Services/${svc}/VerificationCheck was not found`);
  const r = verifyOtp({ provider: P, scope: svc, recipient: to, code: b.Code });
  if (r.result === 'not_found' || r.result === 'expired' || r.result === 'already_verified') {
    return twError(res, 404, 20404, `The requested resource /Services/${svc}/VerificationCheck was not found`);
  }
  if (r.result === 'max_attempts') return twError(res, 429, 60202, 'Max check attempts reached');
  const o = r.otp;
  res.json({
    sid: o.data.sid,
    service_sid: svc,
    account_sid: cfg().accountSid,
    to: o.data.to,
    channel: o.channel,
    status: r.result === 'approved' ? 'approved' : 'pending',
    valid: r.result === 'approved',
    amount: null,
    payee: null,
    sna_attempts_error_codes: [],
    date_created: new Date(o.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    date_updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
});

function rowOf(id) {
  const r = q('SELECT * FROM otps WHERE id = ?').get(id);
  return r && { ...r, data: parseJson(r.data, {}) };
}

router.use((req, res) => twError(res, 404, 20404, `The requested resource ${req.path} was not found (not implemented by the mock gateway)`));
