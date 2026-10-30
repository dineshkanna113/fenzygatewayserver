import { digits, luhn } from '../util.js';

/**
 * Provider-neutral payment outcome engine. Checkout pages, the admin "simulate" API and
 * Stripe test payment methods all resolve to a Result:
 *   { status: 'success' | 'failed' | 'otp_required', method, instrument, error?: { kind, message } }
 * Each provider adapter maps `error.kind` to its own codes.
 */

export const ERRORS = {
  card_declined: 'Your card was declined by the issuing bank.',
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card: 'Your card has expired.',
  incorrect_cvc: "Your card's security code is incorrect.",
  invalid_number: 'Your card number is invalid.',
  processing_error: 'An error occurred while processing your card. Try again.',
  authentication_failed: 'Card authentication (3D Secure / OTP) failed.',
  bank_declined: 'The transaction was declined by your bank.',
  upi_declined: 'The UPI request was declined by the payer.',
  upi_invalid_vpa: 'The UPI ID is invalid.',
  wallet_declined: 'The wallet payment was declined.',
  user_cancelled: 'Payment was cancelled by the user.',
};

/** Test cards. Any other Luhn-valid number succeeds. */
export const TEST_CARDS = {
  '4111111111111111': { outcome: 'success', label: 'Visa - success' },
  '4242424242424242': { outcome: 'success', label: 'Visa - success' },
  '5555555555554444': { outcome: 'success', label: 'Mastercard - success' },
  '5267318187975449': { outcome: 'success', label: 'Mastercard (domestic) - success' },
  '378282246310005': { outcome: 'success', label: 'Amex - success' },
  '6074819900004939': { outcome: 'success', label: 'RuPay - success' },
  '4000000000003220': { outcome: 'otp', label: 'Visa - 3D Secure / OTP required (OTP 123456)' },
  '5200000000001096': { outcome: 'otp', label: 'Mastercard - 3D Secure / OTP required (OTP 123456)' },
  '4000000000000002': { outcome: 'card_declined', label: 'Declined' },
  '4000000000009995': { outcome: 'insufficient_funds', label: 'Insufficient funds' },
  '4000000000000069': { outcome: 'expired_card', label: 'Expired card' },
  '4000000000000127': { outcome: 'incorrect_cvc', label: 'Incorrect CVC' },
  '4000000000000119': { outcome: 'processing_error', label: 'Processing error' },
};

export const SUCCESS_OTP = '123456';

export const BANKS = [
  { code: 'HDFC', name: 'HDFC Bank', cf: 3021 },
  { code: 'ICIC', name: 'ICICI Bank', cf: 3022 },
  { code: 'SBIN', name: 'State Bank of India', cf: 3044 },
  { code: 'UTIB', name: 'Axis Bank', cf: 3003 },
  { code: 'KKBK', name: 'Kotak Mahindra Bank', cf: 3032 },
  { code: 'YESB', name: 'Yes Bank', cf: 3058 },
  { code: 'PUNB', name: 'Punjab National Bank', cf: 3038 },
  { code: 'BARB', name: 'Bank of Baroda', cf: 3005 },
  { code: 'IDFB', name: 'IDFC FIRST Bank', cf: 3024 },
  { code: 'INDB', name: 'IndusInd Bank', cf: 3026 },
  { code: 'CNRB', name: 'Canara Bank', cf: 3009 },
  { code: 'UBIN', name: 'Union Bank of India', cf: 3054 },
];

export const WALLETS = [
  { code: 'paytm', name: 'Paytm' },
  { code: 'phonepe', name: 'PhonePe' },
  { code: 'amazonpay', name: 'Amazon Pay' },
  { code: 'mobikwik', name: 'MobiKwik' },
  { code: 'freecharge', name: 'Freecharge' },
];

export function cardBrand(num) {
  const d = digits(num);
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^(60|65|81|82|508|353|356)/.test(d)) return 'rupay';
  if (/^6011|^64[4-9]/.test(d)) return 'discover';
  if (/^3(0[0-5]|[68])/.test(d)) return 'diners';
  if (/^35/.test(d)) return 'jcb';
  if (/^(5018|5020|5038|6304|6759|676[1-3])/.test(d)) return 'maestro';
  return 'unknown';
}

const fail = (method, instrument, kind) => ({ status: 'failed', method, instrument, error: { kind, message: ERRORS[kind] || kind } });

/**
 * @param {object} input { method, card: {number, expiry|exp_month+exp_year, cvc, name}, otp, bank, bank_outcome,
 *                         vpa, upi_outcome, wallet, wallet_outcome, force: 'success'|'failed', error }
 */
export function decide(input = {}) {
  const method = input.method || 'card';
  if (method === 'card') return decideCard(input);
  if (method === 'netbanking') {
    const bank = BANKS.find((b) => b.code === input.bank) || { code: input.bank || 'HDFC', name: input.bank || 'HDFC Bank' };
    const instrument = { type: 'netbanking', bank: bank.code, bank_name: bank.name, cf_code: bank.cf };
    if (input.force === 'failed' || input.bank_outcome === 'failed') return fail(method, instrument, input.error || 'bank_declined');
    return { status: 'success', method, instrument };
  }
  if (method === 'upi') {
    const vpa = String(input.vpa || 'success@upi').trim().toLowerCase();
    const instrument = { type: 'upi', vpa, flow: input.upi_flow || 'collect' };
    if (input.upi_flow !== 'intent' && !/^[a-z0-9._-]{2,256}@[a-z]{2,64}$/.test(vpa)) return fail(method, instrument, 'upi_invalid_vpa');
    if (input.force === 'failed' || input.upi_outcome === 'declined' || /^fail/.test(vpa)) return fail(method, instrument, input.error || 'upi_declined');
    return { status: 'success', method, instrument };
  }
  if (method === 'wallet') {
    const wallet = WALLETS.find((w) => w.code === input.wallet) || { code: input.wallet || 'paytm', name: input.wallet || 'Paytm' };
    const instrument = { type: 'wallet', wallet: wallet.code, wallet_name: wallet.name };
    if (input.force === 'failed' || input.wallet_outcome === 'failed') return fail(method, instrument, input.error || 'wallet_declined');
    return { status: 'success', method, instrument };
  }
  return fail(method, { type: method }, 'processing_error');
}

function decideCard(input) {
  const c = input.card || {};
  const number = digits(c.number || '4111111111111111');
  const brand = cardBrand(number);
  let expMonth = parseInt(c.exp_month, 10);
  let expYear = parseInt(c.exp_year, 10);
  if (c.expiry) {
    const m = /^(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(String(c.expiry).trim());
    if (m) {
      expMonth = parseInt(m[1], 10);
      expYear = parseInt(m[2], 10);
    }
  }
  if (expYear < 100) expYear += 2000;
  const instrument = {
    type: 'card',
    brand,
    network: brand === 'unknown' ? 'Unknown' : brand[0].toUpperCase() + brand.slice(1),
    last4: number.slice(-4),
    bin: number.slice(0, 6),
    card_type: /^5267|^6074|^6521/.test(number) ? 'debit' : 'credit',
    exp_month: expMonth || 12,
    exp_year: expYear || new Date().getFullYear() + 3,
    name: c.name || '',
    issuer: brand === 'rupay' ? 'SBIN' : 'HDFC',
  };
  if (input.force === 'success') return { status: 'success', method: 'card', instrument };
  if (input.force === 'failed') return fail('card', instrument, input.error || 'card_declined');
  if (!luhn(number)) return fail('card', instrument, 'invalid_number');
  if (expMonth && expYear) {
    const now = new Date();
    if (expMonth < 1 || expMonth > 12 || expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) {
      return fail('card', instrument, 'expired_card');
    }
  }
  const scenario = TEST_CARDS[number]?.outcome || 'success';
  if (scenario === 'success') return { status: 'success', method: 'card', instrument };
  if (scenario === 'otp') {
    if (input.otp === undefined || input.otp === null || input.otp === '') return { status: 'otp_required', method: 'card', instrument };
    if (String(input.otp) === SUCCESS_OTP) return { status: 'success', method: 'card', instrument, authenticated: true };
    return fail('card', instrument, 'authentication_failed');
  }
  return fail('card', instrument, scenario);
}
