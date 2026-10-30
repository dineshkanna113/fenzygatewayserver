import express from 'express';
import { config } from '../config.js';
import { indexCheckout, objects, q, updateCheckoutStatus } from '../db.js';
import { getSetting } from '../settings.js';
import { asArray, baseUrl, bearer, hmac, nowSec, parseBasic, rand, safeEqual, toBool, toInt } from '../util.js';
import { enqueue, registerSigner } from '../webhooks.js';
import { decide } from './simulator.js';

/**
 * Stripe mock — https://docs.stripe.com/api
 * stripe-node: new Stripe(key, { host: 'your-mock-host', port: 443, protocol: 'https' })  (paths are /v1/...)
 * Also mounted under {PUBLIC_URL}/stripe/v1/...
 */
const P = 'stripe';
const cfg = () => config.stripe;
const sid = (prefix, n = 24) => `${prefix}_${rand(n)}`;

registerSigner('stripe', (body) => {
  const t = nowSec();
  return { 'Stripe-Signature': `t=${t},v1=${hmac('sha256', cfg().webhookSecret, `${t}.${body}`)}` };
});

function stripeError(res, status, message, { type = 'invalid_request_error', code, param, decline_code, extra = {} } = {}) {
  return res.status(status).json({
    error: {
      ...(code ? { code, doc_url: `https://stripe.com/docs/error-codes/${code.replace(/_/g, '-')}` } : {}),
      ...(decline_code ? { decline_code } : {}),
      message,
      ...(param ? { param } : {}),
      request_log_url: null,
      type,
      ...extra,
    },
  });
}

const missing = (res, kind, id, param = 'id') => stripeError(res, 404, `No such ${kind}: '${id}'`, { code: 'resource_missing', param });

function auth(req, res, next) {
  res.setHeader('Request-Id', `req_${rand(14)}`);
  res.setHeader('Stripe-Version', req.headers['stripe-version'] || cfg().apiVersion);
  const key = bearer(req) || parseBasic(req)?.user;
  if (!key) {
    return stripeError(res, 401, 'You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. \'Authorization: Bearer YOUR_SECRET_KEY\').');
  }
  if (!safeEqual(key, cfg().secretKey)) {
    return stripeError(res, 401, `Invalid API Key provided: ${key.slice(0, 8)}${'*'.repeat(Math.max(key.length - 12, 4))}${key.slice(-4)}`);
  }
  next();
}

/** Idempotency-Key support on POST requests (replays the stored response for 24h). */
function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (req.method !== 'POST' || !key) return next();
  const k = `stripe:${key}`;
  const hit = q('SELECT status, body FROM idempotency WHERE key = ? AND created_at > ?').get(k, Date.now() - 86_400_000);
  if (hit) {
    res.setHeader('Idempotent-Replayed', 'true');
    return res.status(hit.status).type('application/json').send(hit.body);
  }
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      q('INSERT OR REPLACE INTO idempotency (key, status, body, created_at) VALUES (?, ?, ?, ?)').run(k, res.statusCode, JSON.stringify(body), Date.now());
    }
    return json(body);
  };
  next();
}

function event(type, object, ref, previous) {
  const evt = {
    id: sid('evt'),
    object: 'event',
    api_version: cfg().apiVersion,
    created: nowSec(),
    data: { object, ...(previous ? { previous_attributes: previous } : {}) },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
  objects.put(P, 'event', evt.id, evt, { parent: ref });
  enqueue({ provider: P, event: type, ref, url: getSetting('stripe.webhookUrl'), body: JSON.stringify(evt), signer: 'stripe' });
}

const list = (data, url, hasMore = false) => ({ object: 'list', data, has_more: hasMore, url });
const limitOf = (req) => Math.min(Math.max(toInt(req.query.limit) || 10, 1), 100);

function listObjects(type, url, req, filter) {
  const limit = limitOf(req);
  let items = objects.list(P, type, { limit: 500 });
  if (filter) items = items.filter(filter);
  if (req.query.starting_after) {
    const i = items.findIndex((o) => o.id === req.query.starting_after);
    items = i >= 0 ? items.slice(i + 1) : items;
  }
  return list(items.slice(0, limit), url, items.length > limit);
}

/* ------------------------- payment methods ------------------------- */

const TEST_PMS = {
  pm_card_visa: '4242424242424242',
  pm_card_visa_debit: '4000056655665556',
  pm_card_mastercard: '5555555555554444',
  pm_card_amex: '378282246310005',
  pm_card_in: '4000003560000008',
  pm_card_chargeDeclined: '4000000000000002',
  pm_card_visa_chargeDeclined: '4000000000000002',
  pm_card_chargeDeclinedInsufficientFunds: '4000000000009995',
  pm_card_chargeDeclinedExpiredCard: '4000000000000069',
  pm_card_chargeDeclinedIncorrectCvc: '4000000000000127',
  pm_card_chargeDeclinedProcessingError: '4000000000000119',
  pm_card_threeDSecure2Required: '4000000000003220',
  pm_card_threeDSecureRequired: '4000000000003220',
  pm_card_authenticationRequired: '4000000000003220',
};
for (const [k, v] of Object.entries({ ...TEST_PMS })) TEST_PMS[k.replace(/^pm_card_/, 'tok_')] = v;

function scenarioFor(card) {
  const r = decide({ method: 'card', card });
  return { scenario: r.status === 'success' ? 'success' : r.status === 'otp_required' ? 'otp' : r.error.kind, instrument: r.instrument };
}

function createPaymentMethod(instrument, scenario, billing = {}) {
  const pm = {
    id: sid('pm'),
    object: 'payment_method',
    allow_redisplay: 'unspecified',
    billing_details: { address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null }, email: billing.email || null, name: billing.name || instrument.name || null, phone: billing.phone || null },
    card: {
      brand: instrument.brand === 'unknown' ? 'unknown' : instrument.brand,
      checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: 'pass' },
      country: 'US',
      display_brand: instrument.brand,
      exp_month: instrument.exp_month,
      exp_year: instrument.exp_year,
      fingerprint: rand(16),
      funding: instrument.card_type || 'credit',
      generated_from: null,
      last4: instrument.last4,
      networks: { available: [instrument.brand], preferred: null },
      three_d_secure_usage: { supported: true },
      wallet: null,
    },
    created: nowSec(),
    customer: null,
    livemode: false,
    metadata: {},
    type: 'card',
  };
  objects.put(P, 'payment_method', pm.id, pm);
  objects.put(P, 'pm_sim', `${pm.id}:sim`, { scenario }, { parent: pm.id });
  return pm;
}

function resolvePaymentMethod(id) {
  if (TEST_PMS[id]) {
    const { scenario, instrument } = scenarioFor({ number: TEST_PMS[id], exp_month: 12, exp_year: new Date().getFullYear() + 3 });
    return createPaymentMethod(instrument, scenario);
  }
  return objects.get(id, 'payment_method');
}

const pmScenario = (pm) => objects.get(`${pm.id}:sim`)?.scenario || 'success';

/* ----------------------------- intents ----------------------------- */

function newPaymentIntent(b) {
  const id = sid('pi');
  const pmTypes = asArray(b.payment_method_types);
  const pi = {
    id,
    object: 'payment_intent',
    amount: toInt(b.amount),
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: b.automatic_payment_methods ? { allow_redirects: 'always', enabled: toBool(b.automatic_payment_methods.enabled) ?? true } : pmTypes.length ? null : { allow_redirects: 'always', enabled: true },
    canceled_at: null,
    cancellation_reason: null,
    capture_method: b.capture_method || 'automatic_async',
    client_secret: `${id}_secret_${rand(25)}`,
    confirmation_method: b.confirmation_method || 'automatic',
    created: nowSec(),
    currency: String(b.currency).toLowerCase(),
    customer: b.customer || null,
    description: b.description || null,
    invoice: null,
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata: b.metadata || {},
    next_action: null,
    on_behalf_of: null,
    payment_method: null,
    payment_method_configuration_details: null,
    payment_method_options: { card: { installments: null, mandate_options: null, network: null, request_three_d_secure: 'automatic' } },
    payment_method_types: pmTypes.length ? pmTypes : ['card'],
    processing: null,
    receipt_email: b.receipt_email || null,
    review: null,
    setup_future_usage: b.setup_future_usage || null,
    shipping: b.shipping || null,
    source: null,
    statement_descriptor: b.statement_descriptor || null,
    statement_descriptor_suffix: b.statement_descriptor_suffix || null,
    status: 'requires_payment_method',
    transfer_data: null,
    transfer_group: b.transfer_group || null,
  };
  return pi;
}

function savePI(pi, extra = {}) {
  const session = extra.session || objects.row(pi.id)?.parent_id || null;
  objects.put(P, 'payment_intent', pi.id, pi, { parent: session });
  const status = {
    succeeded: 'paid',
    requires_capture: 'authorized',
    canceled: 'cancelled',
    requires_action: 'pending',
    processing: 'pending',
  }[pi.status] || 'created';
  if (!session) {
    indexCheckout({ id: pi.id, provider: P, kind: 'payment_intent', amount: pi.amount, currency: pi.currency, status: refundStatus(pi) || status, description: pi.description, reference: pi.metadata?.order_id || null, customer: pi.receipt_email ? { email: pi.receipt_email } : null });
  }
}

function refundStatus(pi) {
  if (!pi.latest_charge) return null;
  const ch = objects.get(pi.latest_charge, 'charge');
  if (!ch || !ch.amount_refunded) return null;
  return ch.refunded ? 'refunded' : 'partially_refunded';
}

function newCharge(pi, pm, { status, captured, failure }) {
  const ch = {
    id: sid('ch'),
    object: 'charge',
    amount: pi.amount,
    amount_captured: captured ? pi.amount : 0,
    amount_refunded: 0,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: captured ? sid('txn') : null,
    billing_details: pm.billing_details,
    calculated_statement_descriptor: 'MOCK*' + getSetting('merchant.name').toUpperCase().slice(0, 16),
    captured: !!captured,
    created: nowSec(),
    currency: pi.currency,
    customer: pi.customer,
    description: pi.description,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: failure?.code || null,
    failure_message: failure?.message || null,
    fraud_details: {},
    invoice: null,
    livemode: false,
    metadata: pi.metadata,
    outcome: failure
      ? { network_status: 'declined_by_network', reason: failure.decline_code || failure.code, risk_level: 'normal', risk_score: 20, seller_message: 'The bank did not return any further details with this decline.', type: 'issuer_declined' }
      : { network_status: 'approved_by_network', reason: null, risk_level: 'normal', risk_score: 12, seller_message: 'Payment complete.', type: 'authorized' },
    paid: status === 'succeeded',
    payment_intent: pi.id,
    payment_method: pm.id,
    payment_method_details: {
      card: {
        amount_authorized: status === 'succeeded' ? pi.amount : null,
        brand: pm.card.brand,
        checks: pm.card.checks,
        country: pm.card.country,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year,
        fingerprint: pm.card.fingerprint,
        funding: pm.card.funding,
        last4: pm.card.last4,
        network: pm.card.brand,
        three_d_secure: null,
      },
      type: 'card',
    },
    receipt_email: pi.receipt_email,
    receipt_number: null,
    receipt_url: null,
    refunded: false,
    review: null,
    shipping: pi.shipping,
    source: null,
    statement_descriptor: pi.statement_descriptor,
    status,
    transfer_group: pi.transfer_group,
  };
  objects.put(P, 'charge', ch.id, ch, { parent: pi.id });
  return ch;
}

const DECLINES = {
  card_declined: { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' },
  insufficient_funds: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
  expired_card: { code: 'expired_card', decline_code: 'expired_card', message: 'Your card has expired.' },
  incorrect_cvc: { code: 'incorrect_cvc', decline_code: 'incorrect_cvc', message: "Your card's security code is incorrect." },
  processing_error: { code: 'processing_error', decline_code: 'processing_error', message: 'An error occurred while processing your card. Try again in a little bit.' },
  invalid_number: { code: 'incorrect_number', message: 'Your card number is incorrect.' },
  authentication_failed: {
    code: 'payment_intent_authentication_failure',
    message: 'The provided PaymentMethod has failed authentication. You can provide payment_method_data or a new PaymentMethod to attempt to fulfill this PaymentIntent again.',
  },
};

function succeedPI(pi, pm, ref) {
  const manual = pi.capture_method === 'manual';
  const ch = newCharge(pi, pm, { status: 'succeeded', captured: !manual });
  Object.assign(pi, { payment_method: pm.id, latest_charge: ch.id, next_action: null, last_payment_error: null });
  if (manual) {
    pi.status = 'requires_capture';
    pi.amount_capturable = pi.amount;
  } else {
    pi.status = 'succeeded';
    pi.amount_received = pi.amount;
  }
  savePI(pi, ref);
  event('charge.succeeded', ch, ref?.session || pi.id);
  event(manual ? 'payment_intent.amount_capturable_updated' : 'payment_intent.succeeded', pi, ref?.session || pi.id);
  return ch;
}

function failPI(pi, pm, kind, ref) {
  const d = DECLINES[kind] || DECLINES.card_declined;
  const ch = newCharge(pi, pm, { status: 'failed', captured: false, failure: d });
  pi.status = 'requires_payment_method';
  pi.latest_charge = ch.id;
  pi.next_action = null;
  pi.payment_method = null;
  pi.last_payment_error = {
    charge: ch.id,
    code: d.code,
    ...(d.decline_code ? { decline_code: d.decline_code } : {}),
    doc_url: `https://stripe.com/docs/error-codes/${d.code.replace(/_/g, '-')}`,
    message: d.message,
    payment_method: pm,
    type: kind === 'authentication_failed' ? 'invalid_request_error' : 'card_error',
  };
  savePI(pi, ref);
  event('charge.failed', ch, ref?.session || pi.id);
  event('payment_intent.payment_failed', pi, ref?.session || pi.id);
  return d;
}

function requireAction(pi, pm, returnUrl) {
  pi.payment_method = pm.id;
  pi.status = 'requires_action';
  pi.next_action = {
    type: 'redirect_to_url',
    redirect_to_url: { return_url: returnUrl || null, url: `${baseUrl()}/checkout/stripe/${pi.id}?stage=authenticate` },
  };
  objects.put(P, 'pi_sim', `${pi.id}:sim`, { return_url: returnUrl || null }, { parent: pi.id });
  savePI(pi);
  event('payment_intent.requires_action', pi, pi.id);
}

function confirmPI(pi, b, res) {
  if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
    return stripeError(res, 400, `You cannot confirm this PaymentIntent because it has a status of ${pi.status}.`, { code: 'payment_intent_unexpected_state', extra: { payment_intent: pi } });
  }
  let pm = null;
  if (b.payment_method_data?.card) {
    const { scenario, instrument } = scenarioFor(b.payment_method_data.card);
    pm = createPaymentMethod(instrument, scenario, b.payment_method_data.billing_details);
  } else {
    const pmId = b.payment_method || pi.payment_method;
    if (!pmId) {
      return stripeError(res, 400, "You cannot confirm this PaymentIntent because it's missing a payment method. You can either update the PaymentIntent with a payment method and then confirm it again, or confirm it again directly with a payment method or ConfirmationToken.", { code: 'payment_intent_unexpected_state', extra: { payment_intent: pi } });
    }
    pm = typeof pmId === 'string' && pmId === pi.payment_method ? objects.get(pmId, 'payment_method') : resolvePaymentMethod(pmId);
    if (!pm) return missing(res, 'PaymentMethod', pmId, 'payment_method');
  }
  if (b.receipt_email) pi.receipt_email = b.receipt_email;
  const scenario = pmScenario(pm);
  if (scenario === 'success') {
    succeedPI(pi, pm);
    return res.json(pi);
  }
  if (scenario === 'otp') {
    requireAction(pi, pm, b.return_url);
    return res.json(pi);
  }
  const d = failPI(pi, pm, scenario);
  return stripeError(res, 402, d.message, {
    type: scenario === 'authentication_failed' ? 'invalid_request_error' : 'card_error',
    code: d.code,
    decline_code: d.decline_code,
    extra: { charge: pi.latest_charge, payment_intent: pi, payment_method: pm },
  });
}

function refund(charge, { amount, reason, metadata }) {
  const remaining = charge.amount_captured - charge.amount_refunded;
  const amt = amount ?? remaining;
  if (charge.status !== 'succeeded' || !charge.captured) return { status: 400, message: `Charge ${charge.id} has not been captured.`, code: 'charge_not_refundable' };
  if (charge.refunded || remaining <= 0) return { status: 400, message: `Charge ${charge.id} has already been refunded.`, code: 'charge_already_refunded' };
  if (!Number.isInteger(amt) || amt <= 0) return { status: 400, message: 'Invalid positive integer', param: 'amount', code: 'parameter_invalid_integer' };
  if (amt > remaining) return { status: 400, message: `Refund amount (${amt}) is greater than unrefunded amount on charge (${remaining})`, param: 'amount', code: 'amount_too_large' };
  const re = {
    id: sid('re'),
    object: 'refund',
    amount: amt,
    balance_transaction: sid('txn'),
    charge: charge.id,
    created: nowSec(),
    currency: charge.currency,
    destination_details: { card: { reference: rand(20), reference_status: 'available', reference_type: 'acquirer_reference_number', type: 'refund' }, type: 'card' },
    metadata: metadata || {},
    payment_intent: charge.payment_intent,
    reason: reason || null,
    receipt_number: null,
    source_transfer_reversal: null,
    status: 'succeeded',
    transfer_reversal: null,
  };
  charge.amount_refunded += amt;
  charge.refunded = charge.amount_refunded >= charge.amount_captured;
  objects.put(P, 'refund', re.id, re, { parent: charge.id });
  objects.put(P, 'charge', charge.id, charge);
  const pi = objects.get(charge.payment_intent, 'payment_intent');
  const sessionRow = pi && objects.row(pi.id)?.parent_id;
  const ref = sessionRow || charge.payment_intent;
  updateCheckoutStatus(ref, charge.refunded ? 'refunded' : 'partially_refunded');
  event('refund.created', re, ref);
  event('charge.refunded', charge, ref);
  return { refund: re };
}

function expand(obj, req) {
  const fields = asArray(req.query.expand || req.body?.expand);
  if (!fields.length) return obj;
  const out = { ...obj };
  for (const f of fields) {
    if (f === 'payment_intent' && typeof out.payment_intent === 'string') out.payment_intent = objects.get(out.payment_intent, 'payment_intent');
    if (f === 'latest_charge' && typeof out.latest_charge === 'string') out.latest_charge = objects.get(out.latest_charge, 'charge');
    if (f === 'payment_method' && typeof out.payment_method === 'string') out.payment_method = objects.get(out.payment_method, 'payment_method');
    if (f === 'line_items' && out.object === 'checkout.session') out.line_items = list(objects.get(`${out.id}:li`)?.items || [], `/v1/checkout/sessions/${out.id}/line_items`);
    if (f === 'payment_intent.latest_charge' && out.payment_intent) {
      const pi = typeof out.payment_intent === 'string' ? objects.get(out.payment_intent, 'payment_intent') : out.payment_intent;
      out.payment_intent = pi && { ...pi, latest_charge: pi.latest_charge && objects.get(pi.latest_charge, 'charge') };
    }
  }
  return out;
}

/* ------------------------------- API ------------------------------- */

export const router = express.Router();
router.use('/v1', auth, idempotency);

router.post('/v1/payment_intents', (req, res) => {
  const b = req.body || {};
  const amount = toInt(b.amount);
  if (amount === undefined) return stripeError(res, 400, 'Missing required param: amount.', { code: 'parameter_missing', param: 'amount' });
  if (Number.isNaN(amount) || amount < 1) return stripeError(res, 400, 'Invalid positive integer', { code: 'parameter_invalid_integer', param: 'amount' });
  if (!b.currency) return stripeError(res, 400, 'Missing required param: currency.', { code: 'parameter_missing', param: 'currency' });
  if (b.capture_method && !['automatic', 'automatic_async', 'manual'].includes(b.capture_method)) {
    return stripeError(res, 400, `Invalid capture_method: must be one of automatic, automatic_async, or manual`, { param: 'capture_method' });
  }
  const pi = newPaymentIntent(b);
  if (b.payment_method) {
    const pm = resolvePaymentMethod(b.payment_method);
    if (!pm) return missing(res, 'PaymentMethod', b.payment_method, 'payment_method');
    pi.payment_method = pm.id;
    pi.status = 'requires_confirmation';
  }
  savePI(pi);
  event('payment_intent.created', pi, pi.id);
  if (toBool(b.confirm)) return confirmPI(pi, { ...b, payment_method: pi.payment_method }, res);
  res.json(expand(pi, req));
});

router.get('/v1/payment_intents', (req, res) => {
  res.json(listObjects('payment_intent', '/v1/payment_intents', req, req.query.customer ? (p) => p.customer === req.query.customer : null));
});

router.get('/v1/payment_intents/:id', (req, res) => {
  const pi = objects.get(req.params.id, 'payment_intent');
  if (!pi) return missing(res, 'payment_intent', req.params.id, 'intent');
  if (req.query.client_secret && req.query.client_secret !== pi.client_secret) return stripeError(res, 400, 'The client_secret provided does not match the client_secret associated with the PaymentIntent.', { param: 'client_secret' });
  res.json(expand(pi, req));
});

router.post('/v1/payment_intents/:id', (req, res) => {
  const pi = objects.get(req.params.id, 'payment_intent');
  if (!pi) return missing(res, 'payment_intent', req.params.id, 'intent');
  if (['succeeded', 'canceled'].includes(pi.status)) return stripeError(res, 400, `This PaymentIntent's amount could not be updated because it has a status of ${pi.status}.`, { code: 'payment_intent_unexpected_state' });
  const b = req.body || {};
  if (b.amount !== undefined) pi.amount = toInt(b.amount);
  for (const k of ['currency', 'description', 'receipt_email', 'customer', 'statement_descriptor', 'setup_future_usage', 'shipping']) if (b[k] !== undefined) pi[k] = k === 'currency' ? String(b[k]).toLowerCase() : b[k];
  if (b.metadata) pi.metadata = { ...pi.metadata, ...b.metadata };
  if (b.payment_method) {
    const pm = resolvePaymentMethod(b.payment_method);
    if (!pm) return missing(res, 'PaymentMethod', b.payment_method, 'payment_method');
    pi.payment_method = pm.id;
    pi.status = 'requires_confirmation';
  }
  savePI(pi);
  res.json(expand(pi, req));
});

router.post('/v1/payment_intents/:id/confirm', (req, res) => {
  const pi = objects.get(req.params.id, 'payment_intent');
  if (!pi) return missing(res, 'payment_intent', req.params.id, 'intent');
  confirmPI(pi, req.body || {}, res);
});

router.post('/v1/payment_intents/:id/capture', (req, res) => {
  const pi = objects.get(req.params.id, 'payment_intent');
  if (!pi) return missing(res, 'payment_intent', req.params.id, 'intent');
  if (pi.status !== 'requires_capture') {
    return stripeError(res, 400, `This PaymentIntent could not be captured because it has a status of ${pi.status}. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.`, { code: 'payment_intent_unexpected_state', extra: { payment_intent: pi } });
  }
  const amt = toInt(req.body?.amount_to_capture) ?? pi.amount_capturable;
  if (Number.isNaN(amt) || amt < 1 || amt > pi.amount_capturable) return stripeError(res, 400, 'The amount to capture must be less than or equal to the amount capturable.', { param: 'amount_to_capture', code: 'amount_too_large' });
  const ch = objects.get(pi.latest_charge, 'charge');
  Object.assign(ch, { captured: true, amount_captured: amt, balance_transaction: sid('txn') });
  if (amt < ch.amount) ch.amount_refunded = ch.amount - amt;
  objects.put(P, 'charge', ch.id, ch);
  Object.assign(pi, { status: 'succeeded', amount_received: amt, amount_capturable: 0 });
  savePI(pi);
  event('charge.captured', ch, pi.id);
  event('payment_intent.succeeded', pi, pi.id);
  res.json(expand(pi, req));
});

router.post('/v1/payment_intents/:id/cancel', (req, res) => {
  const pi = objects.get(req.params.id, 'payment_intent');
  if (!pi) return missing(res, 'payment_intent', req.params.id, 'intent');
  if (['succeeded', 'canceled', 'processing'].includes(pi.status)) {
    return stripeError(res, 400, `You cannot cancel this PaymentIntent because it has a status of ${pi.status}. Only a PaymentIntent with one of the following statuses may be canceled: requires_payment_method, requires_capture, requires_confirmation, requires_action, processing.`, { code: 'payment_intent_unexpected_state', extra: { payment_intent: pi } });
  }
  Object.assign(pi, { status: 'canceled', canceled_at: nowSec(), cancellation_reason: req.body?.cancellation_reason || null, amount_capturable: 0, next_action: null });
  savePI(pi);
  event('payment_intent.canceled', pi, pi.id);
  res.json(pi);
});

router.post('/v1/payment_methods', (req, res) => {
  const b = req.body || {};
  if (b.type !== 'card') return stripeError(res, 400, 'The mock only supports payment methods of type "card".', { param: 'type' });
  if (!b.card?.number && !b.card?.token) return stripeError(res, 400, 'Missing required param: card[number].', { code: 'parameter_missing', param: 'card[number]' });
  if (b.card.token) {
    const pm = resolvePaymentMethod(b.card.token);
    return pm ? res.json(pm) : missing(res, 'token', b.card.token, 'card[token]');
  }
  const { scenario, instrument } = scenarioFor(b.card);
  if (scenario === 'invalid_number') return stripeError(res, 402, 'Your card number is incorrect.', { type: 'card_error', code: 'incorrect_number', param: 'number' });
  res.json(createPaymentMethod(instrument, scenario, b.billing_details));
});

router.get('/v1/payment_methods/:id', (req, res) => {
  const pm = objects.get(req.params.id, 'payment_method');
  return pm ? res.json(pm) : missing(res, 'PaymentMethod', req.params.id);
});

router.get('/v1/charges', (req, res) => {
  res.json(listObjects('charge', '/v1/charges', req, req.query.payment_intent ? (c) => c.payment_intent === req.query.payment_intent : null));
});

router.get('/v1/charges/:id', (req, res) => {
  const ch = objects.get(req.params.id, 'charge');
  return ch ? res.json(expand(ch, req)) : missing(res, 'charge', req.params.id, 'charge');
});

router.post('/v1/refunds', (req, res) => {
  const b = req.body || {};
  let charge = null;
  if (b.charge) {
    charge = objects.get(b.charge, 'charge');
    if (!charge) return missing(res, 'charge', b.charge, 'charge');
  } else if (b.payment_intent) {
    const pi = objects.get(b.payment_intent, 'payment_intent');
    if (!pi) return missing(res, 'payment_intent', b.payment_intent, 'payment_intent');
    charge = pi.latest_charge && objects.get(pi.latest_charge, 'charge');
    if (!charge || pi.status !== 'succeeded') return stripeError(res, 400, `This PaymentIntent does not have a successful charge to refund.`, { code: 'charge_not_refundable', param: 'payment_intent' });
  } else {
    return stripeError(res, 400, 'One of the following params should be provided for this request: payment_intent or charge.', { code: 'parameter_missing' });
  }
  const amount = toInt(b.amount);
  const r = refund(charge, { amount, reason: b.reason, metadata: b.metadata });
  if (r.message) return stripeError(res, r.status, r.message, { code: r.code, param: r.param });
  res.json(r.refund);
});

router.get('/v1/refunds', (req, res) => {
  res.json(listObjects('refund', '/v1/refunds', req, (r) => (!req.query.payment_intent || r.payment_intent === req.query.payment_intent) && (!req.query.charge || r.charge === req.query.charge)));
});

router.get('/v1/refunds/:id', (req, res) => {
  const r = objects.get(req.params.id, 'refund');
  return r ? res.json(r) : missing(res, 'refund', req.params.id);
});

/* Customers (minimal) */
router.post('/v1/customers', (req, res) => {
  const b = req.body || {};
  const c = {
    id: sid('cus', 14),
    object: 'customer',
    address: b.address || null,
    balance: 0,
    created: nowSec(),
    currency: null,
    default_source: null,
    delinquent: false,
    description: b.description || null,
    discount: null,
    email: b.email || null,
    invoice_prefix: rand(8).toUpperCase(),
    invoice_settings: { custom_fields: null, default_payment_method: null, footer: null, rendering_options: null },
    livemode: false,
    metadata: b.metadata || {},
    name: b.name || null,
    next_invoice_sequence: 1,
    phone: b.phone || null,
    preferred_locales: [],
    shipping: b.shipping || null,
    tax_exempt: 'none',
    test_clock: null,
  };
  objects.put(P, 'customer', c.id, c, { lookup: c.email });
  res.json(c);
});

router.get('/v1/customers', (req, res) => res.json(listObjects('customer', '/v1/customers', req, req.query.email ? (c) => c.email === req.query.email : null)));

router.get('/v1/customers/:id', (req, res) => {
  const c = objects.get(req.params.id, 'customer');
  return c ? res.json(c) : missing(res, 'customer', req.params.id);
});

router.post('/v1/customers/:id', (req, res) => {
  const c = objects.get(req.params.id, 'customer');
  if (!c) return missing(res, 'customer', req.params.id);
  const b = req.body || {};
  for (const k of ['email', 'name', 'phone', 'description', 'address', 'shipping']) if (b[k] !== undefined) c[k] = b[k];
  if (b.metadata) c.metadata = { ...c.metadata, ...b.metadata };
  objects.put(P, 'customer', c.id, c, { lookup: c.email });
  res.json(c);
});

router.delete('/v1/customers/:id', (req, res) => {
  const c = objects.get(req.params.id, 'customer');
  if (!c) return missing(res, 'customer', req.params.id);
  objects.put(P, 'customer_deleted', c.id, c);
  res.json({ id: c.id, object: 'customer', deleted: true });
});

/* Checkout Sessions */
router.post('/v1/checkout/sessions', (req, res) => {
  const b = req.body || {};
  const mode = b.mode || 'payment';
  if (mode !== 'payment') return stripeError(res, 400, `The mock gateway only supports Checkout Sessions with mode=payment (got ${mode}).`, { param: 'mode' });
  if (!b.success_url && b.ui_mode !== 'embedded') return stripeError(res, 400, 'Missing required param: success_url.', { code: 'parameter_missing', param: 'success_url' });
  const rawItems = asArray(b.line_items);
  if (!rawItems.length) return stripeError(res, 400, 'Missing required param: line_items.', { code: 'parameter_missing', param: 'line_items' });
  const items = [];
  for (const [i, li] of rawItems.entries()) {
    if (!li.price_data) return stripeError(res, 400, `No such price: '${li.price}'. The mock gateway supports line_items[${i}][price_data] only.`, { code: 'resource_missing', param: `line_items[${i}][price]` });
    const unit = toInt(li.price_data.unit_amount);
    const qty = toInt(li.quantity) || 1;
    if (!Number.isInteger(unit) || unit < 0) return stripeError(res, 400, 'Invalid integer', { param: `line_items[${i}][price_data][unit_amount]`, code: 'parameter_invalid_integer' });
    const currency = String(li.price_data.currency || '').toLowerCase();
    if (!currency) return stripeError(res, 400, 'Missing required param: line_items[0][price_data][currency].', { code: 'parameter_missing', param: `line_items[${i}][price_data][currency]` });
    items.push({
      id: sid('li'),
      object: 'item',
      amount_discount: 0,
      amount_subtotal: unit * qty,
      amount_tax: 0,
      amount_total: unit * qty,
      currency,
      description: li.price_data.product_data?.name || 'Item',
      price: { id: sid('price'), object: 'price', active: false, billing_scheme: 'per_unit', created: nowSec(), currency, livemode: false, metadata: {}, product: sid('prod', 14), type: 'one_time', unit_amount: unit },
      quantity: qty,
    });
  }
  const amount = items.reduce((s, i) => s + i.amount_total, 0);
  const currency = items[0].currency;
  const id = `cs_test_${rand(58)}`;
  const s = {
    id,
    object: 'checkout.session',
    after_expiration: null,
    allow_promotion_codes: null,
    amount_subtotal: amount,
    amount_total: amount,
    automatic_tax: { enabled: false, liability: null, status: null },
    billing_address_collection: b.billing_address_collection || null,
    cancel_url: b.cancel_url || null,
    client_reference_id: b.client_reference_id || null,
    client_secret: null,
    consent: null,
    created: nowSec(),
    currency,
    custom_fields: [],
    customer: b.customer || null,
    customer_creation: b.customer ? null : 'if_required',
    customer_details: null,
    customer_email: b.customer_email || null,
    expires_at: toInt(b.expires_at) || nowSec() + 86400,
    invoice: null,
    livemode: false,
    locale: b.locale || null,
    metadata: b.metadata || {},
    mode,
    payment_intent: null,
    payment_link: null,
    payment_method_collection: 'if_required',
    payment_method_types: ['card'],
    payment_status: 'unpaid',
    phone_number_collection: { enabled: false },
    recovered_from: null,
    setup_intent: null,
    shipping_address_collection: null,
    shipping_cost: null,
    shipping_details: null,
    status: 'open',
    submit_type: b.submit_type || null,
    subscription: null,
    success_url: b.success_url || null,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: 'hosted',
    url: `${baseUrl()}/checkout/stripe/${id}`,
  };
  objects.put(P, 'checkout_session', id, s, { lookup: s.client_reference_id });
  objects.put(P, 'cs_line_items', `${id}:li`, { items, payment_intent_data: b.payment_intent_data || {} }, { parent: id });
  indexCheckout({ id, provider: P, kind: 'checkout_session', amount, currency, status: 'created', reference: s.client_reference_id, description: items.map((i) => i.description).join(', '), customer: s.customer_email ? { email: s.customer_email } : null });
  res.json(expand(s, req));
});

router.get('/v1/checkout/sessions', (req, res) => {
  res.json(listObjects('checkout_session', '/v1/checkout/sessions', req, req.query.payment_intent ? (s) => s.payment_intent === req.query.payment_intent : null));
});

router.get('/v1/checkout/sessions/:id', (req, res) => {
  const s = objects.get(req.params.id, 'checkout_session');
  return s ? res.json(expand(s, req)) : missing(res, 'checkout.session', req.params.id, 'session');
});

router.get('/v1/checkout/sessions/:id/line_items', (req, res) => {
  const li = objects.get(`${req.params.id}:li`);
  if (!li) return missing(res, 'checkout.session', req.params.id, 'session');
  res.json(list(li.items, `/v1/checkout/sessions/${req.params.id}/line_items`));
});

router.post('/v1/checkout/sessions/:id/expire', (req, res) => {
  const s = objects.get(req.params.id, 'checkout_session');
  if (!s) return missing(res, 'checkout.session', req.params.id, 'session');
  if (s.status !== 'open') return stripeError(res, 400, `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${s.status}".`);
  s.status = 'expired';
  objects.put(P, 'checkout_session', s.id, s);
  updateCheckoutStatus(s.id, 'expired');
  event('checkout.session.expired', s, s.id);
  res.json(s);
});

/* Events */
router.get('/v1/events', (req, res) => res.json(listObjects('event', '/v1/events', req, req.query.type ? (e) => e.type === req.query.type : null)));
router.get('/v1/events/:id', (req, res) => {
  const e = objects.get(req.params.id, 'event');
  return e ? res.json(e) : missing(res, 'event', req.params.id);
});

router.use('/v1', (req, res) => stripeError(res, 404, `Unrecognized request URL (${req.method}: ${req.originalUrl.split('?')[0]}). The mock gateway does not implement this Stripe endpoint.`));

/* ----------------------------- Checkout ----------------------------- */

function sessionReturn(s) {
  return s.success_url ? s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) : null;
}

function piReturn(pi, status) {
  const sim = objects.get(`${pi.id}:sim`);
  if (!sim?.return_url) return null;
  return {
    type: 'redirect',
    method: 'GET',
    url: sim.return_url,
    fields: { payment_intent: pi.id, payment_intent_client_secret: pi.client_secret, redirect_status: status },
  };
}

export const adapter = {
  name: P,
  label: 'Stripe',
  methods: ['card'],

  load(id, query) {
    if (id.startsWith('cs_')) {
      const s = objects.get(id, 'checkout_session');
      if (!s) return null;
      if (s.status === 'open' && s.expires_at < nowSec()) {
        s.status = 'expired';
        objects.put(P, 'checkout_session', s.id, s);
        updateCheckoutStatus(s.id, 'expired');
        event('checkout.session.expired', s, s.id);
      }
      const li = objects.get(`${id}:li`);
      return {
        amount: s.amount_total,
        currency: s.currency,
        description: li?.items.map((i) => (i.quantity > 1 ? `${i.description} × ${i.quantity}` : i.description)).join(', '),
        merchant: getSetting('merchant.name'),
        prefill: { email: s.customer_email || '' },
        status: { complete: 'paid', expired: 'expired' }[s.status] || 'open',
        cancelable: !!s.cancel_url,
        reference: s.client_reference_id,
      };
    }
    const pi = objects.get(id, 'payment_intent');
    if (!pi) return null;
    if (query.stage === 'authenticate' && pi.status !== 'requires_action') {
      return { amount: pi.amount, currency: pi.currency, merchant: getSetting('merchant.name'), status: pi.status === 'succeeded' ? 'paid' : 'open', stage: 'pay' };
    }
    return {
      amount: pi.amount,
      currency: pi.currency,
      description: pi.description || '',
      merchant: getSetting('merchant.name'),
      prefill: { email: pi.receipt_email || '' },
      status: pi.status === 'succeeded' || pi.status === 'requires_capture' ? 'paid' : pi.status === 'canceled' ? 'cancelled' : 'open',
      stage: pi.status === 'requires_action' ? 'authenticate' : 'pay',
      card: pi.status === 'requires_action' && pi.payment_method ? objects.get(pi.payment_method, 'payment_method')?.card : null,
    };
  },

  complete(id, result) {
    if (id.startsWith('cs_')) {
      const s = objects.get(id, 'checkout_session');
      if (!s || s.status !== 'open') return { status: 'failed', error: { message: 'This checkout session is no longer open' } };
      const li = objects.get(`${id}:li`);
      const pid = li?.payment_intent_data || {};
      let pi = s.payment_intent && objects.get(s.payment_intent, 'payment_intent');
      if (!pi) {
        pi = newPaymentIntent({ amount: s.amount_total, currency: s.currency, metadata: pid.metadata || {}, description: pid.description, capture_method: pid.capture_method, receipt_email: s.customer_email, customer: s.customer });
        s.payment_intent = pi.id;
        savePI(pi, { session: s.id });
        event('payment_intent.created', pi, s.id);
      }
      const pm = createPaymentMethod(result.instrument, result.status === 'success' ? 'success' : result.error.kind, { email: s.customer_email });
      if (result.status !== 'success') {
        const d = failPI(pi, pm, result.error.kind, { session: s.id });
        objects.put(P, 'checkout_session', s.id, s);
        return { status: 'failed', retryable: true, error: { message: d.message, code: d.decline_code || d.code }, next: null };
      }
      succeedPI(pi, pm, { session: s.id });
      Object.assign(s, {
        status: 'complete',
        payment_status: 'paid',
        customer_details: { address: null, email: s.customer_email || result.instrument.email || null, name: result.instrument.name || null, phone: null, tax_exempt: 'none', tax_ids: [] },
      });
      objects.put(P, 'checkout_session', s.id, s);
      updateCheckoutStatus(s.id, pi.status === 'succeeded' ? 'paid' : 'authorized', 'card');
      event('checkout.session.completed', s, s.id);
      const url = sessionReturn(s);
      return { status: 'success', payment_id: pi.id, next: url ? { type: 'redirect', method: 'GET', url, fields: {} } : null };
    }

    const pi = objects.get(id, 'payment_intent');
    if (!pi) return { status: 'failed', error: { message: 'PaymentIntent not found' } };
    let pm;
    if (pi.status === 'requires_action') {
      pm = objects.get(pi.payment_method, 'payment_method');
    } else if (['requires_payment_method', 'requires_confirmation'].includes(pi.status)) {
      pm = createPaymentMethod(result.instrument, result.status === 'success' ? 'success' : result.error.kind);
    } else {
      return { status: 'failed', error: { message: `PaymentIntent has status ${pi.status}` } };
    }
    if (result.status !== 'success') {
      const d = failPI(pi, pm, result.error.kind);
      return { status: 'failed', retryable: !piReturn(pi, 'failed'), error: { message: d.message, code: d.decline_code || d.code }, next: piReturn(pi, 'failed') };
    }
    succeedPI(pi, pm);
    return { status: 'success', payment_id: pi.id, next: piReturn(pi, 'succeeded') };
  },

  cancel(id) {
    if (id.startsWith('cs_')) {
      const s = objects.get(id, 'checkout_session');
      if (s?.cancel_url) return { type: 'redirect', method: 'GET', url: s.cancel_url, fields: {} };
      return { type: 'back' };
    }
    const pi = objects.get(id, 'payment_intent');
    if (pi?.status === 'requires_action') {
      const pm = objects.get(pi.payment_method, 'payment_method');
      failPI(pi, pm, 'authentication_failed');
      return piReturn(pi, 'failed') || { type: 'back' };
    }
    return { type: 'back' };
  },

  refund(id, amount) {
    let piId = id;
    if (id.startsWith('cs_')) piId = objects.get(id, 'checkout_session')?.payment_intent;
    const pi = piId && objects.get(piId, 'payment_intent');
    const ch = pi?.latest_charge && objects.get(pi.latest_charge, 'charge');
    if (!ch) return { error: 'No charge to refund' };
    const r = refund(ch, { amount });
    return r.message ? { error: r.message } : { ok: true, refund: r.refund };
  },
};
