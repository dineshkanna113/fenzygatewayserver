import path from 'node:path';
import express from 'express';
import { router as adminApi } from './admin/api.js';
import { router as authRouter } from './auth.js';
import { config } from './config.js';
import * as email from './email/http.js';
import { adminAuth, chaos, errorHandler, notFound, rateLimit, requestLog, securityHeaders } from './middleware.js';
import * as cashfree from './payments/cashfree.js';
import * as checkout from './payments/checkout.js';
import * as genericPay from './payments/generic.js';
import * as phonepe from './payments/phonepe.js';
import * as razorpay from './payments/razorpay.js';
import * as stripe from './payments/stripe.js';
import * as genericMsg from './sms/generic.js';
import * as msg91 from './sms/msg91.js';
import * as twilio from './sms/twilio.js';

const PUBLIC = path.resolve(import.meta.dirname, '../public');

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.set('query parser', 'extended'); // Stripe-style expand[]=..., nested params

  app.use(securityHeaders, requestLog, rateLimit());
  app.use(express.json({ limit: config.bodyLimit, type: ['application/json', 'application/*+json', 'application/x-amz-json-1.0', 'application/x-amz-json-1.1'] }));
  app.use(express.urlencoded({ extended: true, limit: config.bodyLimit, parameterLimit: 10000 }));

  app.get('/health', (req, res) => res.json({ status: 'ok', version: config.version, uptime: Math.round(process.uptime()) }));
  app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));
  app.use('/assets', express.static(PUBLIC, { index: false, maxAge: '10m' }));

  // Admin login, dashboard + API
  app.use(authRouter);
  app.get('/', (req, res) => res.redirect(302, '/dashboard'));
  app.get('/dashboard', adminAuth, (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.sendFile(path.join(PUBLIC, 'dashboard.html'));
  });
  app.use('/api', adminAuth, adminApi);

  // Hosted checkout pages + JS SDKs
  app.use(checkout.router);

  // Payment gateways
  app.use('/razorpay', chaos, razorpay.router);
  app.use('/stripe', chaos, stripe.router);
  app.use('/cashfree', chaos, cashfree.router);
  app.use('/phonepe', chaos, phonepe.router);
  app.use('/generic', chaos, genericPay.router, genericMsg.router);

  // SMS
  app.use('/twilio', chaos, twilio.router);
  app.use('/msg91', chaos, msg91.router);

  // Email
  app.use('/sendgrid', chaos, email.sendgrid);
  app.use('/resend', chaos, email.resend);
  app.use('/ses', chaos, email.ses);

  // Root-level aliases for SDKs that cannot take a base path.
  app.use('/v3/mail/send', (req, res, next) => { req.url = '/v3/mail/send'; email.sendgrid(req, res, next); });
  app.use('/v2/email', chaos, email.ses);
  app.post('/', email.ses);
  app.use('/v1', chaos, (req, res, next) => { req.url = '/v1' + req.url; stripe.router(req, res, next); });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
