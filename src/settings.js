import { config } from './config.js';
import { q } from './db.js';

/**
 * Runtime-editable settings (from the dashboard). Values stored in the DB override env defaults.
 * Only keys listed here can be set.
 */
const DEFINITIONS = {
  'merchant.name': { type: 'string', label: 'Merchant name shown on checkout', default: () => config.merchantName },
  'razorpay.webhookUrl': { type: 'url', label: 'Razorpay webhook URL', default: () => config.razorpay.webhookUrl },
  'stripe.webhookUrl': { type: 'url', label: 'Stripe webhook URL', default: () => config.stripe.webhookUrl },
  'cashfree.webhookUrl': { type: 'url', label: 'Cashfree webhook URL (used when order has no notify_url)', default: () => config.cashfree.webhookUrl },
  'phonepe.webhookUrl': { type: 'url', label: 'PhonePe v2 webhook URL', default: () => config.phonepe.webhookUrl },
  'generic.webhookUrl': { type: 'url', label: 'Generic payments webhook URL (used when payment has no webhook_url)', default: () => config.generic.webhookUrl },
  'msg91.dlrUrl': { type: 'url', label: 'MSG91 delivery report URL', default: () => config.msg91.dlrUrl },
  'api.latencyMs': { type: 'int', label: 'Artificial latency added to provider API calls (ms)', default: () => 0 },
  'api.failureRate': { type: 'int', label: 'Random 5xx failure rate for provider APIs (0-100 %)', default: () => 0 },
  'checkout.upiAutoApproveSeconds': { type: 'int', label: 'UPI collect auto-approve after (seconds, 0 = manual)', default: () => 8 },
  'sms.deliveryStatus': { type: 'enum', values: ['delivered', 'failed', 'undelivered'], label: 'Simulated SMS delivery status', default: () => 'delivered' },
};

let cache = null;

function load() {
  cache = new Map(q('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

function coerce(def, value) {
  if (value === null || value === undefined || value === '') return def.type === 'int' ? 0 : '';
  if (def.type === 'int') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error('must be a non-negative integer');
    return n;
  }
  if (def.type === 'url') {
    const u = new URL(String(value));
    if (!/^https?:$/.test(u.protocol)) throw new Error('must be an http(s) URL');
    return u.toString();
  }
  if (def.type === 'enum' && !def.values.includes(value)) throw new Error(`must be one of ${def.values.join(', ')}`);
  return String(value);
}

export function getSetting(key) {
  if (!cache) load();
  const def = DEFINITIONS[key];
  if (!def) throw new Error(`Unknown setting ${key}`);
  if (cache.has(key)) return coerce(def, cache.get(key));
  return def.default();
}

export function allSettings() {
  if (!cache) load();
  return Object.entries(DEFINITIONS).map(([key, def]) => ({
    key,
    label: def.label,
    type: def.type,
    values: def.values,
    value: getSetting(key),
    overridden: cache.has(key),
    default: def.default(),
  }));
}

/** Pass null to reset a key to its env default. */
export function setSettings(patch) {
  if (!cache) load();
  const errors = {};
  const writes = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const def = DEFINITIONS[key];
    if (!def) {
      errors[key] = 'unknown setting';
      continue;
    }
    if (value === null) {
      writes.push([key, null]);
      continue;
    }
    try {
      writes.push([key, String(coerce(def, value))]);
    } catch (e) {
      errors[key] = e.message;
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  for (const [key, value] of writes) {
    if (value === null) q('DELETE FROM settings WHERE key = ?').run(key);
    else q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  load();
  return { ok: true };
}
