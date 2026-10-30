(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var form = document.getElementById('login');
  var user = document.getElementById('username');
  var pass = document.getElementById('password');
  var alertEl = document.getElementById('alert');
  var submit = document.getElementById('submit');

  var next = params.get('next');
  if (next && /^\/(?![/\\])/.test(next)) document.getElementById('next').value = next;

  var messages = {
    invalid: ['Incorrect username or password.', false],
    locked: ['Too many failed attempts. Try again in ' + (params.get('minutes') || 15) + ' minutes.', false],
    signed_out: ['You have been signed out.', true],
  };
  var err = params.get('error');
  if (messages[err]) {
    alertEl.textContent = messages[err][0];
    alertEl.classList.toggle('ok', messages[err][1]);
    alertEl.hidden = false;
    if (!messages[err][1]) {
      form.classList.add('shake');
      pass.classList.add('invalid');
    }
    history.replaceState(null, '', location.pathname + (next ? '?next=' + encodeURIComponent(next) : ''));
  }

  try {
    var last = localStorage.getItem('mg_last_user');
    if (last) user.value = last;
  } catch (e) { /* storage unavailable */ }
  (user.value ? pass : user).focus();

  document.getElementById('reveal').addEventListener('click', function () {
    var show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
    this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    pass.focus();
  });

  var caps = document.getElementById('caps');
  pass.addEventListener('keyup', function (e) {
    if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock');
  });
  pass.addEventListener('input', function () { pass.classList.remove('invalid'); });

  form.addEventListener('submit', function (e) {
    if (!user.value.trim() || !pass.value) {
      e.preventDefault();
      (user.value.trim() ? pass : user).classList.add('invalid');
      alertEl.textContent = 'Enter your username and password.';
      alertEl.classList.remove('ok');
      alertEl.hidden = false;
      return;
    }
    try { localStorage.setItem('mg_last_user', user.value.trim()); } catch (e2) { /* ignore */ }
    submit.disabled = true;
    submit.innerHTML = '<span class="spin"></span><span>Signing in…</span>';
  });
})();
