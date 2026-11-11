import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import nodemailer from 'nodemailer';

/* ---------- boot the server in-process with an isolated data dir ---------- */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockgw-'));
const received = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, body });
    res.writeHead(req.url.includes('fail') ? 500 : 200).end('ok');
  });
});
await new Promise((r) => hook.listen(0, '127.0.0.1', r));
const HOOK = `http://127.0.0.1:${hook.address().port}`;

Object.assign(process.env, {
  DATA_DIR: dataDir,
  ADMIN_PASSWORD: 'admin-pass',
  ADMIN_API_TOKEN: 'admin-token',
  LOG_LEVEL: 'error',
  RAZORPAY_WEBHOOK_URL: `${HOOK}/razorpay`,
  STRIPE_WEBHOOK_URL: `${HOOK}/stripe`,
  CASHFREE_WEBHOOK_URL: `${HOOK}/cashfree`,
  PHONEPE_WEBHOOK_URL: `${HOOK}/phonepe2`,
  PAYTM_WEBHOOK_URL: `${HOOK}/paytm`,
  GENERIC_WEBHOOK_URL: `${HOOK}/generic`,
  RATE_LIMIT_PER_MINUTE: '0',
});

const { createApp } = await import('../src/app.js');
const { startWebhookWorker, stopWebhookWorker } = await import('../src/webhooks.js');
const { config } = await import('../src/config.js');
const { startSmtp } = await import('../src/email/smtp.js');
const { db } = await import('../src/db.js');

let server;
let smtp;
let BASE;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = BASE;
  config.smtp.port = 0;
  smtp = startSmtp();
  await new Promise((r) => (smtp.server.listening ? r() : smtp.server.once('listening', r)));
  startWebhookWorker();
});

after(() => {
  stopWebhookWorker();
  server.close();
  smtp.close();
  hook.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* --------------------------------- helpers -------------------------------- */

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const ADMIN = { Authorization: 'Bearer admin-token' };

async function call(method, url, { headers = {}, json, form, raw } = {}) {
  const h = { ...headers };
  let body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (raw) body = raw;
  const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const complete = (provider, id, input) => call('POST', `/checkout/${provider}/${encodeURIComponent(id)}/complete`, { json: input });

async function waitFor(fn, ms = 6000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const hmac = (alg, key, data, enc = 'hex') => crypto.createHmac(alg, key).update(data).digest(enc);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const VISA = { method: 'card', card: { number: '4111111111111111', expiry: '12/40', cvc: '123' } };

/* ---------------------------------- tests --------------------------------- */

describe('admin', () => {
  test('rejects unauthenticated access', async () => {
    assert.equal((await call('GET', '/api/stats')).status, 401);
    assert.equal((await call('GET', '/dashboard')).status, 401);
    assert.equal((await call('GET', '/api/stats', { headers: { Authorization: basic('admin', 'admin-pass') } })).status, 200);
  });

  test('login page, session cookie, CSRF header and lockout', async () => {
    const page = await call('GET', '/dashboard', { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2Fdashboard');
    assert.equal((await call('GET', '/login')).status, 200);
    const bad = await call('POST', '/login', { form: { username: 'admin', password: 'nope', next: '/dashboard' } });
    assert.equal(bad.status, 303);
    assert.match(bad.headers.get('location'), /error=invalid/);
    const ok = await call('POST', '/login', { form: { username: 'admin', password: 'admin-pass', next: '//evil.example' } });
    assert.equal(ok.headers.get('location'), '/dashboard');
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await call('GET', '/api/stats', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await call('GET', '/api/session', { headers: { Cookie: cookie } })).data.username, 'admin');
    assert.equal((await call('POST', '/api/reset', { headers: { Cookie: cookie }, json: { scope: 'otps' } })).status, 403);
    assert.equal((await call('POST', '/api/reset', { headers: { Cookie: cookie, 'X-Requested-With': 'mock-gateway' }, json: { scope: 'otps' } })).status, 200);
    assert.equal((await call('GET', '/api/stats', { headers: { Cookie: cookie.replace(/.$/, 'x') } })).status, 401);
    const out = await call('POST', '/logout', { headers: { Cookie: cookie } });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  });

  test('locks out after repeated failed logins', async () => {
    const h = { 'X-Forwarded-For': '10.9.9.9' };
    let last;
    for (let i = 0; i < 5; i++) last = await call('POST', '/login', { headers: h, form: { username: 'admin', password: 'wrong' } });
    assert.match(last.headers.get('location'), /error=locked/);
    const evenRight = await call('POST', '/login', { headers: h, form: { username: 'admin', password: 'admin-pass' } });
    assert.match(evenRight.headers.get('location'), /error=locked/);
  });

  test('dashboard and checkout assets are served', async () => {
    const d = await call('GET', '/dashboard', { headers: ADMIN });
    assert.equal(d.status, 200);
    assert.match(d.data, /Mock Gateway/);
    assert.equal((await call('GET', '/assets/checkout.js')).status, 200);
    assert.equal((await call('GET', '/health')).data.status, 'ok');
  });
});

describe('razorpay', () => {
  const auth = { Authorization: basic(config.razorpay.keyId, config.razorpay.keySecret) };

  test('auth failure matches Razorpay shape', async () => {
    const r = await call('POST', '/razorpay/v1/orders', { headers: { Authorization: basic('x', 'y') }, json: { amount: 100 } });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'BAD_REQUEST_ERROR');
  });

  test('validates amount', async () => {
    const r = await call('POST', '/razorpay/v1/orders', { headers: auth, json: { amount: 50 } });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.field, 'amount');
  });

  test('order -> card payment -> signature -> webhooks -> refund', async () => {
    const order = (await call('POST', '/razorpay/v1/orders', { headers: auth, json: { amount: 49900, currency: 'INR', receipt: 'rcpt_1', notes: { user: 'u1' } } })).data;
    assert.match(order.id, /^order_/);
    const page = await call('GET', `/checkout/razorpay/${order.id}?key=${config.razorpay.keyId}&embedded=1`);
    assert.equal(page.status, 200);
    assert.match(page.data, /__CHECKOUT__/);

    const r = (await complete('razorpay', order.id, { ...VISA, query: { embedded: '1' } })).data;
    assert.equal(r.status, 'success');
    const resp = r.next.payload.response;
    assert.equal(resp.razorpay_order_id, order.id);
    assert.equal(resp.razorpay_signature, hmac('sha256', config.razorpay.keySecret, `${order.id}|${resp.razorpay_payment_id}`));

    const o2 = (await call('GET', `/razorpay/v1/orders/${order.id}`, { headers: auth })).data;
    assert.equal(o2.status, 'paid');
    const pay = (await call('GET', `/razorpay/v1/payments/${resp.razorpay_payment_id}`, { headers: auth })).data;
    assert.equal(pay.status, 'captured');
    assert.equal(pay.card.last4, '1111');

    const paidHook = await waitFor(() => received.find((w) => w.path === '/razorpay' && JSON.parse(w.body).event === 'order.paid' && JSON.parse(w.body).payload.order.entity.id === order.id));
    assert.equal(paidHook.headers['x-razorpay-signature'], hmac('sha256', config.razorpay.webhookSecret, paidHook.body));

    const refund = await call('POST', `/razorpay/v1/payments/${pay.id}/refund`, { headers: auth, json: { amount: 10000 } });
    assert.equal(refund.status, 200);
    assert.equal(refund.data.status, 'processed');
    const tooMuch = await call('POST', `/razorpay/v1/payments/${pay.id}/refund`, { headers: auth, json: { amount: 99999 } });
    assert.equal(tooMuch.status, 400);
  });

  test('3DS card needs OTP; 3 wrong OTPs fail with payment.failed', async () => {
    const order = (await call('POST', '/razorpay/v1/orders', { headers: auth, json: { amount: 1000 } })).data;
    const card = { method: 'card', card: { number: '4000000000003220', expiry: '12/40', cvc: '123' }, query: { embedded: '1' } };
    assert.equal((await complete('razorpay', order.id, card)).data.status, 'otp_required');
    const first = (await complete('razorpay', order.id, { ...card, otp: '000000' })).data;
    assert.equal(first.status, 'otp_invalid');
    assert.equal(first.attempts_left, 2);
    assert.equal((await complete('razorpay', order.id, { ...card, otp: '111111' })).data.attempts_left, 1);
    const bad = (await complete('razorpay', order.id, { ...card, otp: '222222' })).data;
    assert.equal(bad.status, 'failed');
    assert.equal(bad.next.payload.event, 'payment.failed');
    assert.equal(bad.retryable, true);
    const good = (await complete('razorpay', order.id, { ...card, otp: '123456' })).data;
    assert.equal(good.status, 'success');
  });

  test('declined card + netbanking + upi', async () => {
    const o1 = (await call('POST', '/razorpay/v1/orders', { headers: auth, json: { amount: 1000 } })).data;
    const d = (await complete('razorpay', o1.id, { method: 'card', card: { number: '4000000000000002', expiry: '12/40', cvc: '1' } })).data;
    assert.equal(d.status, 'failed');
    assert.equal(d.next.payload.response.error.reason, 'card_declined');
    const nb = (await complete('razorpay', o1.id, { method: 'netbanking', bank: 'HDFC', bank_outcome: 'success' })).data;
    assert.equal(nb.status, 'success');
    const o2 = (await call('POST', '/razorpay/v1/orders', { headers: auth, json: { amount: 1000 } })).data;
    assert.equal((await complete('razorpay', o2.id, { method: 'upi', vpa: 'failure@upi' })).data.status, 'failed');
    assert.equal((await complete('razorpay', o2.id, { method: 'upi', vpa: 'success@upi' })).data.status, 'success');
  });

  test('redirect mode posts to callback_url', async () => {
    const o = (await call('POST', '/razorpay/v1/orders', { headers: auth, json: { amount: 1000 } })).data;
    const r = (await complete('razorpay', o.id, { ...VISA, query: { callback_url: 'https://app.example/cb' } })).data;
    assert.equal(r.next.type, 'redirect');
    assert.equal(r.next.method, 'POST');
    assert.equal(r.next.fields.razorpay_order_id, o.id);
  });

  test('payment link', async () => {
    const l = (await call('POST', '/razorpay/v1/payment_links', { headers: auth, json: { amount: 5000, reference_id: 'ref-1', callback_url: 'https://app.example/pl', callback_method: 'get' } })).data;
    assert.match(l.short_url, /\/checkout\/razorpay\/plink_/);
    const r = (await complete('razorpay', l.id, VISA)).data;
    assert.equal(r.next.fields.razorpay_payment_link_status, 'paid');
    const sig = hmac('sha256', config.razorpay.keySecret, `${l.id}|ref-1|paid|${r.next.fields.razorpay_payment_id}`);
    assert.equal(r.next.fields.razorpay_signature, sig);
  });

  test('checkout.js SDK is served', async () => {
    const s = await call('GET', '/razorpay/v1/checkout.js');
    assert.equal(s.status, 200);
    assert.match(s.data, /window\.Razorpay = Razorpay/);
  });
});

describe('stripe', () => {
  const auth = { Authorization: `Bearer ${config.stripe.secretKey}` };

  function verifyStripe(w) {
    const parts = Object.fromEntries(w.headers['stripe-signature'].split(',').map((p) => p.split('=')));
    assert.equal(parts.v1, hmac('sha256', config.stripe.webhookSecret, `${parts.t}.${w.body}`));
  }

  test('rejects bad key', async () => {
    const r = await call('POST', '/v1/payment_intents', { headers: { Authorization: 'Bearer sk_test_wrong' }, form: { amount: '100', currency: 'usd' } });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.type, 'invalid_request_error');
  });

  test('PaymentIntent confirm with pm_card_visa (form-encoded, root /v1)', async () => {
    const r = await call('POST', '/v1/payment_intents', { headers: auth, form: { amount: '2000', currency: 'usd', confirm: 'true', payment_method: 'pm_card_visa', 'metadata[order_id]': 'o-9' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'succeeded');
    assert.equal(r.data.metadata.order_id, 'o-9');
    const w = await waitFor(() => received.find((x) => x.path === '/stripe' && JSON.parse(x.body).type === 'payment_intent.succeeded' && JSON.parse(x.body).data.object.id === r.data.id));
    verifyStripe(w);
    const re = await call('POST', '/stripe/v1/refunds', { headers: auth, form: { payment_intent: r.data.id, amount: '500' } });
    assert.equal(re.data.status, 'succeeded');
    const ch = await call('GET', `/v1/charges/${r.data.latest_charge}`, { headers: auth });
    assert.equal(ch.data.amount_refunded, 500);
  });

  test('declines return 402 card_error', async () => {
    const r = await call('POST', '/v1/payment_intents', { headers: auth, form: { amount: '2000', currency: 'usd', confirm: 'true', payment_method: 'pm_card_chargeDeclinedInsufficientFunds' } });
    assert.equal(r.status, 402);
    assert.equal(r.data.error.decline_code, 'insufficient_funds');
    assert.equal(r.data.error.payment_intent.status, 'requires_payment_method');
  });

  test('3DS requires_action -> hosted authentication -> return_url', async () => {
    const r = await call('POST', '/v1/payment_intents', { headers: auth, form: { amount: '2000', currency: 'eur', confirm: 'true', payment_method: 'pm_card_threeDSecure2Required', return_url: 'https://app.example/return' } });
    assert.equal(r.data.status, 'requires_action');
    assert.match(r.data.next_action.redirect_to_url.url, /stage=authenticate/);
    const done = (await complete('stripe', r.data.id, { authenticate: true, otp: '123456' })).data;
    assert.equal(done.next.fields.redirect_status, 'succeeded');
    assert.equal((await call('GET', `/v1/payment_intents/${r.data.id}`, { headers: auth })).data.status, 'succeeded');
  });

  test('idempotency key replays response', async () => {
    const h = { ...auth, 'Idempotency-Key': 'idem-1' };
    const a = await call('POST', '/v1/customers', { headers: h, form: { email: 'a@b.co' } });
    const b = await call('POST', '/v1/customers', { headers: h, form: { email: 'a@b.co' } });
    assert.equal(a.data.id, b.data.id);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
  });

  test('Checkout Session -> hosted page -> success_url + checkout.session.completed', async () => {
    const s = await call('POST', '/v1/checkout/sessions', {
      headers: auth,
      form: {
        mode: 'payment',
        success_url: 'https://app.example/ok?sid={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://app.example/cancel',
        'line_items[0][price_data][currency]': 'inr',
        'line_items[0][price_data][unit_amount]': '15000',
        'line_items[0][price_data][product_data][name]': 'Fenzy Pro',
        'line_items[0][quantity]': '2',
      },
    });
    assert.equal(s.data.amount_total, 30000);
    assert.match(s.data.url, /\/checkout\/stripe\/cs_test_/);
    const fail = (await complete('stripe', s.data.id, { method: 'card', card: { number: '4000000000000002', expiry: '12/40', cvc: '123' } })).data;
    assert.equal(fail.status, 'failed');
    assert.equal(fail.retryable, true);
    const ok = (await complete('stripe', s.data.id, VISA)).data;
    assert.equal(ok.next.url, `https://app.example/ok?sid=${s.data.id}`);
    const got = (await call('GET', `/v1/checkout/sessions/${s.data.id}?expand[]=payment_intent`, { headers: auth })).data;
    assert.equal(got.payment_status, 'paid');
    assert.equal(got.payment_intent.status, 'succeeded');
    const w = await waitFor(() => received.find((x) => x.path === '/stripe' && JSON.parse(x.body).type === 'checkout.session.completed'));
    verifyStripe(w);
  });
});

describe('cashfree', () => {
  const h = { 'x-client-id': config.cashfree.appId, 'x-client-secret': config.cashfree.secretKey, 'x-api-version': '2023-08-01' };

  test('order -> session checkout -> PAID + signed webhook + refund', async () => {
    const o = await call('POST', '/cashfree/pg/orders', { headers: h, json: { order_id: 'cf_order_1', order_amount: 499.5, order_currency: 'INR', customer_details: { customer_id: 'c1', customer_phone: '9999999999' }, order_meta: { return_url: 'https://app.example/cf?order_id={order_id}' } } });
    assert.equal(o.status, 200);
    assert.equal(o.data.order_status, 'ACTIVE');
    assert.equal((await call('POST', '/cashfree/pg/orders', { headers: h, json: { order_id: 'cf_order_1', order_amount: 1, order_currency: 'INR', customer_details: { customer_id: 'c1', customer_phone: '9' } } })).status, 409);
    assert.equal((await call('GET', `/checkout/cashfree/${o.data.payment_session_id}`)).status, 200);
    const r = (await complete('cashfree', o.data.payment_session_id, { method: 'upi', vpa: 'success@upi' })).data;
    assert.equal(r.status, 'success');
    assert.equal(r.next.url, 'https://app.example/cf?order_id=cf_order_1');
    assert.equal((await call('GET', '/cashfree/pg/orders/cf_order_1', { headers: h })).data.order_status, 'PAID');
    const pays = (await call('GET', '/cashfree/pg/orders/cf_order_1/payments', { headers: h })).data;
    assert.equal(pays[0].payment_status, 'SUCCESS');
    assert.equal(pays[0].payment_group, 'upi');
    const w = await waitFor(() => received.find((x) => x.path === '/cashfree' && JSON.parse(x.body).type === 'PAYMENT_SUCCESS_WEBHOOK'));
    assert.equal(w.headers['x-webhook-signature'], hmac('sha256', config.cashfree.secretKey, w.headers['x-webhook-timestamp'] + w.body, 'base64'));
    const rf = await call('POST', '/cashfree/pg/orders/cf_order_1/refunds', { headers: h, json: { refund_amount: 100, refund_id: 'rf1' } });
    assert.equal(rf.data.refund_status, 'SUCCESS');
  });

  test('auth and version headers enforced', async () => {
    assert.equal((await call('GET', '/cashfree/pg/orders/x', { headers: { ...h, 'x-client-secret': 'bad' } })).status, 401);
    assert.equal((await call('GET', '/cashfree/pg/orders/x', { headers: { ...h, 'x-api-version': '' } })).status, 400);
  });
});

describe('phonepe', () => {
  const salt = config.phonepe.saltKey;
  const idx = config.phonepe.saltIndex;

  test('v1 pay with X-VERIFY -> checkout -> S2S callback + status', async () => {
    const payload = { merchantId: config.phonepe.merchantId, merchantTransactionId: 'MT1001', merchantUserId: 'U1', amount: 10000, redirectUrl: 'https://app.example/pp', redirectMode: 'POST', callbackUrl: `${HOOK}/phonepe1`, paymentInstrument: { type: 'PAY_PAGE' } };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const bad = await call('POST', '/phonepe/pg/v1/pay', { headers: { 'X-VERIFY': 'nope###1' }, json: { request: b64 } });
    assert.equal(bad.status, 400);
    const r = await call('POST', '/phonepe/pg/v1/pay', { headers: { 'X-VERIFY': `${sha256(b64 + '/pg/v1/pay' + salt)}###${idx}` }, json: { request: b64 } });
    assert.equal(r.data.code, 'PAYMENT_INITIATED');
    const url = new URL(r.data.data.instrumentResponse.redirectInfo.url);
    assert.equal((await call('GET', url.pathname)).status, 200);
    const c = (await complete('phonepe', 'MT1001', { method: 'card', card: { number: '4111111111111111', expiry: '12/40', cvc: '1' } })).data;
    assert.equal(c.next.method, 'POST');
    assert.equal(c.next.fields.code, 'PAYMENT_SUCCESS');
    const cb = await waitFor(() => received.find((x) => x.path === '/phonepe1'));
    const resp = JSON.parse(cb.body).response;
    assert.equal(cb.headers['x-verify'], `${sha256(resp + salt)}###${idx}`);
    assert.equal(JSON.parse(Buffer.from(resp, 'base64')).data.state, 'COMPLETED');
    const statusPath = `/pg/v1/status/${config.phonepe.merchantId}/MT1001`;
    const st = await call('GET', '/phonepe' + statusPath, { headers: { 'X-VERIFY': `${sha256(statusPath + salt)}###${idx}`, 'X-MERCHANT-ID': config.phonepe.merchantId } });
    assert.equal(st.data.code, 'PAYMENT_SUCCESS');
  });

  test('v2 oauth -> pay -> status -> webhook', async () => {
    const tok = await call('POST', '/phonepe/v1/oauth/token', { form: { client_id: config.phonepe.clientId, client_secret: config.phonepe.clientSecret, client_version: config.phonepe.clientVersion, grant_type: 'client_credentials' } });
    assert.equal(tok.data.token_type, 'O-Bearer');
    const h = { Authorization: `O-Bearer ${tok.data.access_token}` };
    assert.equal((await call('POST', '/phonepe/checkout/v2/pay', { headers: { Authorization: 'O-Bearer bad' }, json: {} })).status, 401);
    const p = await call('POST', '/phonepe/checkout/v2/pay', { headers: h, json: { merchantOrderId: 'MO-1', amount: 5000, paymentFlow: { type: 'PG_CHECKOUT', merchantUrls: { redirectUrl: 'https://app.example/pp2' } } } });
    assert.equal(p.data.state, 'PENDING');
    const r = (await complete('phonepe2', 'MO-1', { method: 'netbanking', bank: 'SBIN', bank_outcome: 'failed' })).data;
    assert.equal(r.status, 'failed');
    const st = await call('GET', '/phonepe/apis/pg/checkout/v2/order/MO-1/status', { headers: h });
    assert.equal(st.data.state, 'FAILED');
    const w = await waitFor(() => received.find((x) => x.path === '/phonepe2'));
    assert.equal(w.headers.authorization, sha256(`${config.phonepe.webhookUsername}:${config.phonepe.webhookPassword}`));
    assert.equal(JSON.parse(w.body).event, 'checkout.order.failed');
  });

  test('v2 order status and refund follow the published response shapes', async () => {
    const tok = await call('POST', '/phonepe/v1/oauth/token', { form: { client_id: config.phonepe.clientId, client_secret: config.phonepe.clientSecret, client_version: config.phonepe.clientVersion, grant_type: 'client_credentials' } });
    const h = { Authorization: `O-Bearer ${tok.data.access_token}` };
    const pay = (id, amount) => call('POST', '/phonepe/checkout/v2/pay', { headers: h, json: { merchantOrderId: id, amount, paymentFlow: { type: 'PG_CHECKOUT', merchantUrls: { redirectUrl: 'https://app.example/pp2' } } } });
    const status = (id, q = '') => call('GET', `/phonepe/checkout/v2/order/${id}/status${q}`, { headers: h });

    const missing = await status('NO-SUCH-ORDER');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.data, { code: 'INVALID_MERCHANT_ORDER_ID', message: 'No entry found for given merchant order id' });

    await pay('MO-SHAPE', 20000);
    const pending = (await status('MO-SHAPE')).data;
    assert.deepEqual(pending.paymentDetails, []);
    assert.deepEqual(Object.keys(pending.metaInfo), Array.from({ length: 15 }, (_, i) => `udf${i + 1}`));

    await complete('phonepe2', 'MO-SHAPE', { method: 'upi', vpa: 'success@upi' });
    const done = (await status('MO-SHAPE')).data;
    assert.equal(done.state, 'COMPLETED');
    assert.equal(done.payableAmount, 20000);
    assert.equal(done.feeAmount, 0);
    assert.equal(done.paymentDetails[0].payableAmount, 20000);

    const refund = (id, amount) => call('POST', '/phonepe/payments/v2/refund', { headers: h, json: { merchantRefundId: id, originalMerchantOrderId: 'MO-SHAPE', amount } });
    assert.equal((await refund('RF-LOW', 99)).status, 400, 'PhonePe documents a 100 paise minimum');
    assert.equal((await refund('RF-HIGH', 20001)).status, 400);
    const ok = await refund('RF-OK', 5000);
    assert.equal(ok.data.state, 'PENDING');
    assert.equal(ok.data.amount, 5000);
    await new Promise((r) => setTimeout(r, 1800));
    const rs = (await call('GET', '/phonepe/payments/v2/refund/RF-OK/status', { headers: h })).data;
    assert.equal(rs.state, 'COMPLETED');
    assert.equal(rs.originalMerchantOrderId, 'MO-SHAPE');
    assert.equal(rs.splitInstruments[0].amount, 5000);

    await pay('MO-FAIL', 10000);
    await complete('phonepe2', 'MO-FAIL', { method: 'upi', vpa: 'failure@upi' });
    const failed = (await status('MO-FAIL', '?errorContext=true')).data;
    assert.equal(failed.state, 'FAILED');
    assert.ok(failed.errorCode && failed.detailedErrorCode);
    assert.deepEqual(Object.keys(failed.errorContext), ['errorCode', 'detailedErrorCode', 'source', 'stage', 'description']);
    assert.equal((await status('MO-FAIL')).data.errorContext, undefined, 'errorContext only when asked for');
  });
});

describe('upipay SDK (real package against the mock)', () => {
  let uninstall;
  let toMock;
  let UPIPay;

  before(async () => {
    const shim = await import('../scripts/upipay-shim.mjs');
    ({ UPIPay } = await import('upipay'));
    toMock = shim.toMock;
    uninstall = shim.installUpipayShim(BASE);
  });
  after(() => uninstall?.());

  const paytmClient = () => new UPIPay({ provider: 'paytm', environment: 'sandbox', credentials: { merchantId: config.paytm.merchantId, merchantKey: config.paytm.merchantKey } });

  test('paytm: create -> hosted checkout -> callback checksum -> status -> refund', async () => {
    const client = paytmClient();
    const pay = await client.createPayment({ amount: 12345, orderId: 'pay_paytm_1', customerPhone: '9876543210', callbackUrl: 'https://app.example/paytm-cb', redirectUrl: 'https://app.example/done' });
    assert.equal(pay.success, true);

    const page = new URL(toMock(pay.paymentUrl));
    const hop = await call('GET', page.pathname + page.search);
    assert.equal(hop.status, 302);
    assert.match(hop.headers.get('location'), /\/checkout\/paytm\/pay_paytm_1$/);
    assert.equal((await call('GET', '/checkout/paytm/pay_paytm_1')).status, 200);
    assert.equal((await call('GET', `/paytm/theia/api/v1/showPaymentPage?mid=${config.paytm.merchantId}&orderId=pay_paytm_1&txnToken=wrong`)).status, 400);

    const done = (await complete('paytm', 'pay_paytm_1', { method: 'upi', vpa: 'success@upi' })).data;
    assert.equal(done.status, 'success');
    assert.equal(done.next.method, 'POST');
    assert.equal(done.next.url, 'https://app.example/paytm-cb');

    // The browser callback is verified by the SDK exactly as an app would.
    const raw = new URLSearchParams(done.next.fields).toString();
    const event = client.verifyWebhook(raw, done.next.fields.CHECKSUMHASH, { expectedAmount: 12345 });
    assert.equal(event.verified, true);
    assert.equal(event.status, 'SUCCESS');
    assert.equal(event.orderId, 'pay_paytm_1');
    const tampered = client.verifyWebhook(raw.replace('TXNAMOUNT=123.45', 'TXNAMOUNT=1.00'), done.next.fields.CHECKSUMHASH, { expectedAmount: 12345 });
    assert.equal(tampered.verified, false);

    // Server-to-server webhook carries the same signed fields as a form post.
    const hookCall = await waitFor(() => received.find((x) => x.path === '/paytm'));
    const form = Object.fromEntries(new URLSearchParams(hookCall.body));
    assert.equal(client.verifyWebhook(hookCall.body, form.CHECKSUMHASH, { expectedAmount: 12345 }).verified, true);

    const status = await client.checkStatus('pay_paytm_1', { expectedAmount: 12345, maxRetries: 1 });
    assert.equal(status.status, 'SUCCESS');
    assert.equal(status.amount, 12345);

    const refund = await client.createRefund({ originalOrderId: 'pay_paytm_1', refundId: 'refund_paytm_1', amount: 5000, providerTransactionId: status.transactionId });
    assert.equal(refund.refundId, 'refund_paytm_1');
    assert.ok(['PENDING', 'SUCCESS'].includes(refund.status));
    const tooMuch = await client.createRefund({ originalOrderId: 'pay_paytm_1', refundId: 'refund_paytm_2', amount: 999999, providerTransactionId: status.transactionId });
    assert.equal(tooMuch.status, 'FAILED');
  });

  test('paytm: failed payment and wrong merchant key', async () => {
    const client = paytmClient();
    await client.createPayment({ amount: 5000, orderId: 'pay_paytm_2', customerPhone: '9876543210', callbackUrl: 'https://app.example/paytm-cb', redirectUrl: 'https://app.example/done' });
    const done = (await complete('paytm', 'pay_paytm_2', { method: 'netbanking', bank: 'SBIN', bank_outcome: 'failed' })).data;
    assert.equal(done.status, 'failed');
    assert.equal(done.next.fields.STATUS, 'TXN_FAILURE');
    const status = await client.checkStatus('pay_paytm_2', { maxRetries: 1 });
    assert.equal(status.status, 'FAILED');

    const wrong = new UPIPay({ provider: 'paytm', environment: 'sandbox', credentials: { merchantId: config.paytm.merchantId, merchantKey: 'wrongwrongwrong16' } });
    const rejected = await wrong.createPayment({ amount: 5000, orderId: 'pay_paytm_3', customerPhone: '9876543210', callbackUrl: 'https://app.example/paytm-cb', redirectUrl: 'https://app.example/done' }).catch((e) => e);
    assert.ok(rejected instanceof Error || rejected.success === false, 'a bad checksum must not create a payment');
    const noOrder = await call('GET', '/checkout/paytm/pay_paytm_3');
    assert.equal(noOrder.status, 404);
  });

  test('phonepe v1: create -> checkout -> signed webhook -> status', async () => {
    const client = new UPIPay({ provider: 'phonepe', environment: 'sandbox', credentials: { merchantId: config.phonepe.merchantId, saltKey: config.phonepe.saltKey, saltIndex: config.phonepe.saltIndex } });
    const pay = await client.createPayment({ amount: 20000, orderId: 'pay_phonepe_1', customerPhone: '9876543210', callbackUrl: `${HOOK}/phonepe-upipay`, redirectUrl: 'https://app.example/done' });
    assert.equal(pay.success, true);
    assert.match(pay.paymentUrl, /\/checkout\/phonepe\/pay_phonepe_1$/);
    await complete('phonepe', 'pay_phonepe_1', { method: 'upi', vpa: 'success@upi' });
    const cb = await waitFor(() => received.find((x) => x.path === '/phonepe-upipay'));
    const event = client.verifyWebhook(cb.body, cb.headers['x-verify'], { expectedAmount: 20000 });
    assert.equal(event.verified, true);
    assert.equal(event.status, 'SUCCESS');
    const status = await client.checkStatus('pay_phonepe_1', { expectedAmount: 20000, maxRetries: 1 });
    assert.equal(status.status, 'SUCCESS');
  });
});

describe('failure injection and Paytm lifecycle', () => {
  const setSetting = (patch) => call('PUT', '/api/settings', { headers: ADMIN, json: patch });
  const newPaytmOrder = async (client, orderId, amount = 10000) => {
    const pay = await client.createPayment({ amount, orderId, customerPhone: '9876543210', callbackUrl: 'https://app.example/paytm-cb', redirectUrl: 'https://app.example/done' });
    assert.equal(pay.success, true);
  };
  let client;
  let uninstall;
  let paytm;

  before(async () => {
    const shim = await import('../scripts/upipay-shim.mjs');
    const { UPIPay } = await import('upipay');
    paytm = await import('../src/payments/paytm.js');
    uninstall = shim.installUpipayShim(BASE);
    client = new UPIPay({ provider: 'paytm', environment: 'sandbox', credentials: { merchantId: config.paytm.merchantId, merchantKey: config.paytm.merchantKey } });
  });
  after(() => uninstall?.());

  test('nextFailure fails exactly one payment, then resets', async () => {
    assert.equal((await setSetting({ 'checkout.nextFailure': 'insufficient_funds' })).status, 200);
    await newPaytmOrder(client, 'inj_1');
    await newPaytmOrder(client, 'inj_2');
    const first = (await complete('paytm', 'inj_1', { method: 'upi', vpa: 'success@upi' })).data;
    assert.equal(first.status, 'failed');
    assert.equal(first.next.fields.RESPCODE, '227', 'a declined UPI payment uses the bank-decline code');
    const second = (await complete('paytm', 'inj_2', { method: 'upi', vpa: 'success@upi' })).data;
    assert.equal(second.status, 'success');
    const rows = (await call('GET', '/api/settings', { headers: ADMIN })).data.data;
    assert.equal(rows.find((r) => r.key === 'checkout.nextFailure').value, '');
  });

  test('webhooks can be delivered twice and held back', async () => {
    await setSetting({ 'webhooks.duplicate': 'twice', 'webhooks.delaySeconds': 1 });
    try {
      await newPaytmOrder(client, 'dup_1');
      const startedAt = Date.now();
      await complete('paytm', 'dup_1', { method: 'upi', vpa: 'success@upi' });
      const bodies = () => received.filter((x) => x.path === '/paytm' && x.body.includes('ORDERID=dup_1'));
      await waitFor(() => bodies().length >= 2, 8000);
      assert.equal(bodies().length, 2);
      assert.ok(Date.now() - startedAt >= 900, 'first delivery waited for the delay');
      assert.equal(bodies()[0].body, bodies()[1].body, 'both deliveries carry the same signed body');
    } finally {
      await setSetting({ 'webhooks.duplicate': null, 'webhooks.delaySeconds': null });
    }
  });

  test('paytm: unpaid orders expire; expired orders reject payment', async () => {
    await newPaytmOrder(client, 'exp_1');
    const { objects } = await import('../src/db.js');
    const o = objects.get('ptm:exp_1', 'order');
    o.createdAt = Date.now() - 16 * 60 * 1000;
    objects.put('paytm', 'order', 'ptm:exp_1', o);
    // Paytm does not fail an abandoned order: status stays PENDING (402) and no callback is sent.
    const status = await client.checkStatus('exp_1', { maxRetries: 1 });
    assert.equal(status.status, 'PENDING');
    const late = (await complete('paytm', 'exp_1', { method: 'upi', vpa: 'success@upi' })).data;
    assert.equal(late.status, 'failed');
    assert.equal(late.error.code, '1006');
    assert.equal(received.some((x) => x.path === '/paytm' && x.body.includes('ORDERID=exp_1')), false, 'no webhook for an expired order');
  });

  test('paytm: refund status endpoint', async () => {
    await newPaytmOrder(client, 'rf_1', 20000);
    await complete('paytm', 'rf_1', { method: 'upi', vpa: 'success@upi' });
    const st = await client.checkStatus('rf_1', { expectedAmount: 20000, maxRetries: 1 });
    await client.createRefund({ originalOrderId: 'rf_1', refundId: 'rf_ref_1', amount: 20000, providerTransactionId: st.transactionId });
    const sign = (body) => ({ body, head: { signature: paytm.generateChecksum(paytm.stableStringify(body)) } });
    const body = { mid: config.paytm.merchantId, orderId: 'rf_1', refId: 'rf_ref_1' };
    const first = (await call('POST', '/paytm/v2/refund/status', { json: sign(body) })).data;
    assert.equal(first.body.resultInfo.resultStatus, 'PENDING');
    await new Promise((r) => setTimeout(r, 1800));
    const later = (await call('POST', '/paytm/v2/refund/status', { json: sign(body) })).data;
    assert.equal(later.body.resultInfo.resultStatus, 'TXN_SUCCESS');
    const unknown = (await call('POST', '/paytm/v2/refund/status', { json: sign({ ...body, refId: 'nope' }) })).data;
    assert.equal(unknown.body.resultInfo.resultStatus, 'TXN_FAILURE');
    assert.equal(unknown.body.resultInfo.resultCode, '631');
    assert.equal(later.body.resultInfo.resultCode, '10');
  });

  test('paytm: signed the way Paytm\'s own library does, with the documented paths and codes', async () => {
    const mid = config.paytm.merchantId;
    // paytmchecksum signs JSON.stringify(body) exactly as sent, so key order is the caller's.
    const post = (path, body, { sign = true } = {}) => {
      const signature = sign ? paytm.generateChecksum(JSON.stringify(body)) : 'not-a-checksum';
      return call('POST', path, { json: { body, head: { signature } } }).then((r) => r.data.body);
    };
    const init = (over = {}) => ({ requestType: 'Payment', mid, websiteName: 'WEBSTAGING', orderId: 'off_1', callbackUrl: 'https://app.example/cb', txnAmount: { value: '12.50', currency: 'INR' }, userInfo: { custId: 'CUST_1' }, ...over });

    const first = await post(`/paytm/theia/api/v1/initiateTransaction?mid=${mid}&orderId=off_1`, init());
    assert.equal(first.resultInfo.resultCode, '0000');
    assert.equal(first.isPromoCodeValid, false);
    const again = await post(`/paytm/theia/api/v1/initiateTransaction?mid=${mid}&orderId=off_1`, init());
    assert.equal(again.resultInfo.resultCode, '0002', 'same request is idempotent');
    assert.equal(again.txnToken, first.txnToken);
    const changed = await post(`/paytm/theia/api/v1/initiateTransaction?mid=${mid}&orderId=off_1`, init({ txnAmount: { value: '99.00', currency: 'INR' } }));
    assert.equal(changed.resultInfo.resultCode, '2023');
    assert.equal((await post(`/paytm/theia/api/v1/initiateTransaction?mid=${mid}&orderId=off_1`, init(), { sign: false })).resultInfo.resultCode, '2005');
    assert.equal((await post(`/paytm/theia/api/v1/initiateTransaction?mid=${mid}&orderId=other`, init())).resultInfo.resultCode, '2014');
    assert.equal((await post(`/paytm/theia/api/v1/initiateTransaction?mid=${mid}&orderId=off_2`, init({ orderId: 'off_2', txnAmount: { value: '0.50', currency: 'INR' } }))).resultInfo.resultCode, '2007');

    const status = (orderId) => post('/paytm/v3/order/status', { mid, orderId });
    assert.deepEqual((await status('off_1')).resultInfo, { resultStatus: 'PENDING', resultCode: '400', resultMsg: 'Transaction status not confirmed yet.' });
    assert.equal((await status('nope_1')).resultInfo.resultStatus, 'NO_RECORD_FOUND');
    assert.equal((await status('nope_1')).resultInfo.resultCode, '331');

    const refund = (over) => post('/paytm/refund/apply', { mid, txnType: 'REFUND', orderId: 'off_1', txnId: 'x', refId: 'off_r1', refundAmount: '5.00', ...over });
    assert.equal((await refund({})).resultInfo.resultCode, '627', 'wrong txnId');
    assert.equal((await refund({ orderId: 'nope_1' })).resultInfo.resultCode, '673');
    assert.equal((await refund({ refundAmount: '' })).resultInfo.resultCode, '660');

    await complete('paytm', 'off_1', { method: 'wallet', wallet: 'paytm' });
    const paid = await status('off_1');
    assert.equal(paid.resultInfo.resultCode, '01');
    const ok = await refund({ txnId: paid.txnId });
    assert.equal(ok.resultInfo.resultCode, '601');
    assert.equal((await refund({ txnId: paid.txnId })).resultInfo.resultCode, '617', 'repeat refId while pending');
    assert.equal((await refund({ txnId: paid.txnId, refId: 'off_r2', refundAmount: '500.00' })).resultInfo.resultCode, '674');
    assert.equal((await refund({ txnId: paid.txnId, refId: 'off_r3', refundAmount: '0.50' })).resultInfo.resultCode, '635');
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal((await refund({ txnId: paid.txnId })).resultInfo.resultCode, '629', 'repeat refId after it succeeded');
  });

  test('paytm: wallet shortfall and invalid UPI id use their own codes', async () => {
    await newPaytmOrder(client, 'code_1');
    await newPaytmOrder(client, 'code_2');
    await setSetting({ 'checkout.nextFailure': 'insufficient_funds' });
    assert.equal((await complete('paytm', 'code_1', { method: 'wallet', wallet: 'paytm' })).data.next.fields.RESPCODE, '235');
    const badVpa = (await complete('paytm', 'code_2', { method: 'upi', vpa: 'not a vpa' })).data;
    assert.equal(badVpa.next.fields.RESPCODE, '295');
    assert.equal(badVpa.next.fields.STATUS, 'TXN_FAILURE');
  });

  test('paytm: upipay replay protection accepts fresh and rejects stale callbacks', async () => {
    const fields = (txnDate) => {
      const f = { CURRENCY: 'INR', GATEWAYNAME: '', RESPMSG: 'Txn Success', BANKNAME: '', PAYMENTMODE: 'UPI', MID: config.paytm.merchantId, RESPCODE: '01', TXNID: '1', TXNAMOUNT: '10.00', ORDERID: 'replay_1', STATUS: 'TXN_SUCCESS', BANKTXNID: '2', TXNDATE: txnDate };
      f.CHECKSUMHASH = paytm.generateChecksum(paytm.paramsString(f));
      return new URLSearchParams(f).toString();
    };
    const stamp = (ms) => new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') + '.0';
    const opts = { enableReplayProtection: true, expectedAmount: 1000 };
    const fresh = fields(stamp(Date.now()));
    assert.equal(client.verifyWebhook(fresh, new URLSearchParams(fresh).get('CHECKSUMHASH'), opts).verified, true);
    const stale = fields(stamp(Date.now() - 3600 * 1000));
    assert.equal(client.verifyWebhook(stale, new URLSearchParams(stale).get('CHECKSUMHASH'), opts).verified, false);
  });

  test('phonepe v1: refund through upipay', async () => {
    const { UPIPay } = await import('upipay');
    const pp = new UPIPay({ provider: 'phonepe', environment: 'sandbox', credentials: { merchantId: config.phonepe.merchantId, saltKey: config.phonepe.saltKey, saltIndex: config.phonepe.saltIndex } });
    await pp.createPayment({ amount: 30000, orderId: 'pay_phonepe_rf', customerPhone: '9876543210', callbackUrl: HOOK + '/phonepe-upipay-rf', redirectUrl: 'https://app.example/done' });
    await complete('phonepe', 'pay_phonepe_rf', { method: 'upi', vpa: 'success@upi' });
    const refund = await pp.createRefund({ originalOrderId: 'pay_phonepe_rf', refundId: 'refund_pp_1', amount: 10000, providerTransactionId: 'unused' });
    assert.equal(refund.refundId, 'refund_pp_1');
    assert.equal(refund.amount, 10000);
    assert.ok(['SUCCESS', 'PENDING'].includes(refund.status), 'got ' + refund.status);
  });
});

describe('generic payments', () => {
  const h = { Authorization: `Bearer ${config.generic.apiKey}` };
  test('create -> pay -> signed return + webhook', async () => {
    const p = await call('POST', '/generic/payments', { headers: h, json: { amount: 1999, currency: 'INR', order_id: 'g-1', return_url: 'https://app.example/g' } });
    assert.equal(p.status, 201);
    const r = (await complete('generic', p.data.id, { method: 'wallet', wallet: 'paytm', wallet_outcome: 'success' })).data;
    assert.equal(r.next.fields.status, 'succeeded');
    assert.equal(r.next.fields.signature, hmac('sha256', config.generic.apiSecret, `${p.data.id}|succeeded`));
    const w = await waitFor(() => received.find((x) => x.path === '/generic' && JSON.parse(x.body).type === 'payment.succeeded'));
    assert.equal(w.headers['x-mock-signature'], hmac('sha256', config.generic.webhookSecret, w.body));
    assert.equal((await call('GET', '/generic/payments/g-1', { headers: h })).data.status, 'succeeded');
  });

  test('admin simulate + refund + webhook redelivery', async () => {
    const p = await call('POST', '/generic/payments', { headers: h, json: { amount: 1000, webhook_url: `${HOOK}/fail-generic` } });
    const s = await call('POST', `/api/payments/${p.data.id}/simulate`, { headers: ADMIN, json: { outcome: 'success', method: 'upi' } });
    assert.equal(s.data.status, 'success');
    const rf = await call('POST', `/api/payments/${p.data.id}/refund`, { headers: ADMIN, json: {} });
    assert.equal(rf.status, 200);
    const detail = (await call('GET', `/api/payments/${p.data.id}`, { headers: ADMIN })).data;
    assert.equal(detail.status, 'refunded');
    await waitFor(() => received.find((x) => x.path === '/fail-generic'));
    const list = (await call('GET', `/api/webhooks?ref=${p.data.id}`, { headers: ADMIN })).data.data;
    assert.ok(list.length >= 2);
  });
});

describe('sms', () => {
  test('twilio message + status callback + inbox OTP lookup', async () => {
    const sid = config.twilio.accountSid;
    const auth = { Authorization: basic(sid, config.twilio.authToken) };
    const r = await call('POST', `/twilio/2010-04-01/Accounts/${sid}/Messages.json`, { headers: auth, form: { To: '+919876543210', From: '+15005550006', Body: 'Your Fenzy OTP is 482913', StatusCallback: `${HOOK}/twilio-status` } });
    assert.equal(r.status, 201);
    assert.match(r.data.sid, /^SM[0-9a-f]{32}$/);
    const latest = (await call('GET', '/api/sms/latest?to=9876543210', { headers: ADMIN })).data;
    assert.equal(latest.otp, '482913');
    const cb = await waitFor(() => received.find((x) => x.path === '/twilio-status' && x.body.includes('MessageStatus=delivered')));
    const params = Object.fromEntries(new URLSearchParams(cb.body));
    const data = `${HOOK}/twilio-status` + Object.keys(params).sort().map((k) => k + params[k]).join('');
    assert.equal(cb.headers['x-twilio-signature'], hmac('sha1', config.twilio.authToken, data, 'base64'));
    const magic = await call('POST', `/twilio/2010-04-01/Accounts/${sid}/Messages.json`, { headers: auth, form: { To: '+15005550001', From: '+15005550006', Body: 'x' } });
    assert.equal(magic.data.code, 21211);
  });

  test('twilio verify send + check', async () => {
    const auth = { Authorization: basic(config.twilio.accountSid, config.twilio.authToken) };
    const svc = 'VA' + 'a'.repeat(32);
    const v = await call('POST', `/twilio/v2/Services/${svc}/Verifications`, { headers: auth, form: { To: '+14155550100', Channel: 'sms' } });
    assert.equal(v.data.status, 'pending');
    const code = (await call('GET', '/api/sms/latest?to=4155550100', { headers: ADMIN })).data.otp;
    const wrong = await call('POST', `/twilio/v2/Services/${svc}/VerificationCheck`, { headers: auth, form: { To: '+14155550100', Code: '000000' } });
    assert.equal(wrong.data.status, 'pending');
    const ok = await call('POST', `/twilio/v2/Services/${svc}/VerificationCheck`, { headers: auth, form: { To: '+14155550100', Code: code } });
    assert.equal(ok.data.status, 'approved');
    assert.equal(ok.data.valid, true);
  });

  test('msg91 otp send/verify + flow', async () => {
    const h = { authkey: config.msg91.authKey };
    const s = await call('POST', '/msg91/api/v5/otp?mobile=919812345678&otp_length=6', { headers: h });
    assert.equal(s.data.type, 'success');
    const code = (await call('GET', '/api/sms/latest?to=9812345678', { headers: ADMIN })).data.otp;
    assert.equal((await call('GET', `/msg91/api/v5/otp/verify?mobile=919812345678&otp=1`, { headers: h })).data.message, 'OTP not match');
    assert.equal((await call('GET', `/msg91/api/v5/otp/verify?mobile=919812345678&otp=${code}`, { headers: h })).data.message, 'OTP verified success');
    const f = await call('POST', '/msg91/api/v5/flow', { headers: h, json: { template_id: 't1', recipients: [{ mobiles: '919800000001', otp: '7788' }] } });
    assert.equal(f.data.type, 'success');
    assert.equal((await call('GET', '/api/sms/latest?to=9800000001', { headers: ADMIN })).data.otp, '7788');
    assert.equal((await call('POST', '/msg91/api/v5/flow', { headers: { authkey: 'bad' }, json: {} })).status, 401);
  });

  test('generic otp', async () => {
    const h = { Authorization: `Bearer ${config.generic.apiKey}` };
    await call('POST', '/generic/otp/send', { headers: h, json: { to: 'user@fenzy.test' } });
    const mail = (await call('GET', '/api/emails/latest?to=user@fenzy.test', { headers: ADMIN })).data;
    const v = await call('POST', '/generic/otp/verify', { headers: h, json: { to: 'user@fenzy.test', code: mail.otp } });
    assert.equal(v.data.verified, true);
  });
});

describe('email', () => {
  test('SMTP capture with attachment and bcc', async () => {
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.server.address().port, secure: false, ignoreTLS: true, auth: { user: 'any', pass: 'any' } });
    await t.sendMail({ from: 'Fenzy <no-reply@fenzy.test>', to: 'alice@fenzy.test', bcc: 'audit@fenzy.test', subject: 'Verify your email', html: '<p>Your code is <b>551234</b>. <a href="https://fenzy.test/verify?t=abc">Verify</a></p>', attachments: [{ filename: 'a.txt', content: 'hello' }] });
    const e = (await call('GET', '/api/emails/latest?to=alice@fenzy.test', { headers: ADMIN })).data;
    assert.equal(e.otp, '551234');
    assert.ok(e.links.includes('https://fenzy.test/verify?t=abc'));
    assert.equal(e.attachments[0].filename, 'a.txt');
    assert.equal(e.bcc[0].address, 'audit@fenzy.test');
    const att = await call('GET', `/api/emails/${e.id}/attachments/${e.attachments[0].id}`, { headers: ADMIN });
    assert.equal(att.data, 'hello');
  });

  test('SendGrid / Resend / SES v2', async () => {
    const sg = await call('POST', '/sendgrid/v3/mail/send', { headers: { Authorization: `Bearer ${config.sendgrid.apiKey}` }, json: { personalizations: [{ to: [{ email: 'sg@fenzy.test' }] }], from: { email: 'x@fenzy.test' }, subject: 'Hi', content: [{ type: 'text/html', value: '<p>OTP 112233</p>' }] } });
    assert.equal(sg.status, 202);
    assert.ok(sg.headers.get('x-message-id'));
    assert.equal((await call('POST', '/v3/mail/send', { headers: { Authorization: 'Bearer bad' }, json: {} })).status, 401);
    const rs = await call('POST', '/resend/emails', { headers: { Authorization: `Bearer ${config.resend.apiKey}` }, json: { from: 'x@fenzy.test', to: 'rs@fenzy.test', subject: 'Hello', html: '<b>hi</b>' } });
    assert.match(rs.data.id, /^[0-9a-f-]{36}$/);
    assert.equal((await call('GET', `/resend/emails/${rs.data.id}`, { headers: { Authorization: `Bearer ${config.resend.apiKey}` } })).data.last_event, 'delivered');
    const ses = await call('POST', '/ses/v2/email/outbound-emails', { json: { FromEmailAddress: 'x@fenzy.test', Destination: { ToAddresses: ['ses@fenzy.test'] }, Content: { Simple: { Subject: { Data: 'S' }, Body: { Text: { Data: 'code 909090' } } } } } });
    assert.ok(ses.data.MessageId);
    for (const to of ['sg@fenzy.test', 'rs@fenzy.test', 'ses@fenzy.test']) {
      assert.equal((await call('GET', `/api/emails/latest?to=${to}`, { headers: ADMIN })).status, 200, to);
    }
  });
});
