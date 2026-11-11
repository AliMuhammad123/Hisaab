<?php
declare(strict_types=1);

/**
 * Spending forecast. Pure functions: no database, no clock, so every result
 * can be reproduced from its inputs. All money is in minor units (cents).
 *
 * Two small statistical models, both fitted on the user's own entries only:
 *
 *  1. This month: day-to-day spending (entertainment + other) is smoothed with
 *     an exponentially weighted average so recent days count more, then blended
 *     with the user's pace in earlier months. Bills (mandatory) are lumpy, so
 *     they are projected from the plan or the median of earlier months instead.
 *  2. Next month: a least-squares trend line through each category's totals for
 *     up to the last six months.
 */
final class Forecast
{
    public const SPEND = ['mandatory', 'entertainment', 'other'];
    public const SET_ASIDE = ['savings', 'investment'];
    private const ALPHA = 0.25;

    /**
     * @param array{
     *   income:int, returns:int, has_budget:bool,
     *   budget:array<string,int>, spent:array<string,int>,
     *   daily_variable:array<int,int>, days_in_month:int, day:int,
     *   history:list<array<string,int>>
     * } $a  `day` is today's day of the month, 0 for a month that has not started,
     *       or days_in_month for a finished month. `history` is oldest first.
     */
    public static function month(array $a): array
    {
        $dim = $a['days_in_month'];
        $day = max(0, min($dim, $a['day']));
        $left = $dim - $day;
        $moneyIn = $a['income'] + $a['returns'];

        // --- day-to-day spending rate ---
        $variableSpent = $a['spent']['entertainment'] + $a['spent']['other'];
        $rateNow = self::ewma(array_map(static fn(int $d) => $a['daily_variable'][$d] ?? 0, $day > 0 ? range(1, $day) : []));
        $histRates = [];
        foreach ($a['history'] as $h) {
            $histRates[] = ($h['entertainment'] + $h['other']) / 30.4;
        }
        $rateHist = $histRates ? array_sum($histRates) / count($histRates) : null;
        // Trust this month's pace more as more of it has been seen.
        $w = $rateHist === null ? 1.0 : min(1.0, $day / 14);
        $rate = $day === 0 && $rateHist !== null ? $rateHist : $w * $rateNow + (1 - $w) * ($rateHist ?? $rateNow);

        // --- bills ---
        $histMandatory = array_values(array_filter(array_map(static fn($h) => $h['mandatory'], $a['history'])));
        $expectedMandatory = $a['budget']['mandatory'] > 0 ? $a['budget']['mandatory'] : self::median($histMandatory);
        $mandatoryProjected = max($a['spent']['mandatory'], $expectedMandatory);

        // --- money set aside ---
        $setAsidePlanned = $a['budget']['savings'] + $a['budget']['investment'];
        $setAsideDone = $a['spent']['savings'] + $a['spent']['investment'];
        $setAsideProjected = max($setAsidePlanned, $setAsideDone);

        $projectedSpend = (int)round($mandatoryProjected + $variableSpent + $rate * $left);
        $projectedLeft = $moneyIn - $projectedSpend - $setAsideProjected;

        // Money free for day-to-day spending for the rest of the month.
        $free = $moneyIn - $setAsideProjected - $mandatoryProjected - $variableSpent;
        $safeDaily = $left > 0 ? max(0, intdiv(max(0, $free), $left)) : 0;

        // The day the free money runs out at the current pace.
        $runOutDay = null;
        if ($left > 0 && $rate > 0 && $free >= 0 && $free / $rate < $left) {
            $runOutDay = $day + (int)floor($free / $rate) + 1;
        }

        $level = 'ok';
        if ($a['has_budget'] && $moneyIn > 0) {
            if ($projectedSpend > $moneyIn) {
                $level = 'danger';
            } elseif ($projectedLeft < 0) {
                $level = 'watch';
            }
        }

        $confidence = 'low';
        if ($day >= 20 || ($day >= 10 && count($a['history']) >= 2)) {
            $confidence = 'high';
        } elseif ($day >= 7 || count($a['history']) >= 1) {
            $confidence = 'medium';
        }

        return [
            'level' => $level,
            'confidence' => $confidence,
            'days_left' => $left,
            'daily_rate' => (int)round($rate),
            'projected_spend' => $projectedSpend,
            'projected_left' => $projectedLeft,
            'safe_daily' => $safeDaily,
            'run_out_day' => $runOutDay,
            'next_month' => self::nextMonth($a['history'], $a['spent'], $day >= $dim),
        ];
    }

    /** Trend-line prediction of next month's total for each category. */
    public static function nextMonth(array $history, array $current, bool $currentComplete): array
    {
        $months = $history;
        if ($currentComplete) {
            $months[] = $current;
        }
        $months = array_slice($months, -6);
        $out = [];
        foreach ([...self::SPEND, ...self::SET_ASIDE] as $cat) {
            $ys = array_map(static fn($m) => (float)($m[$cat] ?? 0), $months);
            $out[$cat] = (int)round(self::trend($ys));
        }
        $out['months_used'] = count($months);
        return $out;
    }

    /** Least-squares line through the points, read one step past the end. Never below zero. */
    public static function trend(array $ys): float
    {
        $n = count($ys);
        if ($n === 0) {
            return 0.0;
        }
        $mean = array_sum($ys) / $n;
        if ($n < 3) {
            return $mean; // too few months for a slope to mean anything
        }
        $xMean = ($n - 1) / 2;
        $sxy = 0.0;
        $sxx = 0.0;
        foreach ($ys as $x => $y) {
            $sxy += ($x - $xMean) * ($y - $mean);
            $sxx += ($x - $xMean) ** 2;
        }
        $slope = $sxx > 0 ? $sxy / $sxx : 0.0;
        $pred = $mean + $slope * ($n - $xMean);
        // Keep the prediction within a sane band around what has actually been seen.
        return max(0.0, min($pred, max($ys) * 1.5));
    }

    /** Exponentially weighted average of a daily series; later days weigh more. */
    public static function ewma(array $series): float
    {
        if (!$series) {
            return 0.0;
        }
        $avg = array_sum($series) / count($series);
        $s = $avg;
        foreach ($series as $v) {
            $s = self::ALPHA * $v + (1 - self::ALPHA) * $s;
        }
        // A single big day should not swing the whole month: stay near the plain average.
        return 0.5 * $s + 0.5 * $avg;
    }

    public static function median(array $xs): int
    {
        if (!$xs) {
            return 0;
        }
        sort($xs);
        $n = count($xs);
        return $n % 2 ? (int)$xs[intdiv($n, 2)] : (int)round(($xs[$n / 2 - 1] + $xs[$n / 2]) / 2);
    }

    /**
     * Red lines: limits that stop an entry from being saved.
     * Returns the lines that adding $amount to $category would cross.
     *
     * @param array<string,int> $budget limits per category (0 means no limit set)
     * @param array<string,int> $spent  totals so far this month, before the new entry
     */
    public static function redLines(string $category, int $amount, int $moneyIn, array $budget, array $spent): array
    {
        $lines = [];
        $labels = ['mandatory' => 'bills', 'entertainment' => 'fun', 'other' => 'other spending', 'savings' => 'savings', 'investment' => 'investment'];

        $allOut = array_sum($spent) + $amount;
        if ($allOut > $moneyIn) {
            $lines[] = [
                'code' => 'over_income',
                'title' => 'More than you earned this month',
                'detail' => 'This takes your total for the month above your income.',
                'over_by' => $allOut - $moneyIn,
            ];
        }

        if (in_array($category, self::SPEND, true)) {
            $limit = $budget[$category] ?? 0;
            if ($limit > 0 && $spent[$category] + $amount > $limit) {
                $lines[] = [
                    'code' => 'category_limit',
                    'title' => 'Over your ' . $labels[$category] . ' limit',
                    'detail' => 'You planned a limit for ' . $labels[$category] . ' this month and this goes past it.',
                    'over_by' => $spent[$category] + $amount - $limit,
                ];
            }

            $spendAfter = $spent['mandatory'] + $spent['entertainment'] + $spent['other'] + $amount;
            $protected = max(0, ($budget['savings'] ?? 0) - $spent['savings']) + max(0, ($budget['investment'] ?? 0) - $spent['investment']);
            $alreadySetAside = $spent['savings'] + $spent['investment'];
            $freeForSpending = $moneyIn - $alreadySetAside - $protected;
            if ($protected > 0 && $spendAfter > $freeForSpending && $allOut <= $moneyIn) {
                $lines[] = [
                    'code' => 'eats_savings',
                    'title' => 'This uses money you planned to save',
                    'detail' => 'After this, there is not enough left to reach your savings and investment plan.',
                    'over_by' => $spendAfter - $freeForSpending,
                ];
            }
        }
        return $lines;
    }
}
