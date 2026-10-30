import { config } from './config.js';
import { getSetting } from './settings.js';
import { log, sleep } from './util.js';

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Mock-Gateway', 'true');
  res.removeHeader('X-Powered-By');
  next();
}

// Dashboard sessions, Basic auth and Bearer token handling live in auth.js.
export { adminAuth } from './auth.js';

/** Fixed-window in-memory rate limiter per client IP. */
export function rateLimit() {
  const hits = new Map();
  let windowStart = Date.now();
  return (req, res, next) => {
    const limit = config.rateLimitPerMinute;
    if (!limit) return next();
    const now = Date.now();
    if (now - windowStart > 60_000) {
      hits.clear();
      windowStart = now;
    }
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > limit) {
      res.setHeader('Retry-After', Math.ceil((windowStart + 60_000 - now) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

/** Simulated latency / flaky upstream for provider API routes (set from the dashboard). */
export async function chaos(req, res, next) {
  const latency = getSetting('api.latencyMs');
  if (latency > 0) await sleep(Math.min(latency, 60_000));
  const rate = getSetting('api.failureRate');
  if (rate > 0 && Math.random() * 100 < rate) {
    return res.status(503).json({ error: { code: 'SERVER_ERROR', description: 'Simulated upstream failure (api.failureRate setting)' } });
  }
  next();
}

export function requestLog(req, res, next) {
  if (req.path === '/health' || req.path.startsWith('/assets/') || req.path === '/api/stream') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    log.info('request', { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms), ip: req.ip });
  });
  next();
}

export function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', description: `No mock route for ${req.method} ${req.path}` } });
}

 
export function errorHandler(err, req, res, next) {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', description: 'Request body too large' } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Malformed request body' } });
  log.error('unhandled error', { path: req.path, err: err.stack || err.message });
  if (res.headersSent) return;
  res.status(500).json({ error: { code: 'SERVER_ERROR', description: 'Internal mock server error' } });
}
