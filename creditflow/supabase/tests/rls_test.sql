-- Privacy and data-rule checks for schema.sql. Run with:
--   psql -v ON_ERROR_STOP=1 -f fake_supabase.sql -f ../schema.sql -f rls_test.sql
-- Each check raises an error if it fails; the script ends with "ALL CHECKS PASSED".

\set QUIET on
create temp table _ok (n int);
grant all on _ok to authenticated, anon;

create function pg_temp.expect(cond boolean, what text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'FAILED: %', what; end if;
  insert into _ok values (1);
end $$;
-- Runs a statement and passes only if it raises an error.
create function pg_temp.must_fail(stmt text, what text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    insert into _ok values (1);
    return;
  end;
  raise exception 'FAILED (no error): %', what;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- two users sign up
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com', '{"name":"Aisha"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.com', '{"name":"Bilal"}');
select pg_temp.expect((select count(*) from public.profiles) = 2, 'profiles are created on sign-up');
select pg_temp.expect((select name from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Aisha', 'name is copied');

-- ===== user A =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', false);

select pg_temp.expect((select count(*) from public.profiles) = 1, 'A sees only her own profile');
update public.profiles set app_mode = 'both', country = 'PK', currency = 'PKR';
select pg_temp.expect((select currency from public.profiles) = 'PKR', 'A can update her profile');
select pg_temp.must_fail($$update public.profiles set country = 'pk'$$, 'bad country code is refused');
select pg_temp.must_fail($$insert into public.profiles (id) values ('bbbbbbbb-0000-0000-0000-000000000002')$$, 'A cannot create profiles');
select pg_temp.must_fail($$delete from public.profiles$$, 'A cannot delete profiles directly');

insert into public.clients (name, credit_limit) values ('Ahmed Traders', 50000);
select pg_temp.expect((select user_id from public.clients) = 'aaaaaaaa-0000-0000-0000-000000000001', 'user_id fills in automatically');
select pg_temp.must_fail($$insert into public.clients (name) values ('   ')$$, 'client needs a name');
select pg_temp.must_fail($$insert into public.clients (name, credit_limit) values ('X', -5)$$, 'negative credit limit is refused');
select pg_temp.must_fail($$insert into public.clients (user_id, name) values ('bbbbbbbb-0000-0000-0000-000000000002', 'Planted')$$, 'A cannot create rows owned by B');

insert into public.invoices (client_id, amount, invoice_date, due_date)
  select id, 30000, '2026-11-01', '2026-11-10' from public.clients;
select pg_temp.must_fail($$insert into public.invoices (client_id, amount, invoice_date, due_date) select id, 1, '2026-11-10', '2026-11-01' from public.clients$$, 'due date before credit date is refused');
select pg_temp.must_fail($$insert into public.invoices (client_id, amount, invoice_date) select id, 0, '2026-11-10' from public.clients$$, 'zero amount is refused');
select pg_temp.must_fail($$insert into public.invoices (client_id, amount, invoice_date) select id, 1000000000, '2026-11-10' from public.clients$$, 'too large amount is refused');

insert into public.payments (invoice_id, amount, payment_date) select id, 10000.50, '2026-11-12' from public.invoices;
select pg_temp.must_fail($$insert into public.payments (invoice_id, amount, payment_date) select id, 20000, '2026-11-12' from public.invoices$$, 'payment above what is owed is refused');
insert into public.payments (invoice_id, amount, payment_date) select id, 19999.50, '2026-11-12' from public.invoices;
select pg_temp.expect((select sum(amount) from public.payments) = 30000, 'paying exactly the rest is allowed');
select pg_temp.must_fail($$update public.payments set amount = amount + 1$$, 'editing a payment above what is owed is refused');

insert into public.budgets (month, income, mandatory, savings) values ('2026-11', 100000, 40000, 20000);
select pg_temp.must_fail($$insert into public.budgets (month, income, mandatory) values ('2026-12', 100, 200)$$, 'plan above income is refused');
select pg_temp.must_fail($$insert into public.budgets (month, income) values ('2026-13', 100)$$, 'bad month is refused');
select pg_temp.must_fail($$insert into public.budgets (month, income) values ('2026-11', 5)$$, 'one plan per month');
insert into public.entries (category, amount, entry_date, note) values ('mandatory', 38000, '2026-11-05', 'Rent');
select pg_temp.must_fail($$insert into public.entries (category, amount, entry_date) values ('gambling', 1, '2026-11-05')$$, 'unknown category is refused');
select pg_temp.must_fail($$insert into public.entries (category, amount, entry_date, note) values ('other', 1, '2026-11-05', repeat('x', 201))$$, 'long note is refused');
select pg_temp.must_fail($$truncate public.entries$$, 'A cannot wipe a whole table');
reset role;

-- ===== user B tries to reach A's data =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', false);
select pg_temp.expect((select count(*) from public.clients) = 0, 'B sees none of A''s clients');
select pg_temp.expect((select count(*) from public.invoices) = 0, 'B sees none of A''s credit entries');
select pg_temp.expect((select count(*) from public.payments) = 0, 'B sees none of A''s payments');
select pg_temp.expect((select count(*) from public.budgets) = 0, 'B sees none of A''s plans');
select pg_temp.expect((select count(*) from public.entries) = 0, 'B sees none of A''s entries');
select pg_temp.expect((select count(*) from public.profiles) = 1, 'B sees only his own profile');
update public.clients set name = 'Hacked';
delete from public.entries;
delete from public.clients;
update public.profiles set name = 'Hacked' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
reset role;
select pg_temp.expect((select name from public.clients) = 'Ahmed Traders', 'B could not rename A''s client');
select pg_temp.expect((select count(*) from public.entries) = 1, 'B could not delete A''s entries');
select pg_temp.expect((select name from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Aisha', 'B could not change A''s profile');

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', false);
-- B guesses A's ids and tries to attach his own rows to them.
select pg_temp.must_fail($$insert into public.invoices (client_id, amount, invoice_date) values (1, 1, '2026-11-10')$$, 'B cannot add credit to A''s client');
select pg_temp.must_fail($$insert into public.payments (invoice_id, amount, payment_date) values (1, 1, '2026-11-10')$$, 'B cannot pay against A''s credit entry');
select pg_temp.must_fail($$insert into public.clients (id, name) overriding system value values (1, 'Clash')$$, 'B cannot take over an id');
reset role;

-- ===== signed-out visitor =====
set role anon;
select set_config('request.jwt.claims', '', false);
select pg_temp.must_fail($$select * from public.clients$$, 'signed-out visitor cannot read clients');
select pg_temp.must_fail($$select * from public.profiles$$, 'signed-out visitor cannot read profiles');
select pg_temp.must_fail($$insert into public.entries (category, amount, entry_date) values ('other', 1, '2026-11-05')$$, 'signed-out visitor cannot write');
select pg_temp.must_fail($$select public.delete_my_account()$$, 'signed-out visitor cannot call account deletion');
reset role;

-- ===== account deletion =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', false);
select public.delete_my_account();
reset role;
select pg_temp.expect((select count(*) from auth.users) = 1, 'B''s account is deleted');
select pg_temp.expect((select count(*) from public.clients) = 1, 'deleting B left A''s data alone');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', false);
select public.delete_my_account();
reset role;
select pg_temp.expect(
  (select count(*) from public.profiles) + (select count(*) from public.clients) + (select count(*) from public.invoices)
  + (select count(*) from public.payments) + (select count(*) from public.budgets) + (select count(*) from public.entries) = 0,
  'deleting A removed every row she owned');

\set QUIET off
select 'ALL CHECKS PASSED: ' || count(*) || ' checks' as result from _ok;
