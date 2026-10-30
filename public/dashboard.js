(function () {
  'use strict';

  var view = document.getElementById('view');
  var titleEl = document.getElementById('title');
  var search = document.getElementById('search');
  var drawer = document.getElementById('drawer');
  var drawerTitle = document.getElementById('drawer-title');
  var drawerBody = document.getElementById('drawer-body');

  var TITLES = { overview: 'Overview', sms: 'SMS inbox', emails: 'Email inbox', payments: 'Payments', webhooks: 'Webhook deliveries', settings: 'Settings' };
  var CLEAR_SCOPE = { sms: 'sms', emails: 'emails', payments: 'payments', webhooks: 'webhooks' };
  var tab = 'overview';
  var fresh = {};
  var openDetail = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function ago(ms) {
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(ms).toLocaleString();
  }
  function money(minor, cur) {
    try { return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur }).format(minor / 100); }
    catch (e) { return cur + ' ' + (minor / 100).toFixed(2); }
  }
  function pill(status) {
    var cls = {
      delivered: 'ok', paid: 'ok', approved: 'ok', sent: 'info', queued: 'info', pending: 'warn', retrying: 'warn', created: 'info', attempted: 'warn', authorized: 'info',
      failed: 'bad', undelivered: 'bad', cancelled: 'bad', expired: 'bad', skipped: '', refunded: 'warn', partially_refunded: 'warn',
    }[status] || '';
    return '<span class="pill ' + cls + '">' + esc(String(status).replace(/_/g, ' ')) + '</span>';
  }
  function toast(t) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = t;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2000);
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'X-Requested-With': 'mock-gateway' }, opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.status === 401) {
        location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash);
        throw new Error('Session expired');
      }
      if (r.status === 204) return {};
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error && (j.error.message || j.error) || ('HTTP ' + r.status)); return j; });
    });
  }
  function json(o) { return '<pre>' + esc(JSON.stringify(o, null, 2)) + '</pre>'; }
  function table(heads, rows, empty) {
    if (!rows.length) return '<div class="panel"><div class="empty">' + empty + '</div></div>';
    return '<div class="panel table-wrap"><table><thead><tr>' + heads.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  function q() { var v = search.value.trim(); return v ? '&q=' + encodeURIComponent(v) : ''; }

  /* ------------------------------ views ------------------------------ */

  var views = {
    overview: function () {
      return Promise.all([api('/stats'), api('/config')]).then(function (r) {
        var s = r[0], c = r[1];
        var cards = [['SMS', s.sms], ['Emails', s.emails], ['Payments', s.payments], ['Paid', s.paid], ['Webhooks', s.webhooks], ['Webhook failures', s.webhooks_failed]];
        return '<div class="cards">' + cards.map(function (x) { return '<div class="card"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div></div>'; }).join('') + '</div>' +
          '<h4>Integration endpoints &amp; test credentials</h4><div class="cfg-grid">' + c.providers.map(function (p) {
            var rows = [['Base URL', p.base_url]];
            if (p.sdk) rows.push(['JS SDK', p.sdk]);
            Object.keys(p.credentials).forEach(function (k) { rows.push([k, p.credentials[k]]); });
            if (p.note) rows.push(['Note', p.note]);
            return '<div class="cfg"><h4>' + esc(p.name) + '</h4>' + rows.map(function (x) { return '<div class="row"><span>' + esc(x[0]) + '</span><code data-copy="' + esc(x[1]) + '">' + esc(x[1]) + '</code></div>'; }).join('') + '</div>';
          }).join('') + '</div>';
      });
    },

    sms: function () {
      return api('/sms?limit=200' + q()).then(function (r) {
        return table(['When', 'To', 'Message', 'OTP', 'Provider', 'Status'], r.data.map(function (m) {
          return '<tr data-open="sms" data-id="' + m.id + '" class="' + (fresh[m.id] ? 'fresh' : '') + '"><td class="nowrap muted">' + ago(m.created_at) + '</td><td class="mono nowrap">' + esc(m.to_addr) + (m.channel !== 'sms' ? ' <span class="pill">' + esc(m.channel) + '</span>' : '') + '</td>' +
            '<td class="clip">' + esc(m.body) + '</td><td>' + (m.otp ? '<span class="otp" data-copy="' + esc(m.otp) + '">' + esc(m.otp) + '</span>' : '') + '</td><td>' + esc(m.provider) + '</td><td>' + pill(m.status) + '</td></tr>';
        }), 'No SMS yet. Messages sent through Twilio, MSG91 or the generic API appear here instantly.');
      });
    },

    emails: function () {
      return api('/emails?limit=200' + q()).then(function (r) {
        return table(['When', 'To', 'Subject', 'OTP', 'From', 'Provider'], r.data.map(function (e) {
          return '<tr data-open="email" data-id="' + e.id + '" class="' + (fresh[e.id] ? 'fresh' : '') + '"><td class="nowrap muted">' + ago(e.created_at) + '</td><td class="mono clip" style="max-width:220px">' + esc(e.to.map(function (a) { return a.address; }).join(', ')) + '</td>' +
            '<td class="clip"><b>' + esc(e.subject || '(no subject)') + '</b> <span class="muted">' + esc(e.snippet) + '</span></td><td>' + (e.otp ? '<span class="otp" data-copy="' + esc(e.otp) + '">' + esc(e.otp) + '</span>' : '') + '</td>' +
            '<td class="clip" style="max-width:200px">' + esc(e.from) + '</td><td>' + esc(e.provider) + '</td></tr>';
        }), 'No email yet. Point SMTP, SendGrid, Resend or SES at this server.');
      });
    },

    payments: function () {
      return api('/payments?limit=200' + q()).then(function (r) {
        return table(['When', 'ID', 'Provider', 'Amount', 'Status', 'Method', 'Reference'], r.data.map(function (p) {
          return '<tr data-open="payment" data-id="' + esc(p.id) + '" class="' + (fresh[p.id] ? 'fresh' : '') + '"><td class="nowrap muted">' + ago(p.created_at) + '</td><td class="mono nowrap">' + esc(p.checkout_id) + '</td><td>' + esc(p.provider) + '</td>' +
            '<td class="nowrap"><b>' + money(p.amount, p.currency) + '</b></td><td>' + pill(p.status) + '</td><td>' + esc(p.method || '') + '</td><td class="mono">' + esc(p.reference || '') + '</td></tr>';
        }), 'No payments yet. Create an order / session / intent through any gateway API.');
      });
    },

    webhooks: function () {
      return api('/webhooks?limit=200').then(function (r) {
        return table(['When', 'Provider', 'Event', 'URL', 'Status', 'Attempts', 'HTTP'], r.data.map(function (w) {
          return '<tr data-open="webhook" data-id="' + w.id + '" class="' + (fresh[w.id] ? 'fresh' : '') + '"><td class="nowrap muted">' + ago(w.created_at) + '</td><td>' + esc(w.provider) + '</td><td class="mono">' + esc(w.event) + '</td>' +
            '<td class="clip mono" style="max-width:280px">' + esc(w.url || '— not configured —') + '</td><td>' + pill(w.status) + '</td><td>' + w.attempts + '</td><td class="mono">' + esc(w.last_status || w.last_error || '') + '</td></tr>';
        }), 'No webhook deliveries yet.');
      });
    },

    settings: function () {
      return api('/settings').then(function (r) {
        return '<div class="panel"><h3>Runtime settings</h3><div class="panel-body"><form class="settings-form" id="settings-form">' + r.data.map(function (s) {
          var input = s.type === 'enum'
            ? '<select class="input" name="' + s.key + '">' + s.values.map(function (v) { return '<option' + (v === s.value ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select>'
            : '<input class="input" name="' + s.key + '" value="' + esc(s.value) + '" placeholder="' + esc(s.type === 'url' ? 'https://your-app/webhooks/...' : '') + '">';
          return '<div class="field"><div>' + esc(s.label) + '<small>' + esc(s.key) + (s.overridden ? ' · overridden (env: ' + esc(s.default || '—') + ')' : '') + '</small></div>' + input +
            (s.overridden ? '<button type="button" class="btn ghost sm" data-reset="' + s.key + '">Reset</button>' : '<span></span>') + '</div>';
        }).join('') + '<div style="margin-top:14px"><button class="btn" type="submit">Save settings</button></div></form></div></div>' +
          '<div class="panel"><h3>Danger zone</h3><div class="panel-body actions"><button class="btn ghost danger" data-reset-all="all">Delete ALL data</button><button class="btn ghost danger" data-reset-all="otps">Delete OTPs</button></div></div>';
      });
    },
  };

  /* ------------------------------ details ------------------------------ */

  var details = {
    sms: function (id) {
      return api('/sms/' + id).then(function (m) {
        drawerTitle.textContent = 'SMS to ' + m.to_addr;
        return '<dl class="kv"><dt>To</dt><dd class="mono">' + esc(m.to_addr) + '</dd><dt>From</dt><dd class="mono">' + esc(m.from_addr) + '</dd><dt>Provider</dt><dd>' + esc(m.provider) + ' · ' + esc(m.channel) + '</dd><dt>Status</dt><dd>' + pill(m.status) + '</dd><dt>Received</dt><dd>' + new Date(m.created_at).toLocaleString() + '</dd>' +
          (m.otp ? '<dt>OTP</dt><dd><span class="otp" data-copy="' + esc(m.otp) + '">' + esc(m.otp) + '</span></dd>' : '') + '</dl><h4>Body</h4><pre>' + esc(m.body) + '</pre><h4>Metadata</h4>' + json(m.meta);
      });
    },

    email: function (id) {
      return api('/emails/' + id).then(function (e) {
        drawerTitle.textContent = e.subject || '(no subject)';
        var addr = function (l) { return esc(l.map(function (a) { return a.name ? a.name + ' <' + a.address + '>' : a.address; }).join(', ')); };
        return '<dl class="kv"><dt>From</dt><dd>' + esc(e.from) + '</dd><dt>To</dt><dd>' + addr(e.to) + '</dd>' + (e.cc.length ? '<dt>Cc</dt><dd>' + addr(e.cc) + '</dd>' : '') + (e.bcc.length ? '<dt>Bcc</dt><dd>' + addr(e.bcc) + '</dd>' : '') +
          '<dt>Provider</dt><dd>' + esc(e.provider) + '</dd><dt>Received</dt><dd>' + new Date(e.created_at).toLocaleString() + '</dd>' + (e.otp ? '<dt>OTP</dt><dd><span class="otp" data-copy="' + esc(e.otp) + '">' + esc(e.otp) + '</span></dd>' : '') + '</dl>' +
          '<div class="tabs" data-etabs><button class="active" data-etab="html">HTML</button><button data-etab="text">Text</button><button data-etab="headers">Headers</button></div>' +
          '<div data-epane="html">' + (e.has_html ? '<iframe class="email-frame" sandbox src="/api/emails/' + e.id + '/html"></iframe>' : '<p class="muted">No HTML part.</p>') + '</div>' +
          '<div data-epane="text" hidden><pre>' + esc(e.text) + '</pre></div><div data-epane="headers" hidden>' + json(e.headers) + json(e.meta) + '</div>' +
          (e.links.length ? '<h4>Links</h4><div class="links">' + e.links.map(function (l) { return '<a href="' + esc(l) + '" target="_blank" rel="noopener noreferrer">' + esc(l) + '</a>'; }).join('') + '</div>' : '') +
          (e.attachments.length ? '<h4>Attachments</h4>' + e.attachments.map(function (a) { return '<div><a href="/api/emails/' + e.id + '/attachments/' + a.id + '">' + esc(a.filename) + '</a> <span class="muted">' + esc(a.content_type) + ' · ' + Math.ceil(a.size / 1024) + ' KB</span></div>'; }).join('') : '');
      });
    },

    payment: function (id) {
      return api('/payments/' + encodeURIComponent(id)).then(function (p) {
        drawerTitle.textContent = p.provider + ' · ' + p.checkout_id;
        var open = ['created', 'attempted'].indexOf(p.status) >= 0;
        var refundable = ['paid', 'partially_refunded'].indexOf(p.status) >= 0;
        return '<dl class="kv"><dt>Amount</dt><dd><b>' + money(p.amount, p.currency) + '</b></dd><dt>Status</dt><dd>' + pill(p.status) + '</dd><dt>Method</dt><dd>' + esc(p.method || '—') + '</dd><dt>Reference</dt><dd class="mono">' + esc(p.reference || '—') + '</dd>' +
          '<dt>Checkout</dt><dd><a href="' + esc(p.checkout_url) + '" target="_blank" rel="noopener">' + esc(p.checkout_url) + '</a></dd><dt>Created</dt><dd>' + new Date(p.created_at).toLocaleString() + '</dd></dl>' +
          '<div class="actions">' + (open ? '<button class="btn ok sm" data-sim="success">Simulate success</button><button class="btn bad sm" data-sim="failed">Simulate failure</button>' : '') +
          (refundable ? '<input class="input" style="width:140px;height:28px" id="refund-amt" placeholder="amount (minor)"><button class="btn ghost sm" data-refund>Refund</button>' : '') + '</div>' +
          '<h4>Provider object</h4>' + json(p.object) +
          (p.related.length ? '<h4>Related objects</h4>' + p.related.map(function (o) { return '<details><summary class="mono">' + esc(o.type) + ' · ' + esc(o.id) + '</summary>' + json(o.data) + '</details>'; }).join('') : '') +
          '<h4>Webhooks</h4>' + (p.webhooks.length ? p.webhooks.map(function (w) { return '<div style="margin-bottom:6px">' + pill(w.status) + ' <span class="mono">' + esc(w.event) + '</span> <a href="#" data-open="webhook" data-id="' + w.id + '">details</a></div>'; }).join('') : '<p class="muted">None</p>');
      });
    },

    webhook: function (id) {
      return api('/webhooks/' + id).then(function (w) {
        drawerTitle.textContent = w.provider + ' · ' + w.event;
        return '<dl class="kv"><dt>URL</dt><dd class="mono">' + esc(w.url || '— not configured —') + '</dd><dt>Status</dt><dd>' + pill(w.status) + '</dd><dt>Attempts</dt><dd>' + w.attempts + '</dd>' +
          '<dt>Last HTTP</dt><dd>' + esc(w.last_status || '—') + '</dd><dt>Last error</dt><dd>' + esc(w.last_error || '—') + '</dd>' + (w.next_attempt_at ? '<dt>Next attempt</dt><dd>' + new Date(w.next_attempt_at).toLocaleString() + '</dd>' : '') + '</dl>' +
          '<div class="actions"><button class="btn sm" data-retry="' + w.id + '">Redeliver now</button></div>' +
          '<h4>Request headers</h4>' + json(w.last_request_headers || w.headers) + '<h4>Body</h4>' + (w.body_json ? json(w.body_json) : '<pre>' + esc(w.body) + '</pre>') +
          (w.last_response ? '<h4>Last response</h4><pre>' + esc(w.last_response) + '</pre>' : '');
      });
    },
  };

  function showDetail(kind, id) {
    openDetail = { kind: kind, id: id };
    drawer.hidden = false;
    drawerBody.innerHTML = '<p class="muted">Loading…</p>';
    details[kind](id).then(function (html) { drawerBody.innerHTML = html; }).catch(function (e) { drawerBody.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
  }
  function closeDetail() { drawer.hidden = true; openDetail = null; }

  /* ------------------------------ routing ------------------------------ */

  var loading = false, pending = false;
  function load() {
    if (loading) { pending = true; return; }
    loading = true;
    views[tab]().then(function (html) { view.innerHTML = html; }).catch(function (e) { view.innerHTML = '<div class="panel"><div class="empty">' + esc(e.message) + '</div></div>'; })
      .then(function () { loading = false; if (pending) { pending = false; load(); } });
  }
  function route() {
    tab = (location.hash || '#overview').slice(1);
    if (!views[tab]) tab = 'overview';
    titleEl.textContent = TITLES[tab];
    document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-tab') === tab); });
    search.style.display = ['sms', 'emails', 'payments'].indexOf(tab) >= 0 ? '' : 'none';
    document.getElementById('clear').style.display = CLEAR_SCOPE[tab] ? '' : 'none';
    load();
  }
  window.addEventListener('hashchange', route);

  function counts() {
    api('/stats').then(function (s) {
      document.getElementById('c-sms').textContent = s.sms || '';
      document.getElementById('c-emails').textContent = s.emails || '';
      document.getElementById('c-payments').textContent = s.payments || '';
      document.getElementById('c-webhooks').textContent = s.webhooks_failed || '';
    }).catch(function () {});
  }

  /* ------------------------------ events ------------------------------ */

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var copy = t.closest('[data-copy]');
    if (copy) {
      ev.stopPropagation();
      navigator.clipboard && navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(function () { toast('Copied'); });
      return;
    }
    var open = t.closest('[data-open]');
    if (open) { ev.preventDefault(); return showDetail(open.getAttribute('data-open'), open.getAttribute('data-id')); }
    var et = t.closest('[data-etab]');
    if (et) {
      var name = et.getAttribute('data-etab');
      drawerBody.querySelectorAll('[data-etab]').forEach(function (b) { b.classList.toggle('active', b === et); });
      drawerBody.querySelectorAll('[data-epane]').forEach(function (p) { p.hidden = p.getAttribute('data-epane') !== name; });
      return;
    }
    var sim = t.closest('[data-sim]');
    if (sim && openDetail) {
      return api('/payments/' + encodeURIComponent(openDetail.id) + '/simulate', { method: 'POST', body: { outcome: sim.getAttribute('data-sim') } })
        .then(function (r) { toast('Payment ' + r.status); showDetail('payment', openDetail.id); load(); }).catch(function (e) { toast(e.message); });
    }
    if (t.closest('[data-refund]') && openDetail) {
      var amt = document.getElementById('refund-amt').value.trim();
      return api('/payments/' + encodeURIComponent(openDetail.id) + '/refund', { method: 'POST', body: amt ? { amount: +amt } : {} })
        .then(function () { toast('Refunded'); showDetail('payment', openDetail.id); load(); }).catch(function (e) { toast(e.message); });
    }
    var retry = t.closest('[data-retry]');
    if (retry) {
      return api('/webhooks/' + retry.getAttribute('data-retry') + '/retry', { method: 'POST' })
        .then(function () { toast('Queued for redelivery'); setTimeout(function () { if (openDetail) showDetail('webhook', openDetail.id); }, 1500); }).catch(function (e) { toast(e.message); });
    }
    var reset = t.closest('[data-reset]');
    if (reset) {
      var patch = {};
      patch[reset.getAttribute('data-reset')] = null;
      return api('/settings', { method: 'PUT', body: patch }).then(function () { toast('Reset'); load(); });
    }
    var resetAll = t.closest('[data-reset-all]');
    if (resetAll) {
      if (resetAll.getAttribute('data-armed') !== '1') { resetAll.setAttribute('data-armed', '1'); resetAll.textContent = 'Click again to confirm'; return; }
      return api('/reset', { method: 'POST', body: { scope: resetAll.getAttribute('data-reset-all') } }).then(function () { toast('Deleted'); counts(); load(); });
    }
  });

  document.addEventListener('submit', function (ev) {
    if (ev.target.id !== 'settings-form') return;
    ev.preventDefault();
    var patch = {};
    new FormData(ev.target).forEach(function (v, k) { patch[k] = v; });
    api('/settings', { method: 'PUT', body: patch }).then(function () { toast('Settings saved'); load(); }).catch(function (e) { toast(e.message); });
  });

  var clearBtn = document.getElementById('clear');
  clearBtn.addEventListener('click', function () {
    if (clearBtn.getAttribute('data-armed') !== '1') {
      clearBtn.setAttribute('data-armed', '1');
      clearBtn.textContent = 'Confirm clear';
      setTimeout(function () { clearBtn.removeAttribute('data-armed'); clearBtn.textContent = 'Clear'; }, 3000);
      return;
    }
    clearBtn.removeAttribute('data-armed');
    clearBtn.textContent = 'Clear';
    api('/reset', { method: 'POST', body: { scope: CLEAR_SCOPE[tab] } }).then(function () { toast('Cleared'); counts(); load(); });
  });
  document.getElementById('refresh').addEventListener('click', function () { counts(); load(); });
  document.getElementById('drawer-close').addEventListener('click', closeDetail);
  drawer.addEventListener('click', function (ev) { if (ev.target === drawer) closeDetail(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeDetail(); });
  var st;
  search.addEventListener('input', function () { clearTimeout(st); st = setTimeout(load, 250); });

  /* ------------------------------ live ------------------------------ */

  var TAB_FOR = { sms: 'sms', email: 'emails', otp: 'sms', payment: 'payments', webhook: 'webhooks' };
  var refreshTimer;
  function connect() {
    var es = new EventSource('/api/stream');
    var dot = document.getElementById('live-dot'), txt = document.getElementById('live-text');
    es.onopen = function () { dot.classList.add('on'); txt.textContent = 'live'; };
    es.onerror = function () { dot.classList.remove('on'); txt.textContent = 'reconnecting…'; };
    ['sms', 'email', 'otp', 'webhook', 'payment'].forEach(function (type) {
      es.addEventListener(type, function (m) {
        var e = JSON.parse(m.data);
        if (e.data && e.data.id) { fresh[e.data.id] = true; setTimeout(function () { delete fresh[e.data.id]; }, 3000); }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () {
          counts();
          if (TAB_FOR[type] === tab || tab === 'overview' || (type === 'webhook' && tab === 'payments')) load();
        }, 200);
      });
    });
  }

  fetch('/api/session', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
    if (!s) return;
    document.getElementById('who').textContent = s.username;
    document.querySelector('.side-foot .avatar').textContent = s.username.charAt(0).toUpperCase();
  }).catch(function () {});
  document.getElementById('logout').addEventListener('click', function () {
    fetch('/logout', { method: 'POST', headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function () {
      location.href = '/login?error=signed_out';
    });
  });

  route();
  counts();
  connect();
})();
