'use strict';
const $ = (id) => document.getElementById(id);

const ERR = {
  wrong_login: 'Wrong number or password.',
  too_many_attempts: 'Too many attempts. Wait 15 minutes.',
  banned: 'This account has been banned.',
  not_verified: 'Almost there: confirm your number first. Send the .verify code to the bot on WhatsApp.',
  exists: 'This number already has an account. Log in instead. Forgot the password? Chat with customer care.',
  bad_number: 'Enter your full WhatsApp number with country code.',
  bad_password: 'Password must be 6–40 characters with no spaces.',
  rate_limited: 'Slow down a little and try again.',
  busy: 'The site is busy. Try again in a few minutes.',
  mismatch: 'The two passwords are not the same.'
};

async function api(path, method, body) {
  const opt = { method: method || 'GET', headers: {} };
  if (opt.method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-Requested-With'] = 'XMLHttpRequest'; opt.body = JSON.stringify(body || {}); }
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) { const e = new Error(j.error || 'failed'); e.data = j; throw e; }
  return j;
}

// where to go after logging in (only pages on this site)
function nextUrl() {
  const n = new URLSearchParams(location.search).get('next') || '/shop';
  return /^\/(?!\/)[A-Za-z0-9_\-\/.#?=&%]*$/.test(n) ? n : '/shop';
}

function askCare(text) { if (window.openSupportChat) window.openSupportChat(text); }
$('forgotChat').addEventListener('click', () => askCare('I forgot my website password. My WhatsApp number is: '));
$('signupHelp').addEventListener('click', () => askCare('I already have an account but forgot my password. My WhatsApp number is: '));

function authMode(signup) {
  $('authLogin').classList.toggle('on', !signup); $('authSignup').classList.toggle('on', signup);
  $('loginForm').hidden = signup; $('signupForm').hidden = !signup; $('verifyBox').hidden = true;
  document.title = signup ? 'Sign up' : 'Log in';
}
$('authLogin').addEventListener('click', () => authMode(false));
$('authSignup').addEventListener('click', () => authMode(true));
$('verifyDone').addEventListener('click', () => { authMode(false); $('num').value = $('sNum').value; $('pw').focus(); });

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('signupErr').hidden = true;
  if ($('sPw').value !== $('sPw2').value) { $('signupErr').textContent = ERR.mismatch; $('signupErr').hidden = false; return; }
  try {
    const j = await api('/shop/signup', 'POST', { number: $('sNum').value, password: $('sPw').value });
    $('signupForm').hidden = true;
    $('verifyCode').textContent = '.verify ' + j.code;
    $('verifyMins').textContent = j.minutes;
    $('verifyBox').hidden = false;
    $('sPw').value = ''; $('sPw2').value = '';
  } catch (err) { $('signupErr').textContent = ERR[err.message] || 'Could not create the account.'; $('signupErr').hidden = false; }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('loginErr').hidden = true;
  try {
    await api('/shop/login', 'POST', { number: $('num').value, password: $('pw').value });
    $('pw').value = '';
    location.href = nextUrl();
  } catch (err) { $('loginErr').textContent = ERR[err.message] || 'Could not log in.'; $('loginErr').hidden = false; }
});

// /signup opens on the sign-up tab; already logged in? skip straight on
if (location.pathname.replace(/\/$/, '') === '/signup') authMode(true);
api('/shop/api/state').then(j => { if (j.me) location.replace(nextUrl()); }).catch(() => {});
