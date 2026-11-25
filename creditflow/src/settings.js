// Settings: profile, portals, country and currency, password, data export and account deletion.
import { html, mount, api, state, icon, sheet, toast, submitWith } from './core.js';
import { portalChoices, countryFields, linkCountryCurrency } from './auth.js';

export function renderSettings(root, onChange) {
  const u = state.user;
  mount(root, html`
    <h1 class="page-title">Settings</h1>
    <section class="card">
<div class="list"><div class="row"><span class="avatar">${u.name.slice(0, 1).toUpperCase()}</span>
        <span class="body"><span class="title">${u.name}</span><span class="meta">${u.email}</span></span></div></div>
    </section>

    <section class="card">
      <h2>What you use CreditFlow for</h2>
      <div class="form" data-modes>${portalChoices(u.app_mode)}</div>
    </section>

    <form class="card form" data-region>
      <h2>Country and currency</h2>
      ${countryFields(u.country, u.currency)}
      <p class="error" role="alert"></p>
      <button class="btn ghost" type="submit">Save</button>
    </form>

    <section class="card">
      <h2>Privacy and security</h2>
      <p class="lock-note">${icon.lock}<span>Your records are tied to your account and are never shown to other users. Your password is stored scrambled, so nobody can read it.</span></p>
      <a class="link" href="privacy.html">Read the privacy policy</a>
      <button class="btn ghost" data-password>Change password</button>
      <button class="btn ghost" data-logout>Sign out</button>
    </section>

    <section class="card">
      <h2>Delete account</h2>
      <p class="muted">This removes your account and every record in it for good.</p>
      <button class="btn danger" data-delete>Delete my account</button>
    </section>`);

  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('PATCH', '/me', { app_mode: b.dataset.mode }); toast('Saved'); onChange(); } catch (e) { toast(e.message); }
  }));

  const region = root.querySelector('[data-region]');
  linkCountryCurrency(region);
  region.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await submitWith(region, () => api('PATCH', '/me', { country: region.country.value, currency: region.currency.value }));
    if (ok) { toast('Saved'); onChange(); }
  });

  root.querySelector('[data-logout]').addEventListener('click', async () => {
    try { await api('POST', '/auth/logout', {}); } catch { /* signed out either way */ }
    state.user = null;
    window.dispatchEvent(new Event('cf:signed-out'));
  });

  root.querySelector('[data-password]').addEventListener('click', () => sheet('Change password', (body, close) => {
    mount(body, html`<form class="form" novalidate>
      <div class="field"><label for="pw-cur">Current password</label>
        <input class="input" id="pw-cur" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pw-new">New password</label>
        <input class="input" id="pw-new" name="next" type="password" autocomplete="new-password" required>
        <span class="hint">At least 10 characters. Other devices will be signed out.</span></div>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit">Change password</button>
    </form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.next.value.length < 10) { form.querySelector('.error').textContent = 'New password must be at least 10 characters.'; return; }
      const ok = await submitWith(form, () => api('POST', '/me/password', { current: form.current.value, new: form.next.value }));
      if (ok) { toast('Password changed'); close(); }
    });
  }));

  root.querySelector('[data-delete]').addEventListener('click', () => sheet('Delete your account?', (body, close) => {
    mount(body, html`<form class="form" novalidate>
      <p>Every customer, credit entry, payment, plan and entry in your account will be deleted. This cannot be undone.</p>
      <div class="field"><label for="del-pass">Type your password to confirm</label>
        <input class="input" id="del-pass" name="password" type="password" autocomplete="current-password" required></div>
      <p class="error" role="alert"></p>
      <button class="btn danger" type="submit">Delete everything</button>
      <button class="btn ghost" type="button" data-close>Keep my account</button>
    </form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok = await submitWith(form, () => api('POST', '/me/delete', { password: form.password.value }));
      if (ok) { close(); state.user = null; window.dispatchEvent(new Event('cf:signed-out')); }
    });
  }));
}
