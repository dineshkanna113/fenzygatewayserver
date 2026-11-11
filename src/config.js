import crypto from 'node:crypto';
import fs from 'node:fs';

const env = process.env;

const str = (v, d) => (v === undefined || v === '' ? d : v);
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

function trustProxy(v) {
  if (v === undefined || v === '') return 'loopback, linklocal, uniquelocal';
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

const port = int(env.PORT, 4000);

const generatedAdminPassword = !env.ADMIN_PASSWORD;

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const config = {
  version: str(env.APP_VERSION, pkg.version),
  env: str(env.NODE_ENV, 'development'),
  host: str(env.HOST, '0.0.0.0'),
  port,
  // RENDER_EXTERNAL_URL is injected by Render for web services, so PUBLIC_URL can be left unset there.
  publicUrl: str(env.PUBLIC_URL, str(env.RENDER_EXTERNAL_URL, `http://localhost:${port}`)).replace(/\/+$/, ''),
  dataDir: str(env.DATA_DIR, './data'),
  trustProxy: trustProxy(env.TRUST_PROXY),
  merchantName: str(env.MERCHANT_NAME, 'Fenzy'),
  retentionDays: int(env.RETENTION_DAYS, 7),
  rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 1200),
  bodyLimit: str(env.BODY_LIMIT, '15mb'),
  logLevel: str(env.LOG_LEVEL, 'info'),

  admin: {
    username: str(env.ADMIN_USERNAME, 'admin'),
    password: str(env.ADMIN_PASSWORD, crypto.randomBytes(12).toString('base64url')),
    generatedPassword: generatedAdminPassword,
    // Optional bearer token for automated test suites calling /api/*
    token: str(env.ADMIN_API_TOKEN, ''),
  },

  smtp: {
    enabled: bool(env.SMTP_ENABLED, true),
    port: int(env.SMTP_PORT, 2525),
    // When both are set, SMTP clients must authenticate with them. Otherwise any credentials are accepted.
    username: str(env.SMTP_USERNAME, ''),
    password: str(env.SMTP_PASSWORD, ''),
    maxSize: int(env.SMTP_MAX_SIZE_BYTES, 15 * 1024 * 1024),
  },

  webhooks: {
    maxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 6),
    timeoutMs: int(env.WEBHOOK_TIMEOUT_MS, 10000),
  },

  otp: {
    ttlSeconds: int(env.OTP_TTL_SECONDS, 600),
    maxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
  },

  razorpay: {
    keyId: str(env.RAZORPAY_KEY_ID, 'rzp_test_mockkey000001'),
    keySecret: str(env.RAZORPAY_KEY_SECRET, 'mock_razorpay_secret'),
    webhookSecret: str(env.RAZORPAY_WEBHOOK_SECRET, 'mock_razorpay_webhook_secret'),
    webhookUrl: str(env.RAZORPAY_WEBHOOK_URL, ''),
    accountId: str(env.RAZORPAY_ACCOUNT_ID, 'acc_MockAccount0001'),
    autoCapture: bool(env.RAZORPAY_AUTO_CAPTURE, true),
  },

  stripe: {
    secretKey: str(env.STRIPE_SECRET_KEY, 'sk_test_mock_stripe_secret'),
    publishableKey: str(env.STRIPE_PUBLISHABLE_KEY, 'pk_test_mock_stripe_publishable'),
    webhookSecret: str(env.STRIPE_WEBHOOK_SECRET, 'whsec_mock_stripe_webhook_secret'),
    webhookUrl: str(env.STRIPE_WEBHOOK_URL, ''),
    apiVersion: str(env.STRIPE_API_VERSION, '2024-06-20'),
  },

  cashfree: {
    appId: str(env.CASHFREE_APP_ID, 'TEST_mock_cashfree_app_id'),
    secretKey: str(env.CASHFREE_SECRET_KEY, 'cfsk_ma_test_mock_cashfree_secret'),
    webhookUrl: str(env.CASHFREE_WEBHOOK_URL, ''),
  },

  phonepe: {
    // Standard Checkout v1 (salt key + X-VERIFY)
    merchantId: str(env.PHONEPE_MERCHANT_ID, 'PGTESTPAYUAT'),
    saltKey: str(env.PHONEPE_SALT_KEY, 'mock-phonepe-salt-key'),
    saltIndex: str(env.PHONEPE_SALT_INDEX, '1'),
    // Standard Checkout v2 (OAuth client credentials)
    clientId: str(env.PHONEPE_CLIENT_ID, 'MOCK_PHONEPE_CLIENT'),
    clientSecret: str(env.PHONEPE_CLIENT_SECRET, 'mock_phonepe_client_secret'),
    clientVersion: str(env.PHONEPE_CLIENT_VERSION, '1'),
    webhookUsername: str(env.PHONEPE_WEBHOOK_USERNAME, 'phonepe_webhook_user'),
    webhookPassword: str(env.PHONEPE_WEBHOOK_PASSWORD, 'phonepe_webhook_pass'),
    webhookUrl: str(env.PHONEPE_WEBHOOK_URL, ''),
  },

  paytm: {
    merchantId: str(env.PAYTM_MERCHANT_ID, 'MOCKPAYTM00000000001'),
    // The Paytm checksum uses the first 16 characters of this key as an AES-128 key.
    merchantKey: str(env.PAYTM_MERCHANT_KEY, 'mockpaytmkey0001'),
    website: str(env.PAYTM_WEBSITE, 'WEBSTAGING'),
    webhookUrl: str(env.PAYTM_WEBHOOK_URL, ''),
  },

  generic: {
    apiKey: str(env.GENERIC_API_KEY, 'mock_generic_api_key'),
    apiSecret: str(env.GENERIC_API_SECRET, 'mock_generic_api_secret'),
    webhookSecret: str(env.GENERIC_WEBHOOK_SECRET, 'mock_generic_webhook_secret'),
    webhookUrl: str(env.GENERIC_WEBHOOK_URL, ''),
  },

  twilio: {
    accountSid: str(env.TWILIO_ACCOUNT_SID, 'ACmock00000000000000000000000000'),
    authToken: str(env.TWILIO_AUTH_TOKEN, 'mock_twilio_auth_token'),
    defaultFrom: str(env.TWILIO_DEFAULT_FROM, '+15005550006'),
  },

  msg91: {
    authKey: str(env.MSG91_AUTH_KEY, 'mock_msg91_authkey'),
    senderId: str(env.MSG91_SENDER_ID, 'FENZY'),
    dlrUrl: str(env.MSG91_DLR_URL, ''),
    // JSON map of template_id -> template text using ##var## placeholders
    templates: (() => {
      try {
        return env.MSG91_TEMPLATES ? JSON.parse(env.MSG91_TEMPLATES) : {};
      } catch {
        console.error('MSG91_TEMPLATES is not valid JSON; ignoring');
        return {};
      }
    })(),
  },

  sendgrid: { apiKey: str(env.SENDGRID_API_KEY, 'SG.mock_sendgrid_api_key') },
  resend: { apiKey: str(env.RESEND_API_KEY, 're_mock_resend_api_key') },
  // SES requests are SigV4 signed; the mock checks the access key id in the Credential scope only.
  ses: { accessKeyId: str(env.SES_ACCESS_KEY_ID, '') },
};

/** Refuse to boot a production instance that still uses an unset or placeholder admin password. */
export function assertProductionReady() {
  if (config.env !== 'production') return [];
  const problems = [];
  const where = 'Set it in your host\'s environment variables (Render: service > Environment) and redeploy.';
  if (config.admin.generatedPassword) problems.push(`ADMIN_PASSWORD is not set. ${where}`);
  else if (/^change-me/i.test(config.admin.password)) problems.push(`ADMIN_PASSWORD is still the example value from .env.example. ${where}`);
  else if (config.admin.password.length < 12) problems.push(`ADMIN_PASSWORD is ${config.admin.password.length} characters; it must be at least 12. ${where}`);
  if (!/^https?:\/\//.test(config.publicUrl)) problems.push('PUBLIC_URL must be an absolute http(s) URL');
  return problems;
}

/** Non-fatal production warnings. */
export function productionWarnings() {
  if (config.env !== 'production') return [];
  const warnings = [];
  if (/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.publicUrl)) {
    warnings.push(`PUBLIC_URL is ${config.publicUrl}; checkout links and SDK scripts will point at localhost. Set it to this server's public https URL.`);
  }
  return warnings;
}
