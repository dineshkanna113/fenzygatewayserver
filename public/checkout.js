(function () {
  'use strict';

  var C = window.__CHECKOUT__;
  var app = document.getElementById('app');
  if (!C) return;

  /* ------------------------------ helpers ------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var ZERO_DECIMAL = ['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF', 'ISK', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'RWF', 'VUV', 'XPF'];
  function money(minor, cur) {
    var v = ZERO_DECIMAL.indexOf(cur) >= 0 ? minor : minor / 100;
    try {
      return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur }).format(v);
    } catch (e) {
      return cur + ' ' + v.toFixed(2);
    }
  }
  function digits(s) { return String(s || '').replace(/\D+/g, ''); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function luhn(num) {
    var d = digits(num);
    if (d.length < 12 || d.length > 19) return false;
    var sum = 0;
    for (var i = 0; i < d.length; i++) {
      var n = +d[d.length - 1 - i];
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }
  function brandOf(num) {
    var d = digits(num);
    if (/^4/.test(d)) return 'visa';
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return 'mastercard';
    if (/^3[47]/.test(d)) return 'amex';
    if (/^(60|65|81|82|508|353|356)/.test(d)) return 'rupay';
    if (/^6011|^64[4-9]/.test(d)) return 'discover';
    if (/^3(0[0-5]|[68])/.test(d)) return 'diners';
    if (/^35/.test(d)) return 'jcb';
    return '';
  }
  function formatCard(num) {
    var d = digits(num).slice(0, 19);
    if (brandOf(d) === 'amex') return [d.slice(0, 4), d.slice(4, 10), d.slice(10, 15)].filter(Boolean).join(' ');
    return d.replace(/(\d{4})(?=\d)/g, '$1 ');
  }
  function hexLum(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 0;
    var n = parseInt(m[1], 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  var root = document.documentElement;
  root.style.setProperty('--brand', C.theme);
  if (hexLum(C.theme) > 0.65) root.style.setProperty('--brand-ink', '#0f172a');
  if (C.embedded) document.body.classList.add('embedded');
  document.title = C.merchant + ' · Secure Checkout';

  var AMOUNT = money(C.amount, C.currency);

  var I = {
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
    card: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/></svg>',
    upi: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3l-4 9h6l-2 9 10-12h-6l3-6z"/></svg>',
    bank: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/></svg>',
    wallet: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-3"/><path d="M21 8h-6a3 3 0 000 6h6V8z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="check-path" d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };

  var METHODS = {
    card: { title: 'Card', sub: 'Visa, Mastercard, RuPay, Amex & more', icon: I.card },
    upi: { title: 'UPI', sub: 'Pay with any UPI app or UPI ID', icon: I.upi },
    netbanking: { title: 'Netbanking', sub: 'All major Indian banks', icon: I.bank },
    wallet: { title: 'Wallet', sub: 'Paytm, PhonePe, Amazon Pay & more', icon: I.wallet },
  };
  var BANK_COLORS = { HDFC: '#004c8f', ICIC: '#ae282e', SBIN: '#22409a', UTIB: '#97144d', KKBK: '#ed1c24', YESB: '#0060aa', PUNB: '#a6192e', BARB: '#f15a22', IDFB: '#9c1d26', INDB: '#8b1d41', CNRB: '#0091d5', UBIN: '#e31e24' };
  var WALLET_COLORS = { paytm: '#00baf2', phonepe: '#5f259f', amazonpay: '#ff9900', mobikwik: '#0057ff', freecharge: '#f26522' };

  var methods = (C.methods || []).filter(function (m) { return METHODS[m]; });
  var single = methods.length === 1 ? methods[0] : null;

  var S = {
    screen: C.status !== 'open' ? 'status' : C.stage === 'authenticate' ? 'authenticate' : single || 'methods',
    card: { number: '', expiry: '', cvc: '', name: C.prefill.name || '' },
    errors: {},
    vpa: '',
    bank: null,
    wallet: null,
    upi: null,
    otpCard: null,
    lastInput: null,
    result: null,
    timers: [],
  };

  if (S.screen === 'authenticate') initOtp();

  function post(msg) {
    if (C.embedded && window.parent !== window) window.parent.postMessage(Object.assign({ __mockgw: true }, msg), '*');
  }

  function clearTimers() {
    S.timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    S.timers = [];
  }

  function go(screen) {
    clearTimers();
    S.screen = screen;
    render();
  }

  function toast(text) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  /* ------------------------------ layout ------------------------------ */

  function head() {
    var logo = C.image ? '<img src="' + esc(C.image) + '" alt="">' : esc((C.merchant || 'M').trim().charAt(0).toUpperCase());
    var payer = [C.prefill.contact, C.prefill.email].filter(Boolean).map(esc).join('<br>');
    var closable = C.embedded || C.cancelable;
    var lockScreens = ['processing', 'success'];
    return '<div class="sheet-head"><div class="test-banner">TEST MODE</div>' +
      '<div class="head-row"><div class="logo">' + logo + '</div>' +
      '<div class="merchant"><div class="merchant-name">' + esc(C.merchant) + '</div>' +
      '<div class="merchant-desc">' + esc(C.description || C.label + ' secure checkout') + '</div></div>' +
      (closable && lockScreens.indexOf(S.screen) < 0 && S.screen !== 'status' ? '<button class="icon-btn" data-action="close" aria-label="Cancel payment">' + I.close + '</button>' : '') +
      '</div><div class="amount-row"><div><div class="amount-label">Amount payable</div><div class="amount">' + AMOUNT + '</div></div>' +
      (payer ? '<div class="payer">' + payer + '</div>' : '') + '</div></div>';
  }

  function foot() {
    return '<div class="sheet-foot"><span class="test-pill">TEST MODE</span><span class="lock">' + I.lock + ' Secured by ' + esc(C.label) + ' &middot; mock, no real money</span></div>';
  }

  function backLink() {
    return single ? '' : '<button class="back-link" data-action="back">' + I.back + ' All payment options</button>';
  }

  function field(id, label, inner, err) {
    return '<div class="field"><label for="' + id + '">' + label + '</label>' + inner + (err ? '<div class="error-text">' + esc(err) + '</div>' : '') + '</div>';
  }

  /* ------------------------------ screens ------------------------------ */

  var screens = {
    methods: function () {
      return '<p class="section-title">Payment options</p><div class="methods">' + methods.map(function (m) {
        var d = METHODS[m];
        return '<button class="method" data-action="method" data-m="' + m + '"><span class="method-icon">' + d.icon + '</span>' +
          '<span class="method-text"><span class="method-title">' + d.title + '</span><br><span class="method-sub">' + d.sub + '</span></span>' +
          '<span class="chev">' + I.chev + '</span></button>';
      }).join('') + '</div>';
    },

    card: function () {
      var c = S.card, e = S.errors, brand = brandOf(c.number);
      return backLink() + '<form data-form="card" novalidate>' +
        field('cc-number', 'Card number', '<div class="input-wrap"><input class="input has-badge' + (e.number ? ' invalid' : '') + '" id="cc-number" name="number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" maxlength="23" value="' + esc(formatCard(c.number)) + '">' +
          '<span class="badge-in" id="cc-brand"' + (brand ? '' : ' hidden') + '>' + esc(brand) + '</span></div>', e.number) +
        '<div class="row">' +
        field('cc-exp', 'Expiry', '<input class="input' + (e.expiry ? ' invalid' : '') + '" id="cc-exp" name="expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / YY" maxlength="7" value="' + esc(c.expiry) + '">', e.expiry) +
        field('cc-cvc', 'CVV', '<input class="input' + (e.cvc ? ' invalid' : '') + '" id="cc-cvc" name="cvc" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="•••" maxlength="4" value="' + esc(c.cvc) + '">', e.cvc) +
        '</div>' +
        field('cc-name', 'Name on card', '<input class="input" id="cc-name" name="name" autocomplete="cc-name" placeholder="Full name" value="' + esc(c.name) + '">') +
        '<button class="btn" type="submit">Pay ' + AMOUNT + '</button></form>' +
        '<details class="testcards"><summary>Test cards <span>tap to fill</span></summary>' +
        C.testCards.map(function (t) {
          return '<button class="tc" data-action="fill-card" data-n="' + t.number + '"><code>' + esc(formatCard(t.number)) + '</code><span>' + esc(t.label) + '</span></button>';
        }).join('') + '</details>' +
        '<div class="hint">Use any future expiry and any 3-digit CVV. Any other valid card number succeeds.</div>';
    },

    upi: function () {
      var apps = [['gpay', 'Google Pay', '#1a73e8'], ['phonepe', 'PhonePe', '#5f259f'], ['paytm', 'Paytm', '#00baf2'], ['bhim', 'BHIM', '#f37021']];
      return backLink() +
        '<p class="section-title">Pay using UPI app</p><div class="upi-apps">' + apps.map(function (a) {
          return '<button class="tile" data-action="upi-app" data-app="' + a[0] + '" data-name="' + a[1] + '"><span class="mono" style="background:' + a[2] + '">' + a[1].charAt(0) + '</span>' + a[1] + '</button>';
        }).join('') + '</div>' +
        '<button class="btn secondary" data-action="upi-qr">Show QR code</button>' +
        '<div class="divider">or enter UPI ID</div>' +
        '<form data-form="upi" novalidate>' +
        field('vpa', 'UPI ID', '<input class="input' + (S.errors.vpa ? ' invalid' : '') + '" id="vpa" name="vpa" placeholder="yourname@bank" autocomplete="off" autocapitalize="none" value="' + esc(S.vpa) + '">', S.errors.vpa) +
        '<button class="btn" type="submit">Verify and pay ' + AMOUNT + '</button></form>' +
        '<div class="hint">Test UPI IDs: <code>success@upi</code> approves, <code>failure@upi</code> is declined. Any other valid ID waits for approval.</div>';
    },

    upi_qr: function () {
      return '<button class="back-link" data-action="method" data-m="upi">' + I.back + ' Back</button>' +
        '<div class="state-screen" style="padding-top:0">' + qrSvg() + '<p><strong>Scan with any UPI app</strong></p><p class="muted small">QR valid for 5 minutes</p></div>' +
        '<div class="btn-row"><button class="btn ok" data-action="qr-pay">Simulate scan &amp; pay</button><button class="btn secondary" data-action="qr-fail">Simulate failure</button></div>';
    },

    upi_wait: function () {
      var auto = C.upiAutoApproveSeconds > 0 && !/^fail/.test(S.upi.vpa);
      return '<div class="state-screen"><div class="state-icon wait">' + I.clock + '</div>' +
        '<h2>Approve payment</h2><p class="muted">' + (S.upi.flow === 'intent' ? 'Complete the payment in ' + esc(S.upi.app) : 'A collect request was sent to <strong>' + esc(S.upi.vpa) + '</strong>') + '</p>' +
        '<p class="muted small">Open your UPI app and approve the request from ' + esc(C.merchant) + '.</p>' +
        '<div class="progress"><div id="upi-bar" style="width:100%"></div></div><p class="muted small">Expires in <span id="upi-left">5:00</span>' + (auto ? ' &middot; auto-approves in <span id="upi-auto">' + C.upiAutoApproveSeconds + '</span>s' : '') + '</p></div>' +
        '<div class="btn-row"><button class="btn ok" data-action="upi-approve">Simulate approve</button><button class="btn danger" data-action="upi-decline">Simulate decline</button></div>';
    },

    netbanking: function () {
      var popular = ['HDFC', 'ICIC', 'SBIN', 'UTIB', 'KKBK', 'YESB'];
      return backLink() + '<p class="section-title">Popular banks</p><div class="grid">' + popular.map(function (code) {
        var b = C.banks.filter(function (x) { return x.code === code; })[0];
        return '<button class="tile" data-action="bank" data-code="' + code + '"><span class="mono" style="background:' + BANK_COLORS[code] + '">' + esc(b.name.charAt(0)) + '</span>' + esc(b.name.replace(/ Bank$| of India$/, '')) + '</button>';
      }).join('') + '</div>' +
        field('bank-all', 'All banks', '<select class="input" id="bank-all" data-change="bank"><option value="">Select a bank</option>' + C.banks.map(function (b) {
          return '<option value="' + b.code + '">' + esc(b.name) + '</option>';
        }).join('') + '</select>');
    },

    bank_redirect: function () {
      return '<div class="state-screen"><div class="spinner"></div><h2>Redirecting to ' + esc(S.bank.name) + '</h2><p class="muted">Please do not refresh the page or press back.</p></div>';
    },

    bank: function () {
      var color = BANK_COLORS[S.bank.code] || '#334155';
      return '<div class="bank-page"><div class="bank-bar" style="background:' + color + '"><span class="mono" style="width:30px;height:30px;border-radius:6px;background:rgba(255,255,255,.2);display:grid;place-items:center">' + esc(S.bank.name.charAt(0)) + '</span><div>' + esc(S.bank.name) + '<small>NetBanking &middot; simulated</small></div></div>' +
        '<div class="bank-content"><div class="sim-note">Simulated bank page &middot; choose the outcome</div>' +
        '<div class="bank-amount"><span>Pay to ' + esc(C.merchant) + '</span><strong>' + AMOUNT + '</strong></div>' +
        field('nb-user', 'Customer ID', '<input class="input" id="nb-user" value="TESTUSER01">') +
        field('nb-pass', 'Password', '<input class="input" id="nb-pass" type="password" value="password">') +
        '<div class="btn-row"><button class="btn ok" data-action="bank-success">Success</button><button class="btn danger" data-action="bank-fail">Failure</button></div></div></div>' +
        '<p style="text-align:center;margin-top:14px"><button class="link-btn" data-action="method" data-m="netbanking">Choose another bank</button></p>';
    },

    wallet: function () {
      return backLink() + '<p class="section-title">Wallets</p><div class="methods">' + C.wallets.map(function (w) {
        return '<button class="method" data-action="wallet" data-code="' + w.code + '"><span class="method-icon" style="background:' + WALLET_COLORS[w.code] + ';color:#fff;font-weight:800">' + esc(w.name.charAt(0)) + '</span>' +
          '<span class="method-text"><span class="method-title">' + esc(w.name) + '</span></span><span class="chev">' + I.chev + '</span></button>';
      }).join('') + '</div>';
    },

    wallet_page: function () {
      var color = WALLET_COLORS[S.wallet.code] || '#334155';
      return '<div class="bank-page"><div class="bank-bar" style="background:' + color + '">' + esc(S.wallet.name) + '<small style="margin-left:auto">simulated wallet</small></div>' +
        '<div class="bank-content"><div class="sim-note">Simulated wallet page &middot; choose the outcome</div>' +
        '<div class="bank-amount"><span>Wallet balance</span><strong>' + money(Math.max(C.amount * 3, 500000), C.currency) + '</strong></div>' +
        '<div class="bank-amount"><span>Pay to ' + esc(C.merchant) + '</span><strong>' + AMOUNT + '</strong></div>' +
        '<div class="btn-row"><button class="btn ok" data-action="wallet-success">Success</button><button class="btn danger" data-action="wallet-fail">Failure</button></div></div></div>' +
        '<p style="text-align:center;margin-top:14px"><button class="link-btn" data-action="method" data-m="wallet">Choose another wallet</button></p>';
    },

    otp: function () { return otpScreen('otp'); },

    authenticate: function () { return otpScreen('authenticate'); },

    processing: function () {
      return '<div class="state-screen"><div class="spinner"></div><h2>Processing payment</h2><p class="muted">This may take a few seconds. Please do not close this window.</p></div>';
    },

    success: function () {
      var r = S.result || {};
      var redirecting = r.next && (r.next.type === 'redirect' || (r.next.type === 'message' && C.embedded));
      return '<div class="state-screen"><div class="state-icon ok">' + I.check + '</div><h2>Payment successful</h2><p class="muted">' + AMOUNT + ' paid to ' + esc(C.merchant) + '</p>' +
        kv([['Payment ID', r.payment_id], ['Reference', C.reference]]) +
        (redirecting ? '<p class="muted small" style="margin-top:14px">Returning you to ' + esc(C.merchant) + '&hellip;</p>' : C.embedded ? '<div class="btn-row" style="margin-top:16px"><button class="btn" data-action="done">Done</button></div>' : '<p class="muted small" style="margin-top:14px">You can close this window.</p>') +
        '</div>';
    },

    failed: function () {
      var r = S.result || {};
      var err = (r.error && r.error.message) || 'The payment could not be completed.';
      var autoRedirect = !r.retryable && r.next && r.next.type === 'redirect';
      var buttons = '';
      if (r.retryable) {
        buttons = '<div class="btn-row" style="margin-top:16px"><button class="btn" data-action="retry">Retry payment</button></div>' +
          '<p style="margin-top:12px"><button class="link-btn" data-action="' + (r.next && r.next.type === 'redirect' ? 'return' : 'close') + '">' + (C.embedded && !(r.next && r.next.type === 'redirect') ? 'Cancel payment' : 'Return to ' + esc(C.merchant)) + '</button></p>';
      }
      return '<div class="state-screen"><div class="state-icon fail">' + I.cross + '</div><h2>Payment failed</h2><p class="muted">' + esc(err) + '</p>' +
        kv([['Payment ID', r.payment_id], ['Reason', r.error && r.error.code]]) +
        (autoRedirect ? '<p class="muted small" style="margin-top:14px">Returning you to ' + esc(C.merchant) + '&hellip;</p>' : '') + buttons + '</div>';
    },

    status: function () {
      var map = {
        paid: ['ok', I.check, 'Already paid', 'This payment has already been completed.'],
        expired: ['wait', I.clock, 'Link expired', 'This payment link has expired. Please start a new payment from ' + esc(C.merchant) + '.'],
        cancelled: ['fail', I.cross, 'Payment cancelled', 'This payment was cancelled.'],
        failed: ['fail', I.cross, 'Payment failed', 'This transaction has already failed. Please start a new payment.'],
      };
      var m = map[C.status] || map.failed;
      return '<div class="state-screen"><div class="state-icon ' + m[0] + '">' + m[1] + '</div><h2>' + m[2] + '</h2><p class="muted">' + m[3] + '</p>' +
        (C.embedded ? '<div class="btn-row" style="margin-top:16px"><button class="btn secondary" data-action="close">Close</button></div>' : '') + '</div>';
    },

    closed: function () {
      return '<div class="state-screen"><div class="state-icon fail">' + I.cross + '</div><h2>Payment cancelled</h2><p class="muted">You can close this window.</p></div>';
    },
  };

  var ISSUERS = { HDFC: 'HDFC Bank', SBIN: 'State Bank of India', ICIC: 'ICICI Bank', UTIB: 'Axis Bank', KKBK: 'Kotak Mahindra Bank' };
  var NETWORKS = { visa: 'Visa', mastercard: 'Mastercard', rupay: 'RuPay', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', maestro: 'Maestro' };
  var OTP_TTL = 180, RESEND_AFTER = 30;

  function maskedMobile() {
    var d = digits(C.prefill.contact);
    return d.length >= 4 ? 'XXXXXX' + d.slice(-4) : '';
  }
  function mmss(sec) { return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }

  function initOtp() {
    S.otp = { expiresAt: Date.now() + OTP_TTL * 1000, resendAt: Date.now() + RESEND_AFTER * 1000, attemptsLeft: C.otpMaxAttempts || 3, busy: false, expired: false };
  }

  function otpScreen(mode) {
    var c = (mode === 'authenticate' ? C.card : S.otpCard) || {};
    var brand = String(c.brand || '').toLowerCase();
    var network = NETWORKS[brand] || c.network || 'Card';
    var issuer = ISSUERS[c.issuer] || 'Your card issuer';
    var mobile = maskedMobile();
    var now = new Date();
    var when = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' + now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    var boxes = '';
    for (var i = 0; i < 6; i++) {
      boxes += '<input class="otp-box" data-i="' + i + '" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="' + (i === 0 ? 'one-time-code' : 'off') + '" aria-label="OTP digit ' + (i + 1) + '">';
    }
    return '<div class="acs">' +
      '<div class="acs-head">' +
        '<div class="acs-issuer"><span class="acs-logo">' + esc(issuer.charAt(0)) + '</span><div><b>' + esc(issuer) + '</b><small>Secure payment authentication</small></div></div>' +
        '<span class="acs-net">' + I.lock + ' ' + esc(network) + ' &middot; 3-D Secure</span>' +
      '</div>' +
      '<div class="acs-body">' +
        '<h3>Enter OTP to authorise this payment</h3>' +
        '<p class="acs-lead">We sent a 6-digit one-time password to ' + (mobile ? 'your mobile number <b>' + mobile + '</b>' : 'the mobile number registered with your card') + '.</p>' +
        '<dl class="acs-tx">' +
          '<div><dt>Merchant</dt><dd>' + esc(C.merchant) + '</dd></div>' +
          '<div><dt>Amount</dt><dd><b>' + AMOUNT + '</b></dd></div>' +
          '<div><dt>Card</dt><dd>' + esc(network) + ' &bull;&bull;&bull;&bull; ' + esc(c.last4 || '') + '</dd></div>' +
          '<div><dt>Date</dt><dd>' + esc(when) + '</dd></div>' +
        '</dl>' +
        '<form data-form="otp-form" data-mode="' + mode + '" novalidate>' +
          '<div class="otp-boxes" id="otp-boxes">' + boxes + '</div>' +
          '<div class="otp-meta"><span id="otp-timer" class="otp-timer">OTP valid for ' + mmss(OTP_TTL) + '</span><button type="button" class="link-btn" id="otp-resend" data-action="resend" disabled>Resend OTP in ' + RESEND_AFTER + 's</button></div>' +
          '<div class="otp-error" id="otp-error" role="alert" hidden></div>' +
          '<button class="btn" type="submit" id="otp-submit" disabled>Verify &amp; pay ' + AMOUNT + '</button>' +
        '</form>' +
        '<p class="acs-cancel"><button class="link-btn danger-link" data-action="' + (mode === 'authenticate' ? 'auth-fail' : 'otp-cancel') + '">Cancel payment</button></p>' +
        '<div class="sim-note">Simulated issuer &middot; OTP <code>' + esc(C.successOtp) + '</code> succeeds &middot; ' + (C.otpMaxAttempts || 3) + ' attempts</div>' +
      '</div>' +
      '<div class="acs-foot">' + I.lock + ' Your OTP is never shared with ' + esc(C.merchant) + '. Do not share it with anyone.</div>' +
    '</div>';
  }

  function otpBoxes() { return Array.prototype.slice.call(document.querySelectorAll('.otp-box')); }
  function otpValue() { return otpBoxes().map(function (b) { return b.value; }).join(''); }

  function setOtpError(msg) {
    var e = document.getElementById('otp-error'), wrap = document.getElementById('otp-boxes');
    if (!e || !wrap) return;
    e.textContent = msg || '';
    e.hidden = !msg;
    wrap.classList.toggle('error', !!msg);
    if (msg) {
      wrap.classList.remove('shake');
      void wrap.offsetWidth;
      wrap.classList.add('shake');
    }
  }

  function syncOtpSubmit() {
    var btn = document.getElementById('otp-submit');
    if (btn && !S.otp.busy) btn.disabled = otpValue().length !== 6 || S.otp.expired;
    otpBoxes().forEach(function (b) { b.classList.toggle('filled', !!b.value); });
  }

  function fillOtp(str, from) {
    var boxes = otpBoxes(), d = digits(str), i = from || 0;
    for (var k = 0; k < d.length && i < boxes.length; k++, i++) boxes[i].value = d[k];
    var target = boxes[Math.min(i, boxes.length - 1)];
    if (target) target.focus();
    syncOtpSubmit();
    if (otpValue().length === 6) submitOtp();
  }

  function tickOtp() {
    var o = S.otp, now = Date.now();
    var left = Math.max(0, Math.ceil((o.expiresAt - now) / 1000));
    var t = document.getElementById('otp-timer');
    if (t) {
      t.textContent = left ? 'OTP valid for ' + mmss(left) : 'OTP expired';
      t.classList.toggle('warn', left > 0 && left <= 30);
      t.classList.toggle('expired', !left);
    }
    if (!left && !o.expired) {
      o.expired = true;
      setOtpError('This OTP has expired. Request a new one to continue.');
      syncOtpSubmit();
    }
    var r = document.getElementById('otp-resend'), rl = Math.max(0, Math.ceil((o.resendAt - now) / 1000));
    if (r) {
      r.disabled = rl > 0 || o.busy;
      r.textContent = rl ? 'Resend OTP in ' + rl + 's' : 'Resend OTP';
    }
  }

  function startOtpTimers() {
    tickOtp();
    S.timers.push(setInterval(tickOtp, 1000));
  }

  function resendOtp() {
    var o = S.otp;
    if (o.busy || Date.now() < o.resendAt) return;
    o.expiresAt = Date.now() + OTP_TTL * 1000;
    o.resendAt = Date.now() + RESEND_AFTER * 1000;
    o.expired = false;
    otpBoxes().forEach(function (b) { b.value = ''; });
    setOtpError('');
    syncOtpSubmit();
    tickOtp();
    otpBoxes()[0].focus();
    toast('A new OTP has been sent' + (maskedMobile() ? ' to ' + maskedMobile() : '') + ' (test OTP ' + C.successOtp + ')');
  }

  function submitOtp() {
    var o = S.otp, otp = otpValue();
    if (o.busy || otp.length !== 6 || o.expired) return;
    o.busy = true;
    var btn = document.getElementById('otp-submit');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spin"></span> Verifying&hellip;';
    }
    otpBoxes().forEach(function (b) { b.disabled = true; });
    setOtpError('');
    var form = document.querySelector('[data-form="otp-form"]');
    var input = form && form.getAttribute('data-mode') === 'authenticate'
      ? { method: 'card', authenticate: true, otp: otp }
      : Object.assign({}, S.cardInput, { otp: otp });
    complete(input, { inline: true });
  }

  function otpRejected(r) {
    var o = S.otp;
    o.busy = false;
    o.attemptsLeft = r.attempts_left;
    var btn = document.getElementById('otp-submit');
    if (btn) btn.innerHTML = 'Verify &amp; pay ' + AMOUNT;
    otpBoxes().forEach(function (b) { b.disabled = false; b.value = ''; });
    setOtpError('Incorrect OTP. ' + r.attempts_left + (r.attempts_left === 1 ? ' attempt' : ' attempts') + ' left before the payment is declined.');
    syncOtpSubmit();
    tickOtp();
    otpBoxes()[0].focus();
  }

  function kv(rows) {
    rows = rows.filter(function (r) { return r[1]; });
    if (!rows.length) return '';
    return '<div class="kv">' + rows.map(function (r) { return '<div><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>'; }).join('') + '</div>';
  }

  function qrSvg() {
    // Decorative pseudo-QR derived from the payment id (not scannable).
    var seed = 0;
    for (var i = 0; i < C.id.length; i++) seed = (seed * 31 + C.id.charCodeAt(i)) >>> 0;
    var n = 25, cells = '';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
        var on;
        if (finder) {
          var fx = x >= n - 7 ? x - (n - 7) : x, fy = y >= n - 7 ? y - (n - 7) : y;
          on = fx === 0 || fx === 6 || fy === 0 || fy === 6 || (fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4);
        } else {
          seed = (seed * 1103515245 + 12345) >>> 0;
          on = (seed >>> 16) % 2 === 0;
        }
        if (on) cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
      }
    }
    return '<div class="qr"><svg viewBox="0 0 25 25" width="100%" height="100%" shape-rendering="crispEdges" fill="#0f172a">' + cells + '</svg></div>';
  }

  function render() {
    var body = screens[S.screen]();
    app.innerHTML = '<div class="sheet" role="dialog" aria-label="Checkout">' + head() + '<div class="sheet-body">' + body + '</div>' + foot() + '</div>';
    var focus = app.querySelector('#cc-number, #vpa, .otp-box');
    if (focus && !('ontouchstart' in window)) focus.focus();
    if (S.screen === 'upi_wait') startUpiTimers();
    if (S.screen === 'otp' || S.screen === 'authenticate') startOtpTimers();
  }

  /* ------------------------------ flows ------------------------------ */

  function startUpiTimers() {
    var total = 300, left = total, autoLeft = C.upiAutoApproveSeconds;
    var auto = autoLeft > 0 && !/^fail/.test(S.upi.vpa);
    S.timers.push(setInterval(function () {
      left -= 1;
      var bar = document.getElementById('upi-bar'), lbl = document.getElementById('upi-left');
      if (bar) bar.style.width = (left / total) * 100 + '%';
      if (lbl) lbl.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      if (auto) {
        autoLeft -= 1;
        var a = document.getElementById('upi-auto');
        if (a) a.textContent = Math.max(autoLeft, 0);
        if (autoLeft <= 0) return upiOutcome('approved');
      }
      if (left <= 0) upiOutcome('declined');
    }, 1000));
    if (/^fail/.test(S.upi.vpa)) S.timers.push(setTimeout(function () { upiOutcome('declined'); }, 3000));
  }

  function upiOutcome(outcome) {
    clearTimers();
    complete({ method: 'upi', vpa: S.upi.vpa, upi_flow: S.upi.flow, upi_outcome: outcome });
  }

  function complete(input, opts) {
    S.lastInput = input;
    if (input.method === 'card' && input.card) S.cardInput = { method: 'card', card: input.card };
    if (!(opts && opts.inline)) go('processing');
    var started = Date.now();
    fetch('/checkout/' + encodeURIComponent(C.provider) + '/' + encodeURIComponent(C.id) + '/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, input, { query: C.query })),
    })
      .then(function (res) { return res.json(); })
      .catch(function () { return { status: 'failed', retryable: true, error: { message: 'Network error. Please check your connection and try again.' } }; })
      .then(function (r) {
        return wait(Math.max(0, 1100 - (Date.now() - started))).then(function () { return r; });
      })
      .then(function (r) {
        if (r.status === 'otp_required') {
          S.otpCard = r.instrument;
          initOtp();
          return go('otp');
        }
        if (r.status === 'otp_invalid') return otpRejected(r);
        S.result = r;
        if (r.status === 'success') {
          go('success');
          if (r.next) S.timers.push(setTimeout(function () { perform(r.next); }, 1600));
          return;
        }
        go('failed');
        if (r.next && r.next.type === 'message' && r.next.close === false) post(r.next.payload);
        else if (!r.retryable && r.next) S.timers.push(setTimeout(function () { perform(r.next); }, 2500));
      });
  }

  function redirect(next) {
    if (next.method === 'POST') {
      var f = document.createElement('form');
      f.method = 'POST';
      f.action = next.url;
      Object.keys(next.fields || {}).forEach(function (k) {
        var i = document.createElement('input');
        i.type = 'hidden';
        i.name = k;
        i.value = next.fields[k];
        f.appendChild(i);
      });
      document.body.appendChild(f);
      f.submit();
      return;
    }
    var u = new URL(next.url, window.location.href);
    Object.keys(next.fields || {}).forEach(function (k) { u.searchParams.set(k, next.fields[k]); });
    window.location.href = u.toString();
  }

  function perform(next) {
    if (!next) return;
    if (next.type === 'message') {
      if (C.embedded) post(next.payload);
      else if (S.screen !== 'success') go('closed');
      return;
    }
    if (next.type === 'back') {
      if (C.embedded) post({ event: 'dismiss' });
      else if (window.history.length > 1) window.history.back();
      else go('closed');
      return;
    }
    if (next.type === 'redirect') {
      if (C.embedded) post({ event: '__redirect', next: next });
      else redirect(next);
    }
  }

  function cancel() {
    fetch('/checkout/' + encodeURIComponent(C.provider) + '/' + encodeURIComponent(C.id) + '/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: C.query }),
    })
      .then(function (r) { return r.json(); })
      .catch(function () { return { next: { type: 'back' } }; })
      .then(function (r) {
        if (C.embedded && (!r.next || r.next.type === 'back')) return post({ event: 'dismiss' });
        if (!C.embedded && (!r.next || r.next.type === 'back') && C.status !== 'open') return go('closed');
        perform(r.next || { type: 'back' });
      });
  }

  function validateCard() {
    var c = S.card, e = {};
    var num = digits(c.number);
    if (!num) e.number = 'Enter your card number';
    else if (!luhn(num)) e.number = 'Your card number is invalid';
    var m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(c.expiry.trim());
    if (!m) e.expiry = 'Enter expiry as MM / YY';
    else {
      var mm = +m[1], yy = 2000 + +m[2], now = new Date();
      if (mm < 1 || mm > 12) e.expiry = 'Invalid month';
      else if (yy < now.getFullYear() || (yy === now.getFullYear() && mm < now.getMonth() + 1)) e.expiry = 'Your card has expired';
    }
    var need = brandOf(num) === 'amex' ? 4 : 3;
    if (digits(c.cvc).length !== need) e.cvc = 'Enter the ' + need + '-digit CVV';
    S.errors = e;
    return !Object.keys(e).length;
  }

  /* ------------------------------ events ------------------------------ */

  app.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-action]');
    if (!el) return;
    var a = el.getAttribute('data-action');
    switch (a) {
      case 'method':
        S.errors = {};
        return go(el.getAttribute('data-m'));
      case 'back':
        S.errors = {};
        return go('methods');
      case 'close':
        return cancel();
      case 'fill-card': {
        var n = el.getAttribute('data-n');
        var y = String((new Date().getFullYear() + 3) % 100).padStart(2, '0');
        S.card = { number: n, expiry: '12 / ' + y, cvc: brandOf(n) === 'amex' ? '1234' : '123', name: S.card.name || 'Test User' };
        S.errors = {};
        return render();
      }
      case 'upi-app':
        S.upi = { flow: 'intent', vpa: 'test@' + el.getAttribute('data-app'), app: el.getAttribute('data-name') };
        return go('upi_wait');
      case 'upi-qr':
        return go('upi_qr');
      case 'qr-pay':
        return complete({ method: 'upi', upi_flow: 'intent', vpa: 'qr@upi', upi_outcome: 'approved' });
      case 'qr-fail':
        return complete({ method: 'upi', upi_flow: 'intent', vpa: 'qr@upi', upi_outcome: 'declined' });
      case 'upi-approve':
        return upiOutcome('approved');
      case 'upi-decline':
        return upiOutcome('declined');
      case 'bank':
        return chooseBank(el.getAttribute('data-code'));
      case 'bank-success':
      case 'bank-fail':
        return complete({ method: 'netbanking', bank: S.bank.code, bank_outcome: a === 'bank-success' ? 'success' : 'failed' });
      case 'wallet':
        S.wallet = C.wallets.filter(function (w) { return w.code === el.getAttribute('data-code'); })[0];
        return go('wallet_page');
      case 'wallet-success':
      case 'wallet-fail':
        return complete({ method: 'wallet', wallet: S.wallet.code, wallet_outcome: a === 'wallet-success' ? 'success' : 'failed' });
      case 'otp-cancel':
        return complete(Object.assign({}, S.cardInput, { otp: 'cancelled' }));
      case 'auth-fail':
        return complete({ method: 'card', authenticate: true, otp: 'failed' });
      case 'resend':
        return resendOtp();
      case 'retry':
        S.result = null;
        S.errors = {};
        return go(single || 'methods');
      case 'return':
        return perform(S.result && S.result.next);
      case 'done':
        return post({ event: '__close' });
    }
  });

  function chooseBank(code) {
    if (!code) return;
    S.bank = C.banks.filter(function (b) { return b.code === code; })[0];
    go('bank_redirect');
    S.timers.push(setTimeout(function () { go('bank'); }, 1200));
  }

  app.addEventListener('change', function (ev) {
    if (ev.target.getAttribute('data-change') === 'bank') chooseBank(ev.target.value);
  });

  app.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.id === 'cc-number') {
      var pos = t.selectionStart, before = t.value.length;
      S.card.number = digits(t.value);
      t.value = formatCard(S.card.number);
      var after = t.value.length;
      try { t.setSelectionRange(pos + (after - before), pos + (after - before)); } catch (e) { /* noop */ }
      var b = document.getElementById('cc-brand'), brand = brandOf(S.card.number);
      if (b) { b.hidden = !brand; b.textContent = brand; }
    } else if (t.id === 'cc-exp') {
      var d = digits(t.value).slice(0, 4);
      if (d.length === 1 && +d > 1) d = '0' + d;
      t.value = d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d;
      S.card.expiry = t.value;
    } else if (t.id === 'cc-cvc') {
      t.value = digits(t.value).slice(0, 4);
      S.card.cvc = t.value;
    } else if (t.id === 'cc-name') {
      S.card.name = t.value;
    } else if (t.id === 'vpa') {
      S.vpa = t.value.trim();
    } else if (t.classList.contains('otp-box')) {
      var v = digits(t.value);
      setOtpError('');
      if (v.length > 1) {
        t.value = '';
        return fillOtp(v, +t.getAttribute('data-i'));
      }
      t.value = v;
      var nextBox = otpBoxes()[+t.getAttribute('data-i') + 1];
      if (v && nextBox) nextBox.focus();
      syncOtpSubmit();
      if (otpValue().length === 6) submitOtp();
    }
  });

  app.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var form = ev.target.getAttribute('data-form');
    if (form === 'card') {
      if (!validateCard()) return render();
      return complete({ method: 'card', card: { number: digits(S.card.number), expiry: S.card.expiry.replace(/\s/g, ''), cvc: S.card.cvc, name: S.card.name } });
    }
    if (form === 'upi') {
      var vpa = S.vpa.toLowerCase();
      if (!/^[a-z0-9._-]{2,256}@[a-z]{2,64}$/.test(vpa)) {
        S.errors = { vpa: 'Enter a valid UPI ID (e.g. name@bank)' };
        return render();
      }
      S.errors = {};
      if (vpa === 'success@upi') return complete({ method: 'upi', vpa: vpa, upi_flow: 'collect', upi_outcome: 'approved' });
      S.upi = { flow: 'collect', vpa: vpa };
      return go('upi_wait');
    }
    if (form === 'otp-form') {
      if (otpValue().length !== 6) return setOtpError('Enter all 6 digits of the OTP.');
      return submitOtp();
    }
  });

  app.addEventListener('keydown', function (ev) {
    var t = ev.target;
    if (!t.classList || !t.classList.contains('otp-box')) return;
    var i = +t.getAttribute('data-i'), boxes = otpBoxes();
    if (ev.key === 'Backspace' && !t.value && i > 0) {
      ev.preventDefault();
      boxes[i - 1].value = '';
      boxes[i - 1].focus();
      syncOtpSubmit();
    } else if (ev.key === 'ArrowLeft' && i > 0) {
      ev.preventDefault();
      boxes[i - 1].focus();
    } else if (ev.key === 'ArrowRight' && i < boxes.length - 1) {
      ev.preventDefault();
      boxes[i + 1].focus();
    } else if (ev.key.length === 1 && /\D/.test(ev.key) && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
    }
  });

  app.addEventListener('paste', function (ev) {
    var t = ev.target;
    if (!t.classList || !t.classList.contains('otp-box')) return;
    ev.preventDefault();
    fillOtp((ev.clipboardData || window.clipboardData).getData('text'), +t.getAttribute('data-i'));
  });

  app.addEventListener('focusin', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('otp-box')) ev.target.select();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && C.embedded && ['processing', 'success'].indexOf(S.screen) < 0) cancel();
  });

  render();
})();
