// Checks for the forecast and red-line maths. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../server/lib/forecast.js';
import { Money, V, isDate } from '../server/lib/http.js';

const z = { mandatory: 0, savings: 0, investment: 0, entertainment: 0, other: 0 };
const base = () => ({
  income: 10_000_000, returns: 0, has_budget: true,
  budget: { mandatory: 5_000_000, savings: 2_000_000, investment: 0, entertainment: 1_000_000, other: 1_000_000 },
  spent: { ...z }, daily_variable: {}, days_in_month: 30, day: 10, history: [],
});
const fill = (n, v) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, v]));

test('trend line', () => {
  assert.equal(F.trend([]), 0);
  assert.equal(F.trend([100, 300]), 200, 'two months uses the average');
  assert.ok(Math.abs(F.trend([100, 200, 300]) - 400) < 1e-9, 'a steady rise continues');
  assert.ok(Math.abs(F.trend([500, 500, 500]) - 500) < 1e-9, 'flat stays flat');
  assert.equal(F.trend([300, 200, 100, 0]), 0, 'never below zero');
  assert.ok(F.trend([100, 100, 1000]) <= 1500, 'one big month cannot blow up the estimate');
  assert.equal(F.median([5, 1, 3]), 3);
  assert.equal(F.median([]), 0);
});

test('steady spender stays on track', () => {
  const a = base();
  a.spent = { ...z, mandatory: 5_000_000, entertainment: 200_000 };
  a.daily_variable = fill(10, 20_000);
  const f = F.month(a);
  assert.equal(f.daily_rate, 20_000);
  assert.equal(f.projected_spend, 5_000_000 + 200_000 + 20_000 * 20);
  assert.equal(f.level, 'ok');
  assert.equal(f.run_out_day, null);
  assert.equal(f.safe_daily, Math.trunc((10_000_000 - 2_000_000 - 5_000_000 - 200_000) / 20));
});

test('fast spender is warned, very fast spender is in danger', () => {
  const a = base();
  a.spent = { ...z, mandatory: 5_000_000, entertainment: 1_500_000 };
  a.daily_variable = fill(10, 150_000);
  let f = F.month(a);
  assert.equal(f.level, 'watch');
  assert.ok(f.run_out_day > 10 && f.run_out_day <= 30);
  a.spent.entertainment = 4_000_000;
  a.daily_variable = fill(10, 400_000);
  f = F.month(a);
  assert.equal(f.level, 'danger');
});

test('bills, missing plans, history and finished months', () => {
  assert.equal(F.month(base()).projected_spend, 5_000_000, 'unpaid bills are still expected');
  const noPlan = { ...base(), has_budget: false, income: 0, daily_variable: { 1: 999_999 } };
  noPlan.spent.other = 999_999;
  assert.equal(F.month(noPlan).level, 'ok', 'no plan means no alarm');
  const early = { ...base(), day: 1, daily_variable: { 1: 300_000 } };
  early.spent.other = 300_000;
  const alone = F.month(early).daily_rate;
  early.history = [{ ...z, other: 608_000 }, { ...z, other: 608_000 }];
  const withHist = F.month(early).daily_rate;
  assert.ok(withHist < alone && withHist > 20_000, 'earlier months temper one big first day');
  assert.equal(F.month(early).next_month.other, 608_000);
  const done = { ...base(), day: 30 };
  done.spent.other = 100_000;
  const f = F.month(done);
  assert.equal(f.days_left, 0);
  assert.equal(f.safe_daily, 0);
});

test('red lines', () => {
  const b = base().budget;
  assert.deepEqual(F.redLines('entertainment', 500_000, 10_000_000, b, z), []);
  let l = F.redLines('entertainment', 1_000_001, 10_000_000, b, z);
  assert.equal(l.length, 1);
  assert.equal(l[0].code, 'category_limit');
  assert.equal(l[0].over_by, 1, 'one cent over is caught');
  assert.deepEqual(F.redLines('entertainment', 1_000_000, 10_000_000, b, z), [], 'exactly on the limit is allowed');
  l = F.redLines('other', 100, 10_000_000, b, { ...z, mandatory: 8_000_000 });
  assert.ok(l.some((x) => x.code === 'eats_savings'));
  l = F.redLines('savings', 2_000_000, 10_000_000, b, { ...z, mandatory: 9_000_000 });
  assert.deepEqual(l.map((x) => x.code), ['over_income']);
  assert.deepEqual(F.redLines('entertainment', 5000, 10_000_000, { ...b, entertainment: 0 }, z), [], 'zero limit means none set');
  l = F.redLines('mandatory', 100, 10_000_000, b, { ...z, savings: 2_000_000, mandatory: 5_000_000, entertainment: 1_000_000, other: 1_000_000 });
  assert.deepEqual(l.map((x) => x.code), ['category_limit'], 'already-saved money is not counted twice');
});

test('money never uses floating point', () => {
  assert.equal(Money.fromDb('0.10') + Money.fromDb('0.20'), 30);
  assert.equal(Money.fromDb('999999999.99'), 99_999_999_999);
  assert.equal(Money.fromDb('-12.5'), -1250);
  assert.equal(Money.toDb(-1250), '-12.50');
  assert.equal(Money.toDb(5), '0.05');
  assert.equal(Money.parse({ a: '1500.5' }, 'a', 'A'), 150_050);
  assert.equal(Money.parse({ a: 10000.5 }, 'a', 'A'), 1_000_050);
  for (const bad of ['1e3', '-5', '1.005', ' ', '0x10', '1,000', 'NaN', Infinity, null, [], {}, '1234567890123']) {
    assert.throws(() => Money.parse({ a: bad }, 'a', 'A'), undefined, `rejects ${String(bad)}`);
  }
  assert.throws(() => Money.parse({ a: '0' }, 'a', 'A'));
  assert.equal(Money.parse({ a: '0' }, 'a', 'A', true), 0);
});

test('input checks', () => {
  assert.ok(isDate('2024-02-29'));
  assert.ok(!isDate('2023-02-29'));
  assert.ok(!isDate('2026-13-01'));
  assert.ok(!isDate('1999-12-31'));
  assert.equal(V.id('42'), 42);
  for (const bad of ['0', '-1', '1.5', '01', 'abc', '99999999999999999', 1.5, -3]) assert.throws(() => V.id(bad));
  assert.equal(V.text({ n: '  hi\u0000 ' }, 'n', 10), 'hi');
  assert.throws(() => V.text({ n: 'x'.repeat(11) }, 'n', 10));
  assert.throws(() => V.text({ n: { a: 1 } }, 'n', 10));
  assert.equal(V.text(JSON.parse('{"__proto__":"x"}'), 'constructor', 10), '', 'inherited keys are ignored');
  assert.throws(() => V.email({ email: "x' OR '1'='1" }));
  assert.equal(V.email({ email: 'Ali@Example.COM ' }), 'ali@example.com');
});
