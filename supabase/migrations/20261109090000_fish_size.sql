-- Fish size in "fingers" (2026-11-09, Andy): the shop sells small fish (1 finger), fish grow
-- one finger at a time over rewarded feedings, capped by the tank tier and the species'
-- adult length. Invertebrates do not grow. Tunables live in config/game.json:
--   settings.finger_cm, growth_feeds_base, growth_feeds_step, growth_min_health
--   tank_tiers.max_size_fingers
-- Existing fish are set to the biggest size their current tank allows by the backfill
-- migration that runs after the generated static data (so they do not shrink).

alter table public.tank_tiers
  add column if not exists max_size_fingers int not null default 1 check (max_size_fingers >= 1);

alter table public.tank_fish
  add column if not exists size_fingers int not null default 1 check (size_fingers >= 1),
  add column if not exists growth int not null default 0 check (growth >= 0);

-- Biggest size (fingers) a species may reach in a tier.
create or replace function private.max_fish_size(p_species text, p_tier text)
returns int
language sql stable
set search_path = ''
as $$
  select greatest(1, least(
           tt.max_size_fingers,
           floor(s.adult_length_cm / coalesce(nullif(private.setting('finger_cm'), 0), 2))::int))
    from public.species s, public.tank_tiers tt
   where s.id = p_species and tt.id = p_tier
$$;

-- Rewarded feedings needed to grow from p_size to p_size + 1.
create or replace function private.feeds_to_grow(p_size int)
returns int
language sql stable
set search_path = ''
as $$
  select greatest(1, (coalesce(private.setting('growth_feeds_base'), 3)
                    + coalesce(private.setting('growth_feeds_step'), 2) * (p_size - 1))::int)
$$;

-- One rewarded feeding: every fish below its cap gains a growth point and grows a finger
-- when it has enough. Fish at the cap stay as they are until the tank is upgraded.
create or replace function private.grow_fish(p_tank uuid)
returns void
language sql
set search_path = ''
as $$
  with cand as (
    select f.id, f.size_fingers, f.growth + 1 as g, private.feeds_to_grow(f.size_fingers) as need
      from public.tank_fish f
      join public.species s on s.id = f.species_id
      join public.tanks t on t.id = f.tank_id
     where f.tank_id = p_tank
       and s.kind = 'fish'
       and f.size_fingers < private.max_fish_size(f.species_id, t.tier_id)
  )
  update public.tank_fish f
     set size_fingers = case when c.g >= c.need then c.size_fingers + 1 else c.size_fingers end,
         growth       = case when c.g >= c.need then 0 else c.g end
    from cand c
   where f.id = c.id
$$;

-- Feeds one tank. XP/coins (and fish growth) only when the tank was actually hungry.
create or replace function public.feed_tank(p_tank_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_food real;
  v_health real;
begin
  if not exists (select 1 from public.tanks where id = p_tank_id and user_id = v_uid) then
    raise exception 'tank_not_found' using errcode = 'P0002';
  end if;
  perform private.tick_tank(p_tank_id);
  select food, health into v_food, v_health from public.tanks where id = p_tank_id;
  update public.tanks set food = least(100, food + private.setting('feed_amount')) where id = p_tank_id;
  if v_food < private.setting('feed_reward_below') then
    perform private.add_xp(v_uid, private.setting('feed_xp')::int, private.setting('feed_coins')::int);
    if v_health >= coalesce(private.setting('growth_min_health'), 50) then
      perform private.grow_fish(p_tank_id);
    end if;
  end if;
  return private.state_json(v_uid);
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.feed_tank(uuid) from public, anon;
grant execute on function public.feed_tank(uuid) to authenticated;
