import express from 'express';
import { config } from '../config.js';
import { indexCheckout, objects, updateCheckoutStatus } from '../db.js';
import { getSetting } from '../settings.js';
import { baseUrl, bearer, hmac, rand, safeEqual, toInt } from '../util.js';
import { enqueue } from '../webhooks.js';

/**
 * Provider-neutral payments API for apps that don't follow a specific gateway.
 *   POST /generic/payments            create -> { id, checkout_url, ... }
 *   GET  /generic/payments/:id        status
 *   POST /generic/payments/:id/refund refund (full or { amount })
 * Auth: Authorization: Bearer GENERIC_API_KEY
 * Return redirect: return_url?payment_id=..&status=succeeded|failed|cancelled&signature=HMAC_SHA256(id|status, GENERIC_API_SECRET)
 * Webhook header: X-Mock-Signature = HMAC_SHA256(raw body, GENERIC_WEBHOOK_SECRET) (hex)
 */
const P = 'generic';
const cfg = () => config.generic;

const gError = (res, status, code, message, field) => res.status(status).json({ error: { code, message, ...(field ? { field } : {}) } });

function auth(req, res, next) {
  if (!safeEqual(bearer(req), cfg().apiKey)) return gError(res, 401, 'unauthorized', 'Invalid or missing API key');
  next();
}

const returnSignature = (id, status) => hmac('sha256', cfg().apiSecret, `${id}|${status}`);

function webhook(event, payment) {
  const body = JSON.stringify({ id: `evt_${rand(16)}`, type: event, created_at: new Date().toISOString(), data: payment });
  enqueue({
    provider: P,
    event,
    ref: payment.id,
    url: payment.webhook_url || getSetting('generic.webhookUrl'),
    body,
    headers: { 'X-Mock-Signature': hmac('sha256', cfg().webhookSecret, body), 'X-Mock-Event': event },
  });
}

function save(p) {
  p.updated_at = new Date().toISOString();
  objects.put(P, 'payment', p.id, p, { lookup: p.order_id });
}

export const router = express.Router();
router.use('/payments', auth);

router.post('/payments', (req, res) => {
  const b = req.body || {};
  const amount = toInt(b.amount);
  if (!Number.isInteger(amount) || amount < 1) return gError(res, 400, 'invalid_amount', 'amount must be a positive integer in minor units (paise/cents)', 'amount');
  const currency = String(b.currency || 'INR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return gError(res, 400, 'invalid_currency', 'currency must be an ISO 4217 code', 'currency');
  for (const k of ['return_url', 'webhook_url']) {
    if (b[k] && !/^https?:\/\//i.test(b[k])) return gError(res, 400, 'invalid_url', `${k} must be an http(s) URL`, k);
  }
  if (b.order_id && objects.findBy(P, 'payment', b.order_id)) return gError(res, 409, 'duplicate_order_id', 'A payment with this order_id already exists', 'order_id');
  const id = `gp_${rand(20)}`;
  const now = new Date().toISOString();
  const p = {
    id,
    object: 'payment',
    order_id: b.order_id || null,
    amount,
    amount_refunded: 0,
    currency,
    status: 'created',
    method: null,
    instrument: null,
    description: b.description || null,
    customer: b.customer || {},
    metadata: b.metadata || {},
    methods: Array.isArray(b.methods) && b.methods.length ? b.methods : ['card', 'upi', 'netbanking', 'wallet'],
    return_url: b.return_url || null,
    webhook_url: b.webhook_url || null,
    checkout_url: `${baseUrl()}/checkout/generic/${id}`,
    error: null,
    refunds: [],
    created_at: now,
    updated_at: now,
  };
  save(p);
  indexCheckout({ id, provider: P, kind: 'payment', amount, currency, status: 'created', reference: p.order_id, description: p.description, customer: p.customer });
  webhook('payment.created', p);
  res.status(201).json(p);
});

router.get('/payments', (req, res) => {
  res.json({ data: objects.list(P, 'payment', { limit: Math.min(toInt(req.query.limit) || 20, 100) }) });
});

router.get('/payments/:id', (req, res) => {
  const p = objects.get(req.params.id, 'payment') || objects.findBy(P, 'payment', req.params.id);
  return p ? res.json(p) : gError(res, 404, 'not_found', 'Payment not found');
});

router.post('/payments/:id/refund', (req, res) => {
  const p = objects.get(req.params.id, 'payment');
  if (!p) return gError(res, 404, 'not_found', 'Payment not found');
  const r = refund(p, toInt(req.body?.amount), req.body?.reason);
  if (r.error) return gError(res, 400, 'refund_failed', r.error);
  res.json(p);
});

router.post('/payments/:id/cancel', (req, res) => {
  const p = objects.get(req.params.id, 'payment');
  if (!p) return gError(res, 404, 'not_found', 'Payment not found');
  if (!['created', 'failed'].includes(p.status)) return gError(res, 400, 'invalid_state', `Payment in status ${p.status} cannot be cancelled`);
  p.status = 'cancelled';
  save(p);
  updateCheckoutStatus(p.id, 'cancelled');
  webhook('payment.cancelled', p);
  res.json(p);
});

function refund(p, amount, reason) {
  if (!['succeeded', 'partially_refunded'].includes(p.status)) return { error: `Payment in status ${p.status} cannot be refunded` };
  const amt = amount ?? p.amount - p.amount_refunded;
  if (!Number.isInteger(amt) || amt <= 0 || amt > p.amount - p.amount_refunded) return { error: 'Invalid refund amount' };
  const r = { id: `gr_${rand(16)}`, amount: amt, reason: reason || null, status: 'succeeded', created_at: new Date().toISOString() };
  p.refunds.push(r);
  p.amount_refunded += amt;
  p.status = p.amount_refunded >= p.amount ? 'refunded' : 'partially_refunded';
  save(p);
  updateCheckoutStatus(p.id, p.status === 'refunded' ? 'refunded' : 'partially_refunded');
  webhook('payment.refunded', p);
  return { refund: r };
}

function returnTo(p, status) {
  if (!p.return_url) return null;
  return { type: 'redirect', method: 'GET', url: p.return_url, fields: { payment_id: p.id, order_id: p.order_id || '', status, signature: returnSignature(p.id, status) } };
}

export const adapter = {
  name: P,
  label: 'Mock Pay',

  load(id) {
    const p = objects.get(id, 'payment');
    if (!p) return null;
    return {
      amount: p.amount,
      currency: p.currency,
      description: p.description || '',
      merchant: getSetting('merchant.name'),
      prefill: { name: p.customer.name || '', email: p.customer.email || '', contact: p.customer.phone || '' },
      methods: p.methods,
      status: { succeeded: 'paid', refunded: 'paid', partially_refunded: 'paid', cancelled: 'cancelled' }[p.status] || 'open',
      reference: p.order_id,
      cancelable: true,
    };
  },

  complete(id, result) {
    const p = objects.get(id, 'payment');
    if (!p || !['created', 'failed'].includes(p.status)) return { status: 'failed', error: { message: 'Payment is not payable' } };
    const ok = result.status === 'success';
    p.status = ok ? 'succeeded' : 'failed';
    p.method = result.method;
    p.instrument = result.instrument;
    p.error = ok ? null : { code: result.error.kind, message: result.error.message };
    save(p);
    updateCheckoutStatus(p.id, ok ? 'paid' : 'failed', result.method);
    webhook(ok ? 'payment.succeeded' : 'payment.failed', p);
    return { status: p.status === 'succeeded' ? 'success' : 'failed', payment_id: p.id, retryable: !ok, error: p.error, next: returnTo(p, ok ? 'succeeded' : 'failed') };
  },

  cancel(id) {
    const p = objects.get(id, 'payment');
    if (!p) return { type: 'back' };
    if (['created', 'failed'].includes(p.status)) {
      p.status = 'cancelled';
      save(p);
      updateCheckoutStatus(p.id, 'cancelled');
      webhook('payment.cancelled', p);
    }
    return returnTo(p, 'cancelled') || { type: 'back' };
  },

  refund(id, amount) {
    const p = objects.get(id, 'payment');
    if (!p) return { error: 'Not found' };
    const r = refund(p, amount);
    return r.error ? { error: r.error } : { ok: true, refund: r.refund };
  },
};
