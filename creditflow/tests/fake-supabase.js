// Test-only, in-browser stand-in for @supabase/supabase-js, used by `npm run build:test`.
// It keeps tables in localStorage and copies the parts of Supabase the app relies on:
// each signed-in user only sees their own rows, sign-up confirmation by email code
// (the code is always 123456 here), and the payment limit trigger.
// It is never part of the real app build.

const KEY = 'fake-supabase';
const load = () => JSON.parse(localStorage.getItem(KEY) || '{"users":[],"session":null,"seq":1,"t":{}}');
const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
const CODE = '123456';
const NUMERIC = new Set(['amount', 'income', 'mandatory', 'savings', 'investment', 'entertainment', 'other', 'credit_limit']);
const err = (message, code = '', status = 400) => ({ data: null, error: { message, code, status } });

class Query {
  constructor(client, table) {
    this.c = client;
    this.table = table;
    this.filters = [];
    this.op = 'select';
    this.orders = [];
  }
  select() { if (this.op === 'select') this.op = 'select'; this.returning = true; return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  update(row) { this.op = 'update'; this.payload = row; return this; }
  upsert(row, opts) { this.op = 'upsert'; this.payload = row; this.conflict = opts?.onConflict?.split(','); return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
  order(c, o = {}) { this.orders.push([c, o.ascending !== false]); return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  limit(n) { this.rng = [0, n - 1]; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }

  run() {
    const db = load();
    const me = db.session?.user?.id;
    if (!me) return err('JWT required', 'PGRST301', 401);
    const rows = (db.t[this.table] ||= []);
    const owner = this.table === 'profiles' ? 'id' : 'user_id';
    const visible = rows.filter((r) => r[owner] === me);
    const match = (r) => this.filters.every((f) => f(r));
    const norm = (row) => {
      const out = { ...row };
      for (const k of Object.keys(out)) if (NUMERIC.has(k) && out[k] !== null) out[k] = Number(out[k]);
      return out;
    };
    let result;
    if (this.op === 'select') {
      result = visible.filter(match);
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const row = norm({ user_id: me, ...this.payload });
      if (row.user_id !== me) return err('new row violates row-level security policy', '42501', 403);
      const problem = this.check(db, row, me);
      if (problem) return problem;
      const existing = this.op === 'upsert' && visible.find((r) => this.conflict.every((c) => r[c] === row[c]));
      if (existing) Object.assign(existing, row);
      else rows.push(Object.assign(row, { id: db.seq++, created_at: new Date().toISOString() }));
      result = [existing || row];
    } else if (this.op === 'update') {
      result = visible.filter(match);
      for (const r of result) Object.assign(r, norm(this.payload));
    } else {
      result = visible.filter(match);
      const gone = new Set(result);
      db.t[this.table] = rows.filter((r) => !gone.has(r));
      this.cascade(db, this.table, result.map((r) => r.id));
    }
    save(db);
    for (const [c, asc] of this.orders) result = [...result].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
    if (this.rng) result = result.slice(this.rng[0], this.rng[1] + 1);
    result = JSON.parse(JSON.stringify(result));
    if (this.one) {
      if (result.length === 0) return this.one === 'maybe' ? { data: null, error: null } : err('no rows', 'PGRST116', 406);
      return { data: result[0], error: null };
    }
    return { data: this.op === 'select' || this.returning ? result : null, error: null };
  }

  // Mirrors the database rules in supabase/schema.sql that the app relies on.
  check(db, row, me) {
    const own = (t, id) => (db.t[t] || []).find((r) => r.id === id && r.user_id === me);
    if (this.table === 'invoices' && !own('clients', row.client_id)) return err('foreign key', '23503');
    if (this.table === 'payments') {
      const inv = own('invoices', row.invoice_id);
      if (!inv) return err('foreign key', '23503');
      const paid = (db.t.payments || []).filter((p) => p.invoice_id === inv.id).reduce((s, p) => s + Math.round(p.amount * 100), 0);
      if (paid + Math.round(row.amount * 100) > Math.round(inv.amount * 100)) {
        return err(`Only ${((Math.round(inv.amount * 100) - paid) / 100).toFixed(2)} is still owed on this entry. Enter that amount or less.`, 'P0001');
      }
    }
    if (this.table === 'budgets') {
      const sum = ['mandatory', 'savings', 'investment', 'entertainment', 'other'].reduce((s, c) => s + Number(row[c] || 0), 0);
      if (sum > Number(row.income)) return err('check', '23514');
    }
    return null;
  }

  cascade(db, table, ids) {
    const links = { clients: ['invoices', 'client_id'], invoices: ['payments', 'invoice_id'] };
    if (!links[table] || !ids.length) return;
    const [child, col] = links[table];
    const gone = (db.t[child] || []).filter((r) => ids.includes(r[col]));
    db.t[child] = (db.t[child] || []).filter((r) => !ids.includes(r[col]));
    this.cascade(db, child, gone.map((r) => r.id));
  }
}

export function createClient() {
  const client = {
    from: (table) => new Query(client, table),
    async rpc(name) {
      const db = load();
      const me = db.session?.user?.id;
      if (name !== 'delete_my_account' || !me) return err('denied', '42501', 403);
      db.users = db.users.filter((u) => u.id !== me);
      for (const t of Object.keys(db.t)) db.t[t] = db.t[t].filter((r) => (t === 'profiles' ? r.id : r.user_id) !== me);
      save(db);
      return { data: null, error: null };
    },
    auth: {
      async getSession() { return { data: { session: load().session }, error: null }; },
      async signUp({ email, password, options }) {
        const db = load();
        if (db.users.some((u) => u.email === email)) return err('User already registered', 'user_already_exists', 422);
        const user = { id: crypto.randomUUID(), email, password, confirmed: false };
        db.users.push(user);
        (db.t.profiles ||= []).push({ id: user.id, name: options?.data?.name || '', app_mode: null, country: null, currency: null, strict_stop: false });
        save(db);
        return { data: { user: { id: user.id, email }, session: null }, error: null };
      },
      async signInWithPassword({ email, password }) {
        const db = load();
        const u = db.users.find((x) => x.email === email && x.password === password);
        if (!u) return err('Invalid login credentials', 'invalid_credentials', 400);
        if (!u.confirmed) return err('Email not confirmed', 'email_not_confirmed', 400);
        db.session = { user: { id: u.id, email } };
        save(db);
        return { data: { session: db.session }, error: null };
      },
      async verifyOtp({ email, token }) {
        const db = load();
        const u = db.users.find((x) => x.email === email);
        if (!u || token !== CODE) return err('Token has expired or is invalid', 'otp_expired', 403);
        u.confirmed = true;
        db.session = { user: { id: u.id, email } };
        save(db);
        return { data: { session: db.session }, error: null };
      },
      async resend() { return { data: {}, error: null }; },
      async resetPasswordForEmail() { return { data: {}, error: null }; },
      async updateUser({ password }) {
        const db = load();
        const u = db.users.find((x) => x.id === db.session?.user?.id);
        if (!u) return err('not signed in', '', 401);
        u.password = password;
        save(db);
        return { data: { user: { id: u.id } }, error: null };
      },
      async signOut({ scope } = {}) {
        if (scope === 'others') return { error: null };
        const db = load();
        db.session = null;
        save(db);
        return { error: null };
      },
    },
  };
  return client;
}
