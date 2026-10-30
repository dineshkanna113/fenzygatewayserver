import express from 'express';
import { config } from '../config.js';
import { indexCheckout, objects, updateCheckoutStatus } from '../db.js';
import { getSetting } from '../settings.js';
import { ah, baseUrl, hmac, nowSec, parseBasic, rand, randDigits, safeEqual, toInt } from '../util.js';
import { enqueue } from '../webhooks.js';

/**
 * Razorpay mock — https://razorpay.com/docs/api/
 * Base URL: {PUBLIC_URL}/razorpay  (paths are /v1/...)
 */
const P = 'razorpay';
const rid = (prefix) => `${prefix}_${rand(14)}`;
const cfg = () => config.razorpay;

function rzpError(res, status, description, { field, code = 'BAD_REQUEST_ERROR', reason = 'input_validation_failed', source = 'business', step = 'payment_initiation' } = {}) {
  return res.status(status).json({ error: { code, description, source, step, reason, metadata: {}, ...(field ? { field } : {}) } });
}

const notFound = (res) => rzpError(res, 400, 'The id provided does not exist', { reason: 'NA', source: 'NA', step: 'NA' });

function auth(req, res, next) {
  const b = parseBasic(req);
  if (!b || !safeEqual(b.user, cfg().keyId) || !safeEqual(b.pass, cfg().keySecret)) {
    return rzpError(res, 401, 'Authentication failed', { reason: 'NA', source: 'NA', step: 'NA' });
  }
  next();
}

function webhook(event, entities, ref) {
  const payload = {
    entity: 'event',
    account_id: cfg().accountId,
    event,
    contains: Object.keys(entities),
    payload: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, { entity: v }])),
    created_at: nowSec(),
  };
  const body = JSON.stringify(payload);
  enqueue({
    provider: P,
    event,
    ref,
    url: getSetting('razorpay.webhookUrl'),
    body,
    headers: { 'X-Razorpay-Signature': hmac('sha256', cfg().webhookSecret, body), 'X-Razorpay-Event-Id': rid('evt') },
  });
}

export const paymentSignature = (orderId, paymentId) => hmac('sha256', cfg().keySecret, `${orderId}|${paymentId}`);

const collection = (items) => ({ entity: 'collection', count: items.length, items });
const notesOf = (n) => (n && typeof n === 'object' && Object.keys(n).length ? n : []);

function checkoutStatus(order) {
  return order.status === 'paid' ? 'paid' : order.status === 'attempted' ? 'attempted' : 'created';
}

export function createOrder({ amount, currency = 'INR', receipt = null, notes, partial_payment = false }) {
  const order = {
    id: rid('order'),
    entity: 'order',
    amount,
    amount_paid: 0,
    amount_due: amount,
    currency,
    receipt: receipt ?? null,
    offer_id: null,
    status: 'created',
    attempts: 0,
    notes: notesOf(notes),
    created_at: nowSec(),
    ...(partial_payment ? { partial_payment: true } : {}),
  };
  objects.put(P, 'order', order.id, order, { lookup: receipt });
  indexCheckout({ id: order.id, provider: P, kind: 'order', amount, currency, status: 'created', reference: receipt, description: notes?.description || null });
  return order;
}

function validateAmount(body, res) {
  const amount = toInt(body.amount);
  const currency = String(body.currency || 'INR').toUpperCase();
  if (amount === undefined) return rzpError(res, 400, 'The amount field is required.', { field: 'amount' }) && null;
  if (Number.isNaN(amount)) return rzpError(res, 400, 'The amount must be an integer.', { field: 'amount' }) && null;
  if (amount < 100) return rzpError(res, 400, `The amount must be atleast ${currency} 1.00`, { field: 'amount' }) && null;
  if (!/^[A-Z]{3}$/.test(currency)) return rzpError(res, 400, 'The currency is invalid.', { field: 'currency' }) && null;
  return { amount, currency };
}

const ERROR_MAP = {
  card_declined: { code: 'BAD_REQUEST_ERROR', reason: 'card_declined', source: 'bank', step: 'payment_authorization' },
  insufficient_funds: { code: 'BAD_REQUEST_ERROR', reason: 'insufficient_funds', source: 'customer', step: 'payment_authorization' },
  expired_card: { code: 'BAD_REQUEST_ERROR', reason: 'card_expired', source: 'customer', step: 'payment_authorization' },
  incorrect_cvc: { code: 'BAD_REQUEST_ERROR', reason: 'incorrect_cvv', source: 'customer', step: 'payment_authorization' },
  invalid_number: { code: 'BAD_REQUEST_ERROR', reason: 'invalid_card_number', source: 'customer', step: 'payment_initiation' },
  processing_error: { code: 'GATEWAY_ERROR', reason: 'payment_failed', source: 'gateway', step: 'payment_authorization' },
  authentication_failed: { code: 'BAD_REQUEST_ERROR', reason: 'authentication_failed', source: 'customer', step: 'payment_authentication' },
  bank_declined: { code: 'BAD_REQUEST_ERROR', reason: 'payment_failed', source: 'bank', step: 'payment_authorization' },
  upi_declined: { code: 'BAD_REQUEST_ERROR', reason: 'payment_declined', source: 'customer', step: 'payment_authorization' },
  upi_invalid_vpa: { code: 'BAD_REQUEST_ERROR', reason: 'invalid_vpa', source: 'customer', step: 'payment_initiation' },
  wallet_declined: { code: 'BAD_REQUEST_ERROR', reason: 'payment_failed', source: 'customer', step: 'payment_authorization' },
};

function buildPayment(order, result, prefill = {}, description = null) {
  const i = result.instrument;
  const method = { card: 'card', netbanking: 'netbanking', upi: 'upi', wallet: 'wallet' }[result.method] || 'card';
  const p = {
    id: rid('pay'),
    entity: 'payment',
    amount: order.amount_due || order.amount,
    currency: order.currency,
    status: 'created',
    order_id: order.id,
    invoice_id: null,
    international: false,
    method,
    amount_refunded: 0,
    refund_status: null,
    captured: false,
    description: description ?? null,
    card_id: null,
    bank: null,
    wallet: null,
    vpa: null,
    email: prefill.email || 'void@razorpay.com',
    contact: prefill.contact || '+919000090000',
    notes: order.notes,
    fee: null,
    tax: null,
    error_code: null,
    error_description: null,
    error_source: null,
    error_step: null,
    error_reason: null,
    acquirer_data: {},
    created_at: nowSec(),
  };
  if (method === 'card') {
    p.card_id = rid('card');
    p.card = {
      id: p.card_id,
      entity: 'card',
      name: i.name || prefill.name || '',
      last4: i.last4,
      network: { visa: 'Visa', mastercard: 'MasterCard', amex: 'American Express', rupay: 'RuPay', diners: 'Diners Club', maestro: 'Maestro' }[i.brand] || 'Unknown',
      type: i.card_type,
      issuer: i.issuer,
      international: false,
      emi: false,
      sub_type: 'consumer',
      token_iin: null,
    };
    p.acquirer_data = { auth_code: randDigits(6) };
  } else if (method === 'netbanking') {
    p.bank = i.bank;
    p.acquirer_data = { bank_transaction_id: randDigits(10) };
  } else if (method === 'upi') {
    p.vpa = i.vpa;
    p.upi = { vpa: i.vpa, flow: i.flow };
    p.acquirer_data = { rrn: randDigits(12), upi_transaction_id: rand(32).toUpperCase() };
  } else if (method === 'wallet') {
    p.wallet = i.wallet;
    p.acquirer_data = { transaction_id: null };
  }
  return p;
}

function capturePayment(payment, order) {
  payment.status = 'captured';
  payment.captured = true;
  payment.fee = Math.round(payment.amount * 0.02);
  payment.tax = Math.round(payment.fee * 0.18);
  order.amount_paid += payment.amount;
  order.amount_due = Math.max(order.amount - order.amount_paid, 0);
  order.status = order.amount_due === 0 ? 'paid' : 'attempted';
  objects.put(P, 'payment', payment.id, payment, { parent: order.id });
  objects.put(P, 'order', order.id, order);
  updateCheckoutStatus(order.id, checkoutStatus(order), payment.method);
  webhook('payment.captured', { payment }, order.id);
  if (order.status === 'paid') webhook('order.paid', { payment, order }, order.id);
}

function refundPayment(payment, { amount, notes, receipt, speed = 'normal' } = {}) {
  const remaining = payment.amount - payment.amount_refunded;
  const amt = amount ?? remaining;
  if (payment.status !== 'captured' && payment.status !== 'refunded') return { error: 'The payment has not been captured' };
  if (!Number.isInteger(amt) || amt <= 0) return { error: 'The amount must be a positive integer', field: 'amount' };
  if (amt > remaining) return { error: 'The refund amount provided is greater than amount captured', field: 'amount' };
  const refund = {
    id: rid('rfnd'),
    entity: 'refund',
    amount: amt,
    currency: payment.currency,
    payment_id: payment.id,
    notes: notesOf(notes),
    receipt: receipt ?? null,
    acquirer_data: { arn: randDigits(23) },
    created_at: nowSec(),
    batch_id: null,
    status: 'processed',
    speed_processed: speed === 'optimum' ? 'instant' : 'normal',
    speed_requested: speed,
  };
  payment.amount_refunded += amt;
  payment.refund_status = payment.amount_refunded === payment.amount ? 'full' : 'partial';
  if (payment.refund_status === 'full') payment.status = 'refunded';
  objects.put(P, 'refund', refund.id, refund, { parent: payment.id });
  objects.put(P, 'payment', payment.id, payment, { parent: payment.order_id });
  updateCheckoutStatus(payment.order_id, payment.refund_status === 'full' ? 'refunded' : 'partially_refunded');
  webhook('refund.created', { refund, payment }, payment.order_id);
  webhook('refund.processed', { refund, payment }, payment.order_id);
  if (payment.refund_status === 'full') webhook('payment.refunded', { payment, refund }, payment.order_id);
  return { refund };
}

/* ------------------------------- API ------------------------------- */

export const router = express.Router();
router.use('/v1', auth);

router.post('/v1/orders', ah(async (req, res) => {
  const b = req.body || {};
  const v = validateAmount(b, res);
  if (!v) return;
  if (b.receipt && String(b.receipt).length > 40) return rzpError(res, 400, 'receipt length must be at most 40', { field: 'receipt' });
  if (b.notes && Object.keys(b.notes).length > 15) return rzpError(res, 400, 'Number of notes cannot exceed 15', { field: 'notes' });
  res.json(createOrder({ ...v, receipt: b.receipt, notes: b.notes, partial_payment: b.partial_payment }));
}));

router.get('/v1/orders', (req, res) => {
  const count = Math.min(toInt(req.query.count) || 10, 100);
  const skip = toInt(req.query.skip) || 0;
  let items = objects.list(P, 'order', { limit: count, offset: skip });
  if (req.query.receipt) items = items.filter((o) => o.receipt === req.query.receipt);
  if (req.query.authorized === '1') items = items.filter((o) => o.status !== 'created');
  res.json(collection(items));
});

router.get('/v1/orders/:id', (req, res) => {
  const order = objects.get(req.params.id, 'order');
  return order ? res.json(order) : notFound(res);
});

router.patch('/v1/orders/:id', (req, res) => {
  const order = objects.get(req.params.id, 'order');
  if (!order) return notFound(res);
  if (req.body?.notes) order.notes = notesOf({ ...(Array.isArray(order.notes) ? {} : order.notes), ...req.body.notes });
  objects.put(P, 'order', order.id, order);
  res.json(order);
});

router.get('/v1/orders/:id/payments', (req, res) => {
  if (!objects.get(req.params.id, 'order')) return notFound(res);
  res.json(collection(objects.children(req.params.id, 'payment').reverse()));
});

router.get('/v1/payments', (req, res) => {
  const count = Math.min(toInt(req.query.count) || 10, 100);
  res.json(collection(objects.list(P, 'payment', { limit: count, offset: toInt(req.query.skip) || 0 })));
});

router.get('/v1/payments/:id', (req, res) => {
  const p = objects.get(req.params.id, 'payment');
  return p ? res.json(p) : notFound(res);
});

router.patch('/v1/payments/:id', (req, res) => {
  const p = objects.get(req.params.id, 'payment');
  if (!p) return notFound(res);
  if (req.body?.notes) p.notes = notesOf({ ...(Array.isArray(p.notes) ? {} : p.notes), ...req.body.notes });
  objects.put(P, 'payment', p.id, p);
  res.json(p);
});

router.post('/v1/payments/:id/capture', (req, res) => {
  const p = objects.get(req.params.id, 'payment');
  if (!p) return notFound(res);
  const amount = toInt(req.body?.amount);
  if (p.status === 'captured') return rzpError(res, 400, 'This payment has already been captured', { reason: 'NA' });
  if (p.status !== 'authorized') return rzpError(res, 400, 'Only payments which have been authorized and not yet captured can be captured', { reason: 'NA' });
  if (amount !== undefined && amount !== p.amount) return rzpError(res, 400, 'Capture amount must be equal to the amount authorized', { field: 'amount' });
  const order = objects.get(p.order_id, 'order');
  capturePayment(p, order);
  res.json(p);
});

router.post('/v1/payments/:id/refund', (req, res) => {
  const p = objects.get(req.params.id, 'payment');
  if (!p) return notFound(res);
  const amount = toInt(req.body?.amount);
  if (Number.isNaN(amount)) return rzpError(res, 400, 'The amount must be an integer.', { field: 'amount' });
  const r = refundPayment(p, { amount, notes: req.body?.notes, receipt: req.body?.receipt, speed: req.body?.speed });
  if (r.error) return rzpError(res, 400, r.error, { field: r.field });
  res.json(r.refund);
});

router.post('/v1/refunds', (req, res) => {
  const p = objects.get(req.body?.payment_id, 'payment');
  if (!p) return notFound(res);
  const r = refundPayment(p, { amount: toInt(req.body?.amount), notes: req.body?.notes, receipt: req.body?.receipt, speed: req.body?.speed });
  if (r.error) return rzpError(res, 400, r.error, { field: r.field });
  res.json(r.refund);
});

router.get('/v1/payments/:id/refunds', (req, res) => {
  if (!objects.get(req.params.id, 'payment')) return notFound(res);
  res.json(collection(objects.children(req.params.id, 'refund').reverse()));
});

router.get('/v1/payments/:pid/refunds/:id', (req, res) => {
  const r = objects.get(req.params.id, 'refund');
  return r && r.payment_id === req.params.pid ? res.json(r) : notFound(res);
});

router.get('/v1/refunds', (req, res) => res.json(collection(objects.list(P, 'refund', { limit: Math.min(toInt(req.query.count) || 10, 100) }))));

router.get('/v1/refunds/:id', (req, res) => {
  const r = objects.get(req.params.id, 'refund');
  return r ? res.json(r) : notFound(res);
});

/* Payment links */
router.post('/v1/payment_links', (req, res) => {
  const b = req.body || {};
  const v = validateAmount(b, res);
  if (!v) return;
  if (b.reference_id && objects.findBy(P, 'payment_link', b.reference_id)) {
    return rzpError(res, 400, `Payment Link with reference id ${b.reference_id} already exists`, { field: 'reference_id' });
  }
  const order = createOrder({ amount: v.amount, currency: v.currency, receipt: b.reference_id, notes: b.notes });
  const id = rid('plink');
  const link = {
    id,
    entity: 'payment_link',
    amount: v.amount,
    amount_paid: 0,
    currency: v.currency,
    accept_partial: !!b.accept_partial,
    first_min_partial_amount: b.first_min_partial_amount ?? 0,
    description: b.description || '',
    reference_id: b.reference_id || '',
    customer: b.customer || {},
    notify: b.notify || { sms: false, email: false },
    reminder_enable: !!b.reminder_enable,
    callback_url: b.callback_url || '',
    callback_method: b.callback_method || 'get',
    expire_by: toInt(b.expire_by) || 0,
    expired_at: 0,
    cancelled_at: 0,
    notes: notesOf(b.notes),
    order_id: order.id,
    payments: null,
    short_url: `${baseUrl()}/checkout/razorpay/${id}`,
    status: 'created',
    upi_link: !!b.upi_link,
    user_id: '',
    created_at: nowSec(),
    updated_at: nowSec(),
  };
  objects.put(P, 'payment_link', id, link, { lookup: link.reference_id || null });
  indexCheckout({ id, provider: P, kind: 'payment_link', amount: v.amount, currency: v.currency, status: 'created', reference: b.reference_id, description: b.description, customer: b.customer });
  res.json(link);
});

router.get('/v1/payment_links', (req, res) => res.json({ payment_links: objects.list(P, 'payment_link', { limit: 100 }) }));

router.get('/v1/payment_links/:id', (req, res) => {
  const l = objects.get(req.params.id, 'payment_link');
  return l ? res.json(l) : notFound(res);
});

router.post('/v1/payment_links/:id/cancel', (req, res) => {
  const l = objects.get(req.params.id, 'payment_link');
  if (!l) return notFound(res);
  if (l.status !== 'created') return rzpError(res, 400, `Payment link cannot be cancelled in ${l.status} status`);
  Object.assign(l, { status: 'cancelled', cancelled_at: nowSec(), updated_at: nowSec() });
  objects.put(P, 'payment_link', l.id, l);
  updateCheckoutStatus(l.id, 'cancelled');
  webhook('payment_link.cancelled', { payment_link: l }, l.id);
  res.json(l);
});

router.use('/v1', (req, res) => rzpError(res, 400, `The requested URL was not found on the server (mock does not implement ${req.method} ${req.originalUrl.split('?')[0]}).`, { reason: 'NA' }));

/* ----------------------------- Checkout ----------------------------- */

function resolve(id) {
  if (id.startsWith('plink_')) {
    const link = objects.get(id, 'payment_link');
    return link ? { link, order: objects.get(link.order_id, 'order') } : null;
  }
  const order = objects.get(id, 'order');
  return order ? { order } : null;
}

export const adapter = {
  name: P,
  label: 'Razorpay',

  load(id, query) {
    const r = resolve(id);
    if (!r) return null;
    const { order, link } = r;
    if (query.key && query.key !== cfg().keyId) return { fatal: 'The api key provided is invalid' };
    let status = order.status === 'paid' ? 'paid' : 'open';
    if (link?.status === 'cancelled') status = 'cancelled';
    if (link && link.expire_by && link.expire_by < nowSec() && status === 'open') status = 'expired';
    return {
      amount: order.amount_due || order.amount,
      currency: order.currency,
      description: query.description || link?.description || '',
      merchant: query.name || getSetting('merchant.name'),
      image: query.image || null,
      theme: query.theme_color || null,
      prefill: {
        name: query.prefill_name || link?.customer?.name || '',
        email: query.prefill_email || link?.customer?.email || '',
        contact: query.prefill_contact || link?.customer?.contact || '',
      },
      status,
      reference: order.id,
    };
  },

  complete(id, result, { query = {} }) {
    const r = resolve(id);
    if (!r) return { status: 'failed', error: { message: 'Order not found' } };
    const { order, link } = r;
    if (order.status === 'paid') return { status: 'failed', error: { message: 'This order has already been paid' } };
    const prefill = { name: query.prefill_name, email: query.prefill_email || link?.customer?.email, contact: query.prefill_contact || link?.customer?.contact };
    const payment = buildPayment(order, result, prefill, query.description || link?.description);
    order.attempts += 1;
    const redirect = query.callback_url && query.redirect !== 'false';

    if (result.status !== 'success') {
      const m = ERROR_MAP[result.error.kind] || ERROR_MAP.processing_error;
      Object.assign(payment, {
        status: 'failed',
        error_code: m.code,
        error_description: result.error.message,
        error_source: m.source,
        error_step: m.step,
        error_reason: m.reason,
      });
      if (order.status === 'created') order.status = 'attempted';
      objects.put(P, 'payment', payment.id, payment, { parent: order.id });
      objects.put(P, 'order', order.id, order);
      updateCheckoutStatus(link ? link.id : order.id, link ? 'created' : checkoutStatus(order), payment.method);
      webhook('payment.failed', { payment }, order.id);
      const error = {
        code: m.code,
        description: result.error.message,
        source: m.source,
        step: m.step,
        reason: m.reason,
        metadata: { payment_id: payment.id, order_id: order.id },
      };
      if (redirect) {
        return {
          status: 'failed',
          payment_id: payment.id,
          error: { message: result.error.message, code: m.reason },
          next: {
            type: 'redirect',
            method: 'POST',
            url: query.callback_url,
            fields: {
              'error[code]': error.code,
              'error[description]': error.description,
              'error[source]': error.source,
              'error[step]': error.step,
              'error[reason]': error.reason,
              'error[metadata]': JSON.stringify(error.metadata),
            },
          },
        };
      }
      return {
        status: 'failed',
        payment_id: payment.id,
        retryable: true,
        error: { message: result.error.message, code: m.reason },
        next: { type: 'message', close: false, payload: { event: 'payment.failed', response: { error } } },
      };
    }

    payment.status = 'authorized';
    if (order.status === 'created') order.status = 'attempted';
    objects.put(P, 'payment', payment.id, payment, { parent: order.id });
    objects.put(P, 'order', order.id, order);
    updateCheckoutStatus(order.id, checkoutStatus(order), payment.method);
    webhook('payment.authorized', { payment }, order.id);
    if (cfg().autoCapture || link) capturePayment(payment, order);

    if (link) {
      link.status = 'paid';
      link.amount_paid = payment.amount;
      link.payments = [{ amount: payment.amount, created_at: payment.created_at, method: payment.method, payment_id: payment.id, status: 'captured' }];
      link.updated_at = nowSec();
      objects.put(P, 'payment_link', link.id, link);
      updateCheckoutStatus(link.id, 'paid', payment.method);
      webhook('payment_link.paid', { payment_link: link, payment, order }, link.id);
      if (!link.callback_url) return { status: 'success', payment_id: payment.id, next: null };
      const sig = hmac('sha256', cfg().keySecret, `${link.id}|${link.reference_id}|paid|${payment.id}`);
      return {
        status: 'success',
        payment_id: payment.id,
        next: {
          type: 'redirect',
          method: link.callback_method === 'post' ? 'POST' : 'GET',
          url: link.callback_url,
          fields: {
            razorpay_payment_id: payment.id,
            razorpay_payment_link_id: link.id,
            razorpay_payment_link_reference_id: link.reference_id,
            razorpay_payment_link_status: 'paid',
            razorpay_signature: sig,
          },
        },
      };
    }

    const response = query.implicit_order
      ? { razorpay_payment_id: payment.id }
      : { razorpay_payment_id: payment.id, razorpay_order_id: order.id, razorpay_signature: paymentSignature(order.id, payment.id) };
    if (redirect) return { status: 'success', payment_id: payment.id, next: { type: 'redirect', method: 'POST', url: query.callback_url, fields: response } };
    return { status: 'success', payment_id: payment.id, next: { type: 'message', close: true, payload: { event: 'success', response } } };
  },

  cancel(id, { query = {} }) {
    if (query.embedded) return { type: 'message', close: true, payload: { event: 'dismiss' } };
    const r = resolve(id);
    if (r?.link?.callback_url) return { type: 'redirect', method: 'GET', url: r.link.callback_url, fields: { razorpay_payment_link_id: r.link.id, razorpay_payment_link_status: 'cancelled' } };
    return { type: 'back' };
  },

  refund(id, amount) {
    const r = resolve(id);
    if (!r) return { error: 'Not found' };
    const payment = objects.children(r.order.id, 'payment').reverse().find((p) => p.status === 'captured');
    if (!payment) return { error: 'No captured payment to refund' };
    const out = refundPayment(payment, { amount });
    return out.error ? { error: out.error } : { ok: true, refund: out.refund };
  },
};

/** Used by the checkout.js SDK when options have no order_id (Razorpay "standard checkout without orders"). */
export function implicitOrder(query) {
  const amount = toInt(query.amount);
  if (!amount || amount < 100) return { error: 'Invalid amount' };
  if (query.key !== cfg().keyId) return { error: 'The api key provided is invalid' };
  return { order: createOrder({ amount, currency: String(query.currency || 'INR').toUpperCase(), notes: {} }) };
}
