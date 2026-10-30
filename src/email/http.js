import express from 'express';
import { config } from '../config.js';
import { formatEmail, saveEmail } from '../store.js';
import { q } from '../db.js';
import { ah, bearer, escapeHtml, parseAddresses, rand, randHex, safeEqual, uuid } from '../util.js';
import { storeRaw } from './smtp.js';

/* ------------------------------ SendGrid ------------------------------ */
// Base URL {PUBLIC_URL}/sendgrid  ->  POST /sendgrid/v3/mail/send

export const sendgrid = express.Router();

const sgError = (res, status, message, field = null) => res.status(status).json({ errors: [{ message, field, help: null }] });

function renderTemplateData(id, data) {
  const rows = Object.entries(data || {}).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${escapeHtml(k)}</td><td style="padding:4px 0"><b>${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)}</b></td></tr>`);
  return `<div style="font-family:sans-serif"><p style="color:#64748b">SendGrid dynamic template <code>${escapeHtml(id)}</code> rendered by the mock with:</p><table>${rows.join('')}</table></div>`;
}

sendgrid.post('/v3/mail/send', (req, res) => {
  if (!safeEqual(bearer(req), config.sendgrid.apiKey)) return sgError(res, 401, 'The provided authorization grant is invalid, expired, or revoked');
  const b = req.body || {};
  if (!b.from?.email) return sgError(res, 400, 'The from object must be provided for every email send. It is an object that requires the email parameter, but may also contain a name parameter.', 'from.email');
  if (!Array.isArray(b.personalizations) || !b.personalizations.length) return sgError(res, 400, 'The personalizations field is required and must have at least one personalization.', 'personalizations');
  const content = Array.isArray(b.content) ? b.content : [];
  if (!b.template_id && !content.length) return sgError(res, 400, 'Unless a valid template_id is provided, the content parameter is required.', 'content');
  const msgId = rand(22);
  for (const p of b.personalizations) {
    const to = parseAddresses(p.to);
    if (!to.length) return sgError(res, 400, 'The to array is required for all personalization objects, and must have at least one email object with a valid email address.', 'personalizations.0.to');
    const subs = { ...(p.substitutions || {}) };
    const sub = (s) => Object.entries(subs).reduce((acc, [k, v]) => acc.split(k).join(v), s || '');
    let text = sub(content.find((c) => c.type === 'text/plain')?.value);
    let html = sub(content.find((c) => c.type === 'text/html')?.value);
    let subject = sub(p.subject || b.subject || '');
    if (b.template_id) {
      const d = p.dynamic_template_data || {};
      html = html || renderTemplateData(b.template_id, d);
      subject = subject || d.subject || `[template ${b.template_id}]`;
      text = text || Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    }
    saveEmail({
      provider: 'sendgrid',
      messageId: `<${msgId}@sendgrid.mock>`,
      from: { address: b.from.email, name: b.from.name || '' },
      to,
      cc: parseAddresses(p.cc),
      bcc: parseAddresses(p.bcc),
      replyTo: parseAddresses(b.reply_to),
      subject,
      text,
      html,
      headers: { ...(b.headers || {}), ...(p.headers || {}) },
      attachments: (b.attachments || []).map((a) => ({ filename: a.filename, contentType: a.type, content: a.content })),
      meta: { template_id: b.template_id || null, dynamic_template_data: p.dynamic_template_data || null, categories: b.categories || [], custom_args: { ...(b.custom_args || {}), ...(p.custom_args || {}) }, send_at: p.send_at || b.send_at || null },
    });
  }
  res.setHeader('X-Message-Id', msgId);
  res.status(202).end();
});

/* ------------------------------- Resend ------------------------------- */
// Base URL {PUBLIC_URL}/resend  (resend-node reads RESEND_BASE_URL)  ->  POST /resend/emails

export const resend = express.Router();

const rsError = (res, status, name, message) => res.status(status).json({ statusCode: status, name, message });

resend.use((req, res, next) => {
  if (!bearer(req)) return rsError(res, 401, 'missing_api_key', 'Missing API key in the authorization header');
  if (!safeEqual(bearer(req), config.resend.apiKey)) return rsError(res, 403, 'invalid_api_key', 'API key is invalid');
  next();
});

function resendOne(b) {
  const to = parseAddresses(b.to);
  if (!b.from) return { error: ['validation_error', 'Missing `from` field.'] };
  if (!to.length) return { error: ['validation_error', 'Missing `to` field.'] };
  if (!b.subject) return { error: ['validation_error', 'Missing `subject` field.'] };
  if (!b.html && !b.text) return { error: ['validation_error', 'Missing `html` or `text` field.'] };
  const id = uuid();
  saveEmail({
    provider: 'resend',
    messageId: `<${id}@resend.mock>`,
    from: parseAddresses(b.from)[0],
    to,
    cc: parseAddresses(b.cc),
    bcc: parseAddresses(b.bcc),
    replyTo: parseAddresses(b.reply_to || b.replyTo),
    subject: b.subject,
    text: b.text,
    html: b.html,
    headers: b.headers || {},
    attachments: (b.attachments || []).map((a) => ({ filename: a.filename, contentType: a.content_type || a.contentType, content: a.content })),
    meta: { resend_id: id, tags: b.tags || [], scheduled_at: b.scheduled_at || null },
  });
  return { id };
}

resend.post('/emails', (req, res) => {
  const r = resendOne(req.body || {});
  if (r.error) return rsError(res, 422, ...r.error);
  res.json({ id: r.id });
});

resend.post('/emails/batch', (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [];
  if (!items.length || items.length > 100) return rsError(res, 422, 'validation_error', 'Batch must contain between 1 and 100 emails.');
  const data = [];
  for (const item of items) {
    const r = resendOne(item);
    if (r.error) return rsError(res, 422, ...r.error);
    data.push({ id: r.id });
  }
  res.json({ data });
});

resend.get('/emails/:id', (req, res) => {
  const row = q("SELECT * FROM emails WHERE provider = 'resend' AND message_id = ?").get(`<${req.params.id}@resend.mock>`);
  if (!row) return rsError(res, 404, 'not_found', 'Email not found');
  const e = formatEmail(row, { full: true });
  res.json({
    object: 'email',
    id: req.params.id,
    to: e.to.map((a) => a.address),
    from: e.from,
    created_at: new Date(e.created_at).toISOString(),
    subject: e.subject,
    html: e.html,
    text: e.text,
    bcc: e.bcc.map((a) => a.address),
    cc: e.cc.map((a) => a.address),
    reply_to: e.reply_to.map((a) => a.address),
    last_event: 'delivered',
  });
});

/* -------------------------------- AWS SES -------------------------------- */
// SESv2: endpoint {PUBLIC_URL}/ses  ->  POST /ses/v2/email/outbound-emails
// SESv1 (Query API): POST /ses  with Action=SendEmail | SendRawEmail

export const ses = express.Router();

function sesAuthorized(req) {
  if (!config.ses.accessKeyId) return true;
  return String(req.headers.authorization || '').includes(`Credential=${config.ses.accessKeyId}/`);
}

ses.post('/v2/email/outbound-emails', ah(async (req, res) => {
  if (!sesAuthorized(req)) return res.status(403).json({ message: 'The security token included in the request is invalid.' });
  const b = req.body || {};
  const d = b.Destination || {};
  const c = b.Content || {};
  const messageId = `0100${randHex(8)}-${uuid()}-000000`;
  if (c.Raw?.Data) {
    await storeRaw(Buffer.from(c.Raw.Data, 'base64'), { provider: 'ses', envelope: { rcptTo: [...(d.ToAddresses || []), ...(d.CcAddresses || []), ...(d.BccAddresses || [])].map((address) => ({ address })) } });
    return res.json({ MessageId: messageId });
  }
  if (!b.FromEmailAddress) return res.status(400).json({ message: 'Missing required parameter FromEmailAddress' });
  if (!(d.ToAddresses || []).length && !(d.CcAddresses || []).length && !(d.BccAddresses || []).length) return res.status(400).json({ message: 'Missing final destination' });
  let subject = c.Simple?.Subject?.Data;
  let text = c.Simple?.Body?.Text?.Data;
  let html = c.Simple?.Body?.Html?.Data;
  if (c.Template) {
    const data = c.Template.TemplateData ? JSON.parse(c.Template.TemplateData) : {};
    subject = `[SES template ${c.Template.TemplateName || c.Template.TemplateArn}]`;
    html = renderTemplateData(c.Template.TemplateName || 'template', data);
    text = JSON.stringify(data, null, 2);
  }
  saveEmail({
    provider: 'ses',
    messageId: `<${messageId}@email.amazonses.com>`,
    from: parseAddresses(b.FromEmailAddress)[0],
    to: parseAddresses(d.ToAddresses),
    cc: parseAddresses(d.CcAddresses),
    bcc: parseAddresses(d.BccAddresses),
    replyTo: parseAddresses(b.ReplyToAddresses),
    subject,
    text,
    html,
    meta: { configuration_set: b.ConfigurationSetName || null, tags: b.EmailTags || [] },
  });
  res.json({ MessageId: messageId });
}));

const sesXml = (action, messageId) => `<${action}Response xmlns="http://ses.amazonaws.com/doc/2010-12-01/">
  <${action}Result><MessageId>${messageId}</MessageId></${action}Result>
  <ResponseMetadata><RequestId>${uuid()}</RequestId></ResponseMetadata>
</${action}Response>`;

ses.post('/', ah(async (req, res, next) => {
  const b = req.body || {};
  if (!b.Action) return next();
  if (!sesAuthorized(req)) return res.status(403).type('text/xml').send('<ErrorResponse><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>');
  const messageId = `0100${randHex(8)}-${uuid()}-000000`;
  const list = (prefix) => Object.keys(b).filter((k) => k.startsWith(prefix)).sort().map((k) => b[k]);
  if (b.Action === 'SendRawEmail') {
    await storeRaw(Buffer.from(b['RawMessage.Data'] || b.RawMessage?.Data || '', 'base64'), { provider: 'ses', envelope: { rcptTo: list('Destinations.member.').map((address) => ({ address })) } });
    return res.type('text/xml').send(sesXml('SendRawEmail', messageId));
  }
  if (b.Action === 'SendEmail') {
    const dest = b.Destination || {};
    saveEmail({
      provider: 'ses',
      messageId: `<${messageId}@email.amazonses.com>`,
      from: parseAddresses(b.Source)[0],
      to: parseAddresses(list('Destination.ToAddresses.member.').concat(dest.ToAddresses?.member || [])),
      cc: parseAddresses(list('Destination.CcAddresses.member.')),
      bcc: parseAddresses(list('Destination.BccAddresses.member.')),
      replyTo: parseAddresses(list('ReplyToAddresses.member.')),
      subject: b['Message.Subject.Data'],
      text: b['Message.Body.Text.Data'],
      html: b['Message.Body.Html.Data'],
    });
    return res.type('text/xml').send(sesXml('SendEmail', messageId));
  }
  res.status(400).type('text/xml').send(`<ErrorResponse><Error><Type>Sender</Type><Code>InvalidAction</Code><Message>The mock does not implement ${escapeHtml(b.Action)}</Message></Error></ErrorResponse>`);
}));
