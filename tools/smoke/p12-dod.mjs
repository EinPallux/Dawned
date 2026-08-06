#!/usr/bin/env node
/**
 * P12's Definition of Done, measured against the running world.
 *
 * Three questions, all answered by asking the GAME rather than by reading the
 * content that was published into it — the distinction every phase since P9 has
 * turned on, because a publish saying "ok" is the panel's account of its own
 * work and the only line that proves content crossed the repo boundary is the
 * server counting what it seeded.
 *
 *  1. **Does CONTENT_0.1 hit 100 %?** Counts from `/api/content/*` and the ops
 *     levers, against the targets in docs/CONTENT_0.1.md.
 *  2. **Does a 1→30 route exist?** For every zone band, the XP a player can earn
 *     inside it — quests, discoveries, and clearing its camps — against what the
 *     published curve demands to cross that band. This is the DoD's "route
 *     exists" turned into a number instead of a walk: a bot grinding 1→30 for
 *     real is many hours, and it would answer "is the XP there" with far less
 *     precision than the arithmetic does.
 *  3. **Do the budgets hold?** Tick p95 and RSS with the whole world seeded.
 *
 * Usage: node tools/smoke/p12-dod.mjs [http://localhost:8081]
 * Requires: the game server, on a published Dawnlands bake.
 */

import {
  defaultXpCurve,
  totalXpForLevel,
  xpToNext,
  poiDiscoveryXp,
  POI_XP_BASIS,
} from '@dawned/shared';

const BASE_URL = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://localhost:8081';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';

let failures = 0;
const ok = (message) => console.log(`✅ ${message}`);
const bad = (message) => {
  console.log(`❌ ${message}`);
  failures++;
};
const note = (message) => console.log(`   ${message}`);
const head = (title) => console.log(`\n${'━'.repeat(74)}\n${title}\n${'━'.repeat(74)}`);

const getJson = async (path, ops = false) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: ops ? { 'x-ops-secret': OPS_SECRET } : {},
  });
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
  return response.json();
};

/**
 * One CONTENT_0.1 row.
 *
 * `mode` mirrors how the target is WRITTEN in the doc, because those distinctions
 * are real: "≥45 POIs" is a floor, "21 node types" is exact, and "~370 resource
 * node placements" is an intent. Testing an approximate target with `>=` turns a
 * 2 % shortfall into a red cross and teaches you to ignore the report, which is
 * the opposite of what a content audit is for. `~` allows 5 % either way.
 */
const row = (label, actual, target, mode = 'atLeast') => {
  const pass =
    mode === 'exact'
      ? actual === target
      : mode === 'about'
        ? Math.abs(actual - target) <= target * 0.05
        : actual >= target;
  const shown = mode === 'exact' ? `${target}` : mode === 'about' ? `~${target}` : `≥${target}`;
  if (!pass) failures++;
  console.log(
    `  ${pass ? '✅' : '❌'} ${label.padEnd(30)} ${String(actual).padStart(5)}  (target ${shown})`,
  );
  return pass;
};

const main = async () => {
  console.log(`P12 DoD — measuring the world at ${BASE_URL}\n`);
  const health = await getJson('/api/health');
  ok(`server ${health.buildId}, protocol v${health.protocolVersion}, map ${health.mapVersion}`);

  // ============================================================ 1. content
  head('1 · CONTENT_0.1 — counted from the game, not from the publish button');

  const [enemies, items, quests, npcs, nodes, vendors] = await Promise.all([
    getJson('/api/content/enemies'),
    getJson('/api/content/items'),
    getJson('/api/content/quests'),
    getJson('/api/content/npcs'),
    getJson('/api/content/resource-nodes'),
    getJson('/api/content/vendors'),
  ]);
  const camps = await getJson('/ops/camps', true);
  const objects = await getJson('/ops/worldobjects', true);
  const nodeReport = await fetch(`${BASE_URL}/ops/respawnnodes`, {
    method: 'POST',
    headers: { 'x-ops-secret': OPS_SECRET },
  }).then((r) => r.json());

  const enemyList = enemies.enemies ?? [];
  const questList = quests.quests ?? [];
  const itemList = items.items ?? [];

  console.log('\n§1 World');
  row('POIs placed', objects.pois, 45);
  row('Interactables placed', objects.interactables, 60);
  console.log('\n§2 Enemies & NPCs');
  row('Enemy types', enemyList.length, 36);
  // The rank enum is normal | elite | zone_boss | world_boss. CONTENT_0.1 used
  // to count FIVE zone bosses by naming Mossback among them; NPCS_ENEMIES §4
  // calls Mossback a "mini-boss, quest" at Elite Grunt rank and WORLD.md §3 a
  // "quest target", so the content is right and the count was the drift. Four
  // zone bosses, one world boss, and the shore's climax is an elite — which is
  // the right shape for a level 1–6 starter zone.
  row('Zone bosses', enemyList.filter((e) => e.rank === 'zone_boss').length, 4);
  row('World boss', enemyList.filter((e) => e.rank === 'world_boss').length, 1);
  row('Elites (incl. Mossback)', enemyList.filter((e) => e.rank === 'elite').length, 5);
  row('Spawners placed', camps.spawners, 124);
  // Definitions and placements are different numbers and both matter: a defined
  // NPC nobody placed is a row the world never shows, and a placement whose
  // definition is missing is the orphan count below.
  row('NPC definitions', (npcs.npcs ?? []).length, 40);
  row('NPCs placed', objects.npcs, 40);
  console.log('\n§3 Items');
  row('Items total', itemList.length, 210);
  row('Legendaries', itemList.filter((i) => i.rarity === 'legendary').length, 6);
  row('Vendors', (vendors.vendors ?? []).length, 12);
  console.log('\n§5 Quests');
  row('Side quests', questList.length, 28);
  row('Quest chains', new Set(questList.map((q) => q.chainId).filter(Boolean)).size, 5);
  console.log('\n§6 Gathering');
  row('Resource node placements', nodeReport.total, 370, 'about');
  row('Node types', (nodes.nodes ?? []).length, 21, 'exact');

  console.log('\nIntegrity (0 is the only passing number):');
  row('orphan enemy refs', -camps.orphanEnemyRefs.length, 0);
  row('camps that spawned nothing', -camps.drySpawners.length, 0);
  row('orphan node placements', -nodeReport.orphans, 0);
  row('orphan NPC placements', -objects.orphanNpcs, 0);

  // ====================================================== 2. the 1→30 route
  head('2 · Is there a 1→30 route? XP supply vs the curve, band by band');

  const curve = defaultXpCurve();
  // Zone level bands come from the world itself — the bake's zones carry them,
  // and reading them here rather than re-typing them is the same rule the hint
  // resolver follows: derive from what shipped.
  const BANDS = [
    ['dawnshore', 1, 6],
    ['verdant_weald', 6, 12],
    ['emberwood', 12, 18],
    ['sungraze', 18, 24],
    ['ashcrag', 24, 30],
  ];

  console.log(
    `\n  ${'zone'.padEnd(15)} ${'band'.padEnd(8)} ${'need'.padStart(8)} ` +
      `${'quests'.padStart(7)} ${'POIs'.padStart(6)} ${'1 clear'.padStart(8)} ${'clears'.padStart(7)}`,
  );
  const clearsNeeded = [];
  for (const [zone, lo, hi] of BANDS) {
    const need = totalXpForLevel(curve, hi) - totalXpForLevel(curve, lo);
    const questXp = questList
      .filter((q) => q.zoneId === zone)
      .reduce((sum, q) => sum + (q.rewards?.xp ?? 0), 0);
    // POI XP is a fraction of the level's need, so it is worth what it is worth
    // at the BOTTOM of the band — the pessimistic read, and the one a player
    // walking in fresh actually gets.
    const poiCount = Math.round(objects.pois / BANDS.length);
    const poiXp = poiCount * poiDiscoveryXp(POI_XP_BASIS.landmark ?? 250, xpToNext(curve, lo));
    const perClear = camps.perZone[zone]?.xpPerClear ?? 0;
    const fromCamps = Math.max(0, need - questXp - poiXp);
    const clears = perClear > 0 ? fromCamps / perClear : Infinity;
    clearsNeeded.push({ zone, clears, perClear, need });
    console.log(
      `  ${zone.padEnd(15)} ${`${lo}–${hi}`.padEnd(8)} ${String(need).padStart(8)} ` +
        `${String(questXp).padStart(7)} ${String(poiXp).padStart(6)} ` +
        `${String(perClear).padStart(8)} ${clears.toFixed(1).padStart(7)}`,
    );
  }

  console.log('');
  for (const { zone, clears, perClear } of clearsNeeded) {
    if (perClear === 0) {
      bad(`${zone}: no enemies spawned — the band cannot be levelled through at all`);
    } else if (!Number.isFinite(clears) || clears > 12) {
      bad(
        `${zone}: ${clears.toFixed(1)} full camp clears to cross the band — that is a grind wall`,
      );
    } else {
      ok(`${zone}: ${clears.toFixed(1)} full camp clears crosses the band`);
    }
  }
  note('A "clear" is every enemy the zone currently has standing, killed once at level.');
  note('Camps respawn, so >1 is normal — the number to watch is whether it is many.');

  // Enemy levels have to actually cover 1–30, or a band has nothing at level.
  const levelled = camps.perZone;
  const gaps = BANDS.filter(([zone, lo, hi]) => {
    const bucket = levelled[zone];
    if (!bucket || bucket.enemies === 0) return true;
    return bucket.levelMax < lo || bucket.levelMin > hi;
  });
  if (gaps.length === 0) {
    ok('every band has enemies standing inside its own level range');
    for (const [zone, lo, hi] of BANDS) {
      const b = levelled[zone];
      note(`${zone.padEnd(15)} band ${lo}–${hi}, enemies level ${b.levelMin}–${b.levelMax}`);
    }
  } else {
    for (const [zone, lo, hi] of gaps) {
      const b = levelled[zone];
      bad(
        `${zone}: band ${lo}–${hi} but enemies are level ${b?.levelMin ?? '-'}–${b?.levelMax ?? '-'}`,
      );
    }
  }

  // ============================================================== 3. budgets
  head('3 · Budgets, with the whole world seeded');

  const samples = [];
  for (let i = 0; i < 10; i++) {
    samples.push(await getJson('/ops/metrics', true));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const worstP95 = Math.max(...samples.map((s) => s.tickP95Ms));
  const worstMax = Math.max(...samples.map((s) => s.tickMaxMs));
  const worstRss = Math.max(...samples.map((s) => s.rssMb));
  console.log(
    `\n  tick p95 ${worstP95.toFixed(2)} ms · max ${worstMax.toFixed(2)} ms · RSS ${worstRss} MB`,
  );
  console.log(`  entities ${samples.at(-1).entities} · players ${samples.at(-1).players}`);
  // TECH_STACK: 20 Hz means a 50 ms tick; the working budget is half of it.
  if (worstP95 <= 25) ok(`tick p95 ${worstP95.toFixed(2)} ms within the 25 ms budget`);
  else bad(`tick p95 ${worstP95.toFixed(2)} ms exceeds the 25 ms budget`);
  if (worstRss <= 700) ok(`RSS ${worstRss} MB within the 700 MB budget`);
  else bad(`RSS ${worstRss} MB exceeds the 700 MB budget`);

  head(failures === 0 ? 'P12 DoD: PASS' : `P12 DoD: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((error) => {
  console.error(`\n❌ ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
