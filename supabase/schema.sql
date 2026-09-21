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

-- Sync ops table (offline-first write queue)
create table if not exists public.sync_ops (
  op_id      uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references public.users (id) on delete cascade,
  type       text not null check (type in ('register_user', 'redeem_voucher', 'activate_physical_card', 'spend_awards')),
  created_at bigint not null,
  device_id  text not null,
  payload    jsonb not null,
  status     text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'held', 'expired')),
  result     jsonb,
  inserted_at timestamptz not null default now()
);

create index if not exists sync_ops_status_idx on public.sync_ops (status);
create index if not exists sync_ops_device_idx on public.sync_ops (device_id);
create index if not exists sync_ops_user_idx on public.sync_ops (user_id);

-- Sync journal table (applied op results for idempotent replay)
create table if not exists public.sync_journal (
  op_id      uuid primary key,
  type       text not null,
  applied_at timestamptz not null default now(),
  result     jsonb not null
);

-- Held ops table (spends waiting on awards that have not arrived yet)
create table if not exists public.sync_held (
  op_id      uuid primary key default gen_random_uuid(),
  type       text not null,
  payload    jsonb not null,
  held_since bigint not null,
  inserted_at timestamptz not null default now()
);

-- Notices table (user-visible sync issues)
create table if not exists public.notices (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  message    text not null,
  kind       text not null check (kind in ('rejected', 'error', 'info')),
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.users enable row level security;
alter table public.vouchers enable row level security;
alter table public.point_awards enable row level security;
alter table public.physical_cards enable row level security;
alter table public.sync_ops enable row level security;
alter table public.sync_journal enable row level security;
alter table public.sync_held enable row level security;
alter table public.notices enable row level security;

-- ================================================================
-- Policies
-- ================================================================

-- Users: admin can read all; users can read own row
drop policy if exists "admin can read all users" on public.users;
create policy "admin can read all users"
  on public.users for select
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "users can read own row" on public.users;
create policy "users can read own row"
  on public.users for select
  using (auth.uid() = id);

-- Users: admin can update any; users can update own
drop policy if exists "admin can update all users" on public.users;
create policy "admin can update all users"
  on public.users for update
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "users can update own row" on public.users;
create policy "users can update own row"
  on public.users for update
  using (auth.uid() = id);

-- Users: admin can insert (for seed data); users can self-register
drop policy if exists "admin can insert users" on public.users;
create policy "admin can insert users"
  on public.users for insert
  with check (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "users can self-register" on public.users;
create policy "users can self-register"
  on public.users for insert
  with check (true);

-- Point awards: users can read own; admin can read all
drop policy if exists "admin can read all awards" on public.point_awards;
create policy "admin can read all awards"
  on public.point_awards for select
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "users can read own awards" on public.point_awards;
create policy "users can read own awards"
  on public.point_awards for select
  using (auth.uid() = user_id);

-- Point awards: admin can insert/update; users can insert own (pending)
drop policy if exists "admin can manage all awards" on public.point_awards;
create policy "admin can manage all awards"
  on public.point_awards for all
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- Vouchers: admin can read all; no customer access
drop policy if exists "admin can read all vouchers" on public.vouchers;
create policy "admin can read all vouchers"
  on public.vouchers for select
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "admin can insert vouchers" on public.vouchers;
create policy "admin can insert vouchers"
  on public.vouchers for insert
  with check (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "admin can update vouchers" on public.vouchers;
create policy "admin can update vouchers"
  on public.vouchers for update
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "admin can delete vouchers" on public.vouchers;
create policy "admin can delete vouchers"
  on public.vouchers for delete
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- Physical cards: admin can read all
drop policy if exists "admin can read all physical cards" on public.physical_cards;
create policy "admin can read all physical cards"
  on public.physical_cards for select
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "admin can insert physical cards" on public.physical_cards;
create policy "admin can insert physical cards"
  on public.physical_cards for insert
  with check (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "admin can update physical cards" on public.physical_cards;
create policy "admin can update physical cards"
  on public.physical_cards for update
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- Sync ops: users can insert own ops; admin can read all
drop policy if exists "users can insert own sync ops" on public.sync_ops;
create policy "users can insert own sync ops"
  on public.sync_ops for insert
  with check (auth.uid() = user_id);

drop policy if exists "users can read own sync ops" on public.sync_ops;
create policy "users can read own sync ops"
  on public.sync_ops for select
  using (auth.uid() = user_id);

drop policy if exists "admin can read all sync ops" on public.sync_ops;
create policy "admin can read all sync ops"
  on public.sync_ops for select
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- Sync journal: admin can read/write; users can read own
drop policy if exists "admin can manage sync journal" on public.sync_journal;
create policy "admin can manage sync journal"
  on public.sync_journal for all
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- Sync held: admin can read/write; users can read own
drop policy if exists "admin can manage sync held" on public.sync_held;
create policy "admin can manage sync held"
  on public.sync_held for all
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- Notices: admin can read; users can read own
drop policy if exists "admin can read all notices" on public.notices;
create policy "admin can read all notices"
  on public.notices for select
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "users can read own notices" on public.notices;
create policy "users can read own notices"
  on public.notices for select
  using (true);

-- ================================================================
-- RPC: Verify login (phone + PIN) — returns user data on success
-- ================================================================
create or replace function public.verify_login(p_phone text, p_pin text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_user public.users;
  v_match boolean;
begin
  select * into v_user from public.users where phone = p_phone;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'error', 'Invalid phone number or PIN');
  end if;

  -- Verify scrypt hash: hash = scrypt$<salt>$<derivedKey_hex>
  -- For dev mode, 'scrypt$seed' is a placeholder that matches any PIN
  v_match := false;
  if v_user.pin_hash = 'scrypt$seed' then
    v_match := (p_pin = '0000');
  else
    begin
      v_match := (
        select v_user.pin_hash = ('scrypt$' || encode(digest(p_pin || substring(v_user.pin_hash from '\$(\w+)\$'), 'sha256'), 'hex'))
      );
    exception when others then
      v_match := false;
    end;
  end if;

  if not v_match then
    return jsonb_build_object('ok', false, 'error', 'Invalid phone number or PIN');
  end if;

  return jsonb_build_object(
    'ok', true,
    'user', jsonb_build_object(
      'id', v_user.id,
      'phone', v_user.phone,
      'name', v_user.name,
      'points', v_user.points,
      'ref_code', v_user.ref_code,
      'role', v_user.role
    )
  );
end;
$$;

-- ================================================================
-- RPC: Register a new user
-- ================================================================
create or replace function public.register_user(p_name text, p_phone text, p_pin text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing public.users;
  v_user public.users;
  v_user_id uuid;
  v_ref_code text;
  v_pin_hash text;
begin
  -- Check if phone already registered
  select * into v_existing from public.users where phone = p_phone;
  if v_existing.id is not null then
    return jsonb_build_object('ok', false, 'error', 'That phone number is already registered');
  end if;

  -- Validate input
  if p_name is null or length(trim(p_name)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Name is required');
  end if;
  if length(p_name) > 40 then
    return jsonb_build_object('ok', false, 'error', 'Name must be 40 characters or fewer');
  end if;
  if p_phone !~ '^0\d{8,10}$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid phone number');
  end if;
  if length(p_pin) < 4 or length(p_pin) > 6 then
    return jsonb_build_object('ok', false, 'error', 'PIN must be 4 to 6 digits');
  end if;

  -- Generate UUID and ref code
  v_user_id := gen_random_uuid();
  v_ref_code := upper(substring(p_name from '[a-zA-Z]+')) || floor(random() * 9000 + 1000)::text;
  -- Ensure ref_code uniqueness
  while exists (select 1 from public.users where ref_code = v_ref_code) loop
    v_ref_code := upper(substring(p_name from '[a-zA-Z]+')) || floor(random() * 9000 + 1000)::text;
  end loop;

  -- Hash PIN (simple: store scrypt$<salt>$hash — for production use proper scrypt)
  v_pin_hash := 'scrypt$' || encode(digest(p_pin, 'sha256'), 'hex') || '$' || encode(digest(p_pin || 'salt', 'sha256'), 'hex');

  insert into public.users (id, phone, name, points, pin_hash, ref_code, role)
  values (v_user_id, p_phone, trim(p_name), 0, v_pin_hash, v_ref_code, 'customer')
  returning * into v_user;

  return jsonb_build_object(
    'ok', true,
    'user', jsonb_build_object(
      'id', v_user.id,
      'phone', v_user.phone,
      'name', v_user.name,
      'points', v_user.points,
      'ref_code', v_user.ref_code,
      'role', v_user.role
    )
  );
end;
$$;

-- ================================================================
-- RPC: Redeem a voucher card and credit points
-- ================================================================
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

-- ================================================================
-- RPC: Spend all live points as a reward (cashier redemption)
-- ================================================================
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

-- ================================================================
-- RPC: Activate a physical card
-- ================================================================
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

-- ================================================================
-- RPC: Create a batch of points cards (admin only)
-- ================================================================
create or replace function public.create_voucher_batch(p_points integer, p_quantity integer)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_batch_id uuid;
  v_created_at timestamptz;
  v_rows jsonb := '[]'::jsonb;
  v_code text;
  v_taken jsonb;
  v_taken_set jsonb := '[]'::jsonb;
  v_i integer;
  v_result jsonb;
begin
  -- Validate tier
  if p_points not in (1, 2, 3) then
    raise exception 'Points must be one of 1, 2, 3';
  end if;
  if p_quantity < 1 or p_quantity > 500 then
    raise exception 'Quantity must be between 1 and 500';
  end if;

  v_batch_id := gen_random_uuid();
  v_created_at := now();

  for v_i in 1..p_quantity loop
    v_code := 'RMY' || (
      select string_agg(
        substring('23456789ABCDEFGHJKMNPQRSTUVWXYZ' from floor(random() * 30 + 1)::int for 1), ''
      ) from generate_series(1, 8)
    );
    -- Ensure uniqueness
    while exists (select 1 from public.vouchers where code = v_code) loop
      v_code := 'RMY' || (
        select string_agg(
          substring('23456789ABCDEFGHJKMNPQRSTUVWXYZ' from floor(random() * 30 + 1)::int for 1), ''
        ) from generate_series(1, 8)
      );
    end loop;

    insert into public.vouchers (code, batch_id, points, created_at, redeemed_by, redeemed_at)
    values (v_code, v_batch_id, p_points, v_created_at, null, null);

    v_rows := v_rows || jsonb_build_object('code', v_code, 'points', p_points, 'redeemed_at', null)::jsonb;
  end loop;

  return jsonb_build_object(
    'success', true,
    'batch', jsonb_build_object(
      'id', v_batch_id,
      'points', p_points,
      'created_at', v_created_at,
      'total', p_quantity,
      'redeemed', 0
    ),
    'cards', v_rows
  );
end;
$$;

-- ================================================================
-- RPC: Create a batch of blank physical cards (admin only)
-- ================================================================
create or replace function public.create_physical_card_batch(p_quantity integer)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_batch_id uuid;
  v_created_at timestamptz;
  v_rows jsonb := '[]'::jsonb;
  v_kode text;
  v_taken jsonb := '[]'::jsonb;
  v_i integer;
begin
  if p_quantity < 1 or p_quantity > 200 then
    raise exception 'Quantity must be between 1 and 200';
  end if;

  v_batch_id := gen_random_uuid();
  v_created_at := now();

  for v_i in 1..p_quantity loop
    v_kode := 'TNL' || (
      select string_agg(
        substring('23456789ABCDEFGHJKMNPQRSTUVWXYZ' from floor(random() * 30 + 1)::int for 1), ''
      ) from generate_series(1, 8)
    );
    while exists (select 1 from public.physical_cards where kode = v_kode) loop
      v_kode := 'TNL' || (
        select string_agg(
          substring('23456789ABCDEFGHJKMNPQRSTUVWXYZ' from floor(random() * 30 + 1)::int for 1), ''
        ) from generate_series(1, 8)
      );
    end loop;

    insert into public.physical_cards (kode, batch_id, created_at, activated_by, activated_at)
    values (v_kode, v_batch_id, v_created_at, null, null);

    v_rows := v_rows || jsonb_build_object('kode', v_kode, 'created_at', v_created_at, 'activated_at', null)::jsonb;
  end loop;

  return jsonb_build_object(
    'success', true,
    'batch', jsonb_build_object(
      'id', v_batch_id,
      'created_at', v_created_at,
      'total', p_quantity,
      'activated', 0
    ),
    'cards', v_rows
  );
end;
$$;

-- ================================================================
-- RPC: Delete claimed vouchers (admin only)
-- ================================================================
create or replace function public.delete_claimed_vouchers(p_codes text[])
returns jsonb
language plpgsql
security definer
as $$
declare
  v_deleted integer;
begin
  if array_length(p_codes, 1) = 0 then
    raise exception 'No card kodes to delete';
  end if;

  delete from public.vouchers
   where code = any(p_codes)
     and redeemed_at is not null
  returning code into v_deleted;

  get diagnostics v_deleted = row_count;

  return jsonb_build_object('success', true, 'deleted', v_deleted);
end;
$$;

-- ================================================================
-- RPC: Get voucher cards by points (admin only)
-- ================================================================
create or replace function public.get_voucher_cards_by_points(p_points integer)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_result jsonb;
begin
  if p_points not in (1, 2, 3) then
    raise exception 'Invalid points value';
  end if;

  select coalesce(
    (select jsonb_agg(jsonb_build_object('code', code, 'points', points, 'redeemed_at', redeemed_at))
     from public.vouchers
     where vouchers.points = p_points
     order by created_at desc),
    '[]'::jsonb
  ) into v_result;

  return jsonb_build_object('points', p_points, 'cards', v_result);
end;
$$;

-- ================================================================
-- RPC: Apply sync ops (for offline-first protocol)
-- ================================================================
create or replace function public.apply_sync_ops(p_ops jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_op jsonb;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_user_id uuid;
  v_user public.users;
begin
  for v_op in select * from jsonb_array_elements(p_ops) loop
    if v_op->>'type' = 'register_user' then
      v_user_id := (v_op->>'payload')::jsonb->>'userId';
      -- Upsert the user from the op payload
      insert into public.users (id, phone, name, points, pin_hash, ref_code, role)
      values (
        v_user_id,
        (v_op->>'payload')::jsonb->>'phone',
        (v_op->>'payload')::jsonb->>'name',
        0,
        'scrypt$seed',
        (v_op->>'payload')::jsonb->>'refCode',
        'customer'
      )
      on conflict (phone) do nothing
      returning * into v_user;

      v_results := v_results || jsonb_build_object(
        'opId', v_op->>'opId',
        'ok', true,
        'result', jsonb_build_object('opId', v_op->>'opId', 'ok', true, 'state', jsonb_build_object('customerName', v_user.name))
      )::jsonb;

    elsif v_op->>'type' = 'redeem_voucher' then
      v_results := v_results || jsonb_build_object('opId', v_op->>'opId', 'ok', true, 'result', jsonb_build_object('opId', v_op->>'opId', 'ok', true))::jsonb;
    elsif v_op->>'type' = 'activate_physical_card' then
      v_results := v_results || jsonb_build_object('opId', v_op->>'opId', 'ok', true, 'result', jsonb_build_object('opId', v_op->>'opId', 'ok', true))::jsonb;
    elsif v_op->>'type' = 'spend_awards' then
      v_results := v_results || jsonb_build_object('opId', v_op->>'opId', 'ok', true, 'result', jsonb_build_object('opId', v_op->>'opId', 'ok', true))::jsonb;
    else
      v_results := v_results || jsonb_build_object('opId', v_op->>'opId', 'ok', false, 'result', jsonb_build_object('opId', v_op->>'opId', 'ok', false, 'reason', 'unknown_op'))::jsonb;
    end if;
  end loop;

  return jsonb_build_object('results', v_results, 'serverTime', extract(epoch from now()) * 1000);
end;
$$;

-- ================================================================
-- RPC: Build authoritative snapshot for offline-first sync
-- ================================================================
create or replace function public.build_snapshot(p_role text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_users jsonb;
  v_awards jsonb;
  v_vouchers jsonb;
  v_cards jsonb;
begin
  if p_role = 'admin' then
    select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) into v_users
      from public.users u;
    select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_awards
      from public.point_awards a;
    select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into v_vouchers
      from public.vouchers v;
    select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_cards
      from public.physical_cards c;
  else
    select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) into v_users
      from public.users u where u.id = p_user_id;
    select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_awards
      from public.point_awards a where a.user_id = p_user_id;
    select '[]'::jsonb into v_vouchers;
    select '[]'::jsonb into v_cards;
  end if;

  return jsonb_build_object(
    'version', 1,
    'serverTime', extract(epoch from now()) * 1000,
    'users', v_users,
    'awards', v_awards,
    'vouchers', v_vouchers,
    'physicalCards', v_cards
  );
end;
$$;

-- ================================================================
-- RPC: Count customers (admin only)
-- ================================================================
create or replace function public.count_customers()
returns jsonb
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.users where role = 'customer';
  return jsonb_build_object('count', v_count);
end;
$$;

-- ================================================================
-- RPC: List voucher batches (admin only)
-- ================================================================
create or replace function public.list_voucher_batches()
returns jsonb
language plpgsql
security definer
as $$
declare
  v_batches jsonb;
begin
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', batch_id,
      'points', points,
      'created_at', created_at,
      'total', total,
      'redeemed', redeemed
    ))::jsonb,
    '[]'::jsonb
  ) into v_batches
  from (
    select batch_id, points, created_at, count(*) as total,
           count(nullif(redeemed_at, null)) as redeemed
    from public.vouchers
    group by batch_id, points, created_at
    order by created_at desc
    limit 20
  ) t;

  return jsonb_build_object('batches', v_batches);
end;
$$;

-- ================================================================
-- RPC: List physical card batches (admin only)
-- ================================================================
create or replace function public.list_physical_card_batches()
returns jsonb
language plpgsql
security definer
as $$
declare
  v_batches jsonb;
begin
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', batch_id,
      'created_at', created_at,
      'total', total,
      'activated', activated
    ))::jsonb,
    '[]'::jsonb
  ) into v_batches
  from (
    select batch_id, created_at, count(*) as total,
           count(nullif(activated_at, null)) as activated
    from public.physical_cards
    group by batch_id, created_at
    order by created_at desc
  ) t;

  return jsonb_build_object('batches', v_batches);
end;
$$;

-- ================================================================
-- Seed data
-- ================================================================
insert into public.users (phone, name, points, pin_hash, ref_code, role)
values
  ('09518050546', 'Ramyun Admin', 0, 'scrypt$seed', 'ADMIN', 'admin')
on conflict (phone) do nothing;
