-- Tank sizes move to the shop (2026-11-08, Andy): each player has ONE tank.
-- Buying a bigger size upgrades that tank in place; fish and meters carry over.
-- unlock_tank / select_tank (multi-tank model) are removed.

drop function if exists public.unlock_tank(text);
drop function if exists public.select_tank(uuid);

-- Upgrades the player's active tank to a bigger tier.
-- Server checks: tier exists, is bigger than the current one, level, coins.
create or replace function public.upgrade_tank(p_tier_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_tier public.tank_tiers%rowtype;
  v_cur  public.tank_tiers%rowtype;
  v_prof public.profiles%rowtype;
  v_tank public.tanks%rowtype;
begin
  perform private.ensure_player(v_uid);
  select * into v_tier from public.tank_tiers where id = p_tier_id;
  if not found then
    raise exception 'unknown_tier' using errcode = 'P0002';
  end if;

  select * into v_prof from public.profiles where user_id = v_uid for update;
  select * into v_tank from public.tanks where id = v_prof.active_tank_id and user_id = v_uid for update;
  if not found then
    raise exception 'tank_not_found' using errcode = 'P0002';
  end if;
  select * into v_cur from public.tank_tiers where id = v_tank.tier_id;

  if v_tier.sort_order <= v_cur.sort_order then
    raise exception 'not_an_upgrade: % is not bigger than %', p_tier_id, v_cur.id using errcode = '22023';
  end if;
  if v_prof.level < v_tier.unlock_level then
    raise exception 'level_too_low: need level %, have %', v_tier.unlock_level, v_prof.level
      using errcode = '42501';
  end if;
  if v_prof.coins < v_tier.unlock_cost_coins then
    raise exception 'not_enough_coins: need %, have %', v_tier.unlock_cost_coins, v_prof.coins
      using errcode = '42501';
  end if;
  -- Legacy multi-tank players may already own that tier in another tank.
  if exists (select 1 from public.tanks where user_id = v_uid and tier_id = p_tier_id) then
    raise exception 'already_unlocked' using errcode = '23505';
  end if;

  -- Tick first so the elapsed time is settled on the old tier.
  perform private.tick_tank(v_tank.id);
  update public.profiles
     set coins = coins - v_tier.unlock_cost_coins, updated_at = now()
   where user_id = v_uid;
  update public.tanks set tier_id = p_tier_id where id = v_tank.id;
  return private.state_json(v_uid);
end;
$$;

revoke all on function public.upgrade_tank(text) from public, anon;
grant execute on function public.upgrade_tank(text) to authenticated;
