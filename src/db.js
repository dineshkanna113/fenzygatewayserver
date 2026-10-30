import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { emit } from './events.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'mock-gateway.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sms (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  from_addr TEXT,
  to_addr TEXT NOT NULL,
  to_key TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  otp TEXT,
  status TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sms_to_key ON sms(to_key, created_at);
CREATE INDEX IF NOT EXISTS sms_created ON sms(created_at);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  message_id TEXT,
  from_addr TEXT,
  to_addrs TEXT NOT NULL,
  cc_addrs TEXT,
  bcc_addrs TEXT,
  reply_to TEXT,
  rcpt TEXT NOT NULL,
  subject TEXT,
  text TEXT,
  html TEXT,
  otp TEXT,
  links TEXT,
  headers TEXT,
  meta TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emails_created ON emails(created_at);

CREATE TABLE IF NOT EXISTS email_attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  content BLOB
);
CREATE INDEX IF NOT EXISTS email_attachments_email ON email_attachments(email_id);

CREATE TABLE IF NOT EXISTS otps (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  channel TEXT,
  data TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otps_lookup ON otps(provider, scope, recipient, created_at);

-- One row per payable thing (order / checkout session / payment intent / transaction); feeds the dashboard.
CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  description TEXT,
  customer TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkouts_created ON checkouts(created_at);

-- Provider-native objects (orders, payments, refunds, intents, charges, sessions ...) stored as JSON.
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id TEXT,
  lookup TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_parent ON objects(parent_id, type);
CREATE INDEX IF NOT EXISTS objects_type ON objects(provider, type, created_at);
CREATE INDEX IF NOT EXISTS objects_lookup ON objects(provider, type, lookup);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event TEXT NOT NULL,
  ref TEXT,
  url TEXT,
  content_type TEXT NOT NULL,
  headers TEXT,
  signer TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  last_response TEXT,
  last_request_headers TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_due ON webhooks(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhooks_ref ON webhooks(ref);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const stmtCache = new Map();
/** Cached prepared statement. */
export function q(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const parseJson = (s, d = null) => {
  if (s === null || s === undefined) return d;
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};

/** Generic provider object store. */
export const objects = {
  get(id, type) {
    const row = type ? q('SELECT data FROM objects WHERE id = ? AND type = ?').get(id, type) : q('SELECT data FROM objects WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  },
  row(id) {
    const row = q('SELECT * FROM objects WHERE id = ?').get(id);
    return row ? { ...row, data: JSON.parse(row.data) } : null;
  },
  put(provider, type, id, data, { parent = null, lookup = null } = {}) {
    const now = Date.now();
    q(`INSERT INTO objects (id, provider, type, parent_id, lookup, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
         parent_id = COALESCE(excluded.parent_id, objects.parent_id), lookup = COALESCE(excluded.lookup, objects.lookup)`).run(
      id, provider, type, parent, lookup, JSON.stringify(data), now, now,
    );
    return data;
  },
  findBy(provider, type, lookup) {
    const row = q('SELECT data FROM objects WHERE provider = ? AND type = ? AND lookup = ? ORDER BY created_at DESC LIMIT 1').get(provider, type, String(lookup));
    return row ? JSON.parse(row.data) : null;
  },
  children(parentId, type) {
    const rows = type
      ? q('SELECT data FROM objects WHERE parent_id = ? AND type = ? ORDER BY created_at ASC, rowid ASC').all(parentId, type)
      : q('SELECT data FROM objects WHERE parent_id = ? ORDER BY created_at ASC, rowid ASC').all(parentId);
    return rows.map((r) => JSON.parse(r.data));
  },
  childRows(parentId) {
    return q('SELECT * FROM objects WHERE parent_id = ? ORDER BY created_at ASC, rowid ASC').all(parentId).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  },
  list(provider, type, { limit = 10, offset = 0 } = {}) {
    return q('SELECT data FROM objects WHERE provider = ? AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(provider, type, limit, offset)
      .map((r) => JSON.parse(r.data));
  },
  count(provider, type) {
    return q('SELECT COUNT(*) AS n FROM objects WHERE provider = ? AND type = ?').get(provider, type).n;
  },
};

/** Dashboard index of payable things. */
export function indexCheckout({ id, provider, kind, amount, currency, status, method = null, reference = null, description = null, customer = null }) {
  const now = Date.now();
  q(`INSERT INTO checkouts (id, provider, kind, amount, currency, status, method, reference, description, customer, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, status = excluded.status,
       method = COALESCE(excluded.method, checkouts.method), reference = COALESCE(excluded.reference, checkouts.reference),
       description = COALESCE(excluded.description, checkouts.description), customer = COALESCE(excluded.customer, checkouts.customer),
       updated_at = excluded.updated_at`).run(
    id, provider, kind, amount, String(currency).toUpperCase(), status, method, reference, description,
    customer ? JSON.stringify(customer) : null, now, now,
  );
  emit('payment', { id, provider, status });
}

export function updateCheckoutStatus(id, status, method) {
  q('UPDATE checkouts SET status = ?, method = COALESCE(?, method), updated_at = ? WHERE id = ?').run(status, method ?? null, Date.now(), id);
  emit('payment', { id, status });
}
