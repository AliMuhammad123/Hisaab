// Sign-in, sign-up and the two-step welcome (choose portals, then country and currency).
import { html, mount, api, state, icon, logo, COUNTRIES, CURRENCIES, currencyFor, guessCountry, submitWith } from './core.js';

const passwordField = (id, label, autocomplete, hint) => html`<div class="field"><label for="${id}">${label}</label>
  <div class="input-wrap">
    <input class="input" id="${id}" name="password" type="password" autocomplete="${autocomplete}" required>
    <button type="button" data-show aria-pressed="false">Show</button>
  </div>
  ${hint ? html`<span class="hint">${hint}</span>` : ''}
</div>`;

const codeField = html`<div class="field"><label for="au-code">Code from the email</label>
  <input class="input amount num" id="au-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required></div>`;

/**
 * Sign-in screens. Modes: login, signup, code (confirm a new account's email),
 * forgot (ask for a reset code) and reset (enter the code and a new password).
 */
export function renderAuth(root, onDone) {
  let mode = 'login';
  let email = '';
  let notice = '';

  const draw = () => {
    const titles = {
      login: ['Welcome back', 'Sign in to see your money.'],
      signup: ['Create your account', 'Track your own money, your business credit, or both.'],
      code: ['Check your email', `We sent a code to ${email}. Enter it to finish creating your account.`],
      forgot: ['Reset your password', 'Enter your email and we will send you a code.'],
      reset: ['Choose a new password', `Enter the code we sent to ${email} and your new password.`],
    };
    const [title, sub] = titles[mode];
    const needsEmail = mode === 'login' || mode === 'signup' || mode === 'forgot';
    mount(root, html`<div class="auth"><div class="auth-box">
      <div class="brand">${logo} CreditFlow</div>
      <div><h1>${title}</h1><p class="muted">${sub}</p></div>
      ${notice ? html`<div class="status" role="status">${icon.check}<div><span>${notice}</span></div></div>` : ''}
      <form class="form" novalidate>
        ${mode === 'signup' && html`<div class="field"><label for="au-name">Your name</label>
          <input class="input" id="au-name" name="name" autocomplete="name" maxlength="80" required></div>`}
        ${needsEmail && html`<div class="field"><label for="au-email">Email</label>
          <input class="input" id="au-email" name="email" type="email" autocomplete="email" inputmode="email" value="${email}" required></div>`}
        ${(mode === 'code' || mode === 'reset') && codeField}
        ${mode === 'login' && passwordField('au-pass', 'Password', 'current-password')}
        ${mode === 'signup' && passwordField('au-pass', 'Password', 'new-password', 'At least 10 characters. A short sentence works well.')}
        ${mode === 'reset' && passwordField('au-pass', 'New password', 'new-password', 'At least 10 characters.')}
        <p class="error" role="alert"></p>
        <button class="btn" type="submit">${{ login: 'Sign in', signup: 'Create account', code: 'Confirm email', forgot: 'Send code', reset: 'Save new password' }[mode]}</button>
      </form>
      ${mode === 'login' && html`<button class="btn text" data-go="forgot">Forgot password?</button>
        <button class="btn text" data-go="signup">New here? Create an account</button>`}
      ${mode === 'signup' && html`<button class="btn text" data-go="login">I already have an account</button>`}
      ${(mode === 'code' || mode === 'reset') && html`<button class="btn text" data-resend>Send a new code</button>`}
      ${mode !== 'login' && mode !== 'signup' && html`<button class="btn text" data-go="login">Back to sign in</button>`}
      <p class="lock-note">${icon.lock}<span>Your records are private to your account. Nobody else using CreditFlow can see them. <a class="link" href="privacy.html">Privacy policy</a></span></p>
    </div></div>`);

    const form = root.querySelector('form');
    const err = form.querySelector('.error');
    const go = (m, n = '') => { mode = m; notice = n; draw(); };
    root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
    root.querySelector('[data-show]')?.addEventListener('click', (e) => {
      const input = form.password;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Hide' : 'Show';
      e.currentTarget.setAttribute('aria-pressed', String(show));
    });
    root.querySelector('[data-resend]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api('POST', mode === 'code' ? '/auth/resend' : '/auth/forgot', { email });
        notice = 'We sent a new code. It can take a minute to arrive.';
        draw();
      } catch (ex) { err.textContent = ex.message; e.currentTarget.disabled = false; }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const fail = (msg, field) => { err.textContent = msg; field?.focus(); };
      if (needsEmail) {
        email = form.email.value.trim();
        if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.', form.email);
      }
      if (mode === 'signup' && !form.name.value.trim()) return fail('Enter your name.', form.name);
      if (form.code && !/^\d{6,10}$/.test(form.code.value.replace(/\s/g, ''))) return fail('Enter the code from the email.', form.code);
      if (form.password && !form.password.value) return fail('Enter your password.', form.password);
      if (form.password && mode !== 'login' && form.password.value.length < 10) return fail('Password must be at least 10 characters.', form.password);

      err.textContent = '';
      btn.disabled = true;
      try {
        if (mode === 'login') {
          await api('POST', '/auth/login', { email, password: form.password.value });
          return onDone();
        }
        if (mode === 'signup') {
          const res = await api('POST', '/auth/register', { email, password: form.password.value, name: form.name.value.trim() });
          return res.needs_code ? go('code') : onDone();
        }
        if (mode === 'code') {
          await api('POST', '/auth/verify', { email, code: form.code.value });
          return onDone();
        }
        if (mode === 'forgot') {
          await api('POST', '/auth/forgot', { email });
          return go('reset', 'If this email has an account, a code is on its way.');
        }
        await api('POST', '/auth/reset', { email, code: form.code.value, password: form.password.value });
        return onDone();
      } catch (ex) {
        if (ex.data?.needs_code) return go('code', ex.message);
        fail(ex.message);
      } finally {
        btn.disabled = false;
      }
    });
  };
  draw();
}

const PORTAL_CHOICES = [
  { id: 'personal', icon: 'wallet', title: 'My own money', text: 'Salary, bills, savings and spending limits.' },
  { id: 'business', icon: 'store', title: 'My business', text: 'Customers who buy on credit and what they owe.' },
  { id: 'both', icon: 'both', title: 'Both', text: 'Keep them separate and switch with one tap.' },
];

export function portalChoices(selected) {
  return PORTAL_CHOICES.map((c) => html`<button type="button" class="choice" data-mode="${c.id}" aria-pressed="${String(selected === c.id)}">
    <span class="avatar">${icon[c.icon]}</span><span><b>${c.title}</b><span>${c.text}</span></span></button>`);
}

export function countryFields(country, currency) {
  return html`<div class="field"><label for="ob-country">Country</label>
      <select class="input" id="ob-country" name="country">
        ${COUNTRIES.map((c) => html`<option value="${c.code}" ${c.code === country ? html`selected` : ''}>${c.name}</option>`)}
      </select></div>
    <div class="field"><label for="ob-currency">Currency</label>
      <select class="input" id="ob-currency" name="currency">
        ${CURRENCIES.map((c) => html`<option value="${c.code}" ${c.code === currency ? html`selected` : ''}>${c.name} (${c.code})</option>`)}
      </select>
      <span class="hint">Set from your country. Change it if you are paid in another currency.</span></div>`;
}

/** Keeps the currency in step with the country until the user picks a currency by hand. */
export function linkCountryCurrency(scope) {
  const country = scope.querySelector('[name=country]');
  const currency = scope.querySelector('[name=currency]');
  country.addEventListener('change', () => { currency.value = currencyFor(country.value); });
}

export function renderWelcome(root, onDone) {
  let step = 1;
  let mode = null;
  const draw = () => {
    const country = guessCountry();
    mount(root, html`<div class="auth"><div class="auth-box">
      <div class="brand">${logo} CreditFlow</div>
      <div class="steps" aria-hidden="true"><i class="on"></i><i class="${step === 2 ? 'on' : ''}"></i></div>
      ${step === 1 ? html`
        <div><h1>Hi ${state.user.name.split(' ')[0]}, what will you track?</h1>
          <p class="muted">You can change this later in Settings.</p></div>
        <div class="form">${portalChoices(mode)}</div>
        <button class="btn" data-next ${mode ? '' : html`disabled`}>Continue</button>` : html`
        <div><h1>Where do you live?</h1>
          <p class="muted">We use this to show amounts in your money.</p></div>
        <form class="form">
          ${countryFields(country, currencyFor(country))}
          <p class="error" role="alert"></p>
          <button class="btn" type="submit">Start using CreditFlow</button>
          <button class="btn text" type="button" data-back>Back</button>
        </form>`}
    </div></div>`);

    if (step === 1) {
      root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; draw(); }));
      root.querySelector('[data-next]').addEventListener('click', () => { step = 2; draw(); });
    } else {
      const form = root.querySelector('form');
      linkCountryCurrency(form);
      root.querySelector('[data-back]').addEventListener('click', () => { step = 1; draw(); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = await submitWith(form, () => api('PATCH', '/me', { app_mode: mode, country: form.country.value, currency: form.currency.value }));
        if (ok) onDone();
      });
    }
  };
  draw();
}
