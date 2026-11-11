// End-to-end API checks. Run against a throwaway database:
//   php -S 127.0.0.1:8080 -t .   then   node tests/api.test.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8080/api/index.php';
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

function client() {
  let cookie = '', csrf = '';
  const call = async (method, path, body, opts = {}) => {
    const headers = { 'X-Requested-With': 'creditflow', ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (csrf && !opts.noCsrf) headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) headers['Content-Type'] = opts.type || 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await r.json().catch(() => ({}));
    if (data.user?.csrf) csrf = data.user.csrf;
    return { status: r.status, data, headers: r.headers, setCookie: set };
  };
  return { call, drop: () => { cookie = ''; csrf = ''; }, get cookie() { return cookie; } };
}

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const uniq = Date.now();
const A = client(), B = client();
let r;

// ---- sign-up and sign-in ----
r = await A.call('POST', '/auth/register', { email: `a${uniq}@example.com`, password: 'short', name: 'Aisha' });
ok(r.status === 422, 'weak password is rejected');
r = await A.call('POST', '/auth/register', { email: `a${uniq}@example.com`, password: 'correct horse 1', name: 'Aisha' });
ok(r.status === 200 && r.data.user.email === `a${uniq}@example.com`, 'sign-up works', JSON.stringify(r.data));
ok(/HttpOnly/i.test(r.setCookie) && /SameSite=Strict/i.test(r.setCookie), 'session cookie is HttpOnly and SameSite=Strict', r.setCookie);
ok(!JSON.stringify(r.data).includes('password'), 'password hash never leaves the server');
r = await B.call('POST', '/auth/register', { email: `a${uniq}@example.com`, password: 'correct horse 1', name: 'Copy' });
ok(r.status === 409, 'duplicate email is rejected');
r = await B.call('POST', '/auth/register', { email: `b${uniq}@example.com`, password: 'another pass 22', name: 'Bilal' });
ok(r.status === 200, 'second user signs up');
r = await client().call('GET', '/auth/me');
ok(r.status === 401, 'signed-out visitor gets 401');
r = await client().call('POST', '/auth/login', { email: `a${uniq}@example.com`, password: 'correct horse 1' }, { headers: { 'X-Requested-With': '' } });
ok(r.status === 403, 'sign-in without the app header is blocked');
r = await A.call('PATCH', '/me', { app_mode: 'both', country: 'PK', currency: 'PKR' }, { noCsrf: true });
ok(r.status === 403, 'change without CSRF token is blocked');
r = await A.call('PATCH', '/me', { app_mode: 'both' }, { type: 'text/plain' });
ok(r.status === 415, 'non-JSON body is rejected');
r = await A.call('GET', '/clients');
ok(r.status === 403, 'portal routes are closed before a portal is chosen');
r = await A.call('PATCH', '/me', { app_mode: 'both', country: 'PK', currency: 'PKR' });
ok(r.status === 200 && r.data.user.currency === 'PKR', 'profile saved');
await B.call('PATCH', '/me', { app_mode: 'both', country: 'US', currency: 'USD' });
r = await A.call('PATCH', '/me', { country: "P'" });
ok(r.status === 422, 'bad country is rejected');

// ---- business ----
r = await A.call('POST', '/clients', { name: 'Ahmed Traders', phone: '0300', credit_limit: 50000 });
ok(r.status === 200 && r.data.client.owed === 0, 'client created');
const clientId = r.data.client.id;
r = await A.call('POST', '/clients', { name: '' });
ok(r.status === 422, 'client needs a name');
r = await A.call('POST', '/invoices', { client_id: clientId, amount: 30000, invoice_date: today, due_date: today });
ok(r.status === 200 && r.data.invoice.remaining === 30000 && r.data.invoice.number === 'CR-0001', 'credit entry created', JSON.stringify(r.data));
const invId = r.data.invoice.id;
r = await A.call('POST', '/invoices', { client_id: clientId, amount: 25000, invoice_date: today });
ok(r.status === 409 && r.data.red_lines?.[0]?.code === 'credit_limit' && r.data.red_lines[0].over_by === 5000, 'credit limit stops a new entry', JSON.stringify(r.data));
r = await A.call('POST', '/invoices', { client_id: clientId, amount: 25000, invoice_date: today, override: true });
ok(r.status === 200, 'credit limit can be overridden on purpose');
const inv2 = r.data.invoice.id;
r = await A.call('POST', '/payments', { invoice_id: invId, amount: 30000.01, method: 'cash', payment_date: today });
ok(r.status === 422, 'payment above what is owed is rejected');
r = await A.call('POST', '/payments', { invoice_id: invId, amount: 10000.50, method: 'cash', payment_date: today });
ok(r.status === 200 && r.data.invoice.remaining === 19999.5 && r.data.invoice.status === 'partial', 'part payment recorded', JSON.stringify(r.data));
r = await A.call('POST', '/payments', { invoice_id: invId, amount: -5, method: 'cash', payment_date: today });
ok(r.status === 422, 'negative amount is rejected');
r = await A.call('POST', '/payments', { invoice_id: invId, amount: '1e3', method: 'cash', payment_date: today });
ok(r.status === 422, 'odd number formats are rejected');
r = await A.call('GET', '/business/summary');
ok(r.status === 200 && r.data.outstanding === 44999.5 && r.data.collected_this_month === 10000.5, 'business totals add up', JSON.stringify(r.data).slice(0, 200));
r = await A.call('GET', '/clients');
ok(r.data.clients[0].owed === 44999.5 && r.data.clients[0].open_count === 2, 'client balance is right', JSON.stringify(r.data.clients[0]));

// ---- privacy between users ----
r = await B.call('GET', '/clients');
ok(r.status === 200 && r.data.clients.length === 0, 'user B sees none of user A\'s clients');
r = await B.call('GET', '/invoices');
ok(r.data.invoices.length === 0, 'user B sees none of user A\'s credit entries');
r = await B.call('GET', `/invoices?client_id=${clientId}`);
ok(r.data.invoices.length === 0, 'user B cannot list A\'s entries by client id');
r = await B.call('POST', '/payments', { invoice_id: invId, amount: 1, method: 'cash', payment_date: today });
ok(r.status === 404, 'user B cannot pay against A\'s entry');
r = await B.call('POST', '/invoices', { client_id: clientId, amount: 1, invoice_date: today });
ok(r.status === 404, 'user B cannot add credit to A\'s client');
r = await B.call('PATCH', `/clients/${clientId}`, { name: 'Hacked' });
ok(r.status === 404, 'user B cannot rename A\'s client');
r = await B.call('DELETE', `/clients/${clientId}`);
ok(r.status === 404, 'user B cannot delete A\'s client');
r = await B.call('DELETE', `/invoices/${inv2}`);
ok(r.status === 404, 'user B cannot delete A\'s credit entry');
r = await A.call('GET', '/clients');
ok(r.data.clients[0].name === 'Ahmed Traders', 'A\'s client is unchanged');

// ---- personal ----
r = await A.call('PUT', '/budget', { month, income: 100000, mandatory: 40000, savings: 20000, investment: 10000, entertainment: 10000, other: 30000 });
ok(r.status === 422, 'plan above income is rejected');
r = await A.call('PUT', '/budget', { month, income: 100000, mandatory: 40000, savings: 20000, investment: 10000, entertainment: 10000, other: 15000 });
ok(r.status === 200 && r.data.budget.income === 100000, 'monthly plan saved', JSON.stringify(r.data));
r = await A.call('POST', '/entries', { category: 'mandatory', amount: 38000, entry_date: today, note: 'Rent' });
ok(r.status === 200, 'entry within limits is saved');
r = await A.call('POST', '/entries', { category: 'entertainment', amount: 9000, entry_date: today });
ok(r.status === 200, 'second entry saved');
r = await A.call('POST', '/entries', { category: 'entertainment', amount: 1500, entry_date: today });
ok(r.status === 409 && r.data.red_lines.some(l => l.code === 'category_limit' && l.over_by === 500) && r.data.can_override === true, 'category limit stops the entry', JSON.stringify(r.data));
r = await A.call('GET', `/personal/summary?month=${month}`);
ok(r.data.categories.entertainment.spent === 9000, 'stopped entry was not saved');
r = await A.call('POST', '/entries', { category: 'entertainment', amount: 1500, entry_date: today, override: true });
ok(r.status === 200, 'user can choose to save anyway');
r = await A.call('POST', '/entries', { category: 'other', amount: 22000, entry_date: today });
ok(r.status === 409 && r.data.red_lines.some(l => l.code === 'eats_savings'), 'spending into planned savings is stopped', JSON.stringify(r.data));
r = await A.call('POST', '/entries', { category: 'other', amount: 60000, entry_date: today });
ok(r.status === 409 && r.data.red_lines.some(l => l.code === 'over_income'), 'spending above income is stopped', JSON.stringify(r.data));
r = await A.call('POST', '/entries', { category: 'return', amount: 5000, entry_date: today, note: 'Dividend' });
ok(r.status === 200, 'investment return saved');
await A.call('PATCH', '/me', { strict_stop: true });
r = await A.call('POST', '/entries', { category: 'other', amount: 90000, entry_date: today, override: true });
ok(r.status === 409 && r.data.can_override === false, 'strict mode blocks even with override', JSON.stringify(r.data));
r = await A.call('GET', `/personal/summary?month=${month}`);
const s = r.data;
ok(s.money_in === 105000 && s.spent === 48500 && s.left === 56500, 'personal totals add up', JSON.stringify({ in: s.money_in, spent: s.spent, left: s.left }));
ok(s.entries.some(e => e.overridden) && typeof s.forecast.safe_daily === 'number' && ['ok', 'watch', 'danger'].includes(s.forecast.level), 'summary has forecast and marks overridden entries', JSON.stringify(s.forecast));
r = await B.call('GET', `/personal/summary?month=${month}`);
ok(r.data.entries.length === 0 && r.data.budget === null, 'user B sees none of A\'s personal data');
r = await B.call('DELETE', `/entries/${s.entries[0].id}`);
ok(r.status === 404, 'user B cannot delete A\'s entry');
r = await A.call('GET', "/personal/summary?month=2026-13");
ok(r.status === 422, 'bad month is rejected');

// ---- single-portal accounts ----
await B.call('PATCH', '/me', { app_mode: 'personal' });
r = await B.call('GET', '/clients');
ok(r.status === 403, 'personal-only account cannot open business routes');

// ---- account controls ----
r = await A.call('GET', '/me/export');
ok(r.status === 200 && r.data.clients.length === 1 && r.data.personal_entries.length === 4 && !JSON.stringify(r.data).includes('password_hash'), 'data export holds the user\'s records only', JSON.stringify(Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, Array.isArray(v) ? v.length : '-']))));
ok(r.headers.get('cache-control') === 'no-store' && r.headers.get('x-content-type-options') === 'nosniff', 'responses carry no-store and nosniff headers');
const A2 = client();
await A2.call('POST', '/auth/login', { email: `a${uniq}@example.com`, password: 'correct horse 1' });
r = await A.call('POST', '/me/password', { current: 'wrong', new: 'brand new pass 9' });
ok(r.status === 403, 'password change needs the current password');
r = await A.call('POST', '/me/password', { current: 'correct horse 1', new: 'brand new pass 9' });
ok(r.status === 200, 'password changed');
r = await A2.call('GET', '/auth/me');
ok(r.status === 401, 'other devices are signed out after a password change');
const oldCookie = A.cookie;
await A.call('POST', '/auth/logout', {});
r = await fetch(BASE + '/auth/me', { headers: { Cookie: oldCookie } });
ok(r.status === 401, 'signed-out session token no longer works');

// ---- lockout ----
const L = client();
for (let i = 0; i < 5; i++) await L.call('POST', '/auth/login', { email: `b${uniq}@example.com`, password: 'nope nope nope' });
r = await L.call('POST', '/auth/login', { email: `b${uniq}@example.com`, password: 'another pass 22' });
ok(r.status === 429, 'five wrong passwords lock sign-in for that email');
r = await L.call('POST', '/auth/login', { email: `x' OR '1'='1`, password: 'x' });
ok(r.status === 422, 'injection-style email is rejected');

// ---- account deletion ----
r = await B.call('POST', '/me/delete', { password: 'wrong' });
ok(r.status === 403, 'account deletion needs the password');
r = await B.call('POST', '/me/delete', { password: 'another pass 22' });
ok(r.status === 200, 'account deleted');
r = await B.call('GET', '/auth/me');
ok(r.status === 401, 'deleted account is signed out');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
