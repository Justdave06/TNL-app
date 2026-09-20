-- TNL Rewards - Supabase Schema
-- Apply with: supabase db push  (or paste into Supabase SQL Editor)
-- Run from the server/ directory or copy to your Supabase project

-- Users table
create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  phone      text        not null unique,
  name       text        not null,
  points     integer     not null default 0 check (points >= 0),
  pin_hash   text        not null,
  ref_code   text        not null unique,
  role       text        not null default 'customer' check (role in ('customer', 'admin')),
  created_at timestamptz not null default now()
);

create index if not exists users_phone_idx on public.users (phone);

-- Point awards table (one row per grant of points)
create table if not exists public.point_awards (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references public.users (id) on delete cascade,
  points       integer     not null check (points > 0),
  awarded_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  source       text        not null check (source in ('voucher', 'manual')),
  voucher_code text,
  spent_at     timestamptz,
  check (expires_at > awarded_at)
);

create index if not exists point_awards_user_idx on public.point_awards (user_id, expires_at);

-- Vouchers table (printed reward cards)
create table if not exists public.vouchers (
  code        text        primary key,
  batch_id    uuid        not null,
  points      integer     not null check (points in (1, 2, 3)),
  created_at  timestamptz not null default now(),
  redeemed_by uuid        references public.users (id) on delete set null,
  redeemed_at timestamptz
);

create index if not exists vouchers_batch_idx on public.vouchers (batch_id);

-- Physical cards table (printed TNL cards)
create table if not exists public.physical_cards (
  kode        text        primary key,
  batch_id    uuid        not null,
  created_at  timestamptz not null default now(),
  activated_by uuid       references public.users (id) on delete set null,
  activated_at timestamptz
);

create index if not exists physical_cards_batch_idx on public.physical_cards (batch_id);

-- Enable RLS
alter table public.users enable row level security;
alter table public.vouchers enable row level security;
alter table public.point_awards enable row level security;
alter table public.physical_cards enable row level security;

-- Users can read their own row
drop policy if exists "users can read own row" on public.users;
create policy "users can read own row"
  on public.users for select
  using (auth.uid() = id);

-- Service role has full access (no policies needed for service role)

-- RPC: Claim a voucher card and credit points
create or replace function public.redeem_voucher_card(p_code text, p_user_id uuid)
returns table (points integer, new_balance integer, expires_at timestamptz)
language plpgsql
security definer
as $$
declare
  claimed public.vouchers;
  award public.point_awards;
  live_total integer;
  balance integer;
begin
  update public.vouchers
     set redeemed_by = p_user_id,
         redeemed_at = now()
   where code = p_code
     and redeemed_at is null
  returning * into claimed;

  if claimed.code is null then
    if exists (select 1 from public.vouchers where code = p_code) then
      raise exception 'already_redeemed' using errcode = 'P0001';
    end if;
    raise exception 'unknown_code' using errcode = 'P0001';
  end if;

  select coalesce(sum(points), 0) into live_total
    from public.point_awards
   where user_id = p_user_id
     and expires_at > now();

  if live_total + claimed.points > 50 then
    raise exception 'balance_cap' using errcode = 'P0001';
  end if;

  insert into public.point_awards (user_id, points, awarded_at, expires_at, source, voucher_code)
  values (p_user_id, claimed.points, now(), now() + interval '7 days', 'voucher', claimed.code)
  returning * into award;

  update public.users
     set points = live_total + claimed.points
   where id = p_user_id
  returning points into balance;

  if balance is null then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;

  return query select claimed.points, balance, award.expires_at;
end;
$$;

-- RPC: Spend all live points as a reward
create or replace function public.redeem_reward_points(p_user_id uuid, p_min_points integer)
returns table (remaining_points integer, points_spent integer, user_id uuid, customer_name text)
language plpgsql
security definer
as $$
begin
  select coalesce(sum(points), 0) into points_spent
    from public.point_awards
   where user_id = p_user_id
     and expires_at > now();

  if points_spent < p_min_points then
    raise exception 'insufficient_points' using errcode = 'P0001';
  end if;

  select u.name into customer_name
    from public.users u
   where u.id = p_user_id;

  if customer_name is null then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;

  delete from public.point_awards
   where user_id = p_user_id
     and expires_at > now();

  update public.users
     set points = 0
   where id = p_user_id;

  return query select 0, points_spent, p_user_id, customer_name;
end;
$$;

-- RPC: Activate a physical card
create or replace function public.activate_physical_card(p_kode text, p_user_id uuid)
returns timestamptz
language plpgsql
security definer
as $$
declare
  card public.physical_cards;
  user_exists boolean;
begin
  select exists (select 1 from public.users where id = p_user_id) into user_exists;
  if not user_exists then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;

  select * into card
    from public.physical_cards
   where kode = p_kode;

  if card.kode is null then
    raise exception 'unknown_kode' using errcode = 'P0001';
  end if;

  if card.activated_at is not null then
    raise exception 'already_activated' using errcode = 'P0001';
  end if;

  update public.physical_cards
     set activated_by = p_user_id,
         activated_at = now()
   where kode = p_kode
  returning activated_at into card.activated_at;

  return card.activated_at;
end;
$$;

-- Seed data
insert into public.users (phone, name, points, pin_hash, ref_code, role)
values
  ('09518050546', 'Ramyun Admin', 0, 'scrypt$seed', 'ADMIN', 'admin')
on conflict (phone) do nothing;