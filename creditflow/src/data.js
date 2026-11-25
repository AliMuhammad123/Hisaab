// Everything the screens read or save, backed by Supabase.
// Supabase's Row Level Security (supabase/schema.sql) is what keeps each user's
// data private; the checks here only give friendly messages before saving.
import { createClient } from '@supabase/supabase-js';
import { state, today, ApiError } from './core.js';
import { V, Money, get } from './lib/validate.js';
import * as Forecast from './lib/forecast.js';

/* global __SUPABASE_URL__, __SUPABASE_ANON_KEY__ */
const URL_ = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : '';
const KEY = typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__ : '';
export const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(URL_) && KEY.length > 20;

const sb = configured
  ? createClient(URL_, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  : null;

const CATS = ['mandatory', 'savings', 'investment', 'entertainment', 'other'];
const PLAN_NAMES = { mandatory: 'Bills', savings: 'Savings', investment: 'Investment', entertainment: 'Fun', other: 'Other spending' };
const MIN_PASSWORD = 10;

// ---------- helpers ----------

/** Turns a Supabase error into a message the user can act on. */
function fail(error, fallbackStatus = 500) {
  const code = error?.code || '';
  const msg = error?.message || '';
  if (error?.name === 'AuthRetryableFetchError' || /fetch|network/i.test(msg)) return new ApiError(0);
  if (code === 'P0001' || code === 'P0002') return new ApiError(422, { error: msg });
  if (code === '23514' || code === '22P02' || code === '22003') return new ApiError(422, { error: 'Check the amounts and dates and try again.' });
  if (code === '23505') return new ApiError(409, { error: 'This already exists.' });
  if (code === '23503') return new ApiError(404, { error: 'That item no longer exists.' });
  if (code === 'PGRST301' || code === '42501' || error?.status === 401) return new ApiError(401, { error: 'Please sign in.' });
  if (error?.status === 429 || /rate limit/i.test(msg)) return new ApiError(429, { error: 'Too many attempts. Wait a few minutes and try again.' });
  console.error('creditflow:', error);
  return new ApiError(fallbackStatus, { error: 'Something went wrong. Please try again.' });
}

const ok = ({ data, error }) => {
  if (error) throw fail(error);
  return data;
};

function uid() {
  if (!state.user?.id) throw new ApiError(401, { error: 'Please sign in.' });
  return state.user.id;
}

/** Reads every row of a table that belongs to the user, a page at a time. */
async function selectAll(table, columns, filter = (q) => q) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const rows = ok(await filter(sb.from(table).select(columns).eq('user_id', uid())).order('id').range(from, from + size - 1));
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

const cents = (v) => (v === null || v === undefined ? 0 : Money.fromDb(String(v)));
const strictStop = () => Boolean(state.user?.strict_stop);

const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const monthEnd = (month) => `${month}-${String(lastDay(month)).padStart(2, '0')}`;
const shiftMonth = (month, by) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function checkPassword(p) {
  if (typeof p !== 'string' || [...p].length < MIN_PASSWORD) {
    throw new ApiError(422, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }
  if (p.length > 200) throw new ApiError(422, { error: 'Password is too long.' });
  return p;
}

// ---------- account ----------

async function loadUser() {
  const { data } = await sb.auth.getSession();
  const session = data?.session;
  if (!session) throw new ApiError(401, { error: 'Please sign in.' });
  const p = ok(await sb.from('profiles').select('name, app_mode, country, currency, strict_stop').eq('id', session.user.id).maybeSingle());
  if (!p) throw new ApiError(401, { error: 'Please sign in.' });
  return { id: session.user.id, email: session.user.email, ...p };
}

async function register(input) {
  const email = V.email(input);
  const name = V.text(input, 'name', 80, true, 'Your name');
  const password = checkPassword(get(input, 'password'));
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name } } });
  if (error) {
    if (/already registered|already exists/i.test(error.message)) throw new ApiError(409, { error: 'An account with this email already exists. Try signing in.' });
    if (error.code === 'weak_password') throw new ApiError(422, { error: 'Choose a stronger password: a short sentence works well.' });
    throw fail(error);
  }
  // With email confirmation on, Supabase sends a code and returns no session yet.
  if (!data.session) return { needs_code: true };
  return { user: await loadUser() };
}

async function login(input) {
  const email = V.email(input);
  const password = typeof get(input, 'password') === 'string' ? get(input, 'password') : '';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === 'email_not_confirmed') {
      await sb.auth.resend({ type: 'signup', email }).catch(() => {});
      throw new ApiError(403, { error: 'Confirm your email first. We sent you a new code.', needs_code: true });
    }
    if (error.status === 400 || error.code === 'invalid_credentials') throw new ApiError(401, { error: 'Email or password is incorrect.' });
    throw fail(error);
  }
  return { user: await loadUser() };
}

async function verifyEmail(input) {
  const email = V.email(input);
  const token = String(get(input, 'code') ?? '').replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(token)) throw new ApiError(422, { error: 'Enter the code from the email.' });
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error.status === 403 || /expired|invalid/i.test(error.message) ? new ApiError(422, { error: 'That code is wrong or has expired. Send a new one.' }) : fail(error);
  return { user: await loadUser() };
}

async function resendCode(input) {
  const { error } = await sb.auth.resend({ type: 'signup', email: V.email(input) });
  if (error) throw fail(error);
  return { ok: true };
}

async function forgotPassword(input) {
  const { error } = await sb.auth.resetPasswordForEmail(V.email(input));
  if (error) throw fail(error);
  // Same answer whether or not the email has an account, so nobody can test which emails are registered.
  return { ok: true };
}

async function resetPassword(input) {
  const email = V.email(input);
  const token = String(get(input, 'code') ?? '').replace(/\s/g, '');
  const password = checkPassword(get(input, 'password'));
  if (!/^\d{6,10}$/.test(token)) throw new ApiError(422, { error: 'Enter the code from the email.' });
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'recovery' });
  if (error) throw new ApiError(422, { error: 'That code is wrong or has expired. Ask for a new one.' });
  const upd = await sb.auth.updateUser({ password });
  if (upd.error) throw fail(upd.error);
  await sb.auth.signOut({ scope: 'others' });
  return { user: await loadUser() };
}

/** Confirms the password by signing in with it again. */
async function confirmPassword(password) {
  const { error } = await sb.auth.signInWithPassword({ email: state.user.email, password: typeof password === 'string' ? password : '' });
  return !error;
}

async function changePassword(input) {
  uid();
  const next = checkPassword(get(input, 'new'));
  if (!(await confirmPassword(get(input, 'current')))) throw new ApiError(403, { error: 'Your current password is incorrect.' });
  const { error } = await sb.auth.updateUser({ password: next });
  if (error) throw fail(error);
  await sb.auth.signOut({ scope: 'others' });
  return { ok: true };
}

async function deleteAccount(input) {
  uid();
  if (!(await confirmPassword(get(input, 'password')))) throw new ApiError(403, { error: 'Password is incorrect. Your account was not deleted.' });
  ok(await sb.rpc('delete_my_account'));
  await sb.auth.signOut({ scope: 'local' });
  return { ok: true };
}

async function updateProfile(input) {
  const set = {};
  if (Object.hasOwn(input, 'name')) set.name = V.text(input, 'name', 80, true, 'Your name');
  if (Object.hasOwn(input, 'app_mode')) set.app_mode = V.choice(input, 'app_mode', ['personal', 'business', 'both'], 'Portal choice');
  if (Object.hasOwn(input, 'country')) {
    if (!/^[A-Z]{2}$/.test(String(input.country))) throw new ApiError(422, { error: 'Choose a country from the list.' });
    set.country = input.country;
  }
  if (Object.hasOwn(input, 'currency')) {
    if (!/^[A-Z]{3}$/.test(String(input.currency))) throw new ApiError(422, { error: 'Choose a currency from the list.' });
    set.currency = input.currency;
  }
  if (Object.hasOwn(input, 'strict_stop')) set.strict_stop = input.strict_stop === true;
  if (Object.keys(set).length) ok(await sb.from('profiles').update(set).eq('id', uid()));
  return { user: await loadUser() };
}

// ---------- business ----------

async function ledger() {
  const [clients, invoices, payments] = await Promise.all([
    selectAll('clients', 'id, name, phone, email, notes, credit_limit'),
    selectAll('invoices', 'id, client_id, number, description, amount, invoice_date, due_date'),
    selectAll('payments', 'id, invoice_id, amount, method, payment_date, reference'),
  ]);
  const paidBy = new Map();
  for (const p of payments) paidBy.set(p.invoice_id, (paidBy.get(p.invoice_id) || 0) + cents(p.amount));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const t = today();
  const invoiceList = invoices.map((r) => invoiceOut(r, paidBy.get(r.id) || 0, clientName.get(r.client_id) || '', t));
  invoiceList.sort((a, b) => (b.invoice_date.localeCompare(a.invoice_date)) || b.id - a.id);
  return { clients, invoices: invoiceList, payments };
}

function invoiceOut(r, paid, clientName, t) {
  const amount = cents(r.amount);
  const left = amount - paid;
  let status = left <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  if (left > 0 && r.due_date && r.due_date < t) status = 'overdue';
  return {
    id: r.id,
    client_id: r.client_id,
    client_name: clientName,
    number: r.number,
    description: r.description,
    amount: Money.out(amount),
    paid: Money.out(paid),
    remaining: Money.out(left),
    invoice_date: r.invoice_date,
    due_date: r.due_date,
    status,
  };
}

function clientsOut({ clients, invoices }) {
  return clients
    .map((c) => {
      const mine = invoices.filter((i) => i.client_id === c.id);
      const billed = mine.reduce((s, i) => s + Math.round(i.amount * 100), 0);
      const paid = mine.reduce((s, i) => s + Math.round(i.paid * 100), 0);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        notes: c.notes,
        credit_limit: c.credit_limit === null ? null : Money.out(cents(c.credit_limit)),
        billed: Money.out(billed),
        paid: Money.out(paid),
        owed: Money.out(billed - paid),
        open_count: mine.filter((i) => i.remaining > 0).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function paymentsOut({ payments, invoices }) {
  const inv = new Map(invoices.map((i) => [i.id, i]));
  return payments
    .map((p) => ({
      id: p.id,
      invoice_id: p.invoice_id,
      invoice_number: inv.get(p.invoice_id)?.number || '',
      client_id: inv.get(p.invoice_id)?.client_id,
      client_name: inv.get(p.invoice_id)?.client_name || '',
      amount: Money.out(cents(p.amount)),
      method: p.method,
      payment_date: p.payment_date,
      reference: p.reference,
    }))
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date) || b.id - a.id);
}

async function saveClient(input, id = null) {
  const row = {
    name: V.text(input, 'name', 120, true, 'Client name'),
    phone: V.text(input, 'phone', 40),
    email: V.email(input, 'email', false),
    notes: V.text(input, 'notes', 1000),
  };
  const raw = get(input, 'credit_limit');
  row.credit_limit = raw === undefined || raw === null || raw === '' ? null : Money.toDb(Money.parse(input, 'credit_limit', 'Credit limit'));
  let saved;
  if (id === null) {
    saved = ok(await sb.from('clients').insert({ ...row, user_id: uid() }).select('id').single());
  } else {
    const rows = ok(await sb.from('clients').update(row).eq('id', id).eq('user_id', uid()).select('id'));
    if (!rows.length) throw new ApiError(404, { error: 'Client not found.' });
    saved = rows[0];
  }
  const client = clientsOut(await ledger()).find((c) => c.id === saved.id);
  return { client };
}

async function removeRow(table, id, notFound) {
  const rows = ok(await sb.from(table).delete().eq('id', id).eq('user_id', uid()).select('id'));
  if (!rows.length) throw new ApiError(404, { error: notFound });
  return { ok: true };
}

async function addInvoice(input) {
  const clientId = V.id(get(input, 'client_id'), 'Client');
  const amount = Money.parse(input, 'amount', 'Amount');
  const date = V.date(input, 'invoice_date', true, 'Date');
  const due = V.date(input, 'due_date', false, 'Due date');
  if (due !== null && due < date) throw new ApiError(422, { error: 'Due date cannot be before the credit date.' });
  const description = V.text(input, 'description', 500);
  let number = V.text(input, 'number', 40);
  const override = get(input, 'override') === true;

  const l = await ledger();
  const client = l.clients.find((c) => c.id === clientId);
  if (!client) throw new ApiError(404, { error: 'Client not found.' });
  // Red line: a client's unpaid balance may not pass the credit limit set for them.
  if (client.credit_limit !== null) {
    const limit = cents(client.credit_limit);
    const owed = l.invoices.filter((i) => i.client_id === clientId).reduce((s, i) => s + Math.round(i.remaining * 100), 0);
    if (owed + amount > limit) {
      const line = {
        code: 'credit_limit',
        title: "Over this client's credit limit",
        detail: `${client.name} already owes ${Money.out(owed)}. This would take them past their limit of ${Money.out(limit)}.`,
        over_by: Money.out(owed + amount - limit),
      };
      if (strictStop() || !override) {
        throw new ApiError(409, { error: 'This crosses a limit you set.', red_lines: [line], can_override: !strictStop() });
      }
    }
  }
  if (number === '') number = `CR-${String(l.invoices.length + 1).padStart(4, '0')}`;
  const saved = ok(await sb.from('invoices').insert({
    user_id: uid(), client_id: clientId, number, description, amount: Money.toDb(amount), invoice_date: date, due_date: due,
  }).select('id, client_id, number, description, amount, invoice_date, due_date').single());
  return { invoice: invoiceOut(saved, 0, client.name, today()) };
}

async function addPayment(input) {
  const invoiceId = V.id(get(input, 'invoice_id'), 'Credit entry');
  const amount = Money.parse(input, 'amount', 'Amount');
  const method = V.choice(input, 'method', ['cash', 'bank', 'other'], 'Payment method');
  const date = V.date(input, 'payment_date', true, 'Date');
  const reference = V.text(input, 'reference', 120);
  const l = await ledger();
  const inv = l.invoices.find((i) => i.id === invoiceId);
  if (!inv) throw new ApiError(404, { error: 'Credit entry not found.' });
  const left = Math.round(inv.remaining * 100);
  if (amount > left) throw new ApiError(422, { error: `Only ${Money.out(left).toFixed(2)} is still owed on this entry. Enter that amount or less.` });
  // The database checks this again, so two phones saving at once cannot overpay.
  ok(await sb.from('payments').insert({ user_id: uid(), invoice_id: invoiceId, amount: Money.toDb(amount), method, payment_date: date, reference }));
  return { invoice: { ...inv, paid: Money.out(Math.round(inv.paid * 100) + amount), remaining: Money.out(left - amount) } };
}

async function businessSummary() {
  const l = await ledger();
  const t = today();
  const soon = addDays(t, 7);
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;
  const attention = [];
  const byClient = new Map();
  for (const inv of l.invoices) {
    const left = Math.round(inv.remaining * 100);
    if (left <= 0) continue;
    outstanding += left;
    if (!byClient.has(inv.client_id)) byClient.set(inv.client_id, { client_id: inv.client_id, name: inv.client_name, owed: 0 });
    byClient.get(inv.client_id).owed += left;
    if (inv.status === 'overdue') {
      overdue += left;
      overdueCount++;
      attention.push(inv);
    } else if (inv.due_date && inv.due_date <= soon) {
      attention.push(inv);
    }
  }
  attention.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  const monthStart = `${t.slice(0, 7)}-01`;
  const collected = l.payments.filter((p) => p.payment_date >= monthStart).reduce((s, p) => s + cents(p.amount), 0);
  const given = l.invoices.filter((i) => i.invoice_date >= monthStart).reduce((s, i) => s + Math.round(i.amount * 100), 0);
  return {
    outstanding: Money.out(outstanding),
    overdue: Money.out(overdue),
    overdue_count: overdueCount,
    collected_this_month: Money.out(collected),
    given_this_month: Money.out(given),
    client_count: l.clients.length,
    top_owing: [...byClient.values()].sort((a, b) => b.owed - a.owed).slice(0, 5).map((c) => ({ ...c, owed: Money.out(c.owed) })),
    needs_attention: attention.slice(0, 8),
    recent_payments: paymentsOut(l).slice(0, 5),
  };
}

// ---------- personal ----------

const limitsOf = (b) => Object.fromEntries(CATS.map((c) => [c, b ? cents(b[c]) : 0]));

function budgetOut(b) {
  const out = { month: b.month, income: Money.out(cents(b.income)) };
  for (const c of CATS) out[c] = Money.out(cents(b[c]));
  return out;
}

async function budgetFor(month) {
  return ok(await sb.from('budgets').select('*').eq('user_id', uid()).eq('month', month).maybeSingle());
}

/** Totals per category for one month, in minor units. */
function totalsOf(entries, month) {
  const out = Object.fromEntries([...CATS, 'return'].map((c) => [c, 0]));
  for (const e of entries) if (e.entry_date.startsWith(month)) out[e.category] += cents(e.amount);
  return out;
}

async function saveBudget(input) {
  const month = V.month(get(input, 'month'));
  const income = Money.parse(input, 'income', 'Monthly income');
  const limits = {};
  for (const c of CATS) limits[c] = get(input, c) === undefined ? 0 : Money.parse(input, c, PLAN_NAMES[c], true);
  if (Object.values(limits).reduce((s, v) => s + v, 0) > income) {
    throw new ApiError(422, { error: 'Your plan adds up to more than your income. Lower one of the amounts.' });
  }
  const row = { user_id: uid(), month, income: Money.toDb(income) };
  for (const c of CATS) row[c] = Money.toDb(limits[c]);
  const saved = ok(await sb.from('budgets').upsert(row, { onConflict: 'user_id,month' }).select('*').single());
  return { budget: budgetOut(saved) };
}

async function addEntry(input) {
  const category = V.choice(input, 'category', [...CATS, 'return'], 'Type');
  const amount = Money.parse(input, 'amount', 'Amount');
  const date = V.date(input, 'entry_date');
  const note = V.text(input, 'note', 200);
  const override = get(input, 'override') === true;
  const month = date.slice(0, 7);

  let crossed = [];
  const b = await budgetFor(month);
  if (category !== 'return' && b) {
    const monthEntries = await selectAll('entries', 'id, category, amount, entry_date', (q) => q.gte('entry_date', `${month}-01`).lte('entry_date', monthEnd(month)));
    const totals = totalsOf(monthEntries, month);
    const moneyIn = cents(b.income) + totals.return;
    delete totals.return;
    crossed = Forecast.redLines(category, amount, moneyIn, limitsOf(b), totals);
  }
  if (crossed.length && (strictStop() || !override)) {
    throw new ApiError(409, {
      error: 'This crosses a limit you set.',
      red_lines: crossed.map((l) => ({ ...l, over_by: Money.out(l.over_by) })),
      can_override: !strictStop(),
    });
  }
  const saved = ok(await sb.from('entries').insert({
    user_id: uid(), category, amount: Money.toDb(amount), entry_date: date, note, overridden: crossed.length > 0,
  }).select('id').single());
  return { id: saved.id, month };
}

async function personalSummary(month) {
  const t = today();
  const from = `${shiftMonth(month, -6)}-01`;
  const [b, prev, all] = await Promise.all([
    budgetFor(month),
    sb.from('budgets').select('*').eq('user_id', uid()).lt('month', month).order('month', { ascending: false }).limit(1).maybeSingle().then(ok),
    selectAll('entries', 'id, category, amount, entry_date, note, overridden', (q) => q.gte('entry_date', from).lte('entry_date', monthEnd(month))),
  ]);
  const monthEntries = all.filter((e) => e.entry_date.startsWith(month));
  const totals = totalsOf(monthEntries, month);
  const returns = totals.return;
  delete totals.return;
  const income = b ? cents(b.income) : 0;
  const limits = limitsOf(b);

  const dim = lastDay(month);
  const thisMonth = t.slice(0, 7);
  const day = month === thisMonth ? Number(t.slice(8, 10)) : month < thisMonth ? dim : 0;

  const daily = {};
  for (const e of monthEntries) {
    if (e.category !== 'entertainment' && e.category !== 'other') continue;
    const d = Number(e.entry_date.slice(8, 10));
    daily[d] = (daily[d] || 0) + cents(e.amount);
  }

  // Earlier months that have entries, oldest first.
  const byMonth = new Map();
  for (const e of all) {
    const m = e.entry_date.slice(0, 7);
    if (m >= month || e.category === 'return') continue;
    if (!byMonth.has(m)) byMonth.set(m, Object.fromEntries(CATS.map((c) => [c, 0])));
    byMonth.get(m)[e.category] += cents(e.amount);
  }
  const hist = [...byMonth].sort(([a], [b2]) => a.localeCompare(b2)).map(([m, tot]) => ({ month: m, totals: tot }));

  const f = Forecast.month({
    income, returns, has_budget: Boolean(b), budget: limits, spent: totals,
    daily_variable: daily, days_in_month: dim, day, history: hist.map((h) => h.totals),
  });

  const spend = totals.mandatory + totals.entertainment + totals.other;
  const setAside = totals.savings + totals.investment;
  const moneyIn = income + returns;
  const categories = Object.fromEntries(CATS.map((c) => [c, { spent: Money.out(totals[c]), limit: Money.out(limits[c]) }]));
  const trend = hist.map((h) => ({
    month: h.month,
    spend: Money.out(h.totals.mandatory + h.totals.entertainment + h.totals.other),
    set_aside: Money.out(h.totals.savings + h.totals.investment),
  }));
  trend.push({ month, spend: Money.out(spend), set_aside: Money.out(setAside) });
  const next = f.next_month;

  return {
    month,
    is_current: month === thisMonth,
    budget: b ? budgetOut(b) : null,
    suggested_budget: b || !prev ? null : { ...budgetOut(prev), month },
    income: Money.out(income),
    returns: Money.out(returns),
    money_in: Money.out(moneyIn),
    spent: Money.out(spend),
    set_aside: Money.out(setAside),
    left: Money.out(moneyIn - spend - setAside),
    categories,
    forecast: {
      level: f.level,
      confidence: f.confidence,
      days_left: f.days_left,
      daily_rate: Money.out(f.daily_rate),
      projected_spend: Money.out(f.projected_spend),
      projected_left: Money.out(f.projected_left),
      safe_daily: Money.out(f.safe_daily),
      run_out_date: f.run_out_day ? `${month}-${String(f.run_out_day).padStart(2, '0')}` : null,
      next_month: {
        months_used: next.months_used,
        spend: Money.out(next.mandatory + next.entertainment + next.other),
        by_category: Object.fromEntries(CATS.map((c) => [c, Money.out(next[c])])),
      },
    },
    trend: trend.slice(-6),
    entries: monthEntries
      .sort((a, b2) => b2.entry_date.localeCompare(a.entry_date) || b2.id - a.id)
      .map((e) => ({ id: e.id, category: e.category, amount: Money.out(cents(e.amount)), entry_date: e.entry_date, note: e.note, overridden: e.overridden })),
  };
}

// ---------- routes ----------

/** A user who chose only one portal does not see the other one's screens. */
function requirePortal(portal) {
  const mode = state.user?.app_mode;
  if (mode !== 'both' && mode !== portal) {
    throw new ApiError(403, { error: 'This part of the app is turned off for your account. Turn it on in Settings.' });
  }
}

/** The same request shape the screens have always used, answered from Supabase. */
export async function handle(method, fullPath, body = {}) {
  if (!sb) throw new ApiError(503, { error: 'The app is not connected to its database yet.' });
  const [path, qs = ''] = fullPath.split('?');
  const query = new URLSearchParams(qs);
  let route = path;
  let id = null;
  const m = path.match(/^(\/[a-z/]+)\/(\d{1,15})$/);
  if (m) {
    route = `${m[1]}/:id`;
    id = Number(m[2]);
  }

  switch (`${method} ${route}`) {
    case 'GET /auth/me': return { user: await loadUser() };
    case 'POST /auth/register': return register(body);
    case 'POST /auth/login': return login(body);
    case 'POST /auth/verify': return verifyEmail(body);
    case 'POST /auth/resend': return resendCode(body);
    case 'POST /auth/forgot': return forgotPassword(body);
    case 'POST /auth/reset': return resetPassword(body);
    case 'POST /auth/logout': await sb.auth.signOut({ scope: 'local' }); return { ok: true };
    case 'PATCH /me': return updateProfile(body);
    case 'POST /me/password': return changePassword(body);
    case 'POST /me/delete': return deleteAccount(body);

    case 'GET /business/summary': requirePortal('business'); return businessSummary();
    case 'GET /clients': requirePortal('business'); return { clients: clientsOut(await ledger()) };
    case 'POST /clients': requirePortal('business'); return saveClient(body);
    case 'PATCH /clients/:id': requirePortal('business'); return saveClient(body, id);
    case 'DELETE /clients/:id': requirePortal('business'); return removeRow('clients', id, 'Client not found.');
    case 'GET /invoices': {
      requirePortal('business');
      const cid = query.has('client_id') ? V.id(query.get('client_id'), 'Client') : null;
      const { invoices } = await ledger();
      return { invoices: cid === null ? invoices : invoices.filter((i) => i.client_id === cid) };
    }
    case 'POST /invoices': requirePortal('business'); return addInvoice(body);
    case 'DELETE /invoices/:id': requirePortal('business'); return removeRow('invoices', id, 'Credit entry not found.');
    case 'GET /payments': requirePortal('business'); return { payments: paymentsOut(await ledger()) };
    case 'POST /payments': requirePortal('business'); return addPayment(body);
    case 'DELETE /payments/:id': requirePortal('business'); return removeRow('payments', id, 'Payment not found.');

    case 'GET /personal/summary': requirePortal('personal'); return personalSummary(V.month(query.get('month') ?? today().slice(0, 7)));
    case 'PUT /budget': requirePortal('personal'); return saveBudget(body);
    case 'POST /entries': requirePortal('personal'); return addEntry(body);
    case 'DELETE /entries/:id': requirePortal('personal'); return removeRow('entries', id, 'Entry not found.');
  }
  throw new ApiError(404, { error: 'Not found.' });
}
