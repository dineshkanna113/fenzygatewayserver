import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getSetting, setSettings } from '../settings.js';
import { baseUrl, escapeHtml, inlineJson, log } from '../util.js';
import { implicitOrder } from './razorpay.js';
import { adapters } from './registry.js';
import { BANKS, decide, ERRORS, SUCCESS_OTP, TEST_CARDS, WALLETS } from './simulator.js';

const PUBLIC = path.resolve(import.meta.dirname, '../../public');
const template = fs.readFileSync(path.join(PUBLIC, 'checkout.html'), 'utf8');

const PROVIDER_THEME = {
  razorpay: '#2457e6',
  stripe: '#635bff',
  cashfree: '#6c3ce0',
  phonepe: '#5f259f',
  phonepe2: '#5f259f',
  paytm: '#00b9f5',
  generic: '#0f766e',
};

function cleanQuery(q) {
  const out = {};
  for (const [k, v] of Object.entries(q || {})) if (typeof v === 'string' && v.length <= 2048) out[k] = v;
  return out;
}

function renderPage(res, ctx) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src * data:; form-action *; frame-ancestors *; base-uri 'none'`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(template.replace('<!--CTX-->', `<script nonce="${nonce}">window.__CHECKOUT__ = ${inlineJson(ctx)};</script>`));
}

function renderError(res, status, title, message) {
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Crect x='0' width='2' height='12' fill='%23e8c531'/%3E%3Crect x='2' width='2' height='12' fill='%2335b7c4'/%3E%3Crect x='4' width='2' height='12' fill='%233fa66a'/%3E%3Crect x='6' width='2' height='12' fill='%23c2468f'/%3E%3Crect x='8' width='2' height='12' fill='%23d2453b'/%3E%3Crect x='10' width='2' height='12' fill='%232b4bd9'/%3E%3C/svg%3E"><link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/checkout.css"></head>
<body><div class="app"><div class="ticket narrow"><div class="stage solo"><div class="pane"><span class="testbar"></span><div class="pane-body"><div class="state-screen"><div class="state-icon fail">!</div><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(message)}</p></div></div>
<div class="sheet-foot"><span class="test-pill">Test mode</span> Mock gateway. No real money moves.</div></div></div></div></div></body></html>`);
}

/* ----------------------------- SDK scripts ----------------------------- */

// Shared overlay used by every SDK: full-screen iframe + postMessage bridge. Redirects requested by the
// checkout iframe are performed by the parent page so browsers don't block top-level navigation.
const OVERLAY = `
  function __mockgwRedirect(next) {
    if (!next || !next.url) return;
    if (next.method === 'POST') {
      var f = document.createElement('form');
      f.method = 'POST'; f.action = next.url; f.style.display = 'none';
      Object.keys(next.fields || {}).forEach(function (k) {
        var i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = next.fields[k]; f.appendChild(i);
      });
      document.body.appendChild(f); f.submit();
    } else {
      var u = new URL(next.url, window.location.href);
      Object.keys(next.fields || {}).forEach(function (k) { u.searchParams.set(k, next.fields[k]); });
      window.location.href = u.toString();
    }
  }
  function __mockgwOverlay(url, onMessage) {
    var wrap = document.createElement('div');
    wrap.setAttribute('data-mock-gateway', '');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.62);display:flex;align-items:center;justify-content:center;';
    var frame = document.createElement('iframe');
    frame.src = url;
    frame.allow = 'payment; clipboard-write';
    frame.style.cssText = 'border:0;width:100%;height:100%;background:transparent;';
    wrap.appendChild(frame);
    document.body.appendChild(wrap);
    var prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    function handler(e) {
      if (e.source !== frame.contentWindow || !e.data || !e.data.__mockgw) return;
      if (e.data.event === '__close') return api.close();
      if (e.data.event === '__redirect') { api.close(); return __mockgwRedirect(e.data.next); }
      onMessage(e.data);
    }
    window.addEventListener('message', handler);
    var api = {
      close: function () {
        window.removeEventListener('message', handler);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        document.documentElement.style.overflow = prevOverflow;
      }
    };
    return api;
  }
`;

function razorpaySdk(base) {
  return `/* Mock Razorpay Checkout (window.Razorpay) — served by the mock gateway at ${base} */
(function () {
  var BASE = ${JSON.stringify(base)};
  ${OVERLAY}
  function Razorpay(options) {
    if (!(this instanceof Razorpay)) return new Razorpay(options);
    if (!options || !options.key) throw new Error('Razorpay: key is required');
    this.options = options; this._h = {}; this._ov = null;
  }
  Razorpay.prototype.on = function (evt, cb) { (this._h[evt] = this._h[evt] || []).push(cb); return this; };
  Razorpay.prototype.open = function () {
    var o = this.options, self = this, q = new URLSearchParams();
    var put = function (k, v) { if (v !== undefined && v !== null && v !== '') q.set(k, String(v)); };
    put('key', o.key); put('amount', o.amount); put('currency', o.currency); put('name', o.name);
    put('description', o.description); put('image', o.image); put('callback_url', o.callback_url);
    if (o.redirect === false) put('redirect', 'false');
    var p = o.prefill || {}; put('prefill_name', p.name); put('prefill_email', p.email); put('prefill_contact', p.contact);
    put('theme_color', o.theme && o.theme.color);
    var path = o.order_id ? '/checkout/razorpay/' + encodeURIComponent(o.order_id) : '/checkout/razorpay/new';
    if (o.callback_url && o.redirect === true) { window.location.href = BASE + path + '?' + q.toString(); return this; }
    q.set('embedded', '1');
    this._ov = __mockgwOverlay(BASE + path + '?' + q.toString(), function (msg) {
      if (msg.event === 'success') { self.close(); if (typeof o.handler === 'function') o.handler(msg.response); }
      else if (msg.event === 'payment.failed') { (self._h['payment.failed'] || []).forEach(function (cb) { cb(msg.response); }); }
      else if (msg.event === 'dismiss') { self.close(); if (o.modal && typeof o.modal.ondismiss === 'function') o.modal.ondismiss(); }
    });
    return this;
  };
  Razorpay.prototype.close = function () { if (this._ov) { this._ov.close(); this._ov = null; } };
  window.Razorpay = Razorpay;
})();
`;
}

function cashfreeSdk(base) {
  return `/* Mock Cashfree JS SDK v3 (window.Cashfree) — served by the mock gateway at ${base} */
(function () {
  var BASE = ${JSON.stringify(base)};
  ${OVERLAY}
  function Cashfree(opts) {
    if (!(this instanceof Cashfree)) return new Cashfree(opts);
    this.mode = (opts && opts.mode) || 'sandbox';
  }
  Cashfree.prototype.version = function () { return 'mock-3.0.0'; };
  Cashfree.prototype.checkout = function (o) {
    o = o || {};
    if (!o.paymentSessionId) return Promise.resolve({ error: { message: 'paymentSessionId is required', code: 'payment_session_id_missing' } });
    var url = BASE + '/checkout/cashfree/' + encodeURIComponent(o.paymentSessionId);
    var target = o.redirectTarget;
    if (target === '_modal' || (target && typeof target === 'object')) {
      return new Promise(function (resolve) {
        var ov = __mockgwOverlay(url + '?embedded=1', function (msg) {
          if (msg.event === 'success') { ov.close(); resolve({ paymentDetails: { paymentMessage: 'Payment finished. Check status.' } }); }
          else if (msg.event === 'dismiss') { ov.close(); resolve({ error: { message: 'Payment dismissed by user', code: 'payment_dismissed' } }); }
          else if (msg.event === 'failed') { /* user can retry inside the modal */ }
        });
      });
    }
    if (target === '_blank') { window.open(url, '_blank'); return Promise.resolve({ redirect: true }); }
    (target === '_top' ? window.top : window).location.href = url;
    return Promise.resolve({ redirect: true });
  };
  window.Cashfree = Cashfree;
  if (typeof module !== 'undefined') module.exports = { load: function (o) { return Promise.resolve(Cashfree(o)); } };
})();
`;
}

function phonepeSdk(base) {
  return `/* Mock PhonePe Checkout (window.PhonePeCheckout) — served by the mock gateway at ${base} */
(function () {
  ${OVERLAY}
  var ov = null;
  window.PhonePeCheckout = {
    transact: function (o) {
      o = o || {};
      if (!o.tokenUrl) throw new Error('PhonePeCheckout: tokenUrl is required');
      if (o.type === 'IFRAME') {
        var url = o.tokenUrl + (o.tokenUrl.indexOf('?') < 0 ? '?' : '&') + 'embedded=1';
        ov = __mockgwOverlay(url, function (msg) {
          if (msg.event === 'CONCLUDED' || msg.event === 'USER_CANCEL') { ov.close(); ov = null; if (typeof o.callback === 'function') o.callback(msg.event); }
        });
      } else {
        window.location.href = o.tokenUrl;
      }
    },
    closePage: function () { if (ov) { ov.close(); ov = null; } }
  };
})();
`;
}

function sendScript(res, body) {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.type('application/javascript').send(body);
}

/* ------------------------------- routes ------------------------------- */

export const router = express.Router();

router.get(['/razorpay/v1/checkout.js', '/v1/checkout.js', '/sdk/razorpay.js'], (req, res) => sendScript(res, razorpaySdk(baseUrl())));
router.get(['/cashfree/js/v3/cashfree.js', '/sdk/cashfree.js'], (req, res) => sendScript(res, cashfreeSdk(baseUrl())));
router.get(['/phonepe/checkout.js', '/sdk/phonepe.js'], (req, res) => sendScript(res, phonepeSdk(baseUrl())));

router.get('/checkout/razorpay/new', (req, res) => {
  const r = implicitOrder(req.query);
  if (r.error) return renderError(res, 400, 'Unable to start payment', r.error);
  const q = new URLSearchParams({ ...cleanQuery(req.query), implicit_order: '1' });
  res.redirect(302, `/checkout/razorpay/${r.order.id}?${q}`);
});

router.get('/checkout/:provider/:id', (req, res) => {
  const adapter = adapters[req.params.provider];
  if (!adapter) return renderError(res, 404, 'Not found', 'Unknown payment provider.');
  const query = cleanQuery(req.query);
  const ctx = adapter.load(req.params.id, query);
  if (!ctx) return renderError(res, 404, 'Payment not found', 'This payment link is invalid or has been removed.');
  if (ctx.fatal) return renderError(res, 400, 'Unable to start payment', ctx.fatal);
  renderPage(res, {
    provider: adapter.name,
    label: adapter.label,
    id: req.params.id,
    amount: ctx.amount,
    currency: String(ctx.currency).toUpperCase(),
    description: ctx.description || '',
    merchant: ctx.merchant,
    image: ctx.image || null,
    theme: ctx.theme || PROVIDER_THEME[adapter.name],
    prefill: ctx.prefill || {},
    methods: ctx.methods || adapter.methods || ['card', 'upi', 'netbanking', 'wallet'],
    status: ctx.status,
    stage: ctx.stage || 'pay',
    card: ctx.card || null,
    cancelable: ctx.cancelable !== false,
    reference: ctx.reference || null,
    embedded: query.embedded === '1',
    query,
    banks: BANKS.map(({ code, name }) => ({ code, name })),
    wallets: WALLETS,
    testCards: Object.entries(TEST_CARDS).map(([number, v]) => ({ number, label: v.label })),
    successOtp: SUCCESS_OTP,
    otpMaxAttempts: OTP_MAX_ATTEMPTS,
    upiAutoApproveSeconds: getSetting('checkout.upiAutoApproveSeconds'),
  });
});

// Wrong OTPs on the simulated issuer page get a few retries before the payment fails, like a real ACS.
const OTP_MAX_ATTEMPTS = 3;
const otpAttempts = new Map();

router.post('/checkout/:provider/:id/complete', express.json({ limit: '32kb' }), (req, res) => {
  const adapter = adapters[req.params.provider];
  if (!adapter) return res.status(404).json({ status: 'failed', error: { message: 'Unknown provider' } });
  const b = req.body || {};
  const otpGiven = b.otp !== undefined && b.otp !== null && b.otp !== '';
  if (otpGiven) {
    const key = `${req.params.provider}:${req.params.id}`;
    const abandoned = b.otp === 'cancelled' || b.otp === 'failed';
    if (!abandoned && String(b.otp) !== SUCCESS_OTP) {
      const n = (otpAttempts.get(key) || 0) + 1;
      if (n < OTP_MAX_ATTEMPTS) {
        if (otpAttempts.size > 10_000) otpAttempts.clear();
        otpAttempts.set(key, n);
        return res.json({ status: 'otp_invalid', attempts_left: OTP_MAX_ATTEMPTS - n, error: { message: 'Incorrect OTP' } });
      }
    }
    otpAttempts.delete(key);
  }
  let result;
  if (b.authenticate) {
    result = String(b.otp) === SUCCESS_OTP
      ? { status: 'success', method: 'card', instrument: {} }
      : { status: 'failed', method: 'card', instrument: {}, error: { kind: 'authentication_failed', message: ERRORS.authentication_failed } };
  } else {
    result = decide(b);
  }
  const injected = getSetting('checkout.nextFailure');
  if (injected && result.status === 'success') {
    result = { status: 'failed', method: result.method, instrument: result.instrument, error: { kind: injected, message: ERRORS[injected] || injected } };
    setSettings({ 'checkout.nextFailure': null });
    log.info('checkout failure injected', { provider: adapter.name, id: req.params.id, kind: injected });
  }
  if (result.status === 'otp_required') return res.json({ status: 'otp_required', instrument: result.instrument });
  const out = adapter.complete(req.params.id, result, { query: cleanQuery(b.query) });
  log.info('checkout completed', { provider: adapter.name, id: req.params.id, method: result.method, result: out.status, error: out.error?.code });
  res.json(out);
});

router.post('/checkout/:provider/:id/cancel', express.json({ limit: '32kb' }), (req, res) => {
  const adapter = adapters[req.params.provider];
  if (!adapter) return res.status(404).json({ next: { type: 'back' } });
  res.json({ next: adapter.cancel(req.params.id, { query: cleanQuery(req.body?.query) }) });
});

/** Programmatic completion for automated tests (admin API wraps this). */
export function simulate(provider, id, input = {}) {
  const adapter = adapters[provider];
  if (!adapter) return { error: 'Unknown provider' };
  const ctx = adapter.load(id, {});
  if (!ctx) return { error: 'Not found' };
  const outcome = input.outcome || input.status || 'success';
  const method = input.method || (adapter.methods?.[0] ?? 'card');
  const result = decide({
    method,
    force: outcome === 'success' ? 'success' : 'failed',
    error: input.error,
    card: input.card,
    bank: input.bank,
    vpa: input.vpa || (outcome === 'success' ? 'success@upi' : 'failure@upi'),
    wallet: input.wallet,
    bank_outcome: outcome === 'success' ? 'success' : 'failed',
    upi_outcome: outcome === 'success' ? 'approved' : 'declined',
    wallet_outcome: outcome === 'success' ? 'success' : 'failed',
  });
  return adapter.complete(id, result, { query: input.query || {} });
}
