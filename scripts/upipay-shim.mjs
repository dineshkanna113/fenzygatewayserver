/**
 * Points the `upipay` SDK at this mock gateway without changing application code.
 *
 * upipay hardcodes the PhonePe and Paytm hosts and has no base-URL option, so this module wraps
 * `globalThis.fetch` and rewrites those hosts to the mock:
 *
 *   https://api-preprod.phonepe.com/apis/pg-sandbox/...  ->  {MOCK}/phonepe/...
 *   https://securestage.paytmpayments.com/...             ->  {MOCK}/paytm/...
 *
 * Use it in a test or staging process only:
 *
 *   MOCK_GATEWAY_URL=http://localhost:4000 node --import ./scripts/upipay-shim.mjs app.js
 *
 * Or from code: `import { installUpipayShim, toMock } from './scripts/upipay-shim.mjs'`.
 *
 * Paytm's `paymentUrl` is built inside upipay from the real Paytm host, so wrap it in `toMock()`
 * before you redirect the customer. PhonePe returns the checkout URL from the mock itself.
 *
 * Production hosts are left alone unless MOCK_GATEWAY_INCLUDE_PRODUCTION=1.
 */

const SANDBOX = [
  ['https://api-preprod.phonepe.com/apis/pg-sandbox', '/phonepe'],
  ['https://securestage.paytmpayments.com', '/paytm'],
  ['https://securegw-stage.paytmpayments.in', '/paytm'], // Paytm's own host for status and refund calls
];
const PRODUCTION = [
  ['https://api.phonepe.com/apis/hermes', '/phonepe'],
  ['https://secure.paytmpayments.com', '/paytm'],
];

let mockUrl = '';
let table = SANDBOX;
let realFetch = null;

/** Rewrites a PSP URL to the mock. Returns the input unchanged when it is not a PSP URL. */
export function toMock(url) {
  const s = String(url);
  for (const [from, to] of table) {
    if (s === from || s.startsWith(`${from}/`) || s.startsWith(`${from}?`)) return mockUrl + to + s.slice(from.length);
  }
  return s;
}

/** Installs the fetch wrapper. Returns a function that removes it. */
export function installUpipayShim(url = process.env.MOCK_GATEWAY_URL, { includeProduction = process.env.MOCK_GATEWAY_INCLUDE_PRODUCTION === '1' } = {}) {
  if (!url) throw new Error('installUpipayShim: pass the mock gateway URL or set MOCK_GATEWAY_URL');
  mockUrl = String(url).replace(/\/+$/, '');
  table = includeProduction ? [...SANDBOX, ...PRODUCTION] : SANDBOX;
  if (realFetch) return () => {};
  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) return realFetch(toMock(input), init);
    if (input && typeof input.url === 'string') {
      const rewritten = toMock(input.url);
      if (rewritten !== input.url) return realFetch(new Request(rewritten, input), init);
    }
    return realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
    realFetch = null;
  };
}

if (process.env.MOCK_GATEWAY_URL) installUpipayShim();
