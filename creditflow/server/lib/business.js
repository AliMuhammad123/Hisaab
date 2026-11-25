// Business portal: clients, credit given (invoices) and payments received.
// Every query filters on the signed-in user's id.
import { HttpError, V, Money, get } from './http.js';
import { uid, user } from './auth.js';

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------- clients ----------

export async function clients(ctx, db = ctx.db) {
  const me = uid(ctx);
  const rows = await db.all(
    `SELECT c.id, c.name, c.phone, c.email, c.notes, c.credit_limit,
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
     ORDER BY c.name`,
    [me, me, me],
  );
  return rows.map(clientOut);
}

export async function saveClient(ctx, input, id = null) {
  const name = V.text(input, 'name', 120, true, 'Client name');
  const phone = V.text(input, 'phone', 40);
  const email = V.email(input, 'email', false);
  const notes = V.text(input, 'notes', 1000);
  const rawLimit = get(input, 'credit_limit');
  const limit = rawLimit === undefined || rawLimit === null || rawLimit === '' ? null : Money.toDb(Money.parse(input, 'credit_limit', 'Credit limit'));

  if (id === null) {
    id = await ctx.db.insert(
      'INSERT INTO clients (user_id, name, phone, email, notes, credit_limit) VALUES (?, ?, ?, ?, ?, ?)',
      [uid(ctx), name, phone, email, notes, limit],
    );
  } else {
    await ownClient(ctx, id);
    await ctx.db.run(
      'UPDATE clients SET name = ?, phone = ?, email = ?, notes = ?, credit_limit = ? WHERE id = ? AND user_id = ?',
      [name, phone, email, notes, limit, id, uid(ctx)],
    );
  }
  const found = (await clients(ctx)).find((c) => c.id === id);
  if (!found) throw new HttpError(404, 'Client not found.');
  return found;
}

export async function deleteClient(ctx, id) {
  await ownClient(ctx, id);
  await ctx.db.run('DELETE FROM clients WHERE id = ? AND user_id = ?', [id, uid(ctx)]);
}

// ---------- invoices (credit given) ----------

export async function invoices(ctx, clientId = null) {
  let sql = `SELECT inv.id, inv.client_id, c.name AS client_name, inv.number, inv.description, inv.amount,
                    inv.invoice_date, inv.due_date, COALESCE(p.paid, 0) AS paid
             FROM invoices inv
             JOIN clients c ON c.id = inv.client_id
             LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments WHERE user_id = ? GROUP BY invoice_id) p
                    ON p.invoice_id = inv.id
             WHERE inv.user_id = ?`;
  const params = [uid(ctx), uid(ctx)];
  if (clientId !== null) {
    sql += ' AND inv.client_id = ?';
    params.push(clientId);
  }
  sql += ' ORDER BY inv.invoice_date DESC, inv.id DESC LIMIT 1000';
  return (await ctx.db.all(sql, params)).map((r) => invoiceOut(r, ctx.today));
}

export async function addInvoice(ctx, input) {
  const clientId = V.id(get(input, 'client_id'), 'Client');
  const amount = Money.parse(input, 'amount', 'Amount');
  const date = V.date(input, 'invoice_date', true, 'Date');
  const due = V.date(input, 'due_date', false, 'Due date');
  if (due !== null && due < date) throw new HttpError(422, 'Due date cannot be before the credit date.');
  const desc = V.text(input, 'description', 500);
  let number = V.text(input, 'number', 40);
  const override = get(input, 'override') === true;
  const me = uid(ctx);
  const strict = Boolean(Number(user(ctx).strict_stop));

  return ctx.db.tx(async (t) => {
    const client = await t.one('SELECT id, name, credit_limit FROM clients WHERE id = ? AND user_id = ? FOR UPDATE', [clientId, me]);
    if (!client) throw new HttpError(404, 'Client not found.');
    // Red line: a client's unpaid balance may not pass the credit limit set for them.
    if (client.credit_limit !== null) {
      const limit = Money.fromDb(client.credit_limit);
      const owed = await clientOwed(t, me, clientId);
      if (owed + amount > limit) {
        const line = {
          code: 'credit_limit',
          title: "Over this client's credit limit",
          detail: `${client.name} already owes ${Money.out(owed)}. This would take them past their limit of ${Money.out(limit)}.`,
          over_by: Money.out(owed + amount - limit),
        };
        if (strict || !override) {
          throw new HttpError(409, 'This crosses a limit you set.', { red_lines: [line], can_override: !strict });
        }
      }
    }
    if (number === '') {
      const n = Number((await t.one('SELECT COUNT(*) AS c FROM invoices WHERE user_id = ?', [me])).c) + 1;
      number = `CR-${String(n).padStart(4, '0')}`;
    }
    const id = await t.insert(
      'INSERT INTO invoices (user_id, client_id, number, description, amount, invoice_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [me, clientId, number, desc, Money.toDb(amount), date, due],
    );
    return invoice(ctx, id, t);
  });
}

export async function deleteInvoice(ctx, id) {
  await invoice(ctx, id);
  await ctx.db.run('DELETE FROM invoices WHERE id = ? AND user_id = ?', [id, uid(ctx)]);
}

// ---------- payments ----------

export async function payments(ctx, invoiceId = null) {
  let sql = `SELECT p.id, p.invoice_id, inv.number AS invoice_number, c.id AS client_id, c.name AS client_name,
                    p.amount, p.method, p.payment_date, p.reference
             FROM payments p
             JOIN invoices inv ON inv.id = p.invoice_id
             JOIN clients c ON c.id = inv.client_id
             WHERE p.user_id = ?`;
  const params = [uid(ctx)];
  if (invoiceId !== null) {
    sql += ' AND p.invoice_id = ?';
    params.push(invoiceId);
  }
  sql += ' ORDER BY p.payment_date DESC, p.id DESC LIMIT 1000';
  return (await ctx.db.all(sql, params)).map((r) => ({
    id: Number(r.id),
    invoice_id: Number(r.invoice_id),
    invoice_number: r.invoice_number,
    client_id: Number(r.client_id),
    client_name: r.client_name,
    amount: Money.out(Money.fromDb(r.amount)),
    method: r.method,
    payment_date: r.payment_date,
    reference: r.reference,
  }));
}

export async function addPayment(ctx, input) {
  const invoiceId = V.id(get(input, 'invoice_id'), 'Credit entry');
  const amount = Money.parse(input, 'amount', 'Amount');
  const method = V.choice(input, 'method', ['cash', 'bank', 'other'], 'Payment method');
  const date = V.date(input, 'payment_date', true, 'Date');
  const ref = V.text(input, 'reference', 120);
  const me = uid(ctx);

  return ctx.db.tx(async (t) => {
    // Lock the invoice row so two payments saved at once cannot overpay it.
    const inv = await t.one('SELECT id, amount FROM invoices WHERE id = ? AND user_id = ? FOR UPDATE', [invoiceId, me]);
    if (!inv) throw new HttpError(404, 'Credit entry not found.');
    const paid = Money.fromDb((await t.one('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = ? AND user_id = ?', [invoiceId, me])).s);
    const left = Money.fromDb(inv.amount) - paid;
    if (amount > left) {
      throw new HttpError(422, `Only ${Money.out(left).toFixed(2)} is still owed on this entry. Enter that amount or less.`);
    }
    await t.insert(
      'INSERT INTO payments (user_id, invoice_id, amount, method, payment_date, reference) VALUES (?, ?, ?, ?, ?, ?)',
      [me, invoiceId, Money.toDb(amount), method, date, ref],
    );
    return invoice(ctx, invoiceId, t);
  });
}

export async function deletePayment(ctx, id) {
  const r = await ctx.db.run('DELETE FROM payments WHERE id = ? AND user_id = ?', [id, uid(ctx)]);
  if (r.affectedRows === 0) throw new HttpError(404, 'Payment not found.');
}

// ---------- dashboard ----------

export async function summary(ctx) {
  const today = ctx.today;
  const me = uid(ctx);
  const all = await invoices(ctx);
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;
  const attention = [];
  const byClient = new Map();
  const soon = addDays(today, 7);
  for (const inv of all) {
    const left = Math.round(inv.remaining * 100);
    if (left <= 0) continue;
    outstanding += left;
    if (!byClient.has(inv.client_id)) byClient.set(inv.client_id, { client_id: inv.client_id, name: inv.client_name, owed: 0 });
    byClient.get(inv.client_id).owed += left;
    if (inv.status === 'overdue') {
      overdue += left;
      overdueCount++;
      attention.push(inv);
    } else if (inv.due_date !== null && inv.due_date <= soon) {
      attention.push(inv);
    }
  }
  attention.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  const top = [...byClient.values()].sort((a, b) => b.owed - a.owed);

  const monthStart = `${today.slice(0, 7)}-01`;
  const collected = Money.fromDb((await ctx.db.one('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE user_id = ? AND payment_date >= ?', [me, monthStart])).s);
  const given = Money.fromDb((await ctx.db.one('SELECT COALESCE(SUM(amount), 0) AS s FROM invoices WHERE user_id = ? AND invoice_date >= ?', [me, monthStart])).s);

  return {
    outstanding: Money.out(outstanding),
    overdue: Money.out(overdue),
    overdue_count: overdueCount,
    collected_this_month: Money.out(collected),
    given_this_month: Money.out(given),
    client_count: Number((await ctx.db.one('SELECT COUNT(*) AS c FROM clients WHERE user_id = ?', [me])).c),
    top_owing: top.slice(0, 5).map((c) => ({ client_id: c.client_id, name: c.name, owed: Money.out(c.owed) })),
    needs_attention: attention.slice(0, 8),
    recent_payments: (await payments(ctx)).slice(0, 5),
  };
}

// ---------- helpers ----------

async function ownClient(ctx, id) {
  if (!(await ctx.db.one('SELECT id FROM clients WHERE id = ? AND user_id = ?', [id, uid(ctx)]))) {
    throw new HttpError(404, 'Client not found.');
  }
}

async function clientOwed(db, me, clientId) {
  const billed = Money.fromDb((await db.one('SELECT COALESCE(SUM(amount), 0) AS s FROM invoices WHERE client_id = ? AND user_id = ?', [clientId, me])).s);
  const paid = Money.fromDb((await db.one(
    'SELECT COALESCE(SUM(p.amount), 0) AS s FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.client_id = ? AND p.user_id = ?',
    [clientId, me],
  )).s);
  return billed - paid;
}

async function invoice(ctx, id, db = ctx.db) {
  const me = uid(ctx);
  const row = await db.one(
    `SELECT inv.id, inv.client_id, c.name AS client_name, inv.number, inv.description, inv.amount,
            inv.invoice_date, inv.due_date,
            (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = inv.id AND user_id = ?) AS paid
     FROM invoices inv JOIN clients c ON c.id = inv.client_id
     WHERE inv.id = ? AND inv.user_id = ?`,
    [me, id, me],
  );
  if (!row) throw new HttpError(404, 'Credit entry not found.');
  return invoiceOut(row, ctx.today);
}

function clientOut(r) {
  const billed = Money.fromDb(r.billed);
  const paid = Money.fromDb(r.paid);
  return {
    id: Number(r.id),
    name: r.name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    credit_limit: r.credit_limit === null ? null : Money.out(Money.fromDb(r.credit_limit)),
    billed: Money.out(billed),
    paid: Money.out(paid),
    owed: Money.out(billed - paid),
    open_count: Number(r.open_count),
  };
}

function invoiceOut(r, today) {
  const amount = Money.fromDb(r.amount);
  const paid = Money.fromDb(r.paid);
  const left = amount - paid;
  let status = left <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  if (left > 0 && r.due_date !== null && r.due_date < today) status = 'overdue';
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    client_name: r.client_name,
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
