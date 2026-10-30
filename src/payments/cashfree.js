import express from 'express';
import { config } from '../config.js';
import { indexCheckout, objects, updateCheckoutStatus } from '../db.js';
import { getSetting } from '../settings.js';
import { hmac, rand, randDigits, safeEqual } from '../util.js';
import { enqueue, registerSigner } from '../webhooks.js';

/**
 * Cashfree Payment Gateway mock (API version 2023-08-01 / 2025-01-01) — https://www.cashfree.com/docs/api-reference/payments
 * Base URL: {PUBLIC_URL}/cashfree/pg   (replaces https://sandbox.cashfree.com/pg)
 */
const P = 'cashfree';
const cfg = () => config.cashfree;
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const cfId = () => Number(`5${randDigits(12)}`);

registerSigner('cashfree', (body) => {
  const ts = String(Date.now());
  return { 'x-webhook-signature': hmac('sha256', cfg().secretKey, ts + body, 'base64'), 'x-webhook-timestamp': ts, 'x-webhook-version': '2023-08-01' };
});

function cfError(res, status, message, code, type = 'invalid_request_error') {
  return res.status(status).json({ message, code, type, help: 'https://www.cashfree.com/docs/api-reference/error-codes' });
}

function auth(req, res, next) {
  res.setHeader('x-request-id', req.headers['x-request-id'] || rand(24));
  if (!safeEqual(req.headers['x-client-id'], cfg().appId) || !safeEqual(req.headers['x-client-secret'], cfg().secretKey)) {
    return cfError(res, 401, 'authentication Failed', 'request_failed', 'authentication_error');
  }
  if (!req.headers['x-api-version']) return cfError(res, 400, 'x-api-version : header missing in request', 'x-api-version_missing');
  next();
}

const notFound = (res, what = 'order') => cfError(res, 404, `${what} not found`, `${what}_not_found`);

function webhook(type, data, order) {
  const body = JSON.stringify({ data, event_time: iso(), type });
  const url = order.order_meta?.notify_url || getSetting('cashfree.webhookUrl');
  enqueue({ provider: P, event: type, ref: order.order_id, url, body, signer: 'cashfree' });
}

const publicOrder = (o) => {
  const { _session_expiry, ...rest } = o;
  return rest;
};

/* ------------------------------- API ------------------------------- */

export const router = express.Router();
router.use('/pg', auth);

router.post('/pg/orders', (req, res) => {
  const b = req.body || {};
  const amount = Number(b.order_amount);
  if (!Number.isFinite(amount) || amount < 1) return cfError(res, 400, 'order_amount : must be greater than or equal to 1. Value received: ' + b.order_amount, 'order_amount_invalid');
  if (Math.round(amount * 100) / 100 !== amount) return cfError(res, 400, 'order_amount : should have only 2 decimal places', 'order_amount_invalid');
  if (!b.order_currency) return cfError(res, 400, 'order_currency : is missing in the request', 'order_currency_missing');
  const cd = b.customer_details || {};
  if (!cd.customer_id) return cfError(res, 400, 'customer_details.customer_id : is missing in the request', 'customer_details.customer_id_missing');
  if (!cd.customer_phone) return cfError(res, 400, 'customer_details.customer_phone : is missing in the request', 'customer_details.customer_phone_missing');
  const orderId = b.order_id || `order_${rand(27)}`;
  if (!/^[A-Za-z0-9_-]{3,45}$/.test(orderId)) return cfError(res, 400, 'order_id : should be alphanumeric and can contain _ or -, length 3-45', 'order_id_invalid');
  if (objects.get(`cf:${orderId}`, 'order')) return cfError(res, 409, 'order with same order id exists', 'order_already_exists', 'invalid_request_error');
  const expiry = b.order_expiry_time ? Date.parse(b.order_expiry_time) : Date.now() + 30 * 86400_000;
  const order = {
    cart_details: null,
    cf_order_id: String(cfId()),
    created_at: iso(),
    customer_details: { customer_id: cd.customer_id, customer_name: cd.customer_name || null, customer_email: cd.customer_email || null, customer_phone: cd.customer_phone, customer_uid: null },
    entity: 'order',
    order_amount: amount,
    order_currency: b.order_currency,
    order_expiry_time: iso(expiry),
    order_id: orderId,
    order_meta: { return_url: b.order_meta?.return_url || null, notify_url: b.order_meta?.notify_url || null, payment_methods: b.order_meta?.payment_methods || null },
    order_note: b.order_note || null,
    order_splits: [],
    order_status: 'ACTIVE',
    order_tags: b.order_tags || null,
    payment_session_id: `session_${rand(90)}payment`,
    terminal_data: null,
  };
  objects.put(P, 'order', `cf:${orderId}`, order, { lookup: order.payment_session_id });
  indexCheckout({
    id: `cf:${orderId}`, provider: P, kind: 'order', amount: Math.round(amount * 100), currency: order.order_currency, status: 'created',
    reference: orderId, description: order.order_note, customer: { name: cd.customer_name, email: cd.customer_email, phone: cd.customer_phone },
  });
  res.json(order);
});

router.get('/pg/orders/:id', (req, res) => {
  const o = objects.get(`cf:${req.params.id}`, 'order');
  if (!o) return notFound(res);
  expireIfNeeded(o);
  res.json(publicOrder(o));
});

router.patch('/pg/orders/:id', (req, res) => {
  const o = objects.get(`cf:${req.params.id}`, 'order');
  if (!o) return notFound(res);
  if (req.body?.order_status !== 'TERMINATED') return cfError(res, 400, 'order_status : only TERMINATED is supported', 'order_status_invalid');
  if (o.order_status !== 'ACTIVE') return cfError(res, 400, `order is in ${o.order_status} state and cannot be terminated`, 'order_inactive');
  o.order_status = 'TERMINATED';
  objects.put(P, 'order', `cf:${o.order_id}`, o);
  updateCheckoutStatus(`cf:${o.order_id}`, 'cancelled');
  res.json(o);
});

// Older API versions used this to terminate.
router.post('/pg/orders/:id/terminate', (req, res) => {
  const o = objects.get(`cf:${req.params.id}`, 'order');
  if (!o) return notFound(res);
  o.order_status = 'TERMINATED';
  objects.put(P, 'order', `cf:${o.order_id}`, o);
  updateCheckoutStatus(`cf:${o.order_id}`, 'cancelled');
  res.json(o);
});

router.get('/pg/orders/:id/payments', (req, res) => {
  if (!objects.get(`cf:${req.params.id}`, 'order')) return notFound(res);
  res.json(objects.children(`cf:${req.params.id}`, 'payment').reverse());
});

router.get('/pg/orders/:id/payments/:pid', (req, res) => {
  const p = objects.children(`cf:${req.params.id}`, 'payment').find((x) => String(x.cf_payment_id) === req.params.pid);
  return p ? res.json(p) : notFound(res, 'payment');
});

router.post('/pg/orders/:id/refunds', (req, res) => {
  const o = objects.get(`cf:${req.params.id}`, 'order');
  if (!o) return notFound(res);
  const amount = Number(req.body?.refund_amount);
  const refundId = req.body?.refund_id;
  if (!refundId) return cfError(res, 400, 'refund_id : is missing in the request', 'refund_id_missing');
  if (!Number.isFinite(amount) || amount <= 0) return cfError(res, 400, 'refund_amount : should be greater than 0', 'refund_amount_invalid');
  const r = refundOrder(o, { amount, refundId, note: req.body?.refund_note, speed: req.body?.refund_speed });
  if (r.error) return cfError(res, r.status || 400, r.error, r.code || 'refund_invalid');
  res.json(r.refund);
});

router.get('/pg/orders/:id/refunds', (req, res) => {
  if (!objects.get(`cf:${req.params.id}`, 'order')) return notFound(res);
  res.json(objects.children(`cf:${req.params.id}`, 'refund'));
});

router.get('/pg/orders/:id/refunds/:rid', (req, res) => {
  const r = objects.get(`cf:${req.params.id}:refund:${req.params.rid}`, 'refund');
  return r ? res.json(r) : notFound(res, 'refund');
});

router.use('/pg', (req, res) => cfError(res, 404, `The mock gateway does not implement ${req.method} ${req.originalUrl.split('?')[0]}`, 'request_not_found'));

function expireIfNeeded(o) {
  if (o.order_status === 'ACTIVE' && Date.parse(o.order_expiry_time) < Date.now()) {
    o.order_status = 'EXPIRED';
    objects.put(P, 'order', `cf:${o.order_id}`, o);
    updateCheckoutStatus(`cf:${o.order_id}`, 'expired');
  }
}

function refundOrder(o, { amount, refundId, note, speed = 'STANDARD' }) {
  const paid = objects.children(`cf:${o.order_id}`, 'payment').find((p) => p.payment_status === 'SUCCESS');
  if (!paid) return { error: 'refund cannot be initiated for an unpaid order', code: 'refund_invalid' };
  if (objects.get(`cf:${o.order_id}:refund:${refundId}`)) return { error: 'refund_id already exists', code: 'refund_already_exists', status: 409 };
  const refunded = objects.children(`cf:${o.order_id}`, 'refund').reduce((s, r) => s + r.refund_amount, 0);
  if (amount > Math.round((o.order_amount - refunded) * 100) / 100) return { error: 'refund_amount : greater than refundable amount', code: 'refund_amount_invalid' };
  const refund = {
    cf_payment_id: paid.cf_payment_id,
    cf_refund_id: String(cfId()),
    created_at: iso(),
    entity: 'refund',
    forex_conversion_handling_charge: null,
    forex_conversion_handling_tax: null,
    metadata: null,
    order_id: o.order_id,
    processed_at: iso(),
    refund_amount: amount,
    refund_arn: randDigits(12),
    refund_charge: 0,
    refund_currency: o.order_currency,
    refund_id: refundId,
    refund_mode: speed === 'INSTANT' ? 'INSTANT' : 'STANDARD',
    refund_note: note || null,
    refund_speed: { requested: speed, accepted: speed, processed: speed, message: null },
    refund_splits: [],
    refund_status: 'SUCCESS',
    refund_type: 'MERCHANT_INITIATED',
    refunds_id: Number(randDigits(8)),
    status_description: 'Refund processed successfully',
  };
  objects.put(P, 'refund', `cf:${o.order_id}:refund:${refundId}`, refund, { parent: `cf:${o.order_id}` });
  const total = refunded + amount;
  updateCheckoutStatus(`cf:${o.order_id}`, total >= o.order_amount ? 'refunded' : 'partially_refunded');
  webhook('REFUND_STATUS_WEBHOOK', { refund }, o);
  return { refund };
}

/* ----------------------------- Checkout ----------------------------- */

const GROUPS = { card: 'credit_card', netbanking: 'net_banking', upi: 'upi', wallet: 'wallet' };

function paymentMethodOf(result) {
  const i = result.instrument;
  if (result.method === 'card') {
    return {
      card: {
        channel: 'link',
        card_number: `XXXXXXXXXXXX${i.last4}`,
        card_network: i.brand,
        card_type: `${i.card_type}_card`,
        card_sub_type: 'R',
        card_country: 'IN',
        card_bank_name: i.issuer === 'SBIN' ? 'State Bank of India' : 'HDFC Bank',
        card_network_reference_id: null,
        instrument_id: null,
      },
    };
  }
  if (result.method === 'netbanking') return { netbanking: { channel: 'link', netbanking_bank_code: i.cf_code || 3021, netbanking_bank_name: i.bank_name } };
  if (result.method === 'upi') return { upi: { channel: i.flow === 'intent' ? 'link' : 'collect', upi_id: i.vpa } };
  return { app: { channel: 'link', provider: i.wallet, phone: null } };
}

function returnRedirect(o) {
  const url = o.order_meta?.return_url;
  if (!url) return null;
  if (url.includes('{order_id}')) return { type: 'redirect', method: 'GET', url: url.replaceAll('{order_id}', encodeURIComponent(o.order_id)), fields: {} };
  return { type: 'redirect', method: 'GET', url, fields: { order_id: o.order_id } };
}

function webhookData(o, payment) {
  return {
    order: { order_id: o.order_id, order_amount: o.order_amount, order_currency: o.order_currency, order_tags: o.order_tags },
    payment: {
      cf_payment_id: payment.cf_payment_id,
      payment_status: payment.payment_status,
      payment_amount: payment.payment_amount,
      payment_currency: payment.payment_currency,
      payment_message: payment.payment_message,
      payment_time: payment.payment_time,
      bank_reference: payment.bank_reference,
      auth_id: payment.auth_id,
      payment_method: payment.payment_method,
      payment_group: payment.payment_group,
    },
    customer_details: { customer_name: o.customer_details.customer_name, customer_id: o.customer_details.customer_id, customer_email: o.customer_details.customer_email, customer_phone: o.customer_details.customer_phone },
    payment_gateway_details: { gateway_name: 'CASHFREE', gateway_order_id: o.cf_order_id, gateway_payment_id: String(payment.cf_payment_id), gateway_status_code: null, gateway_settlement: 'CASHFREE' },
    payment_offers: null,
  };
}

/** Resolve a checkout id: either an order id or a payment_session_id. */
function resolveOrder(id) {
  if (id.startsWith('session_')) return objects.findBy(P, 'order', id);
  return objects.get(`cf:${id}`, 'order');
}

export const adapter = {
  name: P,
  label: 'Cashfree',

  load(id) {
    const o = resolveOrder(id);
    if (!o) return null;
    expireIfNeeded(o);
    const status = { PAID: 'paid', EXPIRED: 'expired', TERMINATED: 'cancelled' }[o.order_status] || 'open';
    return {
      id: o.order_id,
      amount: Math.round(o.order_amount * 100),
      currency: o.order_currency,
      description: o.order_note || '',
      merchant: getSetting('merchant.name'),
      prefill: { name: o.customer_details.customer_name || '', email: o.customer_details.customer_email || '', contact: o.customer_details.customer_phone || '' },
      status,
      reference: o.order_id,
      cancelable: true,
    };
  },

  complete(id, result, { query = {} } = {}) {
    const o = resolveOrder(id);
    if (!o || o.order_status !== 'ACTIVE') return { status: 'failed', error: { message: `Order is ${o?.order_status || 'missing'}` } };
    const ok = result.status === 'success';
    const payment = {
      auth_id: ok ? randDigits(6) : null,
      authorization: null,
      bank_reference: ok ? randDigits(12) : null,
      cf_payment_id: cfId(),
      entity: 'payment',
      error_details: ok ? null : { error_code: 'TRANSACTION_DECLINED', error_description: result.error.message, error_reason: result.error.kind, error_source: 'customer', error_code_raw: null, error_description_raw: null, error_subcode_raw: null },
      international_payment: { international: false },
      is_captured: ok,
      order_amount: o.order_amount,
      order_currency: o.order_currency,
      order_id: o.order_id,
      payment_amount: o.order_amount,
      payment_completion_time: iso(),
      payment_currency: o.order_currency,
      payment_gateway_details: { gateway_name: 'CASHFREE', gateway_order_id: o.cf_order_id, gateway_payment_id: null, gateway_status_code: null, gateway_settlement: 'CASHFREE' },
      payment_group: GROUPS[result.method] || 'others',
      payment_message: ok ? 'Transaction Successful' : result.error.message,
      payment_method: paymentMethodOf(result),
      payment_offers: null,
      payment_status: ok ? 'SUCCESS' : 'FAILED',
      payment_time: iso(),
      payment_surcharge: null,
    };
    objects.put(P, 'payment', `cf:${o.order_id}:pay:${payment.cf_payment_id}`, payment, { parent: `cf:${o.order_id}` });
    if (ok) {
      o.order_status = 'PAID';
      objects.put(P, 'order', `cf:${o.order_id}`, o);
    }
    updateCheckoutStatus(`cf:${o.order_id}`, ok ? 'paid' : 'attempted', result.method);
    webhook(ok ? 'PAYMENT_SUCCESS_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK', webhookData(o, payment), o);
    return {
      status: ok ? 'success' : 'failed',
      payment_id: String(payment.cf_payment_id),
      retryable: !ok,
      error: ok ? null : { message: result.error.message, code: result.error.kind },
      next: query.embedded
        ? { type: 'message', close: ok, payload: ok ? { event: 'success', order_id: o.order_id } : { event: 'failed', error: { message: result.error.message, code: result.error.kind } } }
        : returnRedirect(o),
    };
  },

  cancel(id, { query = {} } = {}) {
    const o = resolveOrder(id);
    if (!o) return { type: 'back' };
    if (o.order_status === 'ACTIVE') {
      const payment = {
        cf_payment_id: cfId(),
        entity: 'payment',
        order_id: o.order_id,
        payment_amount: o.order_amount,
        payment_currency: o.order_currency,
        payment_status: 'USER_DROPPED',
        payment_message: 'User dropped the payment',
        payment_time: iso(),
        payment_group: null,
        payment_method: {},
        is_captured: false,
        bank_reference: null,
        auth_id: null,
        error_details: { error_code: 'USER_DROPPED', error_description: 'user dropped and did not complete the two factor authentication', error_reason: 'user_dropped', error_source: 'customer' },
      };
      objects.put(P, 'payment', `cf:${o.order_id}:pay:${payment.cf_payment_id}`, payment, { parent: `cf:${o.order_id}` });
      webhook('PAYMENT_USER_DROPPED_WEBHOOK', webhookData(o, payment), o);
    }
    if (query.embedded) return { type: 'message', close: true, payload: { event: 'dismiss' } };
    return returnRedirect(o) || { type: 'back' };
  },

  refund(id, amountMinor) {
    const o = objects.get(id.startsWith('cf:') ? id : `cf:${id}`, 'order');
    if (!o) return { error: 'Not found' };
    const refunded = objects.children(`cf:${o.order_id}`, 'refund').reduce((s, r) => s + r.refund_amount, 0);
    const amount = amountMinor ? amountMinor / 100 : Math.round((o.order_amount - refunded) * 100) / 100;
    const r = refundOrder(o, { amount, refundId: `refund_${rand(10)}` });
    return r.error ? { error: r.error } : { ok: true, refund: r.refund };
  },
};

/** Maps dashboard ids (cf:<order_id>) to the checkout id. */
export const checkoutId = (indexId) => indexId.replace(/^cf:/, '');
