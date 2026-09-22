-- Fix: add #variable_conflict use_column to redeem_voucher_card and redeem_reward_points
-- to resolve PL/pgSQL column/variable ambiguity errors (SQLSTATE 42702)

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
