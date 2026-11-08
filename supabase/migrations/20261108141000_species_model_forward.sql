-- Which model axis the fish head points along (GLB orientation), used by the client loader.
alter table public.species
  add column if not exists model_forward text not null default '+z'
  check (model_forward in ('+x', '-x', '+z', '-z'));
