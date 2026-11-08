// Live security test against the real Supabase project, using raw HTTP calls
// exactly like a cheating client would (no supabase-js, no UI).
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY,
//      TEST_EMAIL_A, TEST_PASSWORD_A, TEST_EMAIL_B, TEST_PASSWORD_B
// Exit code 0 only if every cheat attempt is rejected and legit calls work.

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
const need = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'TEST_EMAIL_A', 'TEST_PASSWORD_A', 'TEST_EMAIL_B', 'TEST_PASSWORD_B'];
for (const k of need) if (!process.env[k]) { console.error(`missing env ${k}`); process.exit(2); }

let failures = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); };

async function call(method, path, { token, body, prefer } = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  headers.Authorization = `Bearer ${token ?? KEY}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function signIn(email, password) {
  const r = await call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
  if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.access_token, id: r.json.user.id };
}

const rpc = (fn, token, body = {}) => call('POST', `/rest/v1/rpc/${fn}`, { token, body });
const rejected = (r) => r.status >= 400 || (Array.isArray(r.json) && r.json.length === 0);

async function main() {
  const A = await signIn(process.env.TEST_EMAIL_A, process.env.TEST_PASSWORD_A);
  const B = await signIn(process.env.TEST_EMAIL_B, process.env.TEST_PASSWORD_B);

  console.log('\nLegit calls');
  const s1 = await rpc('get_state', A.token);
  if (s1.status === 200 && s1.json.profile?.user_id === A.id) ok(`get_state works (level ${s1.json.profile.level}, ${s1.json.tanks.length} tank(s))`);
  else return bad('get_state', JSON.stringify(s1));
  const level0 = s1.json.profile.level;
  const coins0 = s1.json.profile.coins;
  const tanks0 = s1.json.tanks.map((t) => t.tier_id).sort().join(',');
  await rpc('get_state', B.token);

  console.log('\nCheat: upgrade the tank above level / without coins through the RPC');
  const tiers = (await call('GET', '/rest/v1/tank_tiers?select=id,unlock_level,unlock_cost_coins&order=sort_order', {})).json;
  for (const t of tiers.filter((t) => t.unlock_level > level0)) {
    const r = await rpc('upgrade_tank', A.token, { p_tier_id: t.id });
    if (r.status >= 400 && /level_too_low/.test(JSON.stringify(r.json))) ok(`upgrade_tank('${t.id}') at level ${level0} -> ${r.status} level_too_low`);
    else bad(`upgrade_tank('${t.id}') should be rejected`, `${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const t of tiers.filter((t) => t.unlock_level <= level0 && t.unlock_cost_coins > coins0 && t.id !== s1.json.tanks[0].tier_id)) {
    const r = await rpc('upgrade_tank', A.token, { p_tier_id: t.id });
    if (r.status >= 400 && /not_enough_coins|not_an_upgrade/.test(JSON.stringify(r.json))) ok(`upgrade_tank('${t.id}') with ${coins0} coins -> ${r.status} ${r.json.message.split(':')[0]}`);
    else bad(`upgrade_tank('${t.id}') should be rejected`, `${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const fn of ['unlock_tank', 'select_tank']) {
    const r = await rpc(fn, A.token, fn === 'unlock_tank' ? { p_tier_id: 'cube35' } : { p_tank_id: s1.json.tanks[0].id });
    if (r.status >= 400) ok(`removed rpc/${fn} -> ${r.status}`);
    else bad(`rpc/${fn} should be gone`, `${r.status} ${JSON.stringify(r.json)}`);
  }

  console.log('\nCheat: write player tables directly (PostgREST)');
  const attempts = [
    ['PATCH profiles level=99', () => call('PATCH', `/rest/v1/profiles?user_id=eq.${A.id}`, { token: A.token, body: { level: 99 }, prefer: 'return=representation' })],
    ['PATCH profiles coins=999999', () => call('PATCH', `/rest/v1/profiles?user_id=eq.${A.id}`, { token: A.token, body: { coins: 999999 }, prefer: 'return=representation' })],
    ['POST tanks big200', () => call('POST', '/rest/v1/tanks', { token: A.token, body: { user_id: A.id, tier_id: 'big200' }, prefer: 'return=representation' })],
    ['POST tank_fish', () => call('POST', '/rest/v1/tank_fish', { token: A.token, body: { tank_id: s1.json.tanks[0].id, user_id: A.id, species_id: 'achilles_tang' }, prefer: 'return=representation' })],
    ['DELETE tank_fish', () => call('DELETE', `/rest/v1/tank_fish?user_id=eq.${A.id}`, { token: A.token, prefer: 'return=representation' })],
    ['PATCH tanks food=100 health=100', () => call('PATCH', `/rest/v1/tanks?user_id=eq.${A.id}`, { token: A.token, body: { food: 100, health: 100 }, prefer: 'return=representation' })],
    ['PATCH tank_tiers unlock_level=1', () => call('PATCH', '/rest/v1/tank_tiers?id=eq.big200', { token: A.token, body: { unlock_level: 1 }, prefer: 'return=representation' })],
    ['PATCH game_settings', () => call('PATCH', '/rest/v1/game_settings?id=eq.1', { token: A.token, body: { data: {} }, prefer: 'return=representation' })],
    ['POST profiles for B', () => call('POST', '/rest/v1/profiles', { token: A.token, body: { user_id: B.id, level: 99 }, prefer: 'return=representation' })],
  ];
  for (const [name, fn] of attempts) {
    const r = await fn();
    if (rejected(r)) ok(`${name} -> ${r.status} ${r.json?.message ?? ''}`.trim());
    else bad(`${name} should be rejected`, `${r.status} ${JSON.stringify(r.json)}`);
  }

  console.log('\nCheat: call internal helpers');
  for (const fn of ['add_xp', 'ensure_player', 'tick_tank', 'setting']) {
    const r = await rpc(fn, A.token, { p_user: A.id, p_xp: 100000, p_coins: 0 });
    if (r.status >= 400) ok(`rpc/${fn} -> ${r.status}`);
    else bad(`rpc/${fn} should not be reachable`, `${r.status} ${JSON.stringify(r.json)}`);
  }

  console.log('\nCheat: act on another player\'s tank / read their data');
  const sB = (await rpc('get_state', B.token)).json;
  for (const fn of ['feed_tank', 'change_water']) {
    const r = await rpc(fn, A.token, { p_tank_id: sB.tanks[0].id });
    if (r.status >= 400) ok(`${fn}(B's tank) as A -> ${r.status}`);
    else bad(`${fn}(B's tank) should be rejected`, `${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const table of ['profiles', 'tanks', 'tank_fish']) {
    const r = await call('GET', `/rest/v1/${table}?select=user_id`, { token: A.token });
    const others = Array.isArray(r.json) ? r.json.filter((x) => x.user_id !== A.id) : null;
    if (r.status === 200 && others && others.length === 0) ok(`A sees only own ${table} rows (${r.json.length})`);
    else bad(`A must not see others' ${table}`, `${r.status} ${JSON.stringify(r.json)}`);
  }

  console.log('\nCheat: anonymous (no login)');
  for (const fn of ['get_state', 'upgrade_tank']) {
    const r = await rpc(fn, undefined, fn === 'upgrade_tank' ? { p_tier_id: 'cube35' } : {});
    if (r.status >= 400) ok(`anon rpc/${fn} -> ${r.status}`);
    else bad(`anon rpc/${fn} should be rejected`, `${r.status} ${JSON.stringify(r.json)}`);
  }
  const anonProfiles = await call('GET', '/rest/v1/profiles?select=user_id', {});
  if (rejected(anonProfiles)) ok(`anon GET profiles -> ${anonProfiles.status}`);
  else bad('anon must not read profiles', JSON.stringify(anonProfiles));

  console.log('\nState unchanged after all cheat attempts (persistence check)');
  const s2 = (await rpc('get_state', A.token)).json;
  const tanks2 = s2.tanks.map((t) => t.tier_id).sort().join(',');
  if (s2.profile.level === level0 && s2.profile.coins === coins0 && tanks2 === tanks0) ok(`level ${s2.profile.level}, coins ${s2.profile.coins}, tanks [${tanks2}] unchanged`);
  else bad('state changed!', `before L${level0} ${coins0}c [${tanks0}] after L${s2.profile.level} ${s2.profile.coins}c [${tanks2}]`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL API SECURITY CHECKS PASSED');
}

main().then(() => process.exit(failures ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
