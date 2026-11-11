<?php
declare(strict_types=1);

/** Business portal: clients, credit given (invoices) and payments received. */
final class Business
{
    // ---------- clients ----------

    public static function clients(): array
    {
        $rows = Db::all(
            'SELECT c.id, c.name, c.phone, c.email, c.notes, c.credit_limit,
                    COALESCE(i.billed, 0) AS billed, COALESCE(i.paid, 0) AS paid, COALESCE(i.open_count, 0) AS open_count
             FROM clients c
             LEFT JOIN (
                SELECT inv.client_id,
                       SUM(inv.amount) AS billed,
                       SUM(COALESCE(p.paid, 0)) AS paid,
                       SUM(inv.amount > COALESCE(p.paid, 0)) AS open_count
                FROM invoices inv
                LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments WHERE user_id = ? GROUP BY invoice_id) p
                       ON p.invoice_id = inv.id
                WHERE inv.user_id = ?
                GROUP BY inv.client_id
             ) i ON i.client_id = c.id
             WHERE c.user_id = ?
             ORDER BY c.name',
            [Auth::uid(), Auth::uid(), Auth::uid()]
        );
        return array_map(self::clientOut(...), $rows);
    }

    public static function saveClient(array $in, ?int $id = null): array
    {
        $name = V::text($in, 'name', 120, true, 'Client name');
        $phone = V::text($in, 'phone', 40);
        $email = V::email($in, 'email', false);
        $notes = V::text($in, 'notes', 1000);
        $limit = ($in['credit_limit'] ?? '') === '' || ($in['credit_limit'] ?? null) === null
            ? null
            : Money::toDb(Money::parse($in, 'credit_limit', 'Credit limit'));

        if ($id === null) {
            $id = Db::insert(
                'INSERT INTO clients (user_id, name, phone, email, notes, credit_limit) VALUES (?, ?, ?, ?, ?, ?)',
                [Auth::uid(), $name, $phone, $email, $notes, $limit]
            );
        } else {
            self::ownClient($id);
            Db::run(
                'UPDATE clients SET name = ?, phone = ?, email = ?, notes = ?, credit_limit = ? WHERE id = ? AND user_id = ?',
                [$name, $phone, $email, $notes, $limit, $id, Auth::uid()]
            );
        }
        foreach (self::clients() as $c) {
            if ($c['id'] === $id) {
                return $c;
            }
        }
        throw new HttpError(404, 'Client not found.');
    }

    public static function deleteClient(int $id): void
    {
        self::ownClient($id);
        Db::run('DELETE FROM clients WHERE id = ? AND user_id = ?', [$id, Auth::uid()]);
    }

    // ---------- invoices (credit given) ----------

    public static function invoices(?int $clientId = null): array
    {
        $sql = 'SELECT inv.id, inv.client_id, c.name AS client_name, inv.number, inv.description, inv.amount,
                       inv.invoice_date, inv.due_date, COALESCE(p.paid, 0) AS paid
                FROM invoices inv
                JOIN clients c ON c.id = inv.client_id
                LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments WHERE user_id = ? GROUP BY invoice_id) p
                       ON p.invoice_id = inv.id
                WHERE inv.user_id = ?';
        $params = [Auth::uid(), Auth::uid()];
        if ($clientId !== null) {
            $sql .= ' AND inv.client_id = ?';
            $params[] = $clientId;
        }
        $sql .= ' ORDER BY inv.invoice_date DESC, inv.id DESC LIMIT 1000';
        return array_map(self::invoiceOut(...), Db::all($sql, $params));
    }

    public static function addInvoice(array $in): array
    {
        $clientId = V::id($in['client_id'] ?? null, 'Client');
        $amount = Money::parse($in, 'amount', 'Amount');
        $date = V::date($in, 'invoice_date', true, 'Date');
        $due = V::date($in, 'due_date', false, 'Due date');
        if ($due !== null && $due < $date) {
            throw new HttpError(422, 'Due date cannot be before the credit date.');
        }
        $desc = V::text($in, 'description', 500);
        $number = V::text($in, 'number', 40);
        $override = ($in['override'] ?? false) === true;

        return Db::tx(function () use ($clientId, $amount, $date, $due, $desc, $number, $override) {
            $client = Db::one('SELECT id, name, credit_limit FROM clients WHERE id = ? AND user_id = ? FOR UPDATE', [$clientId, Auth::uid()]);
            if (!$client) {
                throw new HttpError(404, 'Client not found.');
            }
            // Red line: a client's unpaid balance may not pass the credit limit set for them.
            if ($client['credit_limit'] !== null) {
                $limit = Money::fromDb($client['credit_limit']);
                $owed = self::clientOwed($clientId);
                if ($owed + $amount > $limit) {
                    $line = [
                        'code' => 'credit_limit',
                        'title' => 'Over this client\'s credit limit',
                        'detail' => $client['name'] . ' already owes ' . Money::out($owed) . '. This would take them past their limit of ' . Money::out($limit) . '.',
                        'over_by' => Money::out($owed + $amount - $limit),
                    ];
                    if (Auth::user()['strict_stop'] || !$override) {
                        throw new HttpError(409, 'This crosses a limit you set.', [
                            'red_lines' => [$line],
                            'can_override' => !Auth::user()['strict_stop'],
                        ]);
                    }
                }
            }
            if ($number === '') {
                $n = (int)Db::one('SELECT COUNT(*) c FROM invoices WHERE user_id = ?', [Auth::uid()])['c'] + 1;
                $number = 'CR-' . str_pad((string)$n, 4, '0', STR_PAD_LEFT);
            }
            $id = Db::insert(
                'INSERT INTO invoices (user_id, client_id, number, description, amount, invoice_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [Auth::uid(), $clientId, $number, $desc, Money::toDb($amount), $date, $due]
            );
            return self::invoice($id);
        });
    }

    public static function deleteInvoice(int $id): void
    {
        self::invoice($id);
        Db::run('DELETE FROM invoices WHERE id = ? AND user_id = ?', [$id, Auth::uid()]);
    }

    // ---------- payments ----------

    public static function payments(?int $invoiceId = null): array
    {
        $sql = 'SELECT p.id, p.invoice_id, inv.number AS invoice_number, c.id AS client_id, c.name AS client_name,
                       p.amount, p.method, p.payment_date, p.reference
                FROM payments p
                JOIN invoices inv ON inv.id = p.invoice_id
                JOIN clients c ON c.id = inv.client_id
                WHERE p.user_id = ?';
        $params = [Auth::uid()];
        if ($invoiceId !== null) {
            $sql .= ' AND p.invoice_id = ?';
            $params[] = $invoiceId;
        }
        $sql .= ' ORDER BY p.payment_date DESC, p.id DESC LIMIT 1000';
        return array_map(static fn(array $r) => [
            'id' => (int)$r['id'],
            'invoice_id' => (int)$r['invoice_id'],
            'invoice_number' => $r['invoice_number'],
            'client_id' => (int)$r['client_id'],
            'client_name' => $r['client_name'],
            'amount' => Money::out(Money::fromDb($r['amount'])),
            'method' => $r['method'],
            'payment_date' => $r['payment_date'],
            'reference' => $r['reference'],
        ], Db::all($sql, $params));
    }

    public static function addPayment(array $in): array
    {
        $invoiceId = V::id($in['invoice_id'] ?? null, 'Credit entry');
        $amount = Money::parse($in, 'amount', 'Amount');
        $method = V::choice($in, 'method', ['cash', 'bank', 'other'], 'Payment method');
        $date = V::date($in, 'payment_date', true, 'Date');
        $ref = V::text($in, 'reference', 120);

        return Db::tx(function () use ($invoiceId, $amount, $method, $date, $ref) {
            // Lock the invoice row so two payments saved at once cannot overpay it.
            $inv = Db::one('SELECT id, amount FROM invoices WHERE id = ? AND user_id = ? FOR UPDATE', [$invoiceId, Auth::uid()]);
            if (!$inv) {
                throw new HttpError(404, 'Credit entry not found.');
            }
            $paid = Money::fromDb(Db::one('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ? AND user_id = ?', [$invoiceId, Auth::uid()])['s']);
            $left = Money::fromDb($inv['amount']) - $paid;
            if ($amount > $left) {
                throw new HttpError(422, 'Only ' . number_format(Money::out($left), 2) . ' is still owed on this entry. Enter that amount or less.');
            }
            Db::insert(
                'INSERT INTO payments (user_id, invoice_id, amount, method, payment_date, reference) VALUES (?, ?, ?, ?, ?, ?)',
                [Auth::uid(), $invoiceId, Money::toDb($amount), $method, $date, $ref]
            );
            return self::invoice($invoiceId);
        });
    }

    public static function deletePayment(int $id): void
    {
        $st = Db::run('DELETE FROM payments WHERE id = ? AND user_id = ?', [$id, Auth::uid()]);
        if ($st->rowCount() === 0) {
            throw new HttpError(404, 'Payment not found.');
        }
    }

    // ---------- dashboard ----------

    public static function summary(string $today): array
    {
        $invoices = self::invoices();
        $outstanding = 0;
        $overdue = 0;
        $overdueCount = 0;
        $dueSoon = [];
        $byClient = [];
        $soon = (new DateTimeImmutable($today))->modify('+7 days')->format('Y-m-d');
        foreach ($invoices as $inv) {
            $left = (int)round($inv['remaining'] * 100);
            if ($left <= 0) {
                continue;
            }
            $outstanding += $left;
            $byClient[$inv['client_id']] ??= ['client_id' => $inv['client_id'], 'name' => $inv['client_name'], 'owed' => 0];
            $byClient[$inv['client_id']]['owed'] += $left;
            if ($inv['status'] === 'overdue') {
                $overdue += $left;
                $overdueCount++;
                $dueSoon[] = $inv;
            } elseif ($inv['due_date'] !== null && $inv['due_date'] <= $soon) {
                $dueSoon[] = $inv;
            }
        }
        usort($dueSoon, static fn($a, $b) => strcmp((string)$a['due_date'], (string)$b['due_date']));
        usort($byClient, static fn($a, $b) => $b['owed'] <=> $a['owed']);

        $monthStart = substr($today, 0, 7) . '-01';
        $collected = Money::fromDb(Db::one(
            'SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE user_id = ? AND payment_date >= ?',
            [Auth::uid(), $monthStart]
        )['s']);
        $given = Money::fromDb(Db::one(
            'SELECT COALESCE(SUM(amount), 0) s FROM invoices WHERE user_id = ? AND invoice_date >= ?',
            [Auth::uid(), $monthStart]
        )['s']);

        return [
            'outstanding' => Money::out($outstanding),
            'overdue' => Money::out($overdue),
            'overdue_count' => $overdueCount,
            'collected_this_month' => Money::out($collected),
            'given_this_month' => Money::out($given),
            'client_count' => (int)Db::one('SELECT COUNT(*) c FROM clients WHERE user_id = ?', [Auth::uid()])['c'],
            'top_owing' => array_map(static fn($c) => ['client_id' => $c['client_id'], 'name' => $c['name'], 'owed' => Money::out($c['owed'])], array_slice($byClient, 0, 5)),
            'needs_attention' => array_slice($dueSoon, 0, 8),
            'recent_payments' => array_slice(self::payments(), 0, 5),
        ];
    }

    // ---------- helpers ----------

    private static function ownClient(int $id): void
    {
        if (!Db::one('SELECT id FROM clients WHERE id = ? AND user_id = ?', [$id, Auth::uid()])) {
            throw new HttpError(404, 'Client not found.');
        }
    }

    private static function clientOwed(int $clientId): int
    {
        $billed = Money::fromDb(Db::one('SELECT COALESCE(SUM(amount), 0) s FROM invoices WHERE client_id = ? AND user_id = ?', [$clientId, Auth::uid()])['s']);
        $paid = Money::fromDb(Db::one(
            'SELECT COALESCE(SUM(p.amount), 0) s FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.client_id = ? AND p.user_id = ?',
            [$clientId, Auth::uid()]
        )['s']);
        return $billed - $paid;
    }

    private static function invoice(int $id): array
    {
        foreach (self::invoicesWhereId($id) as $inv) {
            return $inv;
        }
        throw new HttpError(404, 'Credit entry not found.');
    }

    private static function invoicesWhereId(int $id): array
    {
        $rows = Db::all(
            'SELECT inv.id, inv.client_id, c.name AS client_name, inv.number, inv.description, inv.amount,
                    inv.invoice_date, inv.due_date,
                    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = inv.id AND user_id = ?) AS paid
             FROM invoices inv JOIN clients c ON c.id = inv.client_id
             WHERE inv.id = ? AND inv.user_id = ?',
            [Auth::uid(), $id, Auth::uid()]
        );
        return array_map(self::invoiceOut(...), $rows);
    }

    private static function clientOut(array $r): array
    {
        $billed = Money::fromDb($r['billed']);
        $paid = Money::fromDb($r['paid']);
        return [
            'id' => (int)$r['id'],
            'name' => $r['name'],
            'phone' => $r['phone'],
            'email' => $r['email'],
            'notes' => $r['notes'],
            'credit_limit' => $r['credit_limit'] === null ? null : Money::out(Money::fromDb($r['credit_limit'])),
            'billed' => Money::out($billed),
            'paid' => Money::out($paid),
            'owed' => Money::out($billed - $paid),
            'open_count' => (int)$r['open_count'],
        ];
    }

    private static function invoiceOut(array $r): array
    {
        $amount = Money::fromDb($r['amount']);
        $paid = Money::fromDb($r['paid']);
        $left = $amount - $paid;
        $status = $left <= 0 ? 'paid' : ($paid > 0 ? 'partial' : 'unpaid');
        if ($left > 0 && $r['due_date'] !== null && $r['due_date'] < gmdate('Y-m-d')) {
            $status = 'overdue';
        }
        return [
            'id' => (int)$r['id'],
            'client_id' => (int)$r['client_id'],
            'client_name' => $r['client_name'],
            'number' => $r['number'],
            'description' => $r['description'],
            'amount' => Money::out($amount),
            'paid' => Money::out($paid),
            'remaining' => Money::out($left),
            'invoice_date' => $r['invoice_date'],
            'due_date' => $r['due_date'],
            'status' => $status,
        ];
    }
}
