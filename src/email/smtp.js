import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { config } from '../config.js';
import { saveEmail } from '../store.js';
import { log, safeEqual } from '../util.js';

const addrs = (v) => (v ? [].concat(v).flatMap((x) => x.value || []).map((a) => ({ address: a.address, name: a.name || '' })) : []);

/** Parses a raw RFC 822 message and stores it in the inbox. */
export async function storeRaw(raw, { provider, envelope } = {}) {
  const parsed = await simpleParser(raw, { skipImageLinks: true });
  const to = addrs(parsed.to);
  const cc = addrs(parsed.cc);
  const bcc = addrs(parsed.bcc);
  // Envelope recipients not present in headers were Bcc'd.
  const known = new Set([...to, ...cc, ...bcc].map((a) => a.address.toLowerCase()));
  for (const r of envelope?.rcptTo || []) if (!known.has(r.address.toLowerCase())) bcc.push({ address: r.address, name: '' });
  const from = addrs(parsed.from)[0] || (envelope?.mailFrom ? { address: envelope.mailFrom.address, name: '' } : null);
  const headers = {};
  for (const [k, v] of parsed.headers) headers[k] = typeof v === 'object' && v && 'text' in v ? v.text : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return saveEmail({
    provider,
    messageId: parsed.messageId,
    from,
    to: to.length ? to : (envelope?.rcptTo || []).map((r) => ({ address: r.address, name: '' })),
    cc,
    bcc,
    replyTo: addrs(parsed.replyTo),
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html || null,
    headers,
    attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
    size: raw.length,
  });
}

export function startSmtp() {
  if (!config.smtp.enabled) return null;
  const requireAuth = !!(config.smtp.username && config.smtp.password);
  const server = new SMTPServer({
    name: 'mock-gateway',
    banner: 'Mock Gateway SMTP - messages are captured, never delivered',
    authOptional: !requireAuth,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    size: config.smtp.maxSize,
    logger: false,
    onAuth(auth, session, cb) {
      if (!requireAuth) return cb(null, { user: auth.username || 'anonymous' });
      if (safeEqual(auth.username, config.smtp.username) && safeEqual(auth.password, config.smtp.password)) return cb(null, { user: auth.username });
      cb(Object.assign(new Error('Invalid username or password'), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        if (stream.sizeExceeded) return cb(Object.assign(new Error('Message exceeds fixed maximum message size'), { responseCode: 552 }));
        try {
          const r = await storeRaw(Buffer.concat(chunks), { provider: 'smtp', envelope: session.envelope });
          log.info('smtp message captured', { id: r.id, rcpt: session.envelope.rcptTo.map((x) => x.address) });
          cb(null, `Message queued as ${r.id}`);
        } catch (e) {
          log.error('smtp parse failed', { err: e.message });
          cb(Object.assign(new Error('Could not parse message'), { responseCode: 451 }));
        }
      });
    },
  });
  server.on('error', (e) => log.error('smtp server error', { err: e.message }));
  server.listen(config.smtp.port, config.host, () => log.info('smtp listening', { port: config.smtp.port, auth: requireAuth ? 'required' : 'optional' }));
  return server;
}
