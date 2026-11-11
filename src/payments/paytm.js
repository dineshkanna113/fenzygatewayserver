import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { indexCheckout, objects, updateCheckoutStatus } from '../db.js';
import { getSetting } from '../settings.js';
import { baseUrl, rand, randDigits } from '../util.js';
import { enqueue } from '../webhooks.js';

/**
 * Paytm Payments Gateway mock. Result codes and shapes follow Paytm's published API reference
 * (paytmpayments.com/docs/api: Initiate Transaction, Transaction Status v3, Refund, Refund Status,
 * Payment Status callback). Codes marked "unverified" are not in those pages.
 *
 *   base {PUBLIC_URL}/paytm ->
 *     POST /theia/api/v1/initiateTransaction?mid=&orderId=    returns txnToken (valid 15 minutes)
 *     GET|POST /theia/api/v1/showPaymentPage?mid=&orderId=&txnToken=   redirects to the hosted checkout
 *     POST /v3/order/status
 *     POST /refund/apply            (Paytm's path; /v3/order/refund is accepted too, because the upipay SDK calls it)
 *     POST /v2/refund/status
 *   After payment the browser is POSTed to callbackUrl with a CHECKSUMHASH, and the same fields go to
 *   the dashboard webhook URL ("paytm.webhookUrl") as a server-to-server form POST.
 */
const P = 'paytm';
const cfg = () => config.paytm;
const IV = '@@@@&&&&####$$$$';
const TOKEN_TTL_MS = 15 * 60 * 1000;

/* ---- Paytm checksum (paytmchecksum / Paytm_Node_Checksum algorithm) ---- */

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const keyOf = () => cfg().merchantKey.slice(0, 16);

/** Values sorted by key, joined with "|". null/undefined become empty strings. */
export function paramsString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => (params[k] === null || params[k] === undefined ? '' : String(params[k])))
    .join('|');
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export function generateChecksum(text, key = keyOf()) {
  const salt = crypto.randomBytes(2).toString('hex');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  return cipher.update(sha(`${text}|${salt}`) + salt, 'binary', 'base64') + cipher.final('base64');
}

export function verifyChecksum(text, checksum, key = keyOf()) {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, IV);
    const plain = d.update(String(checksum), 'base64', 'binary') + d.final('binary');
    const salt = plain.slice(-4);
    const a = Buffer.from(plain.slice(0, -4));
    const b = Buffer.from(sha(`${text}|${salt}`));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* ------------------------------- helpers ------------------------------- */

const ORDER_ID = /^[A-Za-z0-9@_.-]{1,50}$/;
const rupees = (paise) => (paise / 100).toFixed(2);
// Paytm sends naive timestamps in IST (UTC+05:30), not UTC.
const IST_MS = 330 * 60 * 1000;
const stamp = (ms = Date.now()) => `${new Date(ms + IST_MS).toISOString().slice(0, 19).replace('T', ' ')}.0`;

const info = (resultStatus, resultCode, resultMsg) => ({ resultStatus, resultCode, resultMsg });

function reply(res, body, status = 200) {
  res.status(status).json({ head: { responseTimestamp: String(Date.now()), version: 'v1', signature: generateChecksum(JSON.stringify(body)) }, body });
}

/**
 * Checks head.signature over the request body. Paytm's official libraries sign JSON.stringify(body) in
 * insertion order; upipay signs a key-sorted form. Both are accepted.
 * `api` picks the failure code: initiate uses 2005, the status and refund APIs use 330.
 */
function readSigned(req, res, api) {
  const initiate = api === 'initiate';
  const badChecksum = () => (initiate ? info('F', '2005', 'Checksum provided is invalid') : info('TXN_FAILURE', '330', 'Checksum provided is invalid'));
  const { body, head } = req.body || {};
  if (!body || typeof body !== 'object' || !head?.signature) {
    return reply(res, { resultInfo: initiate ? info('F', '1007', 'Missing mandatory element') : badChecksum() }), null;
  }
  if (!verifyChecksum(stableStringify(body), head.signature) && !verifyChecksum(JSON.stringify(body), head.signature)) {
    return reply(res, { resultInfo: badChecksum() }), null;
  }
  if (body.mid !== cfg().merchantId) {
    return reply(res, { resultInfo: initiate ? info('F', '2013', 'Mid in the query param doesn’t match with the Mid sent in the request') : info('TXN_FAILURE', '335', 'Mid is invalid') }), null;
  }
  return { body, head };
}

const MODES = { card: 'CC', netbanking: 'NB', upi: 'UPI', wallet: 'PPI' };

const DECLINED = 'Your payment has been declined by your bank. Please contact your bank for any queries. If money has been deducted from your account, your bank will inform us within 48 hrs and we will refund the same.';
/** error kind -> [code, message]. 141 (user cancelled) is unverified; the others are from Paytm's status and callback docs. */
function failureOf(kind, method) {
  if (kind === 'insufficient_funds' && method === 'wallet') return ['235', 'Wallet balance Insufficient, bankName=WALLET'];
  if (kind === 'upi_invalid_vpa') return ['295', 'Your payment failed as the UPI ID entered is incorrect. Please try again by entering a valid VPA or use a different method to complete the payment.'];
  if (kind === 'user_cancelled') return ['141', 'Customer cancelled the transaction'];
  if (['authentication_failed', 'processing_error', 'wallet_declined'].includes(kind)) return ['810', 'Payment failed due to a technical error. Please try after some time.'];
  return ['227', DECLINED];
}

/** An unpaid order: its txnToken lasts 15 minutes. Paytm sends no failure callback for it, so neither does the mock. */
function isExpired(o) {
  return o.state === 'PENDING' && Date.now() > o.createdAt + TOKEN_TTL_MS;
}

function statusBody(o) {
  const expired = isExpired(o);
  if (expired) updateCheckoutStatus(`ptm:${o.orderId}`, 'expired');
  const result = o.state === 'TXN_SUCCESS'
    ? info('TXN_SUCCESS', '01', 'Txn Success')
    : o.state === 'PENDING'
      ? expired ? info('PENDING', '402', 'Looks like the payment is not complete. Please wait while we confirm the status with your bank.') : info('PENDING', '400', 'Transaction status not confirmed yet.')
      : info('TXN_FAILURE', o.respCode, o.respMsg);
  return {
    resultInfo: result,
    txnId: o.txnId,
    bankTxnId: o.bankTxnId || '',
    orderId: o.orderId,
    txnAmount: rupees(o.amount),
    txnType: 'SALE',
    gatewayName: o.gatewayName || '',
    bankName: o.bankName || '',
    mid: o.mid,
    paymentMode: o.paymentMode || '',
    refundAmt: rupees(o.refunded || 0),
    txnDate: stamp(o.completedAt || o.createdAt),
  };
}

/** Fields Paytm posts to callbackUrl (browser) and to the webhook URL (server). */
function callbackFields(o) {
  const ok = o.state === 'TXN_SUCCESS';
  const f = {
    CURRENCY: 'INR',
    GATEWAYNAME: o.gatewayName || '',
    RESPMSG: ok ? 'Txn Success' : o.respMsg,
    BANKNAME: o.bankName || '',
    PAYMENTMODE: o.paymentMode || '',
    MID: o.mid,
    RESPCODE: ok ? '01' : o.respCode,
    TXNID: o.txnId,
    TXNAMOUNT: rupees(o.amount),
    ORDERID: o.orderId,
    STATUS: o.state,
    BANKTXNID: o.bankTxnId || '',
    TXNDATE: stamp(o.completedAt || Date.now()),
  };
  f.CHECKSUMHASH = generateChecksum(paramsString(f));
  return f;
}

function notify(o, event) {
  enqueue({
    provider: P,
    event,
    ref: `ptm:${o.orderId}`,
    url: getSetting('paytm.webhookUrl'),
    body: new URLSearchParams(callbackFields(o)).toString(),
    contentType: 'application/x-www-form-urlencoded',
  });
}

/* -------------------------------- routes -------------------------------- */

export const router = express.Router();

router.post('/theia/api/v1/initiateTransaction', (req, res) => {
  const signed = readSigned(req, res, 'initiate');
  if (!signed) return;
  const b = signed.body;
  const fail = (code, msg) => reply(res, { resultInfo: info('F', code, msg) });
  if (b.requestType !== 'Payment') return fail('1007', 'Missing mandatory element');
  if (req.query.mid && String(req.query.mid) !== b.mid) return fail('2013', 'Mid in the query param doesn’t match with the Mid sent in the request');
  if (req.query.orderId && String(req.query.orderId) !== String(b.orderId)) return fail('2014', 'OrderId in the query param doesn’t match with the OrderId sent in the request');
  if (!ORDER_ID.test(String(b.orderId || ''))) return fail('1007', 'Missing mandatory element'); // unverified: Paytm documents no code for a malformed orderId
  const amount = Math.round(parseFloat(b.txnAmount?.value) * 100);
  if (!Number.isFinite(amount) || amount < 100 || b.txnAmount?.currency !== 'INR') return fail('2007', 'Txn amount is invalid');
  if (!b.callbackUrl && !b.websiteName) return fail('1007', 'Missing mandatory element');
  const existing = objects.get(`ptm:${b.orderId}`, 'order');
  if (existing) {
    const same = existing.amount === amount && existing.callbackUrl === (b.callbackUrl || null) && existing.customer.id === (b.userInfo?.custId || null);
    return same
      ? reply(res, { resultInfo: info('S', '0002', 'Success Idempotent'), txnToken: existing.txnToken, isPromoCodeValid: false, authenticated: false })
      : fail('2023', 'Repeat Request Inconsistent');
  }
  const o = {
    mid: b.mid,
    orderId: b.orderId,
    amount,
    state: 'PENDING',
    txnToken: rand(32),
    txnId: `${randDigits(20)}`,
    callbackUrl: b.callbackUrl || null,
    website: b.websiteName || null,
    customer: { id: b.userInfo?.custId || null, mobile: b.userInfo?.mobile || null, email: b.userInfo?.email || null, name: b.userInfo?.firstName || null },
    refunded: 0,
    createdAt: Date.now(),
  };
  objects.put(P, 'order', `ptm:${o.orderId}`, o);
  indexCheckout({
    id: `ptm:${o.orderId}`, provider: P, kind: 'order', amount, currency: 'INR', status: 'created', reference: o.orderId,
    customer: o.customer.mobile || o.customer.email ? { phone: o.customer.mobile, email: o.customer.email } : null,
  });
  reply(res, { resultInfo: info('S', '0000', 'Success'), txnToken: o.txnToken, isPromoCodeValid: false, authenticated: false });
});

router.all('/theia/api/v1/showPaymentPage', (req, res) => {
  const o = objects.get(`ptm:${req.query.orderId}`, 'order');
  if (!o || o.mid !== req.query.mid || o.txnToken !== req.query.txnToken) {
    return res.status(400).type('text').send('Invalid or expired transaction token');
  }
  if (isExpired(o)) return res.status(400).type('text').send('Your Session has expired');
  res.redirect(302, `${baseUrl()}/checkout/paytm/${encodeURIComponent(o.orderId)}`);
});

router.post('/v3/order/status', (req, res) => {
  const signed = readSigned(req, res, 'status');
  if (!signed) return;
  const { orderId, mid } = signed.body;
  if (!ORDER_ID.test(String(orderId || ''))) return reply(res, { resultInfo: info('TXN_FAILURE', '334', 'Invalid Order ID'), orderId, mid });
  const o = objects.get(`ptm:${orderId}`, 'order');
  if (!o) return reply(res, { resultInfo: info('NO_RECORD_FOUND', '331', 'No Record Found'), orderId, mid });
  reply(res, statusBody(o));
});

const refundApply = (req, res) => {
  const signed = readSigned(req, res, 'refund');
  if (!signed) return;
  const b = signed.body;
  const bad = (code, msg) => reply(res, { resultInfo: info('TXN_FAILURE', code, msg), orderId: b.orderId, mid: b.mid, refId: b.refId });
  if (!b.orderId || !b.refId || !b.txnId || b.refundAmount === undefined || b.refundAmount === '') return bad('660', 'Missing mandatory refund request parameters');
  const o = objects.get(`ptm:${b.orderId}`, 'order');
  if (!o) return bad('673', 'Original transaction not found');
  if (String(b.txnId) !== o.txnId) return bad('627', 'Order Details Mismatch');
  if (o.state !== 'TXN_SUCCESS') return bad('679', 'Invalid refund request. Kindly retry once original order is successful.');
  const r = refundOrder(o, { amount: Math.round(parseFloat(b.refundAmount) * 100), refId: String(b.refId) });
  if (r.error) return bad(r.code, r.error);
  reply(res, {
    resultInfo: info('PENDING', '601', 'Refund request was raised for this transaction. But it is pending state.'),
    txnTimestamp: stamp(o.createdAt), orderId: o.orderId, mid: o.mid, refId: r.refund.refId, txnId: o.txnId, refundId: r.refund.refundId,
    refundAmount: rupees(r.refund.amount),
  });
};
router.post(['/refund/apply', '/v3/order/refund'], refundApply);

router.post('/v2/refund/status', (req, res) => {
  const signed = readSigned(req, res, 'refund');
  if (!signed) return;
  const b = signed.body;
  const r = objects.get(`ptmrefund:${b.refId}`);
  const o = r && objects.get(`ptm:${r.orderId}`, 'order');
  if (!r || r.orderId !== b.orderId) return reply(res, { resultInfo: info('TXN_FAILURE', '631', 'Record not found'), orderId: b.orderId, mid: b.mid, refId: b.refId });
  const done = r.state === 'TXN_SUCCESS';
  reply(res, {
    resultInfo: done ? info('TXN_SUCCESS', '10', 'Refund successful') : info('PENDING', '601', 'Refund request was raised for this transaction. But it is pending state.'),
    mid: o.mid, orderId: r.orderId, refId: r.refId, refundId: r.refundId, txnId: o.txnId, txnTimestamp: stamp(o.createdAt), source: 'Merchant',
    txnAmount: rupees(o.amount), refundAmount: rupees(r.amount), totalRefundAmount: rupees(o.refunded),
  });
});

router.use((req, res) => reply(res, { resultInfo: info('F', '00000900', `The mock gateway does not implement ${req.method} ${req.originalUrl.split('?')[0]}`) }, 404));

/* -------------------------------- refunds -------------------------------- */

function refundOrder(o, { amount, refId }) {
  if (!/^[A-Za-z0-9@_.-]{1,50}$/.test(refId)) return { error: 'Incorrect refund request parameters', code: '651' };
  const dup = objects.get(`ptmrefund:${refId}`);
  if (dup) return dup.state === 'TXN_SUCCESS' ? { error: 'Refund is already Successful', code: '629' } : { error: 'Refund Already Raised', code: '617' };
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'Invalid refund amount', code: '619' };
  if (amount < 100 && amount !== o.amount - o.refunded) return { error: 'Partial Refund under Rupee 1 is not allowed', code: '635' };
  if (amount > o.amount - o.refunded) return { error: 'Refund amount is invalid or greater than transaction amount', code: '674' };
  const refund = { refId, refundId: `${randDigits(18)}`, orderId: o.orderId, amount, state: 'PENDING', createdAt: Date.now() };
  o.refunded += amount;
  objects.put(P, 'order', `ptm:${o.orderId}`, o);
  objects.put(P, 'refund', `ptmrefund:${refId}`, refund, { parent: `ptm:${o.orderId}` });
  updateCheckoutStatus(`ptm:${o.orderId}`, o.refunded >= o.amount ? 'refunded' : 'partially_refunded');
  setTimeout(() => {
    refund.state = 'TXN_SUCCESS';
    objects.put(P, 'refund', `ptmrefund:${refId}`, refund);
  }, 1500).unref?.();
  return { refund };
}

/* ------------------------------- checkout ------------------------------- */

function settle(o, result) {
  const ok = result.status === 'success';
  const i = result.instrument || {};
  const [respCode, respMsg] = ok ? ['01', 'Txn Success'] : failureOf(result.error?.kind, result.method);
  Object.assign(o, {
    state: ok ? 'TXN_SUCCESS' : 'TXN_FAILURE',
    respCode,
    respMsg,
    paymentMode: result.method === 'card' ? (i.card_type === 'debit' ? 'DC' : 'CC') : MODES[result.method] || 'UPI',
    bankName: i.issuer || i.bank || (result.method === 'upi' ? 'UPI' : ''),
    gatewayName: result.method === 'upi' ? 'PPBL' : result.method === 'wallet' ? 'WALLET' : 'HDFC',
    bankTxnId: ok ? randDigits(12) : '',
    completedAt: Date.now(),
  });
  objects.put(P, 'order', `ptm:${o.orderId}`, o);
  updateCheckoutStatus(`ptm:${o.orderId}`, ok ? 'paid' : 'failed', result.method);
  notify(o, ok ? 'TXN_SUCCESS' : 'TXN_FAILURE');
  return ok;
}

const toCallback = (o) =>
  o.callbackUrl ? { type: 'redirect', method: 'POST', url: o.callbackUrl, fields: callbackFields(o) } : { type: 'back' };

export const adapter = {
  name: P,
  label: 'Paytm',

  load(id) {
    const o = objects.get(`ptm:${id}`, 'order');
    if (!o) return null;
    const expired = isExpired(o);
    if (expired) updateCheckoutStatus(`ptm:${o.orderId}`, 'expired');
    return {
      amount: o.amount,
      currency: 'INR',
      description: '',
      merchant: getSetting('merchant.name'),
      prefill: { contact: o.customer.mobile || '', email: o.customer.email || '', name: o.customer.name || '' },
      status: expired ? 'expired' : { TXN_SUCCESS: 'paid', TXN_FAILURE: 'failed' }[o.state] || 'open',
      reference: o.orderId,
      cancelable: true,
    };
  },

  complete(id, result) {
    const o = objects.get(`ptm:${id}`, 'order');
    if (!o || o.state !== 'PENDING') return { status: 'failed', error: { message: 'Order is no longer pending' } };
    if (isExpired(o)) return { status: 'failed', error: { message: 'Your session has expired. Start a new payment.', code: '1006' } };
    const ok = settle(o, result);
    return { status: ok ? 'success' : 'failed', payment_id: o.txnId, error: ok ? null : { message: o.respMsg, code: o.respCode }, next: toCallback(o) };
  },

  cancel(id) {
    const o = objects.get(`ptm:${id}`, 'order');
    if (!o) return { type: 'back' };
    if (o.state === 'PENDING' && !isExpired(o)) settle(o, { status: 'failed', method: 'upi', instrument: {}, error: { kind: 'user_cancelled', message: 'Customer cancelled the transaction' } });
    return toCallback(o);
  },

  refund(id, amount) {
    const o = objects.get(`ptm:${id}`, 'order');
    if (!o) return { error: 'Not found' };
    const r = refundOrder(o, { amount: amount || o.amount - o.refunded, refId: `RF${rand(20)}` });
    return r.error ? { error: r.error } : { ok: true, refund: r.refund };
  },
};
