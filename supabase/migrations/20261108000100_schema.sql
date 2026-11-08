-- Reef 3D: core schema, RLS and server-authoritative RPCs.
--
-- Rules (see CLAUDE.md):
--   * RLS on every table. Players can only SELECT their own rows.
--   * Clients never INSERT/UPDATE/DELETE player data. All mutations go through
--     the SECURITY DEFINER RPCs below, which validate every condition.
--   * No cron per tank: hunger/dirt are derived from `last_tick_at` lazily.

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Static data (seeded from config/game.json by a generated migration)
-- ---------------------------------------------------------------------------

create table public.game_settings (
  id   int primary key default 1 check (id = 1),
  data jsonb not null
);

create table public.tank_tiers (
  id                text primary key,
  name              text not null,
  label             text not null,
  length_cm         int  not null check (length_cm > 0),
  depth_cm          int  not null check (depth_cm > 0),
  height_cm         int  not null check (height_cm > 0),
  volume_l          int  generated always as ((length_cm * depth_cm * height_cm) / 1000) stored,
  unlock_level      int  not null check (unlock_level >= 1),
  unlock_cost_coins int  not null default 0 check (unlock_cost_coins >= 0),
  max_fish          int  not null check (max_fish >= 0),
  sort_order        int  not null unique
);

create table public.species (
  id              text primary key,
  common_name     text not null,
  scientific_name text not null,
  adult_length_cm numeric not null,
  min_tier        text not null references public.tank_tiers(id),
  starter         boolean not null default false,
  body_color      text not null,
  fin_color       text not null,
  accent_color    text not null,
  model_url       text
);

-- ---------------------------------------------------------------------------
-- Player data
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  level          int  not null default 1 check (level >= 1),
  xp             int  not null default 0 check (xp >= 0),
  coins          int  not null default 0 check (coins >= 0),
  gems           int  not null default 0 check (gems >= 0),
  active_tank_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.tanks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(user_id) on delete cascade,
  tier_id      text not null references public.tank_tiers(id),
  food         real not null default 80  check (food between 0 and 100),
  cleanliness  real not null default 100 check (cleanliness between 0 and 100),
  health       real not null default 100 check (health between 0 and 100),
  last_tick_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (user_id, tier_id)
);
create index tanks_user_id_idx on public.tanks(user_id);

alter table public.profiles
  add constraint profiles_active_tank_fk
  foreign key (active_tank_id) references public.tanks(id) on delete set null;

create table public.tank_fish (
  id         uuid primary key default gen_random_uuid(),
  tank_id    uuid not null references public.tanks(id) on delete cascade,
  user_id    uuid not null references public.profiles(user_id) on delete cascade,
  species_id text not null references public.species(id),
  created_at timestamptz not null default now()
);
create index tank_fish_user_id_idx on public.tank_fish(user_id);
create index tank_fish_tank_id_idx on public.tank_fish(tank_id);

-- ---------------------------------------------------------------------------
-- Privileges + RLS: read-only for clients
-- ---------------------------------------------------------------------------

revoke all on public.game_settings, public.tank_tiers, public.species,
              public.profiles, public.tanks, public.tank_fish
  from public, anon, authenticated;

grant select on public.game_settings, public.tank_tiers, public.species to anon, authenticated;
grant select on public.profiles, public.tanks, public.tank_fish to authenticated;

alter table public.game_settings enable row level security;
alter table public.tank_tiers    enable row level security;
alter table public.species       enable row level security;
alter table public.profiles      enable row level security;
alter table public.tanks         enable row level security;
alter table public.tank_fish     enable row level security;

create policy "static data is public" on public.game_settings for select using (true);
create policy "static data is public" on public.tank_tiers    for select using (true);
create policy "static data is public" on public.species       for select using (true);

create policy "own profile"   on public.profiles  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own tanks"     on public.tanks     for select to authenticated using ((select auth.uid()) = user_id);
create policy "own tank fish" on public.tank_fish for select to authenticated using ((select auth.uid()) = user_id);
-- No INSERT/UPDATE/DELETE policies on purpose: writes only via RPCs below.

-- ---------------------------------------------------------------------------
-- Private helpers (not exposed through the API)
-- ---------------------------------------------------------------------------

create or replace function private.setting(p_key text)
returns numeric
language sql stable
set search_path = ''
as $$
  select (data ->> p_key)::numeric from public.game_settings where id = 1
$$;

create or replace function private.xp_to_next(p_level int)
returns int
language sql stable
set search_path = ''
as $$
  select (private.setting('xp_base') + private.setting('xp_per_level') * (p_level - 1))::int
$$;

create or replace function private.require_user()
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return v_uid;
end;
$$;

-- Apply elapsed time to one tank. Health rises while food and cleanliness are
-- above the threshold and falls once either drops below it.
create or replace function private.tick_tank(p_tank_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  t           public.tanks%rowtype;
  v_hours     double precision;
  v_food_dec  double precision := private.setting('food_decay_per_hour');
  v_dirt_dec  double precision := private.setting('dirt_per_hour');
  v_thr       double precision := private.setting('health_threshold');
  v_gain      double precision := private.setting('health_gain_per_hour');
  v_loss      double precision := private.setting('health_loss_per_hour');
  v_t_food    double precision;
  v_t_clean   double precision;
  v_good      double precision;
begin
  select * into t from public.tanks where id = p_tank_id for update;
  if not found then return; end if;

  v_hours := greatest(0, extract(epoch from (now() - t.last_tick_at)) / 3600.0);
  if v_hours = 0 then return; end if;

  v_t_food  := case when t.food <= v_thr then 0
                    when v_food_dec <= 0 then 'infinity'::double precision
                    else (t.food - v_thr) / v_food_dec end;
  v_t_clean := case when t.cleanliness <= v_thr then 0
                    when v_dirt_dec <= 0 then 'infinity'::double precision
                    else (t.cleanliness - v_thr) / v_dirt_dec end;
  v_good := least(v_hours, v_t_food, v_t_clean);

  update public.tanks set
    food         = greatest(0, t.food - v_food_dec * v_hours),
    cleanliness  = greatest(0, t.cleanliness - v_dirt_dec * v_hours),
    -- good phase first (capped at 100), then the bad phase
    health       = greatest(0, least(100, t.health + v_gain * v_good) - v_loss * (v_hours - v_good)),
    last_tick_at = now()
  where id = p_tank_id;
end;
$$;

-- Grants XP (and level-up rewards) to a user. Internal only.
create or replace function private.add_xp(p_user uuid, p_xp int, p_coins int)
returns void
language plpgsql
set search_path = ''
as $$
declare
  p public.profiles%rowtype;
  v_need int;
begin
  select * into p from public.profiles where user_id = p_user for update;
  p.xp := p.xp + greatest(0, p_xp);
  p.coins := p.coins + greatest(0, p_coins);
  loop
    v_need := private.xp_to_next(p.level);
    exit when p.xp < v_need;
    p.xp := p.xp - v_need;
    p.level := p.level + 1;
    p.coins := p.coins + private.setting('level_up_coins')::int;
    p.gems := p.gems + private.setting('level_up_gems')::int;
  end loop;
  update public.profiles
     set xp = p.xp, level = p.level, coins = p.coins, gems = p.gems, updated_at = now()
   where user_id = p_user;
end;
$$;

-- Creates profile, starter tank and starter fish the first time a user plays.
create or replace function private.ensure_player(p_user uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_tier text := (select data ->> 'starter_tier' from public.game_settings where id = 1);
  v_tank uuid;
begin
  insert into public.profiles (user_id, coins, gems)
  values (p_user, private.setting('starting_coins')::int, private.setting('starting_gems')::int)
  on conflict (user_id) do nothing;
  if not found then return; end if;

  insert into public.tanks (user_id, tier_id) values (p_user, v_tier) returning id into v_tank;
  insert into public.tank_fish (tank_id, user_id, species_id)
    select v_tank, p_user, s.id from public.species s where s.starter order by s.id;
  update public.profiles set active_tank_id = v_tank where user_id = p_user;
end;
$$;

create or replace function private.state_json(p_user uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) || jsonb_build_object('xp_to_next', private.xp_to_next(p.level))
                  from public.profiles p where p.user_id = p_user),
    'tanks',   coalesce((select jsonb_agg(to_jsonb(t) order by tt.sort_order)
                  from public.tanks t join public.tank_tiers tt on tt.id = t.tier_id
                  where t.user_id = p_user), '[]'::jsonb),
    'fish',    coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at)
                  from public.tank_fish f where f.user_id = p_user), '[]'::jsonb),
    'server_time', now()
  )
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs (the only write path for clients)
-- ---------------------------------------------------------------------------

-- Returns the player's full state after applying elapsed time to every tank.
create or replace function public.get_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_tank uuid;
begin
  perform private.ensure_player(v_uid);
  for v_tank in select id from public.tanks where user_id = v_uid loop
    perform private.tick_tank(v_tank);
  end loop;
  return private.state_json(v_uid);
end;
$$;

-- Unlocks a tank tier. Server checks level and coin cost.
create or replace function public.unlock_tank(p_tier_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_tier public.tank_tiers%rowtype;
  v_prof public.profiles%rowtype;
  v_tank uuid;
begin
  perform private.ensure_player(v_uid);
  select * into v_tier from public.tank_tiers where id = p_tier_id;
  if not found then
    raise exception 'unknown_tier' using errcode = 'P0002';
  end if;

  select * into v_prof from public.profiles where user_id = v_uid for update;
  if v_prof.level < v_tier.unlock_level then
    raise exception 'level_too_low: need level %, have %', v_tier.unlock_level, v_prof.level
      using errcode = '42501';
  end if;

  if exists (select 1 from public.tanks where user_id = v_uid and tier_id = p_tier_id) then
    raise exception 'already_unlocked' using errcode = '23505';
  end if;

  if v_prof.coins < v_tier.unlock_cost_coins then
    raise exception 'not_enough_coins' using errcode = '42501';
  end if;

  update public.profiles
     set coins = coins - v_tier.unlock_cost_coins, updated_at = now()
   where user_id = v_uid;
  insert into public.tanks (user_id, tier_id) values (v_uid, p_tier_id) returning id into v_tank;
  -- Phase 1: every new tank starts with the starter species (fish shop comes later).
  insert into public.tank_fish (tank_id, user_id, species_id)
    select v_tank, v_uid, s.id from public.species s where s.starter order by s.id;
  update public.profiles set active_tank_id = v_tank where user_id = v_uid;
  return private.state_json(v_uid);
end;
$$;

-- Switches which owned tank is shown.
create or replace function public.select_tank(p_tank_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not exists (select 1 from public.tanks where id = p_tank_id and user_id = v_uid) then
    raise exception 'tank_not_found' using errcode = 'P0002';
  end if;
  update public.profiles set active_tank_id = p_tank_id, updated_at = now() where user_id = v_uid;
  return private.state_json(v_uid);
end;
$$;

-- Feeds one tank. XP/coins only when the tank was actually hungry (anti-spam).
create or replace function public.feed_tank(p_tank_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_food real;
begin
  if not exists (select 1 from public.tanks where id = p_tank_id and user_id = v_uid) then
    raise exception 'tank_not_found' using errcode = 'P0002';
  end if;
  perform private.tick_tank(p_tank_id);
  select food into v_food from public.tanks where id = p_tank_id;
  update public.tanks set food = least(100, food + private.setting('feed_amount')) where id = p_tank_id;
  if v_food < private.setting('feed_reward_below') then
    perform private.add_xp(v_uid, private.setting('feed_xp')::int, private.setting('feed_coins')::int);
  end if;
  return private.state_json(v_uid);
end;
$$;

-- Water change: restores cleanliness. Rewards only when the tank was dirty.
create or replace function public.change_water(p_tank_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_clean real;
begin
  if not exists (select 1 from public.tanks where id = p_tank_id and user_id = v_uid) then
    raise exception 'tank_not_found' using errcode = 'P0002';
  end if;
  perform private.tick_tank(p_tank_id);
  select cleanliness into v_clean from public.tanks where id = p_tank_id;
  update public.tanks set cleanliness = 100 where id = p_tank_id;
  if v_clean < private.setting('water_reward_below') then
    perform private.add_xp(v_uid, private.setting('water_xp')::int, private.setting('water_coins')::int);
  end if;
  return private.state_json(v_uid);
end;
$$;

-- Lock down function execution: helpers are private, RPCs only for signed-in users.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.get_state(), public.unlock_tank(text), public.select_tank(uuid),
                       public.feed_tank(uuid), public.change_water(uuid)
  from public, anon;
grant execute on function public.get_state(), public.unlock_tank(text), public.select_tank(uuid),
                          public.feed_tank(uuid), public.change_water(uuid)
  to authenticated;
