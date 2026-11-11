// Sign-in, sign-up and the two-step welcome (choose portals, then country and currency).
import { html, mount, api, state, icon, logo, COUNTRIES, CURRENCIES, currencyFor, guessCountry, submitWith } from './core.js';

export function renderAuth(root, onDone) {
  let mode = 'login';
  const draw = () => {
    const signup = mode === 'signup';
    mount(root, html`<div class="auth"><div class="auth-box">
      <div class="brand">${logo} CreditFlow</div>
      <div>
        <h1>${signup ? 'Create your account' : 'Welcome back'}</h1>
        <p class="muted">${signup ? 'Track your own money, your business credit, or both.' : 'Sign in to see your money.'}</p>
      </div>
      <form class="form" novalidate>
        ${signup && html`<div class="field"><label for="au-name">Your name</label>
          <input class="input" id="au-name" name="name" autocomplete="name" maxlength="80" required></div>`}
        <div class="field"><label for="au-email">Email</label>
          <input class="input" id="au-email" name="email" type="email" autocomplete="email" inputmode="email" required></div>
        <div class="field"><label for="au-pass">Password</label>
          <div class="input-wrap">
            <input class="input" id="au-pass" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
            <button type="button" data-show aria-pressed="false">Show</button>
          </div>
          ${signup && html`<span class="hint">At least 10 characters. A short sentence works well.</span>`}
        </div>
        <p class="error" role="alert"></p>
        <button class="btn" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <button class="btn text" data-switch>${signup ? 'I already have an account' : 'New here? Create an account'}</button>
      <p class="lock-note">${icon.lock}<span>Your records are private to your account. Nobody else using CreditFlow can see them. <a class="link" href="privacy.html">Privacy policy</a></span></p>
    </div></div>`);

    const form = root.querySelector('form');
    const err = form.querySelector('.error');
    root.querySelector('[data-switch]').addEventListener('click', () => { mode = signup ? 'login' : 'signup'; draw(); });
    root.querySelector('[data-show]').addEventListener('click', (e) => {
      const input = form.password;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Hide' : 'Show';
      e.currentTarget.setAttribute('aria-pressed', String(show));
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const password = form.password.value;
      if (signup && !form.name.value.trim()) { err.textContent = 'Enter your name.'; form.name.focus(); return; }
      if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email address.'; form.email.focus(); return; }
      if (!password) { err.textContent = 'Enter your password.'; form.password.focus(); return; }
      if (signup && password.length < 10) { err.textContent = 'Password must be at least 10 characters.'; form.password.focus(); return; }
      const ok = await submitWith(form, () => api('POST', signup ? '/auth/register' : '/auth/login',
        signup ? { email, password, name: form.name.value.trim() } : { email, password }));
      if (ok) onDone();
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
