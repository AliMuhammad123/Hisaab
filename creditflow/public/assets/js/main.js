// App shell: decides which screen to show and draws the header, portal switch and tabs.
import { html, mount, api, state, icon, logo, toast } from './core.js';
import { renderAuth, renderWelcome } from './auth.js';
import { renderPersonalHome, renderPlan } from './personal.js';
import { renderBusinessHome, renderClients, renderClient } from './business.js';
import { renderSettings } from './settings.js';

const app = document.getElementById('app');

const TABS = {
  personal: [
    { href: '#/p', label: 'Home', icon: 'home' },
    { href: '#/p/plan', label: 'Plan', icon: 'plan' },
    { href: '#/settings', label: 'Settings', icon: 'settings' },
  ],
  business: [
    { href: '#/b', label: 'Home', icon: 'home' },
    { href: '#/b/clients', label: 'Customers', icon: 'people' },
    { href: '#/settings', label: 'Settings', icon: 'settings' },
  ],
};

function allowedPortals() {
  const m = state.user?.app_mode;
  return m === 'both' ? ['personal', 'business'] : [m];
}

function savedPortal() {
  try { return localStorage.getItem('cf_portal'); } catch { return null; }
}

function setPortal(p) {
  state.portal = p;
  document.body.dataset.portal = p;
  try { localStorage.setItem('cf_portal', p); } catch { /* private mode */ }
}

async function start() {
  try {
    await api('GET', '/auth/me');
  } catch (e) {
    if (e.status !== 401) {
      mount(app, html`<div class="auth"><div class="auth-box"><div class="brand">${logo} CreditFlow</div>
        <p>${e.message}</p><button class="btn" data-retry>Try again</button></div></div>`);
      app.querySelector('[data-retry]').addEventListener('click', start);
      return;
    }
  }
  route();
}

function route() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  if (!state.user) {
    delete document.body.dataset.portal;
    renderAuth(app, route);
    return;
  }
  if (!state.user.app_mode || !state.user.currency) {
    renderWelcome(app, () => { location.hash = ''; route(); });
    return;
  }

  const allowed = allowedPortals();
  const hash = location.hash || '';
  // The address decides the portal; otherwise fall back to the last one used.
  let portal = hash.startsWith('#/b') ? 'business' : hash.startsWith('#/p') ? 'personal' : (savedPortal() || allowed[0]);
  if (!allowed.includes(portal)) portal = allowed[0];
  const home = portal === 'business' ? '#/b' : '#/p';
  if (!hash || (hash.startsWith('#/b') && portal !== 'business') || (hash.startsWith('#/p') && portal !== 'personal')) {
    history.replaceState(null, '', home);
  }
  setPortal(portal);
  const path = location.hash;

  mount(app, html`<div class="shell">
    <nav class="tabs" aria-label="Main">
      ${TABS[portal].map((t) => html`<a href="${t.href}" ${t.href === path || (t.href === '#/b/clients' && path.startsWith('#/b/client')) ? html`aria-current="page"` : ''}>${icon[t.icon]}<span>${t.label}</span></a>`)}
    </nav>
    <div class="main">
      <header class="topbar">
        <a class="brand" href="${home}" aria-label="CreditFlow home">${logo}<span>CreditFlow</span></a>
        ${allowed.length > 1 ? html`<div class="seg" role="group" aria-label="Switch portal">
          <button data-portal="personal" aria-pressed="${String(portal === 'personal')}">Personal</button>
          <button data-portal="business" aria-pressed="${String(portal === 'business')}">Business</button>
        </div>` : ''}
      </header>
      <main id="view" class="main-view"></main>
    </div>
  </div>`);

  app.querySelectorAll('[data-portal]').forEach((b) => b.addEventListener('click', () => {
    location.hash = b.dataset.portal === 'business' ? '#/b' : '#/p';
  }));

  const view = document.getElementById('view');
  const client = path.match(/^#\/b\/client\/(\d+)$/);
  if (path === '#/settings') renderSettings(view, route);
  else if (path === '#/p/plan') renderPlan(view);
  else if (path === '#/b/clients') renderClients(view);
  else if (client) renderClient(view, Number(client[1]));
  else if (portal === 'business') renderBusinessHome(view);
  else renderPersonalHome(view);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('cf:signed-out', () => { location.hash = ''; route(); });
window.addEventListener('offline', () => toast('You are offline. Changes cannot be saved right now.'));

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* the app works without it */ });
}

start();
