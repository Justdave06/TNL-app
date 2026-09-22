-- TNL Rewards - Supabase Schema
-- Apply with the Supabase SQL Editor (Dashboard > SQL Editor > New query > paste all > Run).
-- Idempotent: safe to re-run.

create extension if not exists pgcrypto;

-- ================================================================
-- Tables
-- ================================================================

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

-- ================================================================
-- Row Level Security
-- ================================================================
-- The app authenticates customers by phone + PIN (not Supabase Auth), so it
-- holds only the anon key and there is never an auth.uid() to evaluate RLS
-- policies against. RLS is therefore disabled so direct PostgREST reads and
-- writes used by the offline-first client are allowed. Business rules are
-- enforced inside the security-definer RPC functions below, not via RLS.

alter table public.users disable row level security;
alter table public.vouchers disable row level security;
alter table public.point_awards disable row level security;
alter table public.physical_cards disable row level security;
alter table public.sync_ops disable row level security;
alter table public.sync_journal disable row level security;
alter table public.sync_held disable row level security;
alter table public.notices disable row level security;

-- ================================================================
-- PIN hashing helper (pgcrypto bcrypt)
-- ================================================================
-- pin_hash is created by crypt(pin, gen_salt('bf')) and verified with
-- pin_hash = crypt(pin, pin_hash). The literal value 'scrypt$seed' is a
-- legacy placeholder that only ever matches PIN 0000 (seed admin + accounts
-- migrated from the old hash scheme, see the seed section below).

create or replace function public.scrypt_pin(p_pin text)
returns text
language sql
volatile
as $$
  select crypt(p_pin, gen_salt('bf'));
$$;

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

  -- Legacy seed placeholder: only matches PIN 0000.
  if v_user.pin_hash = 'scrypt$seed' then
    v_match := (p_pin = '0000');
  else
    v_match := (v_user.pin_hash = crypt(p_pin, v_user.pin_hash));
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

  v_pin_hash := public.scrypt_pin(p_pin);

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
#variable_conflict use_column
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
#variable_conflict use_column
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
  v_i integer;
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
    (select jsonb_agg(
              jsonb_build_object('code', code, 'points', points, 'redeemed_at', redeemed_at)
              order by created_at desc)
     from public.vouchers
     where vouchers.points = p_points),
    '[]'::jsonb
  ) into v_result;

  return jsonb_build_object('points', p_points, 'cards', v_result);
end;
$$;

-- ================================================================
-- RPC: Apply sync ops (offline-first protocol)
-- ================================================================
-- Applies each queued op authored on a device and returns per-op results in
-- the same order ({opId, ok, reason?, message?, state?}). Everything runs
-- inside one transaction, so a failure mid-loop rolls the whole batch back.
create or replace function public.apply_sync_ops(p_ops jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_op jsonb;
  v_payload jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_user public.users;
  v_user_id uuid;
  v_code text;
  v_kode text;
  v_award_id uuid;
  v_awarded_at double precision;
  v_claimed public.vouchers;
  v_card public.physical_cards;
  v_live_total integer;
  v_balance integer;
  v_spent integer;
  v_remaining integer;
  v_ids uuid[];
begin
  for v_op in select * from jsonb_array_elements(p_ops) loop
    v_result := null;
    begin
      v_payload := v_op->'payload';

      if v_op->>'type' = 'register_user' then
        v_user_id := (v_payload->>'userId')::uuid;
        v_user := null;
        insert into public.users (id, phone, name, points, pin_hash, ref_code, role)
        values (
          v_user_id,
          v_payload->>'phone',
          v_payload->>'name',
          0,
          public.scrypt_pin(v_payload->>'pin'),
          v_payload->>'refCode',
          'customer'
        )
        on conflict (phone) do nothing
        returning * into v_user;

        if v_user.id is null then
          v_result := jsonb_build_object(
            'ok', false,
            'reason', 'phone_taken',
            'message', 'That phone number is already registered'
          );
        else
          v_result := jsonb_build_object(
            'ok', true,
            'state', jsonb_build_object('customerName', v_user.name)
          );
        end if;

      elsif v_op->>'type' = 'redeem_voucher' then
        v_user_id := (v_payload->>'userId')::uuid;
        v_award_id := (v_payload->>'awardId')::uuid;
        v_code := v_payload->>'code';
        v_awarded_at := (v_payload->>'awardedAt')::double precision;

        -- Idempotent replay: the award row already exists for this op.
        if exists (select 1 from public.point_awards where id = v_award_id) then
          v_result := jsonb_build_object('ok', true, 'state', jsonb_build_object('alreadyApplied', true));
        else
          select * into v_claimed from public.vouchers where code = v_code;

          if v_claimed.code is null then
            v_result := jsonb_build_object(
              'ok', false,
              'reason', 'unknown_code',
              'message', 'That kode was not recognised'
            );
          elsif v_claimed.redeemed_at is not null then
            v_result := jsonb_build_object(
              'ok', false,
              'reason', 'already_redeemed',
              'message', 'That card has already been used'
            );
          else
            select coalesce(sum(points), 0) into v_live_total
              from public.point_awards
             where user_id = v_user_id
               and expires_at > now();

            if v_live_total + v_claimed.points > 50 then
              v_result := jsonb_build_object(
                'ok', false,
                'reason', 'balance_cap',
                'message', 'Points balance cap of 50 reached'
              );
            else
              update public.vouchers
                 set redeemed_by = v_user_id,
                     redeemed_at = now()
               where code = v_code;

              insert into public.point_awards
                (id, user_id, points, awarded_at, expires_at, source, voucher_code)
              values (
                v_award_id,
                v_user_id,
                v_claimed.points,
                to_timestamp(v_awarded_at / 1000.0),
                to_timestamp(v_awarded_at / 1000.0) + interval '7 days',
                'voucher',
                v_code
              );

              update public.users
                 set points = v_live_total + v_claimed.points
               where id = v_user_id
              returning points into v_balance;

              v_result := jsonb_build_object(
                'ok', true,
                'state', jsonb_build_object('remainingBalance', v_balance)
              );
            end if;
          end if;
        end if;

      elsif v_op->>'type' = 'activate_physical_card' then
        v_user_id := (v_payload->>'userId')::uuid;
        v_kode := v_payload->>'kode';

        if not exists (select 1 from public.users where id = v_user_id) then
          v_result := jsonb_build_object(
            'ok', false,
            'reason', 'user_not_found',
            'message', 'Account not found'
          );
        else
          select * into v_card from public.physical_cards where kode = v_kode;

          if v_card.kode is null then
            v_result := jsonb_build_object(
              'ok', false,
              'reason', 'unknown_kode',
              'message', 'That card kode was not recognised'
            );
          elsif v_card.activated_at is not null then
            v_result := jsonb_build_object(
              'ok', false,
              'reason', 'already_activated',
              'message', 'That card has already been activated by another account'
            );
          else
            update public.physical_cards
               set activated_by = v_user_id,
                   activated_at = now()
             where kode = v_kode;

            v_result := jsonb_build_object('ok', true);
          end if;
        end if;

      elsif v_op->>'type' = 'spend_awards' then
        v_user_id := (v_payload->>'userId')::uuid;
        select array_agg(x::uuid) into v_ids
          from jsonb_array_elements_text(v_payload->'awardIds') x;

        with del as (
          delete from public.point_awards
           where id = any(v_ids)
             and user_id = v_user_id
             and expires_at > now()
          returning points
        )
        select coalesce(sum(points), 0) into v_spent from del;

        if v_spent = 0 then
          v_result := jsonb_build_object(
            'ok', false,
            'reason', 'insufficient_points',
            'message', 'No live points available to spend'
          );
        else
          select coalesce(sum(points), 0) into v_remaining
            from public.point_awards
           where user_id = v_user_id
             and expires_at > now();

          update public.users
             set points = v_remaining
           where id = v_user_id;

          v_result := jsonb_build_object(
            'ok', true,
            'state', jsonb_build_object(
              'remainingBalance', v_remaining,
              'pointsSpent', v_spent
            )
          );
        end if;

      else
        v_result := jsonb_build_object(
          'ok', false,
          'reason', 'unknown_op',
          'message', 'Unknown sync op'
        );
      end if;

      if v_result is null then
        v_result := jsonb_build_object(
          'ok', false,
          'reason', 'unknown_op',
          'message', 'Unknown sync op'
        );
      end if;
    exception when others then
      v_result := jsonb_build_object(
        'ok', false,
        'reason', 'internal',
        'message', sqlerrm
      );
    end;

    v_results := v_results || (jsonb_build_object('opId', v_op->>'opId') || v_result);
  end loop;

  return jsonb_build_object(
    'results', v_results,
    'serverTime', extract(epoch from now()) * 1000
  );
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
    -- Customers pull the cards they activated, so hasPhysicalCard survives a
    -- sync pull (the standalone server scopes the same way in server/src/db.ts).
    select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_cards
      from public.physical_cards c where c.activated_by = p_user_id;
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
-- RPC: Delete unclaimed vouchers of one denomination (admin only)
-- Removes accidentally printed cards. Claimed cards are kept - they
-- are the audit trail for points already awarded to customers.
-- ================================================================
create or replace function public.delete_unclaimed_vouchers(p_points integer)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_deleted integer;
begin
  if p_points not in (1, 2, 3) then
    raise exception 'Invalid points value';
  end if;

  with removed as (
    delete from public.vouchers
     where points = p_points
       and redeemed_at is null
    returning code
  )
  select count(*) into v_deleted from removed;

  return jsonb_build_object('success', true, 'deleted', v_deleted);
end;
$$;

-- ================================================================
-- RPC: Delete unactivated physical cards of one batch (admin only)
-- Removes accidentally printed batches. Activated cards are kept -
-- they are linked to customer accounts.
-- ================================================================
create or replace function public.delete_unactivated_physical_cards(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_deleted integer;
begin
  if p_batch_id is null then
    raise exception 'A batch id is required';
  end if;

  with removed as (
    delete from public.physical_cards
     where batch_id = p_batch_id
       and activated_at is null
    returning kode
  )
  select count(*) into v_deleted from removed;

  return jsonb_build_object('success', true, 'deleted', v_deleted);
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
  -- One roll-up per denomination (tier), not per batch: the UI keys and expands
  -- cards by tier. `id` is the representative batch - the most recent run of
  -- that tier - matching the offline implementation in src/lib/db.ts.
  -- Ordering lives inside the aggregate: an outer ORDER BY on a non-grouped
  -- column alongside jsonb_agg fails with "must appear in the GROUP BY clause".
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', t.batch_id,
        'points', t.points,
        'created_at', t.created_at,
        'total', t.total,
        'redeemed', t.redeemed
      )
      order by t.created_at desc
    )::jsonb,
    '[]'::jsonb
  ) into v_batches
  from (
    select rep.batch_id, rep.points, rep.created_at, tot.total, tot.redeemed
    from (
      select distinct on (points) points, batch_id, created_at
      from public.vouchers
      order by points, created_at desc
    ) rep
    join (
      select points, count(*) as total,
             count(nullif(redeemed_at, null)) as redeemed
      from public.vouchers
      group by points
    ) tot on tot.points = rep.points
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
-- Access: anon/authenticated can call the RPCs and read the tables.
-- RLS is disabled, so explicit table grants keep the anon client working.
-- ================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

grant execute on function public.scrypt_pin(text) to anon, authenticated;
grant execute on function public.verify_login(text, text) to anon, authenticated;
grant execute on function public.register_user(text, text, text) to anon, authenticated;
grant execute on function public.redeem_voucher_card(text, uuid) to anon, authenticated;
grant execute on function public.redeem_reward_points(uuid, integer) to anon, authenticated;
grant execute on function public.activate_physical_card(text, uuid) to anon, authenticated;
grant execute on function public.create_voucher_batch(integer, integer) to anon, authenticated;
grant execute on function public.create_physical_card_batch(integer) to anon, authenticated;
grant execute on function public.delete_claimed_vouchers(text[]) to anon, authenticated;
grant execute on function public.get_voucher_cards_by_points(integer) to anon, authenticated;
grant execute on function public.apply_sync_ops(jsonb) to anon, authenticated;
grant execute on function public.build_snapshot(text, uuid) to anon, authenticated;
grant execute on function public.count_customers() to anon, authenticated;
grant execute on function public.list_voucher_batches() to anon, authenticated;
grant execute on function public.list_physical_card_batches() to anon, authenticated;
grant execute on function public.delete_unclaimed_vouchers(integer) to anon, authenticated;
grant execute on function public.delete_unactivated_physical_cards(uuid) to anon, authenticated;

-- ================================================================
-- Seed data
-- ================================================================
-- Upsert the seed admin: keeps an existing account working by resetting it to
-- the legacy PIN 0000 placeholder (in case the DB already has rows from an
-- older hash scheme).
insert into public.users (phone, name, points, pin_hash, ref_code, role, created_at)
values
  ('09518050546', 'Ramyun Admin', 0, 'scrypt$seed', 'ADMIN', 'admin', now())
on conflict (phone) do update
  set name = excluded.name,
      pin_hash = 'scrypt$seed',
      ref_code = 'ADMIN',
      role = 'admin';

-- Migrate any pre-existing accounts that were hashed under the old scheme
-- (pin_hash not produced by pgcrypto bcrypt) to the legacy PIN 0000
-- placeholder so those test accounts can still sign in.
update public.users
   set pin_hash = 'scrypt$seed'
 where pin_hash not like '$2a$%';