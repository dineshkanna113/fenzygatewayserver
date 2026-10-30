import { config } from './config.js';
import { q, parseJson } from './db.js';
import { emit } from './events.js';
import { log, rand } from './util.js';

/**
 * Durable webhook queue. Rows survive restarts; failed deliveries retry with backoff.
 * Signers recompute time-based signatures (Stripe, Cashfree) on every attempt, like the real providers.
 */
const signers = new Map();
export function registerSigner(name, fn) {
  signers.set(name, fn);
}

const BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];

export function enqueue({ provider, event, url, body, contentType = 'application/json', headers = {}, signer = null, ref = null, delayMs = 0 }) {
  const id = `whd_${rand(16)}`;
  const now = Date.now();
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const status = url ? 'pending' : 'skipped';
  q(`INSERT INTO webhooks (id, provider, event, ref, url, content_type, headers, signer, body, status, attempts, next_attempt_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(
    id, provider, event, ref, url || null, contentType, JSON.stringify(headers), signer, payload, status,
    url ? now + delayMs : null, url ? null : 'No webhook URL configured', now, now,
  );
  emit('webhook', { id, provider, event, status });
  if (url) setTimeout(tick, delayMs + 10).unref?.();
  return id;
}

export function retryWebhook(id) {
  const row = q('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (!row) return null;
  if (!row.url) return { error: 'This event had no webhook URL. Configure one in Settings and trigger the event again.' };
  q("UPDATE webhooks SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), id);
  setTimeout(tick, 10).unref?.();
  return getWebhook(id);
}

export function getWebhook(id) {
  const row = q('SELECT * FROM webhooks WHERE id = ?').get(id);
  return row ? formatRow(row) : null;
}

export function formatRow(row) {
  return {
    ...row,
    headers: parseJson(row.headers, {}),
    last_request_headers: parseJson(row.last_request_headers, null),
    body_json: parseJson(row.body, null),
  };
}

const inFlight = new Set();
let timer = null;

async function deliver(row) {
  inFlight.add(row.id);
  const attempt = row.attempts + 1;
  const headers = {
    'Content-Type': row.content_type,
    'User-Agent': `MockGateway-Webhooks/1.0 (${row.provider})`,
    ...parseJson(row.headers, {}),
  };
  try {
    const signer = row.signer && signers.get(row.signer);
    if (signer) Object.assign(headers, signer(row.body, row));
  } catch (e) {
    log.error('webhook signer failed', { id: row.id, err: e.message });
  }
  let status = null;
  let error = null;
  let response = null;
  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers,
      body: row.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.webhooks.timeoutMs),
    });
    status = res.status;
    response = (await res.text()).slice(0, 4000);
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (e) {
    error = e.name === 'TimeoutError' ? `Timed out after ${config.webhooks.timeoutMs}ms` : e.cause?.code || e.message;
  }
  const now = Date.now();
  let next = null;
  let state = 'delivered';
  if (error) {
    state = attempt >= config.webhooks.maxAttempts ? 'failed' : 'retrying';
    if (state === 'retrying') next = now + BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  }
  q(`UPDATE webhooks SET status = ?, attempts = ?, next_attempt_at = ?, last_status = ?, last_error = ?, last_response = ?, last_request_headers = ?, updated_at = ? WHERE id = ?`).run(
    state, attempt, next, status, error, response, JSON.stringify(headers), now, row.id,
  );
  inFlight.delete(row.id);
  log.info('webhook delivery', { id: row.id, provider: row.provider, event: row.event, url: row.url, attempt, status, error, state });
  emit('webhook', { id: row.id, provider: row.provider, event: row.event, status: state });
}

function tick() {
  const due = q(`SELECT * FROM webhooks WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 20`).all(Date.now());
  for (const row of due) if (!inFlight.has(row.id)) deliver(row);
}

export function startWebhookWorker() {
  if (timer) return;
  timer = setInterval(tick, 1000);
  timer.unref?.();
}

export function stopWebhookWorker() {
  clearInterval(timer);
  timer = null;
}

export async function drainWebhooks(timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (inFlight.size && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}
