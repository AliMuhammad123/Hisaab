// Spending forecast and red lines. Pure functions: no database, no clock, so
// every result can be reproduced from its inputs. All money is in minor units (cents).
//
// Two small statistical models, both fitted on the user's own entries only:
//  1. This month: day-to-day spending (entertainment + other) is smoothed with an
//     exponentially weighted average so recent days count more, then blended with
//     the user's pace in earlier months. Bills (mandatory) are lumpy, so they are
//     projected from the plan or the median of earlier months instead.
//  2. Next month: a least-squares trend line through each category's totals for
//     up to the last six months.

export const SPEND = ['mandatory', 'entertainment', 'other'];
export const SET_ASIDE = ['savings', 'investment'];
const ALPHA = 0.25;

/**
 * @param {object} a
 * @param {number} a.income
 * @param {number} a.returns
 * @param {boolean} a.has_budget
 * @param {Record<string, number>} a.budget  limits per category
 * @param {Record<string, number>} a.spent   totals so far this month
 * @param {Record<number, number>} a.daily_variable  day of month -> fun + other spent that day
 * @param {number} a.days_in_month
 * @param {number} a.day  today's day of the month, 0 for a month not started, days_in_month for a finished one
 * @param {Array<Record<string, number>>} a.history  earlier months' totals, oldest first
 */
export function month(a) {
  const dim = a.days_in_month;
  const day = Math.max(0, Math.min(dim, a.day));
  const left = dim - day;
  const moneyIn = a.income + a.returns;

  // day-to-day spending rate
  const variableSpent = a.spent.entertainment + a.spent.other;
  const series = [];
  for (let d = 1; d <= day; d++) series.push(a.daily_variable[d] ?? 0);
  const rateNow = ewma(series);
  const histRates = a.history.map((h) => (h.entertainment + h.other) / 30.4);
  const rateHist = histRates.length ? histRates.reduce((s, x) => s + x, 0) / histRates.length : null;
  // Trust this month's pace more as more of it has been seen.
  const w = rateHist === null ? 1 : Math.min(1, day / 14);
  const rate = day === 0 && rateHist !== null ? rateHist : w * rateNow + (1 - w) * (rateHist ?? rateNow);

  // bills
  const histMandatory = a.history.map((h) => h.mandatory).filter((x) => x);
  const expectedMandatory = a.budget.mandatory > 0 ? a.budget.mandatory : median(histMandatory);
  const mandatoryProjected = Math.max(a.spent.mandatory, expectedMandatory);

  // money set aside
  const setAsidePlanned = a.budget.savings + a.budget.investment;
  const setAsideDone = a.spent.savings + a.spent.investment;
  const setAsideProjected = Math.max(setAsidePlanned, setAsideDone);

  const projectedSpend = Math.round(mandatoryProjected + variableSpent + rate * left);
  const projectedLeft = moneyIn - projectedSpend - setAsideProjected;

  // Money free for day-to-day spending for the rest of the month.
  const free = moneyIn - setAsideProjected - mandatoryProjected - variableSpent;
  const safeDaily = left > 0 ? Math.max(0, Math.trunc(Math.max(0, free) / left)) : 0;

  // The day the free money runs out at the current pace.
  let runOutDay = null;
  if (left > 0 && rate > 0 && free >= 0 && free / rate < left) runOutDay = day + Math.floor(free / rate) + 1;

  let level = 'ok';
  if (a.has_budget && moneyIn > 0) {
    if (projectedSpend > moneyIn) level = 'danger';
    else if (projectedLeft < 0) level = 'watch';
  }

  let confidence = 'low';
  if (day >= 20 || (day >= 10 && a.history.length >= 2)) confidence = 'high';
  else if (day >= 7 || a.history.length >= 1) confidence = 'medium';

  return {
    level,
    confidence,
    days_left: left,
    daily_rate: Math.round(rate),
    projected_spend: projectedSpend,
    projected_left: projectedLeft,
    safe_daily: safeDaily,
    run_out_day: runOutDay,
    next_month: nextMonth(a.history, a.spent, day >= dim),
  };
}

/** Trend-line prediction of next month's total for each category. */
export function nextMonth(history, current, currentComplete) {
  const months = (currentComplete ? [...history, current] : [...history]).slice(-6);
  const out = {};
  for (const cat of [...SPEND, ...SET_ASIDE]) out[cat] = Math.round(trend(months.map((m) => m[cat] ?? 0)));
  out.months_used = months.length;
  return out;
}

/** Least-squares line through the points, read one step past the end. Never below zero. */
export function trend(ys) {
  const n = ys.length;
  if (n === 0) return 0;
  const mean = ys.reduce((s, y) => s + y, 0) / n;
  if (n < 3) return mean; // too few months for a slope to mean anything
  const xMean = (n - 1) / 2;
  let sxy = 0;
  let sxx = 0;
  ys.forEach((y, x) => {
    sxy += (x - xMean) * (y - mean);
    sxx += (x - xMean) ** 2;
  });
  const slope = sxx > 0 ? sxy / sxx : 0;
  const pred = mean + slope * (n - xMean);
  // Keep the prediction within a sane band around what has actually been seen.
  return Math.max(0, Math.min(pred, Math.max(...ys) * 1.5));
}

/** Exponentially weighted average of a daily series; later days weigh more. */
export function ewma(series) {
  if (!series.length) return 0;
  const avg = series.reduce((s, v) => s + v, 0) / series.length;
  let s = avg;
  for (const v of series) s = ALPHA * v + (1 - ALPHA) * s;
  // A single big day should not swing the whole month: stay near the plain average.
  return 0.5 * s + 0.5 * avg;
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

const LABELS = { mandatory: 'bills', entertainment: 'fun', other: 'other spending', savings: 'savings', investment: 'investment' };

/**
 * Red lines: limits that stop an entry from being saved.
 * Returns the lines that adding `amount` to `category` would cross.
 * @param {Record<string, number>} budget limits per category (0 means no limit set)
 * @param {Record<string, number>} spent  totals so far this month, before the new entry
 */
export function redLines(category, amount, moneyIn, budget, spent) {
  const lines = [];
  const allOut = Object.values(spent).reduce((s, v) => s + v, 0) + amount;
  if (allOut > moneyIn) {
    lines.push({ code: 'over_income', title: 'More than you earned this month', detail: 'This takes your total for the month above your income.', over_by: allOut - moneyIn });
  }

  if (SPEND.includes(category)) {
    const limit = budget[category] ?? 0;
    if (limit > 0 && spent[category] + amount > limit) {
      lines.push({
        code: 'category_limit',
        title: `Over your ${LABELS[category]} limit`,
        detail: `You planned a limit for ${LABELS[category]} this month and this goes past it.`,
        over_by: spent[category] + amount - limit,
      });
    }

    const spendAfter = spent.mandatory + spent.entertainment + spent.other + amount;
    const protectedLeft = Math.max(0, (budget.savings ?? 0) - spent.savings) + Math.max(0, (budget.investment ?? 0) - spent.investment);
    const alreadySetAside = spent.savings + spent.investment;
    const freeForSpending = moneyIn - alreadySetAside - protectedLeft;
    if (protectedLeft > 0 && spendAfter > freeForSpending && allOut <= moneyIn) {
      lines.push({
        code: 'eats_savings',
        title: 'This uses money you planned to save',
        detail: 'After this, there is not enough left to reach your savings and investment plan.',
        over_by: spendAfter - freeForSpending,
      });
    }
  }
  return lines;
}
