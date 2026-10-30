import * as cashfree from './cashfree.js';
import * as generic from './generic.js';
import * as phonepe from './phonepe.js';
import * as razorpay from './razorpay.js';
import * as stripe from './stripe.js';

/** Checkout adapters keyed by the provider segment used in /checkout/:provider/:id. */
export const adapters = {
  razorpay: razorpay.adapter,
  stripe: stripe.adapter,
  cashfree: cashfree.adapter,
  phonepe: phonepe.adapter,
  phonepe2: phonepe.adapterV2,
  generic: generic.adapter,
};

const PREFIX = { cashfree: 'cf:', phonepe: 'ppv1:', phonepe2: 'ppv2:' };

/** Dashboard index rows use namespaced ids for providers whose ids are merchant-chosen. */
export function checkoutIdFor(provider, indexId) {
  const p = PREFIX[provider];
  return p && indexId.startsWith(p) ? indexId.slice(p.length) : indexId;
}

export function checkoutUrlFor(provider, indexId) {
  return `/checkout/${provider}/${encodeURIComponent(checkoutIdFor(provider, indexId))}`;
}
