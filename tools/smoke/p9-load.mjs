#!/usr/bin/env node
/**
 * P9-E AI CPU budget run (TECH_STACK.md §"Server": tick p95 ≤ 25 ms at 20 Hz
 * with 20 players + 150 active AI).
 *
 * The published bestiary stands up 51 enemies, so the run tops the world up to
 * the budget number with transient `/ops/spawnwave` waves — enemies that never
 * respawn, so the world is exactly as the owner authored it again afterwards.
 * Then it drives the bot swarm through the camps and reads the SERVER's own
 * tick histogram from `/ops/metrics`, which is the number the budget is about.
 *
 * Two phases, both measured:
 *   idle   — 150 AI, 20 players wandering: the resting cost of the population.
 *   combat — the same swarm parked inside the waves so the AI is in COMBAT,
 *            deciding, steering, swinging and resolving every tick. This is
 *            the number that matters; idle AI is cheap by construction.
 *
 * Needs: game server on :8081 (fresh dist) and the migrated dev Postgres.
 * Usage: node tools/smoke/p9-load.mjs [--bots 20] [--enemies 150] [--seconds 45]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? Number(process.argv[index + 1]) : fallback;
};

const BASE_URL = process.env.SMOKE_API ?? 'http://127.0.0.1:8081';
const OPS_SECRET = process.env.OPS_SECRET ?? 'dev-only-ops-secret-change-me';
const BOTS = arg('bots', 20);
const TARGET_AI = arg('enemies', 150);
const SECONDS = arg('seconds', 45);

/** TECH_STACK.md's server budget. */
const TICK_P95_BUDGET_MS = 25;
const RSS_BUDGET_MB = 700;

/**
 * Where the waves stand. Deliberately spread over three of the live camps so
 * the AOI grid, the camp index and social aggro all carry realistic load
 * rather than one giant heap in a single cell.
 */
const WAVE_SITES = [
  { enemyId: 'enemy_shore_glub', x: 0, z: 330, radius: 18 },
  { enemyId: 'enemy_young_mushnub', x: -14, z: 244, radius: 18 },
  { enemyId: 'enemy_weald_frog', x: -4, z: 213, radius: 18 },
];

const ok = (message) => console.log(`✅ ${message}`);
const note = (message) => console.log(`   ${message}`);
const fail = (message) => {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ops = async (route, body) => {
  const response = await fetch(`${BASE_URL}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ops-secret': OPS_SECRET },
    body: JSON.stringify(body),
  });
  if (!response.ok) fail(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json();
};

const metrics = async () => {
  const response = await fetch(`${BASE_URL}/ops/metrics`, {
    headers: { 'x-ops-secret': OPS_SECRET },
  });
  if (!response.ok) fail(`/ops/metrics failed: ${response.status}`);
  return response.json();
};

/**
 * Sample the server's histogram over a window and keep the WORST p95 seen.
 * A single reading at the end can miss the spike the run was built to find.
 */
const watch = async (seconds, label) => {
  const worst = { tickP95Ms: 0, tickMaxMs: 0, rssMb: 0, entities: 0, players: 0 };
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const m = await metrics();
    worst.tickP95Ms = Math.max(worst.tickP95Ms, m.tickP95Ms);
    worst.tickMaxMs = Math.max(worst.tickMaxMs, m.tickMaxMs);
    worst.rssMb = Math.max(worst.rssMb, m.rssMb);
    worst.entities = Math.max(worst.entities, m.entities);
    worst.players = Math.max(worst.players, m.players);
  }
  note(
    `${label}: ${worst.entities} AI · ${worst.players} players · ` +
      `tick p95 ${worst.tickP95Ms.toFixed(2)} ms · max ${worst.tickMaxMs.toFixed(2)} ms · ` +
      `RSS ${worst.rssMb} MB`,
  );
  return worst;
};

const main = async () => {
  console.log(`\nP9 AI budget run — ${TARGET_AI} active AI + ${BOTS} players\n`);

  const before = await metrics();
  note(`world starts with ${before.entities} published enemies`);

  // ------------------------------------------------------- top up to budget
  let need = TARGET_AI - before.entities;
  if (need > 0) {
    const per = Math.ceil(need / WAVE_SITES.length);
    for (const site of WAVE_SITES) {
      if (need <= 0) break;
      const count = Math.min(per, need);
      await ops('/ops/spawnwave', { ...site, count });
      need -= count;
    }
  }
  await sleep(1500);
  const staged = await metrics();
  if (staged.entities < TARGET_AI) {
    fail(`only ${staged.entities} AI in the world, needed ${TARGET_AI}`);
  }
  ok(`${staged.entities} enemies active (${staged.entities - before.entities} transient wave)`);

  // ------------------------------------------------------------- swarm + run
  const here = path.dirname(fileURLToPath(import.meta.url));
  const minutes = Math.max(1, Math.ceil((SECONDS * 2 + 40) / 60));
  const swarm = spawn(
    process.execPath,
    [
      path.join(here, '..', 'bots', 'swarm.mjs'),
      '--bots',
      String(BOTS),
      '--minutes',
      String(minutes),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let swarmLog = '';
  swarm.stdout.on('data', (chunk) => (swarmLog += chunk));
  swarm.stderr.on('data', (chunk) => (swarmLog += chunk));
  const swarmExit = new Promise((resolve) => swarm.on('exit', resolve));

  // Give the bots time to log in and stream their chunks before measuring.
  await sleep(20000);
  const live = await metrics();
  if (live.players < BOTS) {
    swarm.kill();
    fail(`only ${live.players}/${BOTS} bots reached the world\n${swarmLog}`);
  }
  ok(`${live.players} bots in world`);

  const idle = await watch(SECONDS, 'idle  ');

  // Park the swarm ON the waves so the AI is in COMBAT for the second window:
  // idle AI barely costs anything, and the budget is not about idle AI.
  // Bot character names follow swarm.mjs's own scheme (`Botwanderaa`…).
  const botName = (i) =>
    `Botwander${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
  for (let i = 0; i < BOTS; i++) {
    const site = WAVE_SITES[i % WAVE_SITES.length];
    await ops('/ops/tp', { player: botName(i), x: site.x, z: site.z }).catch(() => undefined);
  }
  await sleep(4000);
  const combat = await watch(SECONDS, 'combat');

  swarm.kill();
  await swarmExit;

  // ------------------------------------------------------------------ verdict
  const worstP95 = Math.max(idle.tickP95Ms, combat.tickP95Ms);
  const worstRss = Math.max(idle.rssMb, combat.rssMb);
  console.log('');
  if (worstP95 > TICK_P95_BUDGET_MS) {
    fail(`tick p95 ${worstP95.toFixed(2)} ms exceeds the ${TICK_P95_BUDGET_MS} ms budget`);
  }
  ok(`tick p95 ${worstP95.toFixed(2)} ms — inside the ${TICK_P95_BUDGET_MS} ms budget`);
  if (worstRss > RSS_BUDGET_MB) {
    fail(`RSS ${worstRss} MB exceeds the ${RSS_BUDGET_MB} MB budget`);
  }
  ok(`RSS ${worstRss} MB — inside the ${RSS_BUDGET_MB} MB budget`);
  console.log(
    '\n⚙️  P9 AI budget run passed. The wave enemies carry no respawn ticket, so the\n' +
      '   world returns to its published population as they are killed or the\n' +
      '   server restarts.\n',
  );
};

main().catch((error) => fail(error.stack ?? String(error)));
