<?php
declare(strict_types=1);

/** Personal portal: monthly plan, entries, red-line stop and forecast. */
final class Personal
{
    private const CATS = ['mandatory', 'savings', 'investment', 'entertainment', 'other'];

    // ---------- monthly plan ----------

    public static function saveBudget(array $in): array
    {
        $month = V::month($in['month'] ?? null);
        $income = Money::parse($in, 'income', 'Monthly income');
        $limits = [];
        foreach (self::CATS as $c) {
            $limits[$c] = Money::parse($in + [$c => 0], $c, ucfirst($c), true);
        }
        if (array_sum($limits) > $income) {
            throw new HttpError(422, 'Your plan adds up to more than your income. Lower one of the amounts.');
        }
        Db::run(
            'INSERT INTO budgets (user_id, month, income, mandatory, savings, investment, entertainment, other)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE income = VALUES(income), mandatory = VALUES(mandatory), savings = VALUES(savings),
                 investment = VALUES(investment), entertainment = VALUES(entertainment), other = VALUES(other)',
            [Auth::uid(), $month, Money::toDb($income), ...array_map(Money::toDb(...), array_values($limits))]
        );
        return self::budgetOut(self::budget($month));
    }

    // ---------- entries ----------

    public static function addEntry(array $in): array
    {
        $category = V::choice($in, 'category', [...self::CATS, 'return'], 'Type');
        $amount = Money::parse($in, 'amount', 'Amount');
        $date = V::date($in, 'entry_date');
        $note = V::text($in, 'note', 200);
        $override = ($in['override'] ?? false) === true;
        $month = substr($date, 0, 7);

        return Db::tx(function () use ($category, $amount, $date, $note, $override, $month) {
            // Lock the user's row so two entries saved at the same moment are checked one after the other.
            Db::one('SELECT id FROM users WHERE id = ? FOR UPDATE', [Auth::uid()]);

            $crossed = [];
            $budget = self::budget($month);
            if ($category !== 'return' && $budget) {
                $totals = self::totals($month);
                $moneyIn = Money::fromDb($budget['income']) + $totals['return'];
                unset($totals['return']);
                $crossed = Forecast::redLines($category, $amount, $moneyIn, self::limits($budget), $totals);
            }
            if ($crossed) {
                $strict = (bool)Auth::user()['strict_stop'];
                if ($strict || !$override) {
                    throw new HttpError(409, 'This crosses a limit you set.', [
                        'red_lines' => array_map(self::lineOut(...), $crossed),
                        'can_override' => !$strict,
                    ]);
                }
            }
            $id = Db::insert(
                'INSERT INTO entries (user_id, category, amount, entry_date, note, overridden) VALUES (?, ?, ?, ?, ?, ?)',
                [Auth::uid(), $category, Money::toDb($amount), $date, $note, $crossed ? 1 : 0]
            );
            return ['id' => $id, 'month' => $month];
        });
    }

    public static function deleteEntry(int $id): void
    {
        $st = Db::run('DELETE FROM entries WHERE id = ? AND user_id = ?', [$id, Auth::uid()]);
        if ($st->rowCount() === 0) {
            throw new HttpError(404, 'Entry not found.');
        }
    }

    // ---------- dashboard ----------

    public static function summary(string $month, string $today): array
    {
        $budget = self::budget($month);
        $totals = self::totals($month);
        $returns = $totals['return'];
        unset($totals['return']);
        $income = $budget ? Money::fromDb($budget['income']) : 0;
        $limits = self::limits($budget);

        $first = new DateTimeImmutable($month . '-01');
        $dim = (int)$first->format('t');
        $thisMonth = substr($today, 0, 7);
        $day = $month === $thisMonth ? (int)substr($today, 8, 2) : ($month < $thisMonth ? $dim : 0);

        $daily = [];
        foreach (Db::all(
            "SELECT DAY(entry_date) d, SUM(amount) s FROM entries
             WHERE user_id = ? AND entry_date BETWEEN ? AND ? AND category IN ('entertainment','other') GROUP BY DAY(entry_date)",
            [Auth::uid(), $month . '-01', $month . '-' . $dim]
        ) as $r) {
            $daily[(int)$r['d']] = Money::fromDb($r['s']);
        }

        $history = self::history($month);
        $f = Forecast::month([
            'income' => $income,
            'returns' => $returns,
            'has_budget' => $budget !== null,
            'budget' => $limits,
            'spent' => $totals,
            'daily_variable' => $daily,
            'days_in_month' => $dim,
            'day' => $day,
            'history' => array_column($history, 'totals'),
        ]);

        $spend = $totals['mandatory'] + $totals['entertainment'] + $totals['other'];
        $setAside = $totals['savings'] + $totals['investment'];
        $moneyIn = $income + $returns;

        $cats = [];
        foreach (self::CATS as $c) {
            $cats[$c] = ['spent' => Money::out($totals[$c]), 'limit' => Money::out($limits[$c])];
        }

        $trend = array_map(static fn($h) => [
            'month' => $h['month'],
            'spend' => Money::out($h['totals']['mandatory'] + $h['totals']['entertainment'] + $h['totals']['other']),
            'set_aside' => Money::out($h['totals']['savings'] + $h['totals']['investment']),
        ], $history);
        $trend[] = ['month' => $month, 'spend' => Money::out($spend), 'set_aside' => Money::out($setAside)];

        $next = $f['next_month'];
        return [
            'month' => $month,
            'is_current' => $month === $thisMonth,
            'budget' => $budget ? self::budgetOut($budget) : null,
            'suggested_budget' => $budget ? null : self::suggestBudget($month),
            'income' => Money::out($income),
            'returns' => Money::out($returns),
            'money_in' => Money::out($moneyIn),
            'spent' => Money::out($spend),
            'set_aside' => Money::out($setAside),
            'left' => Money::out($moneyIn - $spend - $setAside),
            'categories' => $cats,
            'forecast' => [
                'level' => $f['level'],
                'confidence' => $f['confidence'],
                'days_left' => $f['days_left'],
                'daily_rate' => Money::out($f['daily_rate']),
                'projected_spend' => Money::out($f['projected_spend']),
                'projected_left' => Money::out($f['projected_left']),
                'safe_daily' => Money::out($f['safe_daily']),
                'run_out_date' => $f['run_out_day'] ? sprintf('%s-%02d', $month, $f['run_out_day']) : null,
                'next_month' => [
                    'months_used' => $next['months_used'],
                    'spend' => Money::out($next['mandatory'] + $next['entertainment'] + $next['other']),
                    'by_category' => array_map(Money::out(...), array_diff_key($next, ['months_used' => 1])),
                ],
            ],
            'trend' => array_slice($trend, -6),
            'entries' => self::entries($month),
        ];
    }

    // ---------- helpers ----------

    private static function budget(string $month): ?array
    {
        return Db::one('SELECT * FROM budgets WHERE user_id = ? AND month = ?', [Auth::uid(), $month]);
    }

    private static function limits(?array $budget): array
    {
        $out = [];
        foreach (self::CATS as $c) {
            $out[$c] = $budget ? Money::fromDb($budget[$c]) : 0;
        }
        return $out;
    }

    private static function budgetOut(array $b): array
    {
        $out = ['month' => $b['month'], 'income' => Money::out(Money::fromDb($b['income']))];
        foreach (self::CATS as $c) {
            $out[$c] = Money::out(Money::fromDb($b[$c]));
        }
        return $out;
    }

    /** The most recent earlier plan, offered as a starting point for a month that has none. */
    private static function suggestBudget(string $month): ?array
    {
        $prev = Db::one('SELECT * FROM budgets WHERE user_id = ? AND month < ? ORDER BY month DESC LIMIT 1', [Auth::uid(), $month]);
        return $prev ? ['month' => $month] + array_diff_key(self::budgetOut($prev), ['month' => 1]) : null;
    }

    /** Totals per category for one month, in minor units. */
    private static function totals(string $month): array
    {
        $out = array_fill_keys([...self::CATS, 'return'], 0);
        $last = (new DateTimeImmutable($month . '-01'))->format('Y-m-t');
        foreach (Db::all(
            'SELECT category, SUM(amount) s FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ? GROUP BY category',
            [Auth::uid(), $month . '-01', $last]
        ) as $r) {
            $out[$r['category']] = Money::fromDb($r['s']);
        }
        return $out;
    }

    /** Up to six earlier months that have entries, oldest first. */
    private static function history(string $month): array
    {
        $rows = Db::all(
            "SELECT DATE_FORMAT(entry_date, '%Y-%m') m, category, SUM(amount) s FROM entries
             WHERE user_id = ? AND entry_date < ? AND entry_date >= DATE_SUB(?, INTERVAL 6 MONTH) AND category <> 'return'
             GROUP BY m, category ORDER BY m",
            [Auth::uid(), $month . '-01', $month . '-01']
        );
        $by = [];
        foreach ($rows as $r) {
            $by[$r['m']] ??= array_fill_keys(self::CATS, 0);
            $by[$r['m']][$r['category']] = Money::fromDb($r['s']);
        }
        $out = [];
        foreach ($by as $m => $totals) {
            $out[] = ['month' => $m, 'totals' => $totals];
        }
        return $out;
    }

    private static function entries(string $month): array
    {
        $last = (new DateTimeImmutable($month . '-01'))->format('Y-m-t');
        return array_map(static fn(array $r) => [
            'id' => (int)$r['id'],
            'category' => $r['category'],
            'amount' => Money::out(Money::fromDb($r['amount'])),
            'entry_date' => $r['entry_date'],
            'note' => $r['note'],
            'overridden' => (bool)$r['overridden'],
        ], Db::all(
            'SELECT id, category, amount, entry_date, note, overridden FROM entries
             WHERE user_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date DESC, id DESC',
            [Auth::uid(), $month . '-01', $last]
        ));
    }

    private static function lineOut(array $l): array
    {
        $l['over_by'] = Money::out($l['over_by']);
        return $l;
    }
}
