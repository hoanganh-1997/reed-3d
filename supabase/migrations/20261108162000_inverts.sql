-- Invertebrates (2026-11-08, Andy): bottom dwellers such as the red starfish are sold in the
-- fish shop but do not take a fish slot. They are capped per species and per tank instead.

alter table public.species
  add column if not exists kind text not null default 'fish' check (kind in ('fish', 'invert')),
  add column if not exists max_per_tank int check (max_per_tank is null or max_per_tank >= 0);

create or replace function public.buy_fish(p_species_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_sp   public.species%rowtype;
  v_prof public.profiles%rowtype;
  v_tank public.tanks%rowtype;
  v_tier public.tank_tiers%rowtype;
  v_min  public.tank_tiers%rowtype;
  v_n    int;
begin
  perform private.ensure_player(v_uid);
  select * into v_sp from public.species where id = p_species_id;
  if not found then
    raise exception 'unknown_species' using errcode = 'P0002';
  end if;

  select * into v_prof from public.profiles where user_id = v_uid for update;
  select * into v_tank from public.tanks where id = v_prof.active_tank_id and user_id = v_uid for update;
  if not found then
    raise exception 'tank_not_found' using errcode = 'P0002';
  end if;
  select * into v_tier from public.tank_tiers where id = v_tank.tier_id;
  select * into v_min from public.tank_tiers where id = v_sp.min_tier;

  if v_prof.level < v_sp.unlock_level then
    raise exception 'level_too_low: need level %, have %', v_sp.unlock_level, v_prof.level using errcode = '42501';
  end if;
  if v_tier.sort_order < v_min.sort_order then
    raise exception 'tank_too_small: % needs %', p_species_id, v_min.id using errcode = '42501';
  end if;

  -- Fish share the tank's max_fish slots; invertebrates do not.
  if v_sp.kind = 'fish' then
    select count(*) into v_n
      from public.tank_fish f join public.species s on s.id = f.species_id
     where f.tank_id = v_tank.id and s.kind = 'fish';
    if v_n >= v_tier.max_fish then
      raise exception 'tank_full: % of %', v_n, v_tier.max_fish using errcode = '42501';
    end if;
  end if;
  -- Per-species cap (always set for invertebrates; optional for fish).
  if v_sp.max_per_tank is not null or v_sp.kind <> 'fish' then
    select count(*) into v_n from public.tank_fish where tank_id = v_tank.id and species_id = v_sp.id;
    if v_n >= coalesce(v_sp.max_per_tank, 0) then
      raise exception 'species_limit: % of %', v_n, coalesce(v_sp.max_per_tank, 0) using errcode = '42501';
    end if;
  end if;

  if v_prof.coins < v_sp.price_coins then
    raise exception 'not_enough_coins: need %, have %', v_sp.price_coins, v_prof.coins using errcode = '42501';
  end if;

  perform private.tick_tank(v_tank.id);
  update public.profiles set coins = coins - v_sp.price_coins, updated_at = now() where user_id = v_uid;
  insert into public.tank_fish (tank_id, user_id, species_id) values (v_tank.id, v_uid, p_species_id);
  return private.state_json(v_uid);
end;
$$;

revoke all on function public.buy_fish(text) from public, anon;
grant execute on function public.buy_fish(text) to authenticated;
