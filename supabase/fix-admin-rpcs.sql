-- ================================================================
-- Fix admin catalog RPCs (run once against Supabase: SQL Editor
-- > New query > paste all > Run). Idempotent - safe to re-run.
-- ----------------------------------------------------------------
-- Fixes:
--   1. get_voucher_cards_by_points raised SQLSTATE 42803
--      ("column vouchers.created_at must appear in the GROUP BY
--       clause") because jsonb_agg was ordered by a bare ORDER BY.
--      The order clause now lives inside the aggregate.
--   2. Guarantees create_voucher_batch / create_physical_card_batch
--      return the {success, batch, cards} shape the app expects.
--   3. list_voucher_batches grouped by batch_id, so printing the same
--      tier twice produced duplicate list entries (and duplicate React
--      keys in the Points cards screen). It now rolls up one entry per
--      denomination with the representative batch id of the most recent
--      run of that tier, matching src/lib/db.ts.
--   4. build_snapshot's customer branch returned no physical cards, so a
--      sync pull deleted the locally-activated card and hasPhysicalCard
--      stayed false - the My TNL Card screen never showed the card after
--      activation. Customers now pull the cards they activated.
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
-- RPC: List voucher batches (admin only)
-- Rolls up one entry per denomination instead of per batch, so the
-- Points cards screen gets unique keys and a single card per tier.
-- ================================================================
create or replace function public.list_voucher_batches()
returns jsonb
language plpgsql
security definer
as $$
declare
  v_batches jsonb;
begin
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
-- RPC: Build role-scoped sync snapshot
-- Customer branch now includes the cards that account activated.
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