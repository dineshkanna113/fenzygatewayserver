import { startRetention } from './admin/api.js';
import { createApp } from './app.js';
import { assertProductionReady, config } from './config.js';
import { db } from './db.js';
import { startSmtp } from './email/smtp.js';
import { log } from './util.js';
import { drainWebhooks, startWebhookWorker, stopWebhookWorker } from './webhooks.js';

const problems = assertProductionReady();
if (problems.length) {
  for (const p of problems) log.error('configuration error', { problem: p });
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  log.info('mock gateway listening', { version: config.version, port: config.port, public_url: config.publicUrl, env: config.env });
  log.info('dashboard', { url: `${config.publicUrl}/dashboard`, username: config.admin.username });
  if (config.admin.generatedPassword) {
    log.warn('ADMIN_PASSWORD is not set; generated a random one for this run. Set ADMIN_PASSWORD to keep it stable.', { password: config.admin.password });
  }
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const smtp = startSmtp();
startWebhookWorker();
startRetention();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  stopWebhookWorker();
  smtp?.close();
  server.close();
  await drainWebhooks(5000);
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: e?.stack || String(e) }));
