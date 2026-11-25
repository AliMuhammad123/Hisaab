-- CreditFlow database for Supabase.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run once on a new project.
--
-- Privacy model: the app talks to Supabase directly, so the database itself
-- enforces who sees what. Row Level Security is on for every table and each
-- policy only allows rows whose user_id is the signed-in user. Rows that point
-- at other rows (a payment to a credit entry, a credit entry to a customer)
-- use composite foreign keys that include user_id, so nobody can attach their
-- rows to someone else's.

-- ---------- profile ----------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  name         text not null default '' check (char_length(name) <= 80),
  app_mode     text check (app_mode in ('personal', 'business', 'both')),
  country      text check (country ~ '^[A-Z]{2}$'),
  currency     text check (currency ~ '^[A-Z]{3}$'),
  strict_stop  boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Creates the profile when someone signs up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'name', ''), 80));
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- business ----------

create table public.clients (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  phone         text not null default '' check (char_length(phone) <= 40),
  email         text not null default '' check (char_length(email) <= 190),
  notes         text not null default '' check (char_length(notes) <= 1000),
  credit_limit  numeric(14, 2) check (credit_limit > 0 and credit_limit <= 999999999.99),
  created_at    timestamptz not null default now(),
  unique (id, user_id)
);
create index clients_user on public.clients (user_id, name);

create table public.invoices (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id     bigint not null,
  number        text not null default '' check (char_length(number) <= 40),
  description   text not null default '' check (char_length(description) <= 500),
  amount        numeric(14, 2) not null check (amount > 0 and amount <= 999999999.99),
  invoice_date  date not null check (invoice_date between '2000-01-01' and '2100-12-31'),
  due_date      date check (due_date >= invoice_date and due_date <= '2100-12-31'),
  created_at    timestamptz not null default now(),
  unique (id, user_id),
  foreign key (client_id, user_id) references public.clients (id, user_id) on delete cascade
);
create index invoices_user on public.invoices (user_id, invoice_date);
create index invoices_client on public.invoices (client_id);

create table public.payments (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  invoice_id    bigint not null,
  amount        numeric(14, 2) not null check (amount > 0 and amount <= 999999999.99),
  method        text not null default 'cash' check (method in ('cash', 'bank', 'other')),
  payment_date  date not null check (payment_date between '2000-01-01' and '2100-12-31'),
  reference     text not null default '' check (char_length(reference) <= 120),
  created_at    timestamptz not null default now(),
  foreign key (invoice_id, user_id) references public.invoices (id, user_id) on delete cascade
);
create index payments_user on public.payments (user_id, payment_date);
create index payments_invoice on public.payments (invoice_id);

-- A payment can never take more than is still owed on its credit entry.
-- The credit entry row is locked first, so two payments saved at once are checked one after the other.
create function public.check_payment() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  owed numeric(14, 2);
  paid numeric(14, 2);
begin
  select amount into owed from public.invoices where id = new.invoice_id and user_id = new.user_id for update;
  if not found then
    raise exception 'Credit entry not found.' using errcode = 'P0002';
  end if;
  select coalesce(sum(amount), 0) into paid from public.payments
    where invoice_id = new.invoice_id and id is distinct from new.id;
  if paid + new.amount > owed then
    raise exception 'Only % is still owed on this entry. Enter that amount or less.', owed - paid using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger payments_not_over
  before insert or update on public.payments
  for each row execute function public.check_payment();

-- ---------- personal ----------

create table public.budgets (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  month          text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  income         numeric(14, 2) not null check (income > 0 and income <= 999999999.99),
  mandatory      numeric(14, 2) not null default 0 check (mandatory >= 0),
  savings        numeric(14, 2) not null default 0 check (savings >= 0),
  investment     numeric(14, 2) not null default 0 check (investment >= 0),
  entertainment  numeric(14, 2) not null default 0 check (entertainment >= 0),
  other          numeric(14, 2) not null default 0 check (other >= 0),
  unique (user_id, month),
  check (mandatory + savings + investment + entertainment + other <= income)
);

create table public.entries (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category    text not null check (category in ('mandatory', 'savings', 'investment', 'entertainment', 'other', 'return')),
  amount      numeric(14, 2) not null check (amount > 0 and amount <= 999999999.99),
  entry_date  date not null check (entry_date between '2000-01-01' and '2100-12-31'),
  note        text not null default '' check (char_length(note) <= 200),
  overridden  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index entries_user on public.entries (user_id, entry_date);

-- ---------- who can see what ----------

alter table public.profiles enable row level security;
alter table public.clients  enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.budgets  enable row level security;
alter table public.entries  enable row level security;

-- Signed-out visitors get nothing at all.
revoke all on public.profiles, public.clients, public.invoices, public.payments, public.budgets, public.entries from anon;

-- Profiles are created by the sign-up trigger and removed with the account,
-- so signed-in users may only read and update their own.
revoke insert, delete, truncate, references, trigger on public.profiles from authenticated;
create policy "own profile: read" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Every other table: full control over your own rows, nothing else.
create policy "own rows" on public.clients  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.invoices for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.payments for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.budgets  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.entries  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke truncate, references, trigger on public.clients, public.invoices, public.payments, public.budgets, public.entries from authenticated;

-- ---------- delete account ----------

-- Lets a signed-in user delete their own account. Every row they own goes with it (on delete cascade).
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Please sign in.' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

revoke all on function public.check_payment() from public, anon, authenticated;
