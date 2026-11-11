import express from 'express';
import { config } from '../config.js';
import { indexCheckout, objects, updateCheckoutStatus } from '../db.js';
import { getSetting } from '../settings.js';
import { baseUrl, rand, randDigits, safeEqual, sha256 } from '../util.js';
import { enqueue } from '../webhooks.js';

/**
 * PhonePe PG mock.
 *  v1 "Standard Checkout" (salt key + X-VERIFY):  base {PUBLIC_URL}/phonepe   -> /pg/v1/pay, /pg/v1/status/{mid}/{txn}, /pg/v1/refund
 *  v2 "Standard Checkout" (OAuth O-Bearer):        base {PUBLIC_URL}/phonepe   -> /v1/oauth/token, /checkout/v2/pay, /checkout/v2/order/{id}/status,
 *                                                   /payments/v2/refund, /payments/v2/refund/{id}/status
 *  Production-style paths (/apis/identity-manager/..., /apis/pg/...) are accepted too.
 */
const P = 'phonepe';
const P2 = 'phonepe2';
const cfg = () => config.phonepe;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const xverify = (data) => `${sha256(data + cfg().saltKey)}###${cfg().saltIndex}`;

const ppError = (res, status, code, message, data = {}) => res.status(status).json({ success: false, code, message, data });

/* -------------------------------- v1 -------------------------------- */

function checkXVerify(req, res, data) {
  const given = String(req.headers['x-verify'] || '');
  if (!given) return ppError(res, 400, 'BAD_REQUEST', 'X-VERIFY header missing'), false;
  if (!safeEqual(given, xverify(data))) return ppError(res, 400, 'BAD_REQUEST', 'Please check the inputs you have provided.'), false;
  return true;
}

function decodeRequest(req, res, path) {
  const encoded = req.body?.request;
  if (!encoded) return ppError(res, 400, 'BAD_REQUEST', 'request is missing'), null;
  if (!checkXVerify(req, res, encoded + path)) return null;
  try {
    return unb64(encoded);
  } catch {
    return ppError(res, 400, 'BAD_REQUEST', 'Invalid request payload'), null;
  }
}

const RESPONSE_CODES = {
  card_declined: 'CARD_DECLINED',
  insufficient_funds: 'INSUFFICIENT_FUNDS',
  expired_card: 'CARD_EXPIRED',
  incorrect_cvc: 'INVALID_CVV',
  invalid_number: 'INVALID_CARD_NUMBER',
  processing_error: 'TXN_FAILED',
  authentication_failed: 'AUTHENTICATION_FAILED',
  bank_declined: 'BANK_DECLINED',
  upi_declined: 'ZA',
  upi_invalid_vpa: 'INVALID_VPA',
  wallet_declined: 'TXN_FAILED',
};

function v1Status(t) {
  const code = { COMPLETED: 'PAYMENT_SUCCESS', FAILED: 'PAYMENT_ERROR', PENDING: 'PAYMENT_PENDING' }[t.state];
  const message = { COMPLETED: 'Your payment is successful.', FAILED: 'Payment Failed', PENDING: 'Your payment is in pending state.' }[t.state];
  return {
    success: t.state === 'COMPLETED',
    code,
    message,
    data: {
      merchantId: t.merchantId,
      merchantTransactionId: t.merchantTransactionId,
      transactionId: t.transactionId,
      amount: t.amount,
      state: t.state,
      responseCode: t.responseCode,
      ...(t.responseCodeDescription ? { responseCodeDescription: t.responseCodeDescription } : {}),
      paymentInstrument: t.paymentInstrument,
      ...(t.feesContext ? { feesContext: t.feesContext } : {}),
    },
  };
}

function instrumentOf(result) {
  const i = result.instrument;
  if (result.method === 'card') {
    return { type: 'CARD', cardType: `${(i.card_type || 'credit').toUpperCase()}_CARD`, pgTransactionId: `PG${randDigits(16)}`, bankTransactionId: randDigits(12), pgAuthorizationCode: randDigits(6), arn: randDigits(23), bankId: i.issuer || 'HDFC', brn: `B${randDigits(11)}`, maskedCardNumber: `XXXXXXXXXXXX${i.last4}` };
  }
  if (result.method === 'netbanking') return { type: 'NETBANKING', pgTransactionId: `PG${randDigits(16)}`, pgServiceTransactionId: `PGS${randDigits(14)}`, bankTransactionId: randDigits(12), bankId: i.bank };
  if (result.method === 'upi') return { type: 'UPI', utr: randDigits(12), upiTransactionId: `YBL${rand(28)}`, accountHolderName: 'Test Payer', cardNetwork: null, accountType: 'SAVINGS', vpa: i.vpa };
  return { type: 'WALLET', walletType: (i.wallet || 'PHONEPE').toUpperCase(), pgTransactionId: `PG${randDigits(16)}` };
}

export const router = express.Router();

router.post('/pg/v1/pay', (req, res) => {
  const p = decodeRequest(req, res, '/pg/v1/pay');
  if (!p) return;
  if (p.merchantId !== cfg().merchantId) return ppError(res, 400, 'KEY_NOT_CONFIGURED', 'Key not found for the merchant');
  const amount = Number(p.amount);
  if (!Number.isInteger(amount) || amount < 100) return ppError(res, 400, 'BAD_REQUEST', 'amount must be an integer in paise >= 100');
  const mtid = String(p.merchantTransactionId || '');
  if (!/^[A-Za-z0-9_-]{1,38}$/.test(mtid)) return ppError(res, 400, 'BAD_REQUEST', 'merchantTransactionId must be 1-38 chars of A-Z a-z 0-9 _ -');
  if (objects.get(`ppv1:${mtid}`)) return ppError(res, 400, 'BAD_REQUEST', 'Duplicate merchantTransactionId');
  if (!p.redirectUrl) return ppError(res, 400, 'BAD_REQUEST', 'redirectUrl is required');
  const t = {
    merchantId: p.merchantId,
    merchantTransactionId: mtid,
    merchantUserId: p.merchantUserId || null,
    transactionId: `T${randDigits(22)}`,
    amount,
    state: 'PENDING',
    responseCode: 'PAYMENT_PENDING',
    paymentInstrument: null,
    redirectUrl: p.redirectUrl,
    redirectMode: (p.redirectMode || 'REDIRECT').toUpperCase(),
    callbackUrl: p.callbackUrl || null,
    mobileNumber: p.mobileNumber || null,
    createdAt: Date.now(),
  };
  objects.put(P, 'transaction', `ppv1:${mtid}`, t);
  indexCheckout({ id: `ppv1:${mtid}`, provider: P, kind: 'transaction', amount, currency: 'INR', status: 'created', reference: mtid, customer: p.mobileNumber ? { phone: p.mobileNumber } : null });
  res.json({
    success: true,
    code: 'PAYMENT_INITIATED',
    message: 'Payment initiated',
    data: { merchantId: t.merchantId, merchantTransactionId: mtid, instrumentResponse: { type: 'PAY_PAGE', redirectInfo: { url: `${baseUrl()}/checkout/phonepe/${encodeURIComponent(mtid)}`, method: 'GET' } } },
  });
});

router.get('/pg/v1/status/:mid/:mtid', (req, res) => {
  const { mid, mtid } = req.params;
  if (!checkXVerify(req, res, `/pg/v1/status/${mid}/${mtid}`)) return;
  if (mid !== cfg().merchantId) return ppError(res, 400, 'KEY_NOT_CONFIGURED', 'Key not found for the merchant');
  const t = objects.get(`ppv1:${mtid}`);
  if (!t || t.merchantId !== mid) return ppError(res, 200, 'TRANSACTION_NOT_FOUND', 'No Transaction found with the given details.');
  res.json(v1Status(t));
});

router.post('/pg/v1/refund', (req, res) => {
  const p = decodeRequest(req, res, '/pg/v1/refund');
  if (!p) return;
  if (p.merchantId !== cfg().merchantId) return ppError(res, 400, 'KEY_NOT_CONFIGURED', 'Key not found for the merchant');
  const orig = objects.get(`ppv1:${p.originalTransactionId}`);
  if (!orig) return ppError(res, 400, 'TRANSACTION_NOT_FOUND', 'No Transaction found with the given details.');
  const r = refundV1(orig, { amount: Number(p.amount), mtid: p.merchantTransactionId, callbackUrl: p.callbackUrl });
  if (r.error) return ppError(res, 400, r.code, r.error);
  res.json({ success: true, code: 'PAYMENT_SUCCESS', message: 'Your request has been successfully completed.', data: { merchantId: r.refund.merchantId, merchantTransactionId: r.refund.merchantTransactionId, transactionId: r.refund.transactionId, amount: r.refund.amount, state: 'COMPLETED', responseCode: 'SUCCESS' } });
});

function refundV1(orig, { amount, mtid, callbackUrl }) {
  if (orig.state !== 'COMPLETED') return { error: 'Original transaction is not successful', code: 'BAD_REQUEST' };
  if (!mtid || objects.get(`ppv1:${mtid}`)) return { error: 'Duplicate or missing merchantTransactionId', code: 'BAD_REQUEST' };
  const refunded = orig.refundedAmount || 0;
  if (!Number.isInteger(amount) || amount <= 0 || amount > orig.amount - refunded) return { error: 'Refund amount exceeds refundable amount', code: 'BAD_REQUEST' };
  const refund = {
    merchantId: orig.merchantId,
    merchantTransactionId: mtid,
    originalTransactionId: orig.merchantTransactionId,
    transactionId: `T${randDigits(22)}`,
    amount,
    state: 'COMPLETED',
    responseCode: 'SUCCESS',
    paymentInstrument: orig.paymentInstrument,
    isRefund: true,
    createdAt: Date.now(),
  };
  orig.refundedAmount = refunded + amount;
  objects.put(P, 'transaction', `ppv1:${orig.merchantTransactionId}`, orig);
  objects.put(P, 'refund', `ppv1:${mtid}`, refund, { parent: `ppv1:${orig.merchantTransactionId}` });
  updateCheckoutStatus(`ppv1:${orig.merchantTransactionId}`, orig.refundedAmount >= orig.amount ? 'refunded' : 'partially_refunded');
  if (callbackUrl) {
    const response = b64(v1Status(refund));
    enqueue({ provider: P, event: 'REFUND_SUCCESS', ref: `ppv1:${orig.merchantTransactionId}`, url: callbackUrl, body: JSON.stringify({ response }), headers: { 'X-VERIFY': xverify(response) } });
  }
  return { refund };
}

/* -------------------------------- v2 -------------------------------- */

function oauth(req, res) {
  const b = req.body || {};
  if (b.grant_type !== 'client_credentials') return res.status(400).json({ code: 'BAD_REQUEST', message: 'grant_type must be client_credentials' });
  if (!safeEqual(b.client_id, cfg().clientId) || !safeEqual(b.client_secret, cfg().clientSecret) || String(b.client_version) !== String(cfg().clientVersion)) {
    return res.status(401).json({ code: 'INVALID_CLIENT', message: 'Client Not Found' });
  }
  const now = Math.floor(Date.now() / 1000);
  const token = `${rand(32)}.${rand(64)}.${rand(43)}`;
  objects.put(P2, 'token', `pptok:${sha256(token)}`, { expires_at: now + 3600 });
  res.json({ access_token: token, encrypted_access_token: token, expires_in: null, issued_at: now, expires_at: now + 3600, session_expires_at: now + 3600, token_type: 'O-Bearer' });
}

function v2Auth(req, res, next) {
  const m = /^O-Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const tok = m && objects.get(`pptok:${sha256(m[1].trim())}`);
  if (!tok || tok.expires_at < Date.now() / 1000) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired O-Bearer access token' });
  next();
}

const v2Error = (res, status, code, message) => res.status(status).json({ code, message });

const MODES = { card: 'CARD', netbanking: 'NET_BANKING', upi: 'UPI_COLLECT', wallet: 'WALLET' };

function v2PaymentDetail(order, result) {
  const ok = result.status === 'success';
  const i = result.instrument;
  const detail = {
    paymentMode: result.method === 'upi' && i.flow === 'intent' ? 'UPI_INTENT' : MODES[result.method] || 'CARD',
    transactionId: `OM${randDigits(20)}`,
    timestamp: Date.now(),
    amount: order.amount,
    payableAmount: order.amount,
    feeAmount: 0,
    state: ok ? 'COMPLETED' : 'FAILED',
    splitInstruments: [
      {
        amount: order.amount,
        rail: result.method === 'upi' ? { type: 'UPI', utr: randDigits(12), upiTransactionId: `YBL${rand(28)}`, vpa: i.vpa } : { type: 'PG', transactionId: `PG${randDigits(16)}`, authorizationCode: randDigits(6), serviceTransactionId: `PGS${randDigits(14)}` },
        instrument: result.method === 'card' ? { type: `${(i.card_type || 'credit').toUpperCase()}_CARD`, bankTransactionId: randDigits(12), bankId: i.issuer, arn: randDigits(23), brn: `B${randDigits(11)}`, maskedCardNumber: `XXXXXXXXXXXX${i.last4}` } : result.method === 'netbanking' ? { type: 'NET_BANKING', bankId: i.bank, bankTransactionId: randDigits(12) } : { type: 'ACCOUNT', accountType: 'SAVINGS', maskedAccountNumber: 'XXXXXX1234' },
      },
    ],
  };
  if (!ok) Object.assign(detail, { errorCode: RESPONSE_CODES[result.error.kind] || 'TXN_FAILED', detailedErrorCode: result.error.kind.toUpperCase() });
  return detail;
}

// PhonePe always returns udf1..udf15, empty when the merchant sent nothing.
const metaOf = (m) => Object.assign(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`udf${i + 1}`, ''])), m || {});

function v2OrderView(o) {
  return {
    orderId: o.orderId,
    state: o.state,
    amount: o.amount,
    ...(o.state === 'COMPLETED' ? { payableAmount: o.amount, feeAmount: 0 } : {}),
    expireAt: o.expireAt,
    metaInfo: metaOf(o.metaInfo),
    ...(o.state === 'FAILED' && o.paymentDetails.length ? { errorCode: o.paymentDetails.at(-1).errorCode, detailedErrorCode: o.paymentDetails.at(-1).detailedErrorCode } : {}),
    paymentDetails: o.paymentDetails,
  };
}

function v2Webhook(event, o, extra = {}) {
  const payload = { merchantId: cfg().merchantId, merchantOrderId: o.merchantOrderId, ...v2OrderView(o), ...extra };
  enqueue({
    provider: P2,
    event,
    ref: `ppv2:${o.merchantOrderId}`,
    url: getSetting('phonepe.webhookUrl'),
    body: JSON.stringify({ event, type: event.toUpperCase().replace(/\./g, '_'), payload }),
    headers: { Authorization: sha256(`${cfg().webhookUsername}:${cfg().webhookPassword}`) },
  });
}

const OAUTH = ['/v1/oauth/token', '/apis/identity-manager/v1/oauth/token', '/apis/pg-sandbox/v1/oauth/token'];
const v2 = (path) => [path, `/apis/pg${path}`, `/apis/pg-sandbox${path}`];

router.post(OAUTH, oauth);

router.post(v2('/checkout/v2/pay'), v2Auth, (req, res) => {
  const b = req.body || {};
  const moid = String(b.merchantOrderId || '');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(moid)) return v2Error(res, 400, 'BAD_REQUEST', 'merchantOrderId must be 1-63 chars of A-Z a-z 0-9 _ -');
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount < 100) return v2Error(res, 400, 'BAD_REQUEST', 'amount must be an integer in paise >= 100');
  if (objects.get(`ppv2:${moid}`)) return v2Error(res, 400, 'BAD_REQUEST', 'Duplicate merchantOrderId');
  const flow = b.paymentFlow || {};
  if (flow.type !== 'PG_CHECKOUT') return v2Error(res, 400, 'BAD_REQUEST', 'paymentFlow.type must be PG_CHECKOUT');
  const expireAfter = Math.min(Math.max(Number(b.expireAfter) || 1200, 300), 3600);
  const o = {
    orderId: `OMO${randDigits(20)}`,
    merchantOrderId: moid,
    amount,
    state: 'PENDING',
    expireAt: Date.now() + expireAfter * 1000,
    metaInfo: b.metaInfo || {},
    paymentDetails: [],
    redirectUrl: flow.merchantUrls?.redirectUrl || null,
    message: flow.message || null,
    refunded: 0,
  };
  objects.put(P2, 'order', `ppv2:${moid}`, o, { lookup: o.orderId });
  indexCheckout({ id: `ppv2:${moid}`, provider: P2, kind: 'order', amount, currency: 'INR', status: 'created', reference: moid, description: flow.message });
  res.json({ orderId: o.orderId, state: 'PENDING', expireAt: o.expireAt, redirectUrl: `${baseUrl()}/checkout/phonepe2/${encodeURIComponent(moid)}` });
});

router.get(v2('/checkout/v2/order/:moid/status'), v2Auth, (req, res) => {
  const o = objects.get(`ppv2:${req.params.moid}`);
  if (!o) return v2Error(res, 404, 'INVALID_MERCHANT_ORDER_ID', 'No entry found for given merchant order id');
  expireV2(o);
  const view = v2OrderView(o);
  if (req.query.errorContext === 'true' && o.state === 'FAILED') {
    const last = o.paymentDetails.at(-1) || {};
    view.errorContext = { errorCode: last.errorCode, detailedErrorCode: last.detailedErrorCode, source: 'CUSTOMER', stage: 'AUTHENTICATION', description: o.lastErrorMessage || 'Payment failed' };
  }
  if (req.query.details !== 'true' && view.paymentDetails.length > 1) view.paymentDetails = view.paymentDetails.slice(-1);
  res.json(view);
});

router.post(v2('/payments/v2/refund'), v2Auth, (req, res) => {
  const b = req.body || {};
  const o = objects.get(`ppv2:${b.originalMerchantOrderId}`);
  if (!o) return v2Error(res, 404, 'ORDER_NOT_FOUND', 'No order found for originalMerchantOrderId');
  const r = refundV2(o, { amount: Number(b.amount), mrid: String(b.merchantRefundId || '') });
  if (r.error) return v2Error(res, 400, 'BAD_REQUEST', r.error);
  res.json({ refundId: r.refund.refundId, amount: r.refund.amount, state: 'PENDING' });
});

router.get(v2('/payments/v2/refund/:mrid/status'), v2Auth, (req, res) => {
  const r = objects.get(`ppv2refund:${req.params.mrid}`);
  if (!r) return v2Error(res, 404, 'REFUND_NOT_FOUND', 'No refund found for the given merchantRefundId');
  res.json(r);
});

function refundV2(o, { amount, mrid }) {
  if (o.state !== 'COMPLETED') return { error: 'Order is not completed' };
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(mrid)) return { error: 'merchantRefundId is invalid' };
  if (objects.get(`ppv2refund:${mrid}`)) return { error: 'Duplicate merchantRefundId' };
  if (!Number.isInteger(amount) || amount < 100) return { error: 'amount must be an integer in paise, at least 100' };
  if (amount > o.amount - o.refunded) return { error: 'Refund amount exceeds refundable amount' };
  const refund = {
    originalMerchantOrderId: o.merchantOrderId,
    merchantRefundId: mrid,
    refundId: `OMR${randDigits(20)}`,
    amount,
    state: 'PENDING',
    timestamp: Date.now(),
    paymentDetails: [],
  };
  o.refunded += amount;
  objects.put(P2, 'order', `ppv2:${o.merchantOrderId}`, o);
  objects.put(P2, 'refund', `ppv2refund:${mrid}`, refund, { parent: `ppv2:${o.merchantOrderId}` });
  setTimeout(() => {
    refund.state = 'COMPLETED';
    refund.splitInstruments = (o.paymentDetails.at(-1)?.splitInstruments || []).map((s) => ({ ...s, amount }));
    refund.paymentDetails = [{ paymentMode: o.paymentDetails.at(-1)?.paymentMode, transactionId: `OM${randDigits(20)}`, timestamp: Date.now(), amount, state: 'COMPLETED' }];
    objects.put(P2, 'refund', `ppv2refund:${mrid}`, refund);
    updateCheckoutStatus(`ppv2:${o.merchantOrderId}`, o.refunded >= o.amount ? 'refunded' : 'partially_refunded');
    enqueue({
      provider: P2,
      event: 'pg.refund.completed',
      ref: `ppv2:${o.merchantOrderId}`,
      url: getSetting('phonepe.webhookUrl'),
      body: JSON.stringify({ event: 'pg.refund.completed', type: 'PG_REFUND_COMPLETED', payload: { merchantId: cfg().merchantId, ...refund } }),
      headers: { Authorization: sha256(`${cfg().webhookUsername}:${cfg().webhookPassword}`) },
    });
  }, 1500).unref?.();
  return { refund };
}

function expireV2(o) {
  if (o.state === 'PENDING' && o.expireAt < Date.now()) {
    o.state = 'FAILED';
    o.paymentDetails.push({ paymentMode: null, transactionId: null, timestamp: Date.now(), amount: o.amount, state: 'FAILED', errorCode: 'TXN_AUTO_FAILED', detailedErrorCode: 'ORDER_EXPIRED' });
    objects.put(P2, 'order', `ppv2:${o.merchantOrderId}`, o);
    updateCheckoutStatus(`ppv2:${o.merchantOrderId}`, 'expired');
    v2Webhook('checkout.order.failed', o);
  }
}

router.use((req, res) => ppError(res, 404, 'NOT_FOUND', `The mock gateway does not implement ${req.method} ${req.originalUrl.split('?')[0]}`));

/* ----------------------------- Checkout ----------------------------- */

function v1Redirect(t) {
  if (t.redirectMode === 'POST') {
    const fields = {
      code: t.state === 'COMPLETED' ? 'PAYMENT_SUCCESS' : 'PAYMENT_ERROR',
      merchantId: t.merchantId,
      transactionId: t.merchantTransactionId,
      amount: String(t.amount),
      providerReferenceId: t.transactionId,
    };
    fields.checksum = xverify(Object.values(fields).join(''));
    return { type: 'redirect', method: 'POST', url: t.redirectUrl, fields };
  }
  return { type: 'redirect', method: 'GET', url: t.redirectUrl, fields: {} };
}

export const adapter = {
  name: P,
  label: 'PhonePe',

  load(id) {
    const t = objects.get(`ppv1:${id}`, 'transaction');
    if (!t) return null;
    return {
      amount: t.amount,
      currency: 'INR',
      description: '',
      merchant: getSetting('merchant.name'),
      prefill: { contact: t.mobileNumber || '' },
      status: { COMPLETED: 'paid', FAILED: 'failed' }[t.state] || 'open',
      reference: t.merchantTransactionId,
      cancelable: true,
    };
  },

  complete(id, result) {
    const t = objects.get(`ppv1:${id}`, 'transaction');
    if (!t || t.state !== 'PENDING') return { status: 'failed', error: { message: 'Transaction is no longer pending' } };
    const ok = result.status === 'success';
    Object.assign(t, {
      state: ok ? 'COMPLETED' : 'FAILED',
      responseCode: ok ? 'SUCCESS' : RESPONSE_CODES[result.error.kind] || 'TXN_FAILED',
      responseCodeDescription: ok ? null : result.error.message,
      paymentInstrument: instrumentOf(result),
      feesContext: ok ? { amount: 0 } : null,
      completedAt: Date.now(),
    });
    objects.put(P, 'transaction', `ppv1:${id}`, t);
    updateCheckoutStatus(`ppv1:${id}`, ok ? 'paid' : 'failed', result.method);
    if (t.callbackUrl) {
      const response = b64(v1Status(t));
      enqueue({ provider: P, event: ok ? 'PAYMENT_SUCCESS' : 'PAYMENT_ERROR', ref: `ppv1:${id}`, url: t.callbackUrl, body: JSON.stringify({ response }), headers: { 'X-VERIFY': xverify(response) } });
    }
    return { status: ok ? 'success' : 'failed', payment_id: t.transactionId, error: ok ? null : { message: result.error.message, code: t.responseCode }, next: v1Redirect(t) };
  },

  cancel(id) {
    const t = objects.get(`ppv1:${id}`, 'transaction');
    if (!t) return { type: 'back' };
    if (t.state === 'PENDING') {
      Object.assign(t, { state: 'FAILED', responseCode: 'USER_CANCEL', responseCodeDescription: 'User cancelled the payment', completedAt: Date.now() });
      objects.put(P, 'transaction', `ppv1:${id}`, t);
      updateCheckoutStatus(`ppv1:${id}`, 'cancelled');
      if (t.callbackUrl) {
        const response = b64(v1Status(t));
        enqueue({ provider: P, event: 'PAYMENT_ERROR', ref: `ppv1:${id}`, url: t.callbackUrl, body: JSON.stringify({ response }), headers: { 'X-VERIFY': xverify(response) } });
      }
    }
    return v1Redirect(t);
  },

  refund(id, amount) {
    const t = objects.get(`ppv1:${id}`, 'transaction');
    if (!t) return { error: 'Not found' };
    const r = refundV1(t, { amount: amount || t.amount - (t.refundedAmount || 0), mtid: `RF${rand(20)}` });
    return r.error ? { error: r.error } : { ok: true, refund: r.refund };
  },
};

export const adapterV2 = {
  name: P2,
  label: 'PhonePe v2',

  load(id) {
    const o = objects.get(`ppv2:${id}`, 'order');
    if (!o) return null;
    expireV2(o);
    return {
      amount: o.amount,
      currency: 'INR',
      description: o.message || '',
      merchant: getSetting('merchant.name'),
      status: o.state === 'COMPLETED' ? 'paid' : o.state === 'FAILED' ? 'failed' : 'open',
      reference: o.merchantOrderId,
      cancelable: true,
    };
  },

  complete(id, result, { query = {} }) {
    const o = objects.get(`ppv2:${id}`, 'order');
    if (!o || o.state !== 'PENDING') return { status: 'failed', error: { message: 'Order is no longer pending' } };
    const ok = result.status === 'success';
    const detail = v2PaymentDetail(o, result);
    if (!ok) o.lastErrorMessage = result.error.message;
    o.paymentDetails.push(detail);
    o.state = ok ? 'COMPLETED' : 'FAILED';
    objects.put(P2, 'order', `ppv2:${id}`, o);
    updateCheckoutStatus(`ppv2:${id}`, ok ? 'paid' : 'failed', result.method);
    v2Webhook(ok ? 'checkout.order.completed' : 'checkout.order.failed', o);
    const next = query.embedded
      ? { type: 'message', close: true, payload: { event: 'CONCLUDED' } }
      : o.redirectUrl ? { type: 'redirect', method: 'GET', url: o.redirectUrl, fields: {} } : null;
    return { status: ok ? 'success' : 'failed', payment_id: detail.transactionId, error: ok ? null : { message: result.error.message, code: detail.errorCode }, next };
  },

  cancel(id, { query = {} }) {
    const o = objects.get(`ppv2:${id}`, 'order');
    if (query.embedded) return { type: 'message', close: true, payload: { event: 'USER_CANCEL' } };
    return o?.redirectUrl ? { type: 'redirect', method: 'GET', url: o.redirectUrl, fields: {} } : { type: 'back' };
  },

  refund(id, amount) {
    const o = objects.get(`ppv2:${id}`, 'order');
    if (!o) return { error: 'Not found' };
    const r = refundV2(o, { amount: amount || o.amount - o.refunded, mrid: `RF${rand(20)}` });
    return r.error ? { error: r.error } : { ok: true, refund: r.refund };
  },
};

/** Test helpers exported for docs / client examples. */
export const phonepeChecksum = { xverify, b64, unb64 };
