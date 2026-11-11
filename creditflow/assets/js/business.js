// Business portal: who owes you, giving credit, and recording payments.
import { html, mount, api, ApiError, icon, money, currencySymbol, today, dayLabel, daysBetween, sheet, confirmSheet, toast, submitWith, readAmount } from './core.js';

const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const STATUS = {
  paid: { label: 'Paid', cls: 'good' },
  partial: { label: 'Part paid', cls: '' },
  unpaid: { label: 'Not paid', cls: '' },
  overdue: { label: 'Overdue', cls: 'bad' },
};

function dueText(inv) {
  if (inv.status === 'paid') return 'Paid in full';
  if (!inv.due_date) return 'No due date';
  const d = daysBetween(today(), inv.due_date);
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`;
  if (d === 0) return 'Due today';
  return `Due in ${d} day${d === 1 ? '' : 's'}`;
}

const failed = (root, e, retry) => {
  mount(root, html`<div class="card empty"><p>${e.message}</p><button class="btn small" data-retry>Try again</button></div>`);
  root.querySelector('[data-retry]').addEventListener('click', retry);
};

// ---------- home ----------
export async function renderBusinessHome(root) {
  mount(root, html`<div class="skeleton"></div><div class="skeleton"></div>`);
  let s;
  try { s = await api('GET', '/business/summary'); } catch (e) { failed(root, e, () => renderBusinessHome(root)); return; }

  mount(root, html`
    <section class="hero" aria-label="Money owed to you">
      <span class="label">Customers owe you</span>
      <span class="big num">${money(s.outstanding)}</span>
      <span class="sub">${s.client_count === 0 ? 'Add your first customer to begin' : `across ${s.client_count} customer${s.client_count === 1 ? '' : 's'}`}</span>
      <div class="hero-stats">
        <div><span>Received this month</span><b class="num">${money(s.collected_this_month)}</b></div>
        <div><span>Credit given this month</span><b class="num">${money(s.given_this_month)}</b></div>
      </div>
    </section>

    ${s.overdue > 0 ? html`<div class="status bad" role="status">${icon.alert}<div><b>${money(s.overdue)} is overdue</b>
      <span>${s.overdue_count} unpaid entr${s.overdue_count === 1 ? 'y has' : 'ies have'} passed the due date. Follow up with these customers.</span></div></div>` : ''}

    ${s.client_count === 0 ? html`<section class="card empty">
        ${icon.people}
        <h2>Add your first customer</h2>
        <p>Then record what they take on credit and what they pay back. CreditFlow keeps the balance for you.</p>
        <button class="btn" data-new-client>Add a customer</button>
      </section>` : html`
      <section class="card">
        <div class="card-head"><h2>Needs attention</h2></div>
        ${s.needs_attention.length ? html`<div class="list">${s.needs_attention.map((inv) => html`
          <a class="row" href="#/b/client/${inv.client_id}">
            <span class="avatar ${inv.status === 'overdue' ? 'bad' : 'warn'}">${initials(inv.client_name)}</span>
            <span class="body"><span class="title">${inv.client_name}</span><span class="meta">${dueText(inv)}</span></span>
            <span class="amt num">${money(inv.remaining)}</span></a>`)}</div>`
          : html`<p class="muted">Nothing is overdue or due in the next 7 days.</p>`}
      </section>
      <section class="card">
        <div class="card-head"><h2>Who owes the most</h2><a class="link" href="#/b/clients">All customers</a></div>
        ${s.top_owing.length ? html`<div class="list">${s.top_owing.map((c) => html`
          <a class="row" href="#/b/client/${c.client_id}"><span class="avatar">${initials(c.name)}</span>
            <span class="body"><span class="title">${c.name}</span></span><span class="amt num">${money(c.owed)}</span></a>`)}</div>`
          : html`<p class="muted">Nobody owes you anything right now.</p>`}
      </section>
      <section class="card">
        <div class="card-head"><h2>Latest payments</h2></div>
        ${s.recent_payments.length ? html`<div class="list">${s.recent_payments.map((p) => html`
          <a class="row" href="#/b/client/${p.client_id}"><span class="avatar good">${icon.cash}</span>
            <span class="body"><span class="title">${p.client_name}</span><span class="meta">${dayLabel(p.payment_date)} · ${p.method}</span></span>
            <span class="amt num in">+${money(p.amount)}</span></a>`)}</div>`
          : html`<p class="muted">No payments recorded yet.</p>`}
      </section>`}

    <button class="fab" data-add>${icon.plus} Add</button>`);

  root.querySelector('[data-new-client]')?.addEventListener('click', async () => { if (await clientSheet()) renderBusinessHome(root); });
  root.querySelector('[data-add]').addEventListener('click', async () => { if (await addChooser()) renderBusinessHome(root); });
}

// ---------- customers ----------
export async function renderClients(root) {
  mount(root, html`<div class="skeleton"></div>`);
  let clients;
  try { clients = (await api('GET', '/clients')).clients; } catch (e) { failed(root, e, () => renderClients(root)); return; }

  mount(root, html`
    <h1 class="page-title">Customers</h1>
    ${clients.length > 5 ? html`<input class="input" type="search" id="cl-search" placeholder="Search by name" aria-label="Search customers">` : ''}
    <section class="card">
      ${clients.length ? html`<div class="list" data-list></div>` : html`<div class="empty">${icon.people}
        <p>No customers yet. Add the people or shops you give credit to.</p></div>`}
    </section>
    <button class="fab" data-add>${icon.plus} Add customer</button>`);

  const list = root.querySelector('[data-list]');
  const draw = (q = '') => {
    if (!list) return;
    const shown = clients.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
    mount(list, shown.length ? html`${shown.map((c) => html`<a class="row" href="#/b/client/${c.id}">
      <span class="avatar">${initials(c.name)}</span>
      <span class="body"><span class="title">${c.name}</span>
        <span class="meta">${c.owed > 0 ? `${c.open_count} unpaid entr${c.open_count === 1 ? 'y' : 'ies'}` : 'All settled'}</span></span>
      <span class="amt num">${money(c.owed)}<small>owed</small></span></a>`)}` : html`<p class="muted">No customer matches “${q}”.</p>`);
  };
  draw();
  root.querySelector('#cl-search')?.addEventListener('input', (e) => draw(e.target.value));
  root.querySelector('[data-add]').addEventListener('click', async () => { if (await clientSheet()) renderClients(root); });
}

// ---------- one customer ----------
export async function renderClient(root, id) {
  mount(root, html`<div class="skeleton"></div>`);
  let client, invoices, payments;
  try {
    const [c, i, p] = await Promise.all([api('GET', '/clients'), api('GET', `/invoices?client_id=${id}`), api('GET', '/payments')]);
    client = c.clients.find((x) => x.id === id);
    invoices = i.invoices;
    payments = p.payments.filter((x) => x.client_id === id);
  } catch (e) { failed(root, e, () => renderClient(root, id)); return; }
  if (!client) { mount(root, html`<div class="card empty"><p>This customer was not found.</p><a class="btn small" href="#/b/clients">Back to customers</a></div>`); return; }

  const open = invoices.filter((i) => i.remaining > 0);
  const overLimit = client.credit_limit !== null && client.owed > client.credit_limit;
  mount(root, html`
    <a class="link" href="#/b/clients">‹ Customers</a>
    <section class="hero" aria-label="Balance">
      <span class="label">${client.name} owes you</span>
      <span class="big num">${money(client.owed)}</span>
      <span class="sub">${client.credit_limit !== null ? html`Credit limit <span class="num">${money(client.credit_limit)}</span>${overLimit ? ' · over the limit' : ''}` : 'No credit limit set'}</span>
      <div class="hero-stats">
        <div><span>Total credit given</span><b class="num">${money(client.billed)}</b></div>
        <div><span>Total paid back</span><b class="num">${money(client.paid)}</b></div>
      </div>
    </section>
    <div class="grid-2">
      <button class="btn" data-credit>Give credit</button>
      <button class="btn ghost" data-pay ${open.length ? '' : html`disabled`}>Record payment</button>
    </div>
    ${client.phone || client.email || client.notes ? html`<section class="card">
      ${client.phone ? html`<div><span class="muted small">Phone</span><br>${client.phone}</div>` : ''}
      ${client.email ? html`<div><span class="muted small">Email</span><br>${client.email}</div>` : ''}
      ${client.notes ? html`<div><span class="muted small">Notes</span><br>${client.notes}</div>` : ''}
    </section>` : ''}
    <section class="card">
      <div class="card-head"><h2>Credit given</h2></div>
      ${invoices.length ? html`<div class="list">${invoices.map((inv) => html`<div class="row">
        <span class="body"><span class="title">${inv.description || inv.number}</span>
          <span class="meta">${dayLabel(inv.invoice_date)} · ${dueText(inv)}</span>
          <span class="pill ${STATUS[inv.status].cls}">${STATUS[inv.status].label}</span></span>
        <span class="amt num">${money(inv.remaining)}<small>left of ${money(inv.amount)}</small></span>
        <button class="icon-btn" data-del-inv="${inv.id}" aria-label="Delete this credit entry">${icon.trash}</button></div>`)}</div>`
        : html`<p class="muted">No credit given yet.</p>`}
    </section>
    <section class="card">
      <div class="card-head"><h2>Payments received</h2></div>
      ${payments.length ? html`<div class="list">${payments.map((p) => html`<div class="row">
        <span class="avatar good">${icon.cash}</span>
        <span class="body"><span class="title">${dayLabel(p.payment_date)}</span><span class="meta">${p.method}${p.reference ? ` · ${p.reference}` : ''} · for ${p.invoice_number}</span></span>
        <span class="amt num in">+${money(p.amount)}</span>
        <button class="icon-btn" data-del-pay="${p.id}" aria-label="Delete this payment">${icon.trash}</button></div>`)}</div>`
        : html`<p class="muted">No payments yet.</p>`}
    </section>
    <div class="grid-2">
      <button class="btn ghost" data-edit>Edit details</button>
      <button class="btn ghost" data-del-client>Delete customer</button>
    </div>`);

  const again = () => renderClient(root, id);
  root.querySelector('[data-credit]').addEventListener('click', async () => { if (await creditSheet(client)) again(); });
  root.querySelector('[data-pay]').addEventListener('click', async () => { if (await paymentSheet(client, open)) again(); });
  root.querySelector('[data-edit]').addEventListener('click', async () => { if (await clientSheet(client)) again(); });
  root.querySelector('[data-del-client]').addEventListener('click', async () => {
    if (!await confirmSheet(`Delete ${client.name}?`, 'This also deletes every credit entry and payment recorded for this customer. It cannot be undone.', 'Delete customer')) return;
    try { await api('DELETE', `/clients/${id}`); toast('Customer deleted'); location.hash = '#/b/clients'; } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('[data-del-inv]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmSheet('Delete this credit entry?', 'Payments recorded against it are deleted too.', 'Delete entry')) return;
    try { await api('DELETE', `/invoices/${b.dataset.delInv}`); toast('Entry deleted'); again(); } catch (e) { toast(e.message); }
  }));
  root.querySelectorAll('[data-del-pay]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmSheet('Delete this payment?', 'The amount goes back onto what the customer owes.', 'Delete payment')) return;
    try { await api('DELETE', `/payments/${b.dataset.delPay}`); toast('Payment deleted'); again(); } catch (e) { toast(e.message); }
  }));
}

// ---------- sheets ----------
function clientSheet(existing) {
  return sheet(existing ? 'Edit customer' : 'Add a customer', (body, close) => {
    const c = existing || {};
    mount(body, html`<form class="form" novalidate>
      <div class="field"><label for="cs-name">Name</label>
        <input class="input" id="cs-name" name="name" maxlength="120" value="${c.name || ''}" placeholder="Person or shop name" required></div>
      <div class="field"><label for="cs-phone">Phone (optional)</label>
        <input class="input" id="cs-phone" name="phone" type="tel" maxlength="40" value="${c.phone || ''}"></div>
      <div class="field"><label for="cs-limit">Credit limit (optional, ${currencySymbol()})</label>
        <input class="input num" id="cs-limit" name="credit_limit" inputmode="decimal" autocomplete="off" value="${c.credit_limit ?? ''}">
        <span class="hint">The most this customer may owe you. CreditFlow stops you before you go past it.</span></div>
      <div class="field"><label for="cs-notes">Notes (optional)</label>
        <input class="input" id="cs-notes" name="notes" maxlength="1000" value="${c.notes || ''}"></div>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit">${existing ? 'Save changes' : 'Add customer'}</button>
    </form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.error');
      if (!form.name.value.trim()) { err.textContent = 'Enter the customer\'s name.'; form.name.focus(); return; }
      let limit = null;
      if (form.credit_limit.value.trim() !== '') {
        limit = readAmount(form.credit_limit);
        if (limit === null || Number(limit) <= 0) { err.textContent = 'Credit limit must be a number above zero, or left empty.'; form.credit_limit.focus(); return; }
      }
      const data = { name: form.name.value.trim(), phone: form.phone.value.trim(), email: c.email || '', notes: form.notes.value.trim(), credit_limit: limit };
      const ok = await submitWith(form, () => api(existing ? 'PATCH' : 'POST', existing ? `/clients/${existing.id}` : '/clients', data));
      if (ok) { toast(existing ? 'Saved' : 'Customer added'); close(ok.client); }
    });
    if (!existing) form.name.focus();
  });
}

function creditSheet(client) {
  return sheet(`Give credit to ${client.name}`, (body, close) => {
    const drawForm = (keep = {}) => {
      mount(body, html`<form class="form" novalidate>
        <div class="field"><label for="cr-amount">Amount (${currencySymbol()})</label>
          <input class="input amount num" id="cr-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${keep.amount || ''}" required></div>
        <div class="field"><label for="cr-desc">What for? (optional)</label>
          <input class="input" id="cr-desc" name="description" maxlength="500" placeholder="For example: 10 bags of rice" value="${keep.description || ''}"></div>
        <div class="grid-2">
          <div class="field"><label for="cr-date">Date</label>
            <input class="input" id="cr-date" name="invoice_date" type="date" value="${keep.invoice_date || today()}" max="${today()}" required></div>
          <div class="field"><label for="cr-due">Pay back by (optional)</label>
            <input class="input" id="cr-due" name="due_date" type="date" value="${keep.due_date || ''}"></div>
        </div>
        <p class="error" role="alert"></p>
        <button class="btn" type="submit">Save credit</button>
      </form>`);
      const form = body.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = form.querySelector('.error');
        const amount = readAmount(form.amount);
        if (!amount || Number(amount) <= 0) { err.textContent = 'Enter an amount, for example 5000.'; form.amount.focus(); return; }
        const data = { client_id: client.id, amount, description: form.description.value.trim(), invoice_date: form.invoice_date.value, due_date: form.due_date.value || null };
        try {
          const ok = await submitWith(form, () => api('POST', '/invoices', data));
          if (ok) { toast('Credit saved'); close(true); }
        } catch (ex) {
          if (ex instanceof ApiError && ex.data.red_lines) drawStop(data, ex.data);
          else err.textContent = ex.message;
        }
      });
      if (!keep.amount) form.amount.focus();
    };
    const drawStop = (data, res) => {
      mount(body, html`<div class="stop-banner" role="alert">
          <h3>${icon.stop} Stop. This crosses a limit.</h3>
          <p><b class="num">${money(data.amount)}</b> of credit has <b>not</b> been saved.</p>
          <ul>${res.red_lines.map((l) => html`<li><b>${l.title}</b> by <span class="num">${money(l.over_by)}</span>.</li>`)}</ul>
        </div>
        <button class="btn" data-back>Go back and change it</button>
        ${res.can_override ? html`<button class="btn ghost" data-force>Give this credit anyway</button>` : html`<p class="muted small">Hard stop is on, so this cannot be saved.</p>`}
        <p class="error" role="alert"></p>`);
      body.querySelector('[data-back]').addEventListener('click', () => drawForm(data));
      body.querySelector('[data-force]')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try { await api('POST', '/invoices', { ...data, override: true }); toast('Credit saved past the limit'); close(true); }
        catch (ex) { body.querySelector('.error').textContent = ex.message; e.currentTarget.disabled = false; }
      });
    };
    drawForm();
  });
}

function paymentSheet(client, open) {
  return sheet(`Payment from ${client.name}`, (body, close) => {
    mount(body, html`<form class="form" novalidate>
      ${open.length > 1 ? html`<div class="field"><label for="pm-inv">Which credit is this for?</label>
        <select class="input" id="pm-inv" name="invoice_id">
          ${open.map((i) => html`<option value="${i.id}">${i.description || i.number} · ${money(i.remaining)} left</option>`)}
        </select></div>` : html`<input type="hidden" name="invoice_id" value="${open[0].id}">`}
      <div class="field"><label for="pm-amount">Amount received (${currencySymbol()})</label>
        <input class="input amount num" id="pm-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" required>
        <button class="btn ghost small" type="button" data-full></button></div>
      <div class="field"><span class="lbl" id="pm-method-lbl">How did they pay?</span>
        <div class="chips" role="radiogroup" aria-labelledby="pm-method-lbl">
          <label><input type="radio" name="method" value="cash" checked><span>Cash</span></label>
          <label><input type="radio" name="method" value="bank"><span>Bank transfer</span></label>
          <label><input type="radio" name="method" value="other"><span>Other</span></label>
        </div></div>
      <div class="field"><label for="pm-date">Date</label>
        <input class="input" id="pm-date" name="payment_date" type="date" value="${today()}" max="${today()}" required></div>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit">Save payment</button>
    </form>`);
    const form = body.querySelector('form');
    const full = form.querySelector('[data-full]');
    const current = () => open.find((i) => i.id === Number(form.invoice_id.value));
    const label = () => { full.textContent = `Paid in full: ${money(current().remaining)}`; };
    label();
    form.invoice_id.addEventListener?.('change', label);
    full.addEventListener('click', () => { form.amount.value = String(current().remaining); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.error');
      const amount = readAmount(form.amount);
      if (!amount || Number(amount) <= 0) { err.textContent = 'Enter the amount you received.'; form.amount.focus(); return; }
      if (Number(amount) > current().remaining) { err.textContent = `Only ${money(current().remaining)} is still owed on this credit.`; form.amount.focus(); return; }
      const ok = await submitWith(form, () => api('POST', '/payments', {
        invoice_id: Number(form.invoice_id.value), amount, method: form.method.value, payment_date: form.payment_date.value, reference: '',
      }));
      if (ok) { toast('Payment saved'); close(true); }
    });
    form.amount.focus();
  });
}

/** The Add button on the business home: pick what to add, then pick the customer. */
function addChooser() {
  return sheet('What do you want to add?', async (body, close) => {
    let clients = [];
    try { clients = (await api('GET', '/clients')).clients; } catch (e) { mount(body, html`<p class="error">${e.message}</p>`); return; }
    const owing = clients.filter((c) => c.owed > 0);
    const pickClient = (title, list, next) => {
      mount(body, html`<p class="muted">${title}</p><div class="list">${list.map((c) => html`<button class="row" data-id="${c.id}">
        <span class="avatar">${initials(c.name)}</span><span class="body"><span class="title">${c.name}</span></span>
        <span class="amt num">${money(c.owed)}<small>owed</small></span></button>`)}</div>`);
      body.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
        const c = list.find((x) => x.id === Number(b.dataset.id));
        close(await next(c));
      }));
    };
    mount(body, html`
      <button class="choice" data-act="credit" ${clients.length ? '' : html`disabled`}><span class="avatar">${icon.credit}</span>
        <span><b>Credit given</b><span>A customer took goods or money on credit.</span></span></button>
      <button class="choice" data-act="payment" ${owing.length ? '' : html`disabled`}><span class="avatar good">${icon.cash}</span>
        <span><b>Payment received</b><span>${owing.length ? 'A customer paid some or all of what they owe.' : 'Nobody owes you anything yet.'}</span></span></button>
      <button class="choice" data-act="client"><span class="avatar">${icon.people}</span>
        <span><b>New customer</b><span>Add a person or shop you give credit to.</span></span></button>`);
    body.querySelector('[data-act=client]').addEventListener('click', async () => close(await clientSheet()));
    body.querySelector('[data-act=credit]').addEventListener('click', () => pickClient('Who took credit?', clients, (c) => creditSheet(c)));
    body.querySelector('[data-act=payment]').addEventListener('click', () => pickClient('Who paid you?', owing, async (c) => {
      const inv = (await api('GET', `/invoices?client_id=${c.id}`)).invoices.filter((i) => i.remaining > 0);
      return paymentSheet(c, inv);
    }));
  });
}
