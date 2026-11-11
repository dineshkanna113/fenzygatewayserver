# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Paytm gateway mock** at `/paytm`: `initiateTransaction`, `showPaymentPage`, `/v3/order/status` and `/v3/order/refund`, with Paytm's AES checksum on requests, responses and callbacks. The hosted checkout, dashboard explorer, simulate and refund controls, and a signed form webhook (`PAYTM_WEBHOOK_URL`) all work for it.
- **upipay support**: `scripts/upipay-shim.mjs` points the upipay SDK (PhonePe and Paytm) at the mock without code changes. The test suite runs the real `upipay` package end to end.

- **Failure injection** in Settings: `checkout.nextFailure` (fail the next payment with a chosen error, once), `webhooks.duplicate` (deliver each webhook twice) and `webhooks.delaySeconds`.
- Paytm: unpaid orders expire after 15 minutes, and `POST /v2/refund/status` reports refund state.
- Dashboard: sortable columns, "Copy as curl" on webhook deliveries, and a dark theme that follows the system setting (bank and issuer pages stay light).
- `npm run test:ui`: a Playwright browser smoke test (sign-in, dashboard, card and 3-D Secure checkout, phone layout, dark mode, console and HTTP errors), run in CI. `scripts/capture-screenshots.mjs` regenerates the README screenshots.
- A test-card favicon, so browsers stop requesting a missing `/favicon.ico`.

### Fixed
- Dashboard no longer scrolls sideways on phones: the single grid column grew to fit the tab bar, which now scrolls inside itself.
- Form-control borders had about 2.5:1 contrast (WCAG asks for 3:1). They use a new `--edge` token at 4:1 or better in light and dark. A browser test now checks 24 colour pairs in both themes.
- PhonePe v2 now matches the published order-status and refund references: unknown orders return `INVALID_MERCHANT_ORDER_ID`, completed orders carry `payableAmount` and `feeAmount`, `metaInfo` always has `udf1` to `udf15`, `errorContext=true` returns the error block for failed orders, refunds under 100 paise are rejected, and a completed refund status includes `splitInstruments`.
- Paytm result codes now follow Paytm's published API reference instead of guesses: `2005` for a bad initiate checksum, `0002` for an idempotent repeat, `2023` for a conflicting repeat, `331` / `NO_RECORD_FOUND` for an unknown order, `402` as a `PENDING` status, and `330`, `335`, `617`, `619`, `627`, `629`, `635`, `660`, `673`, `674`, `679` and `631` for refunds. `295` is now the invalid-UPI-ID code (it was used for failed 3-D Secure), and bank declines use `227`.
- Paytm: `POST /refund/apply` (Paytm's real refund path) is served alongside upipay's `/v3/order/refund`, and the shim also maps `securegw-stage.paytmpayments.in`.
- Paytm: an unpaid order no longer turns into a failed transaction with a callback after 15 minutes. Paytm only expires the token, so the mock now returns `PENDING` / `402` and sends nothing.
- Paytm callbacks now carry `TXNDATE` in IST. They were in UTC, so any app using upipay's replay protection rejected every mock callback.

### Changed
- **New visual design** for sign-in, dashboard and hosted checkout, built around a test-card colour strip and a perforated ticket. Checkout is a two-part ticket (summary stub, payment pane) that stacks on phones. The dashboard is a ledger with binder-tab navigation, a provider switcher with copy-ready snippets, and a compact-rows toggle.
- Fonts are now self-hosted (Schibsted Grotesk, IBM Plex Mono) so the strict CSP still applies.
- Checkout picks black or white button text from the real WCAG contrast of the provider colour.

## [1.0.1] - 2026-10-31

The first release with a published Docker image: the v1.0.0 release workflow stopped at the Trivy step, which this version fixes.

### UI polish (Hallmark audit)
- Login, dashboard and checkout now pass a Hallmark audit (`--scope app`) with 0 Floor failures: visible keyboard focus rings, 4.5:1 text contrast, 3:1 field borders, reduced-motion fallbacks, and every colour as a token.
- Removed the purple-to-blue gradient from the login page, the emoji icons (replaced with SVG), uppercase letter-spaced labels and "A · B · C" strings.
- Dashboard: credential URLs no longer break mid-word, and Sign out is now reachable on phones.
- Checkout: the default Razorpay header colour is slightly darker for readable white text, and the UPI progress bar animates with `transform`.
- README: screenshots of the dashboard, SMS inbox, sign-in and the four-step checkout.

### Changed
- Startup configuration errors now say exactly what is wrong with `ADMIN_PASSWORD` (unset, the example value, or too short) and where to fix it.
- A warning is logged when `PUBLIC_URL` still points at localhost in production.
- `PUBLIC_URL` falls back to Render's `RENDER_EXTERNAL_URL`, so the Render Blueprint needs no manual values.
- `render.yaml` uses `autoDeployTrigger` (Render deprecated `autoDeploy`).

### Fixed
- CI: pin `aquasecurity/trivy-action` to the v0.36.0 commit (the old `0.28.0` tag no longer exists).
- Docker image no longer ships npm/yarn/corepack, which removes 6 HIGH CVEs found in npm's bundled dependencies.

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

[Unreleased]: https://github.com/dineshkanna113/fenzygatewayserver/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/dineshkanna113/fenzygatewayserver/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dineshkanna113/fenzygatewayserver/releases/tag/v1.0.0
