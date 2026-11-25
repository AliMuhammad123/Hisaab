// Personal portal: this month's money, the monthly plan, adding entries and the red-line stop.
import { html, mount, api, state, ApiError, icon, money, currencySymbol, today, monthOf, shiftMonth, monthLabel, dayLabel, sheet, confirmSheet, toast, submitWith, readAmount } from './core.js';

export const CATS = {
  mandatory: { label: 'Bills & needs', hint: 'Rent, food, transport, fees', icon: 'bills', kind: 'spend' },
  entertainment: { label: 'Fun & treats', hint: 'Eating out, trips, hobbies', icon: 'fun', kind: 'spend' },
  other: { label: 'Other spending', hint: 'Anything else', icon: 'other', kind: 'spend' },
  savings: { label: 'Savings', hint: 'Money you put away', icon: 'savings', kind: 'aside' },
  investment: { label: 'Investment', hint: 'Money you invest', icon: 'invest', kind: 'aside' },
  return: { label: 'Investment return', hint: 'Profit that came back to you', icon: 'back', kind: 'in' },
};
const PLAN_ORDER = ['mandatory', 'savings', 'investment', 'entertainment', 'other'];

let month = monthOf(today());

// ---------- home ----------
export async function renderPersonalHome(root) {
  mount(root, html`<div class="skeleton"></div><div class="skeleton"></div>`);
  let s;
  try {
    s = await api('GET', `/personal/summary?month=${month}`);
  } catch (e) {
    mount(root, html`<div class="card empty"><p>${e.message}</p><button class="btn small" data-retry>Try again</button></div>`);
    root.querySelector('[data-retry]').addEventListener('click', () => renderPersonalHome(root));
    return;
  }
  const hasPlan = !!s.budget;
  const f = s.forecast;

  mount(root, html`
    <div class="month-nav">
      <button class="icon-btn" data-month="-1" aria-label="Previous month">${icon.left}</button>
      <h1>${monthLabel(month)}</h1>
      <button class="icon-btn" data-month="1" aria-label="Next month">${icon.right}</button>
    </div>

    ${hasPlan ? html`
      <section class="hero" aria-label="Money left">
        <span class="label">Left this month</span>
        <span class="big num">${money(s.left)}</span>
        <span class="sub num">from ${money(s.money_in)} coming in${s.returns > 0 ? html` (includes ${money(s.returns)} in returns)` : ''}</span>
        <div class="hero-stats">
          <div><span>Spent</span><b class="num">${money(s.spent)}</b></div>
          <div><span>Saved &amp; invested</span><b class="num">${money(s.set_aside)}</b></div>
        </div>
      </section>
      ${s.is_current ? forecastStatus(s) : ''}
    ` : html`
      <section class="card empty">
        ${icon.plan}
        <h2>Make a plan for ${monthLabel(month)}</h2>
        <p>Enter your income and how much you want to spend and save. CreditFlow will stop you before you cross a limit.</p>
        <a class="btn" href="#/p/plan">Set up my plan</a>
      </section>`}

    ${hasPlan ? html`<section class="card">
      <div class="card-head"><h2>Your limits</h2><a class="link" href="#/p/plan">Change plan</a></div>
      ${PLAN_ORDER.map((c) => meter(c, s.categories[c]))}
    </section>` : ''}

    ${nextMonthCard(s)}

    <section class="card">
      <div class="card-head"><h2>Entries</h2><span class="muted small">${s.entries.length} this month</span></div>
      ${s.entries.length ? html`<div class="list">${s.entries.map(entryRow)}</div>` : html`<div class="empty">
        <p>Nothing added yet. Tap <b>Add</b> each time you spend, save or invest.</p></div>`}
    </section>

    <button class="fab" data-add>${icon.plus} Add</button>`);

  root.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => {
    month = shiftMonth(month, Number(b.dataset.month));
    renderPersonalHome(root);
  }));
  root.querySelector('[data-add]').addEventListener('click', async () => {
    if (await addEntrySheet(month)) renderPersonalHome(root);
  });
  root.querySelectorAll('[data-entry]').forEach((b) => b.addEventListener('click', async () => {
    const e = s.entries.find((x) => x.id === Number(b.dataset.entry));
    const yes = await confirmSheet('Delete this entry?', `${e.note || CATS[e.category].label} · ${money(e.amount)} · ${dayLabel(e.entry_date)}`, 'Delete entry');
    if (!yes) return;
    try { await api('DELETE', `/entries/${e.id}`); toast('Entry deleted'); renderPersonalHome(root); } catch (err) { toast(err.message); }
  }));
}

function forecastStatus(s) {
  const f = s.forecast;
  const early = f.confidence === 'low' ? ' This is an early estimate and improves as you add entries.' : '';
  const days = `${f.days_left} day${f.days_left === 1 ? '' : 's'}`;
  if (f.level === 'danger') {
    return html`<div class="status bad" role="status">${icon.stop}<div><b>You are heading over your income</b>
      <span>At this pace you will spend about ${money(s.forecast.projected_spend)} this month${f.run_out_date ? html`, and run out around ${dayLabel(f.run_out_date)}` : ''}. Keep to ${money(f.safe_daily)} a day.${early}</span></div></div>`;
  }
  if (f.level === 'watch') {
    return html`<div class="status warn" role="status">${icon.alert}<div><b>Slow down a little</b>
      <span>At this pace you will use money you planned to save. Keep to ${money(f.safe_daily)} a day for the next ${days}.${early}</span></div></div>`;
  }
  return html`<div class="status" role="status">${icon.check}<div><b>You are on track</b>
    <span>${f.days_left > 0 ? html`You can spend about ${money(f.safe_daily)} a day for the next ${days} and still reach your plan.` : 'Last day of the month. Well done for keeping to your plan.'}${early}</span></div></div>`;
}

function meter(cat, v) {
  const c = CATS[cat];
  const pct = v.limit > 0 ? v.spent / v.limit : 0;
  const cls = c.kind === 'aside' ? (pct >= 1 ? 'good' : '') : pct > 1 ? 'bad' : pct >= 0.8 ? 'warn' : '';
  const right = v.limit > 0
    ? (c.kind === 'aside'
      ? html`${money(v.spent)} of ${money(v.limit)}`
      : v.spent > v.limit ? html`${money(v.spent - v.limit)} over` : html`${money(v.limit - v.spent)} left of ${money(v.limit)}`)
    : html`${money(v.spent)} · no limit`;
  return html`<div class="meter">
    <div class="meter-top"><b>${c.label}</b><span class="num">${right}</span></div>
    <progress class="${cls}" max="${v.limit > 0 ? v.limit : Math.max(v.spent, 1)}" value="${Math.min(v.spent, v.limit > 0 ? v.limit : v.spent)}" aria-label="${c.label}"></progress>
  </div>`;
}

function nextMonthCard(s) {
  const nm = s.forecast.next_month;
  const bars = s.trend;
  if (nm.months_used < 1 && bars.every((b) => b.spend === 0)) return '';
  const pred = nm.months_used >= 1 ? nm.spend : null;
  const max = Math.max(1, ...bars.map((b) => b.spend), pred || 0);
  const all = pred === null ? bars : [...bars, { month: shiftMonth(s.month, 1), spend: pred, pred: true }];
  const W = 320, H = 150, base = 118, top = 14;
  const slot = W / all.length;
  const bw = Math.min(40, slot * 0.6);
  return html`<section class="card">
    <div class="card-head"><h2>Spending by month</h2></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending for recent months${pred !== null ? ' and an estimate for next month' : ''}">
      ${all.map((b, i) => {
        const h = Math.max(3, (b.spend / max) * (base - top));
        const x = i * slot + (slot - bw) / 2;
        return html`<rect class="bar ${b.pred ? 'pred' : b.month === s.month ? '' : 'dim'}" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="6"></rect>
          <text x="${(x + bw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">${monthLabel(b.month, 'short')}</text>`;
      })}
    </svg>
    <p class="muted small">${pred !== null
      ? html`Dashed bar: next month's estimate, about <b class="num">${money(pred)}</b>. It follows the trend of your last ${nm.months_used} full month${nm.months_used === 1 ? '' : 's'}.`
      : 'After one full month of entries, an estimate for next month appears here.'}</p>
  </section>`;
}

function entryRow(e) {
  const c = CATS[e.category];
  return html`<button class="row" data-entry="${e.id}">
    <span class="avatar ${c.kind === 'in' ? 'good' : ''}">${icon[c.icon]}</span>
    <span class="body"><span class="title">${e.note || c.label}</span>
      <span class="meta">${dayLabel(e.entry_date)}${e.note ? ` · ${c.label}` : ''}${e.overridden ? ' · saved past a limit' : ''}</span></span>
    <span class="amt num ${c.kind === 'in' ? 'in' : ''}">${c.kind === 'in' ? '+' : ''}${money(e.amount)}</span>
  </button>`;
}

// ---------- add entry ----------
export function addEntrySheet(forMonth) {
  const date = forMonth === monthOf(today()) ? today() : `${forMonth}-01`;
  return sheet('Add an entry', (body, close) => {
    const drawForm = (keep = {}) => {
      mount(body, html`<form class="form" novalidate>
        <div class="field"><label for="en-amount">Amount (${currencySymbol()})</label>
          <input class="input amount num" id="en-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${keep.amount || ''}" required></div>
        <div class="field"><span class="lbl" id="en-cat-lbl">What was it?</span>
          <div class="chips" role="radiogroup" aria-labelledby="en-cat-lbl">
            ${Object.entries(CATS).map(([id, c]) => html`<label><input type="radio" name="category" value="${id}" ${(keep.category || 'mandatory') === id ? html`checked` : ''}><span>${c.label}</span></label>`)}
          </div>
          <span class="hint" data-cat-hint></span></div>
        <div class="field"><label for="en-date">Date</label>
          <input class="input" id="en-date" name="entry_date" type="date" value="${keep.entry_date || date}" max="${today()}" required></div>
        <div class="field"><label for="en-note">Note (optional)</label>
          <input class="input" id="en-note" name="note" maxlength="200" placeholder="For example: electricity bill" value="${keep.note || ''}"></div>
        <p class="error" role="alert"></p>
        <button class="btn" type="submit">Save entry</button>
      </form>`);
      const form = body.querySelector('form');
      const hint = form.querySelector('[data-cat-hint]');
      const showHint = () => { hint.textContent = CATS[form.category.value].hint; };
      form.addEventListener('change', showHint);
      showHint();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = readAmount(form.amount);
        if (!amount || Number(amount) <= 0) { form.querySelector('.error').textContent = 'Enter an amount, for example 1500.'; form.amount.focus(); return; }
        const entry = { category: form.category.value, amount, entry_date: form.entry_date.value, note: form.note.value.trim() };
        try {
          const ok = await submitWith(form, () => api('POST', '/entries', entry));
          if (ok) { toast('Saved'); close(true); }
        } catch (err) {
          if (err instanceof ApiError && err.data.red_lines) drawStop(entry, err.data);
          else form.querySelector('.error').textContent = err.message;
        }
      });
      if (!keep.amount) form.amount.focus();
    };

    // The stop screen: shown when the server refuses the entry because it crosses a limit.
    const drawStop = (entry, data) => {
      mount(body, html`<div class="stop-banner" role="alert">
          <h3>${icon.stop} Stop. This crosses a limit.</h3>
          <p>${CATS[entry.category].label} · <b class="num">${money(entry.amount)}</b> has <b>not</b> been saved.</p>
          <ul>${data.red_lines.map((l) => html`<li><b>${l.title}</b> by <span class="num">${money(l.over_by)}</span>. ${l.detail}</li>`)}</ul>
        </div>
        <button class="btn" data-back>Go back and change it</button>
        ${data.can_override
          ? html`<button class="btn ghost" data-force>Save it anyway</button>
             <p class="muted small">Saving anyway marks the entry so you can see later where you went past your plan.</p>`
          : html`<p class="muted small">Hard stop is on, so this entry cannot be saved. You can turn it off under Plan.</p>`}
        <p class="error" role="alert"></p>`);
      body.querySelector('[data-back]').addEventListener('click', () => drawForm(entry));
      body.querySelector('[data-force]')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try { await api('POST', '/entries', { ...entry, override: true }); toast('Saved past your limit'); close(true); }
        catch (err) { body.querySelector('.error').textContent = err.message; e.currentTarget.disabled = false; }
      });
    };
    drawForm();
  });
}

// ---------- plan ----------
export async function renderPlan(root) {
  mount(root, html`<div class="skeleton"></div>`);
  let s;
  try { s = await api('GET', `/personal/summary?month=${month}`); } catch (e) { mount(root, html`<div class="card empty"><p>${e.message}</p></div>`); return; }
  const b = s.budget || s.suggested_budget || {};
  const val = (k) => (b[k] ? String(b[k]) : '');

  mount(root, html`
    <div><h1 class="page-title">Plan for ${monthLabel(month)}</h1>
      <p class="muted">${s.budget ? 'Change your income or limits at any time.' : s.suggested_budget ? 'We filled in your last plan. Change anything that is different this month.' : 'Start with your income, then decide where it goes.'}</p></div>
    <form class="card form" novalidate>
      <div class="field"><label for="pl-income">Monthly income (${currencySymbol()})</label>
        <input class="input amount num" id="pl-income" name="income" inputmode="decimal" autocomplete="off" placeholder="0" value="${val('income')}">
        <span class="hint">Your salary or what you expect to earn this month.</span></div>
      <button class="btn ghost small" type="button" data-split>Split it for me</button>
      ${PLAN_ORDER.map((c) => html`<div class="field"><label for="pl-${c}">${CATS[c].label}</label>
        <input class="input num" id="pl-${c}" name="${c}" inputmode="decimal" autocomplete="off" placeholder="0" value="${val(c)}">
        <span class="hint">${CATS[c].kind === 'aside' ? 'Goal: ' : 'Limit: '}${CATS[c].hint.toLowerCase()}</span></div>`)}
      <div class="status" data-left role="status">${icon.check}<div><b></b><span></span></div></div>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit">Save plan</button>
    </form>
    <section class="card">
      <label class="switch"><span><b>Hard stop</b><br><span class="muted small">Never let me save an entry that crosses a limit. Without this, you get a stop screen but can choose to save anyway.</span></span>
        <input type="checkbox" id="pl-strict" ${state.user.strict_stop ? html`checked` : ''}></label>
    </section>`);

  const form = root.querySelector('form');
  const leftBox = form.querySelector('[data-left]');
  const num = (name) => Number(readAmount(form[name]) || 0);
  const update = () => {
    const income = num('income');
    const planned = PLAN_ORDER.reduce((t, c) => t + num(c), 0);
    const left = Math.round((income - planned) * 100) / 100;
    leftBox.className = `status ${left < 0 ? 'bad' : ''}`;
    leftBox.querySelector('b').textContent = left < 0 ? `${money(-left)} more than your income` : left === 0 && income > 0 ? 'Every bit of income has a job' : `${money(left)} not planned yet`;
    leftBox.querySelector('span').textContent = left < 0 ? 'Lower one of the amounts so the plan fits your income.' : left === 0 ? '' : 'That is fine. Unplanned money simply stays free.';
  };
  form.addEventListener('input', update);
  update();

  form.querySelector('[data-split]').addEventListener('click', () => {
    const income = num('income');
    if (!income) { form.querySelector('.error').textContent = 'Enter your income first.'; form.income.focus(); return; }
    // A common starting point: half for needs, a fifth saved, a tenth each for investing, fun and everything else.
    const shares = { mandatory: 0.5, savings: 0.2, investment: 0.1, entertainment: 0.1, other: 0.1 };
    PLAN_ORDER.forEach((c) => { form[c].value = String(Math.floor(income * shares[c])); });
    form.querySelector('.error').textContent = '';
    update();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.error');
    const body = { month };
    for (const name of ['income', ...PLAN_ORDER]) {
      const raw = form[name].value.trim();
      const v = raw === '' ? '0' : readAmount(form[name]);
      if (v === null) { err.textContent = 'Use numbers only, for example 25000.'; form[name].focus(); return; }
      body[name] = v;
    }
    if (Number(body.income) <= 0) { err.textContent = 'Enter your monthly income.'; form.income.focus(); return; }
    const ok = await submitWith(form, () => api('PUT', '/budget', body));
    if (ok) { toast('Plan saved'); location.hash = '#/p'; }
  });

  root.querySelector('#pl-strict').addEventListener('change', async (e) => {
    try { await api('PATCH', '/me', { strict_stop: e.target.checked }); toast(e.target.checked ? 'Hard stop is on' : 'Hard stop is off'); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
  });
}
