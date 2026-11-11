<?php
// Checks for the forecast and red-line maths. Run: php tests/forecast.test.php
declare(strict_types=1);
require __DIR__ . '/../api/lib/Forecast.php';

$pass = 0; $fail = 0;
function ok(bool $c, string $name, mixed $got = null): void {
    global $pass, $fail;
    $c ? $pass++ : $fail++;
    echo ($c ? 'PASS' : 'FAIL') . "  $name" . ($c ? '' : '  got ' . json_encode($got)) . "\n";
}
$z = ['mandatory' => 0, 'savings' => 0, 'investment' => 0, 'entertainment' => 0, 'other' => 0];
$base = ['income' => 10000000, 'returns' => 0, 'has_budget' => true,
    'budget' => ['mandatory' => 5000000, 'savings' => 2000000, 'investment' => 0, 'entertainment' => 1000000, 'other' => 1000000],
    'spent' => $z, 'daily_variable' => [], 'days_in_month' => 30, 'day' => 10, 'history' => []];

// trend line
ok(Forecast::trend([]) === 0.0, 'no months gives zero');
ok(Forecast::trend([100.0, 300.0]) === 200.0, 'two months uses the average');
ok(abs(Forecast::trend([100.0, 200.0, 300.0]) - 400.0) < 0.001, 'a steady rise continues', Forecast::trend([100.0, 200.0, 300.0]));
ok(abs(Forecast::trend([500.0, 500.0, 500.0]) - 500.0) < 0.001, 'flat spending stays flat');
ok(Forecast::trend([300.0, 200.0, 100.0, 0.0]) === 0.0, 'a falling trend never goes below zero');
ok(Forecast::trend([100.0, 100.0, 1000.0]) <= 1500.0, 'one big month cannot blow up the estimate');
ok(Forecast::median([5, 1, 3]) === 3 && Forecast::median([]) === 0, 'median');

// steady spender: 20,000 a day on fun for 10 days, bills paid
$a = $base;
$a['spent'] = ['mandatory' => 5000000] + ['entertainment' => 20000000 / 100] + $z;
$a['spent']['entertainment'] = 200000; $a['daily_variable'] = array_fill(1, 10, 20000);
$f = Forecast::month($a);
ok($f['daily_rate'] === 20000, 'steady daily rate is read correctly', $f['daily_rate']);
ok($f['projected_spend'] === 5000000 + 200000 + 20000 * 20, 'projection = bills + spent + rate x days left', $f['projected_spend']);
ok($f['level'] === 'ok' && $f['run_out_day'] === null, 'within plan is ok', $f);
ok($f['safe_daily'] === intdiv(10000000 - 2000000 - 5000000 - 200000, 20), 'safe daily amount', $f['safe_daily']);

// fast spender: will dip into savings
$a['daily_variable'] = array_fill(1, 10, 150000); $a['spent']['entertainment'] = 1500000;
$f = Forecast::month($a);
ok($f['level'] === 'watch', 'spending into planned savings is flagged', $f['level']);
ok($f['run_out_day'] !== null && $f['run_out_day'] > 10 && $f['run_out_day'] <= 30, 'run-out day falls inside the month', $f['run_out_day']);

// very fast spender: over income
$a['daily_variable'] = array_fill(1, 10, 400000); $a['spent']['entertainment'] = 4000000;
$f = Forecast::month($a);
ok($f['level'] === 'danger', 'spending above income is flagged', $f['level']);

// unpaid bills are still counted
$a = $base; $f = Forecast::month($a);
ok($f['projected_spend'] === 5000000, 'bills not yet paid are still expected', $f['projected_spend']);
// no plan: never alarms
$a = $base; $a['has_budget'] = false; $a['income'] = 0; $a['daily_variable'] = [1 => 999999]; $a['spent']['other'] = 999999;
ok(Forecast::month($a)['level'] === 'ok', 'no plan means no alarm');
// history steadies an early-month estimate
$a = $base; $a['day'] = 1; $a['daily_variable'] = [1 => 300000]; $a['spent']['other'] = 300000;
$alone = Forecast::month($a)['daily_rate'];
$a['history'] = [['other' => 608000] + $z, ['other' => 608000] + $z];
$withHist = Forecast::month($a)['daily_rate'];
ok($withHist < $alone && $withHist > 20000, 'earlier months temper one big first day', [$alone, $withHist]);
ok(Forecast::month($a)['next_month']['other'] === 608000, 'next month follows earlier months');
// finished month
$a = $base; $a['day'] = 30; $a['spent']['other'] = 100000;
$f = Forecast::month($a);
ok($f['days_left'] === 0 && $f['safe_daily'] === 0, 'finished month has nothing left to project');

// red lines
$b = $base['budget'];
ok(Forecast::redLines('entertainment', 500000, 10000000, $b, $z) === [], 'within every limit crosses nothing');
$l = Forecast::redLines('entertainment', 1000001, 10000000, $b, $z);
ok(count($l) === 1 && $l[0]['code'] === 'category_limit' && $l[0]['over_by'] === 1, 'one cent over a category limit is caught', $l);
ok(Forecast::redLines('entertainment', 1000000, 10000000, $b, $z) === [], 'exactly on the limit is allowed');
$l = Forecast::redLines('other', 100, 10000000, $b, ['mandatory' => 8000000] + $z);
ok(in_array('eats_savings', array_column($l, 'code'), true), 'spending that leaves too little for savings is caught', $l);
$l = Forecast::redLines('savings', 2000000, 10000000, $b, ['mandatory' => 9000000] + $z);
ok(array_column($l, 'code') === ['over_income'], 'saving more than is left is caught as over income', $l);
$nb = ['entertainment' => 0] + $b;
ok(Forecast::redLines('entertainment', 5000, 10000000, $nb, $z) === [], 'a zero limit means no limit set');
$l = Forecast::redLines('mandatory', 100, 10000000, $b, ['savings' => 2000000, 'mandatory' => 5000000, 'entertainment' => 1000000, 'other' => 1000000] + $z);
ok(array_column($l, 'code') === ['category_limit'], 'already-saved money is not counted twice', $l);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
