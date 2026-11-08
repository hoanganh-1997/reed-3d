-- Behavioural + security tests for the schema and RPCs.
-- Runs on plain Postgres with local_shim.sql (scripts/test-db-local.sh).
-- Every check raises an exception on failure, so psql exits non-zero.

\set ON_ERROR_STOP on
\set alice '''11111111-1111-1111-1111-111111111111'''
\set bob   '''22222222-2222-2222-2222-222222222222'''

insert into auth.users (id, email) values (:alice, 'alice@test'), (:bob, 'bob@test');

create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm ilike p_like then
      raise notice 'ok (rejected as expected): % -> %', p_sql, sqlerrm;
      return;
    end if;
    raise exception 'wrong error for %: % (expected like %)', p_sql, sqlerrm, p_like;
  end;
  raise exception 'expected failure but succeeded: %', p_sql;
end $$;
grant execute on function pg_temp.expect_error(text, text) to anon, authenticated;

-- ---------------------------------------------------------------- anon
set role anon;
select pg_temp.expect_error('select public.get_state()', '%permission denied%');
select pg_temp.expect_error($q$select public.upgrade_tank('cube35')$q$, '%permission denied%');
select pg_temp.expect_error('select * from public.profiles', '%permission denied%');
do $$ begin
  if (select count(*) from public.tank_tiers) <> 8 then raise exception 'anon should read tank_tiers'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- alice
set role authenticated;
select set_config('request.jwt.claim.sub', :alice, false);

do $$
declare s jsonb := public.get_state();
begin
  if (s #>> '{profile,level}')::int <> 1 then raise exception 'new player should be level 1: %', s; end if;
  if jsonb_array_length(s -> 'tanks') <> 1 then raise exception 'starter tank missing'; end if;
  if jsonb_array_length(s -> 'fish') <> 2 then raise exception 'starter fish missing'; end if;
  if s #>> '{tanks,0,tier_id}' <> 'cube30' then raise exception 'starter tier wrong'; end if;
end $$;

-- Cannot upgrade above level, downgrade, or write directly; old multi-tank RPCs are gone.
select pg_temp.expect_error($q$select public.upgrade_tank('cube35')$q$, '%level_too_low%');
select pg_temp.expect_error($q$select public.upgrade_tank('big200')$q$, '%level_too_low%');
select pg_temp.expect_error($q$select public.upgrade_tank('cube30')$q$, '%not_an_upgrade%');
select pg_temp.expect_error($q$select public.upgrade_tank('nope')$q$, '%unknown_tier%');
select pg_temp.expect_error($q$select public.unlock_tank('cube35')$q$, '%does not exist%');
select pg_temp.expect_error('update public.profiles set level = 99', '%permission denied%');
select pg_temp.expect_error('update public.profiles set coins = 999999', '%permission denied%');
select pg_temp.expect_error($q$insert into public.tanks (user_id, tier_id) values ('11111111-1111-1111-1111-111111111111', 'big200')$q$, '%permission denied%');
select pg_temp.expect_error('delete from public.tank_fish', '%permission denied%');
select pg_temp.expect_error($q$insert into public.tank_fish (tank_id, user_id, species_id) select id, user_id, 'achilles_tang' from public.tanks$q$, '%permission denied%');
select pg_temp.expect_error($q$update public.tank_tiers set unlock_level = 1$q$, '%permission denied%');
select pg_temp.expect_error($q$update public.game_settings set data = '{}'$q$, '%permission denied%');
select pg_temp.expect_error($q$select private.add_xp('11111111-1111-1111-1111-111111111111', 100000, 0)$q$, '%permission denied%');
select pg_temp.expect_error($q$select private.ensure_player('11111111-1111-1111-1111-111111111111')$q$, '%permission denied%');

do $$ begin
  if (select count(*) from public.tanks) <> 1 then raise exception 'alice should still have 1 tank'; end if;
  if (select level from public.profiles) <> 1 then raise exception 'alice level changed'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- bob, isolation
set role authenticated;
select set_config('request.jwt.claim.sub', :bob, false);
select public.get_state();
do $$
declare alice_tank uuid;
begin
  if (select count(*) from public.profiles) <> 1 then raise exception 'bob sees other profiles'; end if;
  if exists (select 1 from public.tanks where user_id <> '22222222-2222-2222-2222-222222222222') then raise exception 'bob sees other tanks'; end if;
  if exists (select 1 from public.tank_fish where user_id <> '22222222-2222-2222-2222-222222222222') then raise exception 'bob sees other fish'; end if;
end $$;
reset role;
-- bob cannot act on alice's tank (id fetched as superuser)
select id as alice_tank from public.tanks where user_id = :alice \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :bob, false);
select pg_temp.expect_error(format('select public.feed_tank(%L)', :'alice_tank'), '%tank_not_found%');
select pg_temp.expect_error(format('select public.change_water(%L)', :'alice_tank'), '%tank_not_found%');
reset role;

-- ---------------------------------------------------------------- time-based tick
-- Pretend alice's tank was last ticked 10h ago with food 80 / clean 100 / health 100.
update public.tanks set last_tick_at = now() - interval '10 hours', food = 80, cleanliness = 100, health = 100 where user_id = :alice;
set role authenticated;
select set_config('request.jwt.claim.sub', :alice, false);
do $$
declare s jsonb := public.get_state(); f real; c real; h real;
begin
  f := (s #>> '{tanks,0,food}')::real; c := (s #>> '{tanks,0,cleanliness}')::real; h := (s #>> '{tanks,0,health}')::real;
  -- 6/h food decay -> 20; 2.5/h dirt -> 75. Food hits 30 after 8.33h, so 8.33h good (+2/h) and 1.67h bad (-4/h): 100 capped then -6.67 ~ 93.3
  if abs(f - 20) > 0.1 then raise exception 'food after 10h: %', f; end if;
  if abs(c - 75) > 0.1 then raise exception 'clean after 10h: %', c; end if;
  if abs(h - 93.33) > 0.2 then raise exception 'health after 10h: %', h; end if;
  raise notice 'ok tick: food % clean % health %', f, c, h;
end $$;

-- Feeding a hungry tank rewards XP; feeding a full tank does not (no spam farming).
do $$
declare s jsonb; tank uuid := (select id from public.tanks limit 1); xp0 int; xp1 int; xp2 int;
begin
  xp0 := (select xp from public.profiles);
  s := public.feed_tank(tank);
  xp1 := (s #>> '{profile,xp}')::int;
  if xp1 <> xp0 + 10 then raise exception 'feed reward wrong: % -> %', xp0, xp1; end if;
  s := public.feed_tank(tank);  -- food 55 -> still < 70, rewarded
  s := public.feed_tank(tank);  -- food 90 -> no reward
  xp2 := (s #>> '{profile,xp}')::int;
  if xp2 <> xp0 + 20 then raise exception 'feed spam should not reward: %', xp2; end if;
  if (s #>> '{tanks,0,food}')::real <> 100 then raise exception 'food should cap at 100'; end if;
  raise notice 'ok feed rewards';
end $$;
reset role;

-- ---------------------------------------------------------------- shop upgrade
-- Give alice level 4 through the internal path (as the server would on level-up).
select private.add_xp(:alice, 100 + 125 + 150 - 20, 0);
-- Level-ups already granted coins; set a known balance below the cube35 price first.
update public.profiles set coins = (select unlock_cost_coins - 1 from public.tank_tiers where id = 'cube35') where user_id = :alice;
set role authenticated;
select set_config('request.jwt.claim.sub', :alice, false);
select pg_temp.expect_error($q$select public.upgrade_tank('cube35')$q$, '%not_enough_coins%');
reset role;
update public.profiles set coins = (select unlock_cost_coins + 7 from public.tank_tiers where id = 'cube35') where user_id = :alice;
set role authenticated;
select set_config('request.jwt.claim.sub', :alice, false);
do $$
declare s jsonb; fish0 int := (select count(*) from public.tank_fish); tank0 uuid := (select active_tank_id from public.profiles);
begin
  if (select level from public.profiles) <> 4 then raise exception 'expected level 4, got %', (select level from public.profiles); end if;
  s := public.upgrade_tank('cube35');
  if jsonb_array_length(s -> 'tanks') <> 1 then raise exception 'upgrade must keep one tank: %', s -> 'tanks'; end if;
  if s #>> '{tanks,0,tier_id}' <> 'cube35' then raise exception 'tank not upgraded'; end if;
  if (s #>> '{tanks,0,id}')::uuid <> tank0 then raise exception 'upgrade must keep the same tank'; end if;
  if (s #>> '{profile,coins}')::int <> 7 then raise exception 'coins not deducted: %', s #>> '{profile,coins}'; end if;
  if (select count(*) from public.tank_fish) <> fish0 then raise exception 'fish lost on upgrade'; end if;
  raise notice 'ok shop upgrade at level 4';
end $$;
select pg_temp.expect_error($q$select public.upgrade_tank('cube35')$q$, '%not_an_upgrade%');
select pg_temp.expect_error($q$select public.upgrade_tank('cube30')$q$, '%not_an_upgrade%');
select pg_temp.expect_error($q$select public.upgrade_tank('cube40')$q$, '%level_too_low%');
reset role;

-- ---------------------------------------------------------------- RLS is on everywhere
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    raise exception 'RLS disabled on %', r.relname;
  end loop;
  raise notice 'ok RLS enabled on all public tables';
end $$;

select 'ALL TESTS PASSED' as result;
