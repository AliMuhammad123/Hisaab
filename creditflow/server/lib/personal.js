// Personal portal: monthly plan, entries, red-line stop and forecast.
// Every query filters on the signed-in user's id.
import { HttpError, V, Money, get } from './http.js';
import { uid, user } from './auth.js';
import * as Forecast from './forecast.js';

const CATS = ['mandatory', 'savings', 'investment', 'entertainment', 'other'];
const NAMES = { mandatory: 'Bills', savings: 'Savings', investment: 'Investment', entertainment: 'Fun', other: 'Other spending' };

const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const monthEnd = (month) => `${month}-${String(lastDay(month)).padStart(2, '0')}`;

// ---------- monthly plan ----------

export async function saveBudget(ctx, input) {
  const month = V.month(get(input, 'month'));
  const income = Money.parse(input, 'income', 'Monthly income');
  const limits = {};
  for (const c of CATS) limits[c] = get(input, c) === undefined ? 0 : Money.parse(input, c, NAMES[c], true);
  if (Object.values(limits).reduce((s, v) => s + v, 0) > income) {
    throw new HttpError(422, 'Your plan adds up to more than your income. Lower one of the amounts.');
  }
  await ctx.db.run(
    `INSERT INTO budgets (user_id, month, income, mandatory, savings, investment, entertainment, other)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE income = VALUES(income), mandatory = VALUES(mandatory), savings = VALUES(savings),
         investment = VALUES(investment), entertainment = VALUES(entertainment), other = VALUES(other)`,
    [uid(ctx), month, Money.toDb(income), ...CATS.map((c) => Money.toDb(limits[c]))],
  );
  return budgetOut(await budget(ctx.db, uid(ctx), month));
}

// ---------- entries ----------

export async function addEntry(ctx, input) {
  const category = V.choice(input, 'category', [...CATS, 'return'], 'Type');
  const amount = Money.parse(input, 'amount', 'Amount');
  const date = V.date(input, 'entry_date');
  const note = V.text(input, 'note', 200);
  const override = get(input, 'override') === true;
  const month = date.slice(0, 7);
  const me = uid(ctx);
  const strict = Boolean(Number(user(ctx).strict_stop));

  return ctx.db.tx(async (t) => {
    // Lock the user's row so two entries saved at the same moment are checked one after the other.
    await t.one('SELECT id FROM users WHERE id = ? FOR UPDATE', [me]);

    let crossed = [];
    const b = await budget(t, me, month);
    if (category !== 'return' && b) {
      const totals = await monthTotals(t, me, month);
      const moneyIn = Money.fromDb(b.income) + totals.return;
      delete totals.return;
      crossed = Forecast.redLines(category, amount, moneyIn, limitsOf(b), totals);
    }
    if (crossed.length && (strict || !override)) {
      throw new HttpError(409, 'This crosses a limit you set.', {
        red_lines: crossed.map((l) => ({ ...l, over_by: Money.out(l.over_by) })),
        can_override: !strict,
      });
    }
    const id = await t.insert(
      'INSERT INTO entries (user_id, category, amount, entry_date, note, overridden) VALUES (?, ?, ?, ?, ?, ?)',
      [me, category, Money.toDb(amount), date, note, crossed.length ? 1 : 0],
    );
    return { id, month };
  });
}

export async function deleteEntry(ctx, id) {
  const r = await ctx.db.run('DELETE FROM entries WHERE id = ? AND user_id = ?', [id, uid(ctx)]);
  if (r.affectedRows === 0) throw new HttpError(404, 'Entry not found.');
}

// ---------- dashboard ----------

export async function summary(ctx, month) {
  const me = uid(ctx);
  const today = ctx.today;
  const b = await budget(ctx.db, me, month);
  const totals = await monthTotals(ctx.db, me, month);
  const returns = totals.return;
  delete totals.return;
  const income = b ? Money.fromDb(b.income) : 0;
  const limits = limitsOf(b);

  const dim = lastDay(month);
  const thisMonth = today.slice(0, 7);
  const day = month === thisMonth ? Number(today.slice(8, 10)) : month < thisMonth ? dim : 0;

  const daily = {};
  for (const r of await ctx.db.all(
    `SELECT DAY(entry_date) AS d, SUM(amount) AS s FROM entries
     WHERE user_id = ? AND entry_date BETWEEN ? AND ? AND category IN ('entertainment','other') GROUP BY DAY(entry_date)`,
    [me, `${month}-01`, monthEnd(month)],
  )) {
    daily[Number(r.d)] = Money.fromDb(r.s);
  }

  const hist = await history(ctx.db, me, month);
  const f = Forecast.month({
    income,
    returns,
    has_budget: b !== null,
    budget: limits,
    spent: totals,
    daily_variable: daily,
    days_in_month: dim,
    day,
    history: hist.map((h) => h.totals),
  });

  const spend = totals.mandatory + totals.entertainment + totals.other;
  const setAside = totals.savings + totals.investment;
  const moneyIn = income + returns;

  const categories = {};
  for (const c of CATS) categories[c] = { spent: Money.out(totals[c]), limit: Money.out(limits[c]) };

  const trend = hist.map((h) => ({
    month: h.month,
    spend: Money.out(h.totals.mandatory + h.totals.entertainment + h.totals.other),
    set_aside: Money.out(h.totals.savings + h.totals.investment),
  }));
  trend.push({ month, spend: Money.out(spend), set_aside: Money.out(setAside) });

  const next = f.next_month;
  const byCategory = {};
  for (const c of CATS) byCategory[c] = Money.out(next[c]);

  return {
    month,
    is_current: month === thisMonth,
    budget: b ? budgetOut(b) : null,
    suggested_budget: b ? null : await suggestBudget(ctx.db, me, month),
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
        by_category: byCategory,
      },
    },
    trend: trend.slice(-6),
    entries: await entries(ctx.db, me, month),
  };
}

// ---------- helpers ----------

function budget(db, me, month) {
  return db.one('SELECT * FROM budgets WHERE user_id = ? AND month = ?', [me, month]);
}

function limitsOf(b) {
  const out = {};
  for (const c of CATS) out[c] = b ? Money.fromDb(b[c]) : 0;
  return out;
}

function budgetOut(b) {
  const out = { month: b.month, income: Money.out(Money.fromDb(b.income)) };
  for (const c of CATS) out[c] = Money.out(Money.fromDb(b[c]));
  return out;
}

/** The most recent earlier plan, offered as a starting point for a month that has none. */
async function suggestBudget(db, me, month) {
  const prev = await db.one('SELECT * FROM budgets WHERE user_id = ? AND month < ? ORDER BY month DESC LIMIT 1', [me, month]);
  return prev ? { ...budgetOut(prev), month } : null;
}

/** Totals per category for one month, in minor units. */
async function monthTotals(db, me, month) {
  const out = Object.fromEntries([...CATS, 'return'].map((c) => [c, 0]));
  for (const r of await db.all(
    'SELECT category, SUM(amount) AS s FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ? GROUP BY category',
    [me, `${month}-01`, monthEnd(month)],
  )) {
    out[r.category] = Money.fromDb(r.s);
  }
  return out;
}

/** Up to six earlier months that have entries, oldest first. */
async function history(db, me, month) {
  const rows = await db.all(
    `SELECT DATE_FORMAT(entry_date, '%Y-%m') AS m, category, SUM(amount) AS s FROM entries
     WHERE user_id = ? AND entry_date < ? AND entry_date >= DATE_SUB(?, INTERVAL 6 MONTH) AND category <> 'return'
     GROUP BY m, category ORDER BY m`,
    [me, `${month}-01`, `${month}-01`],
  );
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.m)) by.set(r.m, Object.fromEntries(CATS.map((c) => [c, 0])));
    by.get(r.m)[r.category] = Money.fromDb(r.s);
  }
  return [...by].map(([m, totals]) => ({ month: m, totals }));
}

async function entries(db, me, month) {
  const rows = await db.all(
    `SELECT id, category, amount, entry_date, note, overridden FROM entries
     WHERE user_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date DESC, id DESC`,
    [me, `${month}-01`, monthEnd(month)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    category: r.category,
    amount: Money.out(Money.fromDb(r.amount)),
    entry_date: r.entry_date,
    note: r.note,
    overridden: Boolean(Number(r.overridden)),
  }));
}
