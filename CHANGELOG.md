# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Startup configuration errors now say exactly what is wrong with `ADMIN_PASSWORD` (unset, the example value, or too short) and where to fix it.
- A warning is logged when `PUBLIC_URL` still points at localhost in production.
- `PUBLIC_URL` falls back to Render's `RENDER_EXTERNAL_URL`, so the Render Blueprint needs no manual values.
- `render.yaml` uses `autoDeployTrigger` (Render deprecated `autoDeploy`).

## [1.0.0] - 2026-10-31

First release.

### Payments
- Razorpay mock: orders, payments, capture, refunds, payment links, signed webhooks, and a `checkout.js` replacement.
- Stripe mock: PaymentIntents with 3-D Secure, Checkout Sessions, refunds, customers, events, idempotency keys, and `Stripe-Signature` webhooks.
- Cashfree PG mock (API version 2023-08-01): orders, payments, refunds, signed webhooks, and a `cashfree.js` replacement.
- PhonePe mock: Standard Checkout v1 (X-VERIFY checksums, S2S callback) and v2 (OAuth, iframe `PhonePeCheckout`).
- Generic payments API with signed return redirects and webhooks.
- Hosted checkout with card, UPI (collect, intent, QR), netbanking and wallet. The issuer OTP page allows 3 attempts, the OTP expires and can be resent, and a TEST MODE banner is always shown.

### SMS & email
- Twilio Messaging (status callbacks, magic test numbers) and Verify v2.
- MSG91 Flow, OTP send/verify/retry, and legacy send APIs.
- SMTP capture server, plus SendGrid v3, Resend, and AWS SES v2/v1 APIs.
- OTPs and links are detected automatically in SMS and email.

### Operations
- Dashboard with a sign-in page, live inboxes, a payment explorer (simulate, refund), a webhook log with redelivery, and runtime settings.
- Admin API for automated E2E tests.
- Durable webhook queue with retry and backoff, a retention cleanup job, rate limiting, and login lockout.
- Docker image (amd64 and arm64), Caddy production compose file, and a Render blueprint.
- CI/CD: lint, tests on Node 22 and 24, dependency audit, Docker smoke test, Trivy scan, versioned GHCR images, GitHub Releases, and automated deploy with live version verification.

[Unreleased]: https://github.com/OWNER/REPO/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/REPO/releases/tag/v1.0.0
