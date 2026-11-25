// Shared helpers: safe HTML templates, the API client, money and date formatting, sheets and toasts.

// ---------- safe HTML ----------
// Everything interpolated into html`...` is escaped unless it was itself produced
// by html`...`, so text typed by users can never run as markup.
class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const part = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
};
export const html = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const mount = (el, tpl) => { el.innerHTML = String(tpl); };

// ---------- state ----------
export const state = { user: null, portal: 'personal' };

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || 'Could not reach the server. Check your connection and try again.');
    this.status = status;
    this.data = data || {};
  }
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => localDate();

export async function api(method, path, body) {
  const headers = { 'X-Requested-With': 'creditflow', 'X-Client-Date': today() };
  if (state.user?.csrf) headers['X-CSRF-Token'] = state.user.csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON reply */ }
  if (!res.ok) {
    if (res.status === 401 && state.user) {
      state.user = null;
      window.dispatchEvent(new Event('cf:signed-out'));
    }
    throw new ApiError(res.status, data);
  }
  if (data?.user) state.user = data.user;
  return data;
}

// ---------- money ----------
const COUNTRY_CURRENCY = 'AE:AED,AF:AFN,AR:ARS,AT:EUR,AU:AUD,AZ:AZN,BD:BDT,BE:EUR,BG:BGN,BH:BHD,BR:BRL,CA:CAD,CH:CHF,CL:CLP,CN:CNY,CO:COP,CZ:CZK,DE:EUR,DK:DKK,DZ:DZD,EG:EGP,ES:EUR,ET:ETB,FI:EUR,FR:EUR,GB:GBP,GH:GHS,GR:EUR,HK:HKD,HU:HUF,ID:IDR,IE:EUR,IL:ILS,IN:INR,IQ:IQD,IR:IRR,IT:EUR,JO:JOD,JP:JPY,KE:KES,KR:KRW,KW:KWD,KZ:KZT,LB:LBP,LK:LKR,MA:MAD,MM:MMK,MX:MXN,MY:MYR,NG:NGN,NL:EUR,NO:NOK,NP:NPR,NZ:NZD,OM:OMR,PE:PEN,PH:PHP,PK:PKR,PL:PLN,PT:EUR,QA:QAR,RO:RON,RS:RSD,RU:RUB,SA:SAR,SD:SDG,SE:SEK,SG:SGD,TH:THB,TN:TND,TR:TRY,TW:TWD,TZ:TZS,UA:UAH,UG:UGX,US:USD,UZ:UZS,VN:VND,YE:YER,ZA:ZAR,ZM:ZMW';
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });
const currencyName = new Intl.DisplayNames(['en'], { type: 'currency' });
export const COUNTRIES = COUNTRY_CURRENCY.split(',')
  .map((p) => { const [code, currency] = p.split(':'); return { code, currency, name: regionName.of(code) }; })
  .sort((a, b) => a.name.localeCompare(b.name));
export const CURRENCIES = [...new Set(COUNTRIES.map((c) => c.currency))]
  .map((code) => ({ code, name: currencyName.of(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));
export const currencyFor = (country) => COUNTRIES.find((c) => c.code === country)?.currency || 'USD';

/** Guess the user's country from the device's language setting, for a sensible default. */
export function guessCountry() {
  for (const tag of navigator.languages || [navigator.language]) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (COUNTRIES.some((c) => c.code === region)) return region;
    } catch { /* ignore bad tags */ }
  }
  return 'US';
}

const fmtCache = new Map();
function formatter(currency, digits) {
  const key = `${currency}:${digits}`;
  if (!fmtCache.has(key)) {
    const base = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    const max = base.resolvedOptions().maximumFractionDigits;
    fmtCache.set(key, new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits === 'auto' ? 0 : max,
      maximumFractionDigits: max,
    }));
  }
  return fmtCache.get(key);
}
/** Formats an amount in the user's currency. Whole amounts drop the ".00" to stay easy to read. */
export function money(n) {
  const v = Number(n) || 0;
  const currency = state.user?.currency || 'USD';
  return formatter(currency, Number.isInteger(v) ? 'auto' : 'full').format(v);
}
export const currencySymbol = () => formatter(state.user?.currency || 'USD', 'auto').formatToParts(0).find((p) => p.type === 'currency')?.value || '';

// ---------- dates ----------
export const monthOf = (dateStr) => dateStr.slice(0, 7);
export const shiftMonth = (month, by) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const asDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
export const monthLabel = (month, style = 'long') => asDate(`${month}-01`).toLocaleDateString(undefined, style === 'long' ? { month: 'long', year: 'numeric' } : { month: 'short' });
export function dayLabel(dateStr) {
  const t = today();
  if (dateStr === t) return 'Today';
  if (dateStr === localDate(new Date(Date.now() - 864e5))) return 'Yesterday';
  return asDate(dateStr).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: dateStr.slice(0, 4) === t.slice(0, 4) ? undefined : 'numeric' });
}
export const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 864e5);

// ---------- icons ----------
const I = (d) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${new Safe(d)}</svg>`;
export const icon = {
  home: I('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
  plan: I('<circle cx="12" cy="12" r="9"/><path d="M12 3v9l6 4"/>'),
  people: I('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M17 4a4 4 0 010 8M22 21c0-3-1.500-5-4-5.600"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.300l2-1.500-2-3.400-2.300 1a7 7 0 00-2.300-1.300L14 3h-4l-.3 2.500a7 7 0 00-2.300 1.300l-2.300-1-2 3.400 2 1.500a7 7 0 000 2.600l-2 1.500 2 3.400 2.300-1a7 7 0 002.300 1.300L10 21h4l.3-2.500a7 7 0 002.300-1.300l2.300 1 2-3.400-2-1.500c.1-.4.1-.9.1-1.300z"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  check: I('<circle cx="12" cy="12" r="9"/><path d="M8 12.500l3 3 5-6"/>'),
  alert: I('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>'),
  stop: I('<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M12 7v6M12 17h.01"/>'),
  left: I('<path d="M15 5l-7 7 7 7"/>'),
  right: I('<path d="M9 5l7 7-7 7"/>'),
  trash: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  wallet: I('<path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v11a2 2 0 002 2h15V9H5a2 2 0 01-2-2z"/><path d="M16 14h.01"/>'),
  store: I('<path d="M4 9l1-5h14l1 5"/><path d="M4 9a3 3 0 006 0 3 3 0 006 0 3 3 0 004 0"/><path d="M5 12v8h14v-8"/><path d="M10 20v-5h4v5"/>'),
  both: I('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M13 7h5v3M11 17H6v-3"/>'),
  bills: I('<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h3"/>'),
  fun: I('<circle cx="12" cy="12" r="9"/><path d="M8 14s1.500 2.500 4 2.500 4-2.500 4-2.500M9 9h.01M15 9h.01"/>'),
  other: I('<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 016 0v2"/>'),
  savings: I('<path d="M19 9c1 1 2 2.500 2 4.500a6 6 0 01-3 5V21h-3v-1.500h-4V21H8v-2.600A6.500 6.500 0 014 13c0-3.600 3.300-6 7.500-6 1 0 2 .1 3 .500L18 6v3z"/><path d="M15.500 11.500h.01"/>'),
  invest: I('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
  back: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  cash: I('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>'),
  credit: I('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
  download: I('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
};
export const logo = html`<svg viewBox="0 0 40 40" aria-hidden="true"><rect class="brand-mark" width="40" height="40" rx="12"/><path class="brand-line" d="M9 26l7-7 5 5 10-11" fill="none" stroke-width="3.500" stroke-linecap="round" stroke-linejoin="round"/><path class="brand-line" d="M24 13h7v7" fill="none" stroke-width="3.500" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------- toast ----------
let toastTimer;
export function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  (document.querySelector('dialog[open]') || document.body).appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2800);
}

// ---------- sheets ----------
/**
 * Opens a bottom sheet. `render(body, close)` fills it and wires its events.
 * Returns a promise that resolves with whatever `close(value)` was given.
 */
export function sheet(title, render) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    mount(dlg, html`<div class="sheet-body">
      <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">${icon.close}</button></div>
      <div class="sheet-content form"></div>
    </div>`);
    let result;
    const close = (value) => { result = value; dlg.close(); };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) close(); });
    document.body.appendChild(dlg);
    render(dlg.querySelector('.sheet-content'), close);
    dlg.showModal();
  });
}

/** A yes/no question in a sheet. Resolves true only if the user confirms. */
export function confirmSheet(title, message, confirmLabel, danger = true) {
  return sheet(title, (body, close) => {
    mount(body, html`<p class="muted">${message}</p>
      <button class="btn ${danger ? 'danger' : ''}" data-yes>${confirmLabel}</button>
      <button class="btn ghost" data-close>Cancel</button>`);
    body.querySelector('[data-yes]').addEventListener('click', () => close(true));
  }).then((v) => v === true);
}

/** Runs a form submit: disables the button while saving and shows the error under the form. */
export async function submitWith(form, fn) {
  const btn = form.querySelector('[type=submit]');
  const err = form.querySelector('.error');
  if (err) err.textContent = '';
  btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status === 409 && e.data.red_lines) throw e;
    if (err) err.textContent = e.message;
    return undefined;
  } finally {
    btn.disabled = false;
  }
}

/** Reads a money input: accepts "1,500.50" style typing and returns a plain number string, or null. */
export function readAmount(input) {
  const v = input.value.replace(/[,\s]/g, '').trim();
  return /^\d{1,12}(\.\d{1,2})?$/.test(v) ? v : null;
}
