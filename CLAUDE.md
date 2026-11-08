# Reef 3D

Web 3D marine-aquarium game. **This file is the source of truth for concept, decisions and rules** — do not rely on chat history. Update it when a decision changes.

Language: talk to the owner (Andy) in Vietnamese; code, identifiers, comments and commits in English.

## Concept

- Main screen: a room with an aquarium; 3D fish swim in the tank.
- Players level up to unlock bigger tanks.
- The room never changes. The bigger the tank, the further the camera pulls back: a 30 cm tank is a close-up on the stand top; the 1 × 2 m tank reveals floor, armchair and the big plant.
- Concept mock (layout/HUD and camera idea only, not code to reuse): https://claude.ai/artifact/KfVS1R8CZyygPwwXFY4Vvr
- HUD: level + XP, tank name + volume, coins + gems, settings, 3 meters (food, cleanliness, fish health), 4 buttons (feed, water change, decorate, collection), tank-size bar at the bottom. Clicking a locked tank shows a ghost preview and how many levels are missing.

## Decided

- Hosting: **Vercel** (frontend) + **Supabase** (Postgres, Auth). Vercel Hobby = personal, non-commercial only.
- First fish: yellow tang (*Zebrasoma flavescens*), regal blue tang (*Paracanthurus hepatus*), Achilles tang (*Acanthurus achilles*). Models come from an AI image → image-to-3D pipeline; until GLBs exist, use the procedural placeholder in `src/scene/fish.ts`.
- Visual style: semi-realistic, warm, room at sunset; the tank is the brightest light source. **Never mix low-poly and semi-realistic models.**
- Tank lighting (2026-11-08, Andy): reef tanks are lit **blue/actinic** (reference: blue LED reef tank with fluorescent corals). The room stays warm sunset; only the tank is blue. Colours live in `config/game.json` → `visual` (client-only).
- Camera: players can orbit to see the tank from **three sides** (front, left, right; azimuth up to ±90°, limited so the camera never leaves the room), zoom in/out, double-click to return to the front framing. Props that block the view fade out.
- Client: **Three.js + TypeScript + Vite**, HUD in plain DOM/CSS (no UI framework yet).
- Swimming: vertex-shader body wave (`applySwimWave`), no skeleton rig. Fish local axes: +X head, +Y up, Z lateral.

## Proposed, changeable (lives in config, never hard-coded)

All tunables are in [`config/game.json`](config/game.json): tank tiers, species, XP curve, decay rates, rewards.
After editing, run `npm run gen:static` → it writes a **new timestamped migration** that upserts the static tables. Apply it like any migration. The client reads static data from the DB (falls back to the bundled JSON).

| Tier | L × D × H (cm) | Unlock level |
|---|---|---|
| Cube 30 | 30 × 30 × 30 | 1 |
| Cube 35 | 35 × 35 × 35 | 4 |
| Cube 40 | 40 × 40 × 40 | 8 |
| Cube 45 | 45 × 45 × 45 | 13 |
| Cube 50 | 50 × 50 × 50 | 19 |
| Cube 55 | 55 × 55 × 55 | 26 |
| Cube 60 | 60 × 60 × 60 | 34 |
| 1 × 2 m | 200 × 100 × 80 | 45 |

Camera framing (`framingFor` in `src/scene/world.ts`) and the stand size are derived from tier dimensions, so new tiers (e.g. 90/120 cm long tanks) need only a config row.

Assets (later phases):
- Fish: GLB, ~500–3,000 tris, 1K textures, fins as flat alpha meshes.
- Furniture: prefer CC0 (Poly Haven). Every asset gets a row in `ASSETS_CREDITS.md` (link, author, license).
- Compress with Draco or Meshopt, textures to KTX2, content-hashed filenames for long-term caching, lazy-load fish and props.
- **Do not host GLBs on Supabase Storage** (free-tier bandwidth is low). Serve from Vercel static/CDN or another CDN.

## Backend rules (mandatory)

- Supabase Postgres, region **Singapore** (`ap-southeast-1`), Supabase Auth (email + password).
- **RLS on every table.** Players can only read their own rows.
- **Clients never write level, XP, coins, tanks or fish directly.** Tables are `SELECT`-only for `authenticated`; all mutations go through `SECURITY DEFINER` RPCs that validate everything server-side (e.g. level check in `unlock_tank`).
- **No cron per tank.** Store `last_tick_at`; hunger/dirt/health are computed from elapsed time when the player returns (`private.tick_tank`). The client projects the same formula for display only (`projectTank`).
- Static data (`game_settings`, `tank_tiers`, `species`) is separate from player data (`profiles`, `tanks`, `tank_fish`).
- Internal helpers live in schema `private` (not exposed by PostgREST, no grants).
- **No secrets in the repo.** Only the public URL + publishable/anon key go to the client (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`); `.env*` is git-ignored.

### RPCs

| RPC | Does |
|---|---|
| `get_state()` | creates profile + starter tank on first call, ticks all tanks, returns full state |
| `unlock_tank(p_tier_id)` | requires `level >= unlock_level` and coins; creates tank (+ starter fish for now), makes it active |
| `select_tank(p_tank_id)` | switch active tank (must own it) |
| `feed_tank(p_tank_id)` | +food; XP/coins only if food was below `feed_reward_below` (anti-spam) |
| `change_water(p_tank_id)` | cleanliness = 100; XP/coins only if it was below `water_reward_below` |

## Layout

```
config/game.json            all tunable game data
src/main.ts                 app controller (state, actions)
src/game/backend.ts         Supabase RPC client (+ offline demo backend when env vars are missing)
src/game/types.ts           types + client-side tick projection
src/scene/world.ts          renderer, camera framing + transitions
src/scene/room.ts           placeholder room (primitives), stand that resizes with the tank
src/scene/tank.ts           glass/water/sand/rocks/light + fish container + food pellets
src/scene/fish.ts           procedural placeholder fish + swim-wave shader
src/ui/                     HUD, auth card, styles
supabase/migrations/        schema/RLS/RPC + generated static data
supabase/tests/             SQL tests (run on plain Postgres via local_shim.sql)
scripts/                    gen-static, local DB test runner, live API attack test, screenshots
```

## Commands

- `npm run dev` / `npm run build` — without env vars the app runs in **demo mode** (`?demoLevel=N` sets the level; nothing is saved).
- `npm run test:db` — needs a local Postgres (`PGHOST/PGPORT/PGUSER`); applies migrations to a throwaway DB and runs `supabase/tests/rpc_security_test.sql`.
- `npm run test:api` — runs against the real project: signs in test users and tries to cheat via direct REST/RPC calls (must all be rejected). Needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, test user credentials in env.

## Working rules

- Ask the owner before creating anything that may cost money or cannot be undone (Supabase project, Vercel deploy, domains, paid plans).
- Never claim something is done without running it. Report: done / tested / blocked.
- Phase 1 (this skeleton) is sequential in one thread. After approval, phase 2 splits into parallel streams (scene & camera, gameplay & backend, asset pipeline).

## Open questions (asked 2026-11-08, see answers below when given)

1. Realistic direction (small tanks: clownfish, gobies, shrimp; tangs only in big tanks; add long 90/120 cm tanks) or keep all three tangs in every tank? Real tangs need far bigger tanks than 30–60 cm cubes.
2. Is the 1 × 2 m tank the final tier?
3. Desktop only or phones too? Monetization planned? (Vercel Hobby forbids commercial use.)
