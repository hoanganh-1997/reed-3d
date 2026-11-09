-- One-off backfill for the fish size system (runs after the static data that sets
-- tank_tiers.max_size_fingers). Fish bought before sizes existed were shown at roughly the
-- biggest size their tank allows, so they start at that size instead of shrinking to 1.
-- Run once: every fish that exists when this is applied predates sizes.

update public.tank_fish f
   set size_fingers = private.max_fish_size(f.species_id, t.tier_id)
  from public.tanks t, public.species s
 where t.id = f.tank_id
   and s.id = f.species_id
   and s.kind = 'fish'
   and f.size_fingers = 1
   and f.growth = 0;
