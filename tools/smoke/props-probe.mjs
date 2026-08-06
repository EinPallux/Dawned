/**
 * Do the authored world's STATIC layers reach the screen?
 *
 * The owner's report: "I only see the NPCs + the Waypoint, nothing else but
 * there are some invisible bounding boxes." The cause was that nothing in the
 * client ever read `placements.props` or `placements.scatter` — the bake stamps
 * every solid prop into the walkgrid, so a town was collision with no mesh —
 * and `loadPropModels` did not even load the `world/buildings` category.
 *
 * This probe answers the question the way it was asked: it walks to where the
 * bake says buildings stand and checks that the client BUILT them, then takes a
 * picture. It reads the live bake rather than hard-coding coordinates, so it
 * keeps working when the owner moves a town.
 *
 * Usage: node tools/smoke/props-probe.mjs [--screenshots DIR]
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { ensureAccount, ensureCharacter } from './lib/fixtures.mjs';

const BASE_URL = process.env.DAWNED_URL ?? 'http://127.0.0.1:8081';
const CLIENT_URL = process.env.DAWNED_CLIENT_URL ?? 'http://127.0.0.1:5173';
const ACCOUNT = 'zz_props_probe';
const PASSWORD = 'props-probe-pass-1';
const CHARACTER = 'Propscout';

const shotIndex = process.argv.indexOf('--screenshots');
const SHOTS = shotIndex >= 0 ? process.argv[shotIndex + 1] : null;

const ok = (msg) => console.log(`✅ ${msg}`);
const note = (msg) => console.log(`   ${msg}`);
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

const shoot = async (page, name) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
};

const run = async () => {
  const token = await ensureAccount(BASE_URL, ACCOUNT, PASSWORD);
  await ensureCharacter(BASE_URL, token, CHARACTER, 'warrior');

  const health = await (await fetch(`${BASE_URL}/api/health`)).json();
  const placements = await (
    await fetch(`${CLIENT_URL}/assets/map/${health.mapVersion}/placements.json`)
  ).json();
  const props = placements.props ?? [];
  const scatter = placements.scatter ?? [];
  note(`bake ${health.mapVersion}: ${props.length} props, ${scatter.length} scatter row(s)`);
  if (props.length === 0 && scatter.length === 0) {
    fail('this bake has no props and no scatter — nothing to prove (bake a world with a town)');
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript((t) => {
    localStorage.setItem('dawned.token', t);
  }, token);

  try {
    await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.char-card', { timeout: 60000 });
    await page.click(`.char-card:has-text("${CHARACTER}")`);
    await page.getByText('ENTER WORLD', { exact: true }).click();
    await page.waitForSelector('.hud', { timeout: 60000 });
    await page.waitForFunction(() => window.__dawned?.connection?.status === 'playing', null, {
      timeout: 60000,
    });
    ok('in world');

    // Stand where the props are: they seat only once their chunk has streamed,
    // which is the whole point of the lazy path being tested.
    const target = props[0] ?? { x: 0, z: 0 };
    await page.evaluate(
      async ({ x, z, url }) => {
        await fetch(`${url}/ops/tp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ops-secret': 'dev-only-ops-secret-change-me',
          },
          body: JSON.stringify({ player: 'Propscout', x, z }),
        }).catch(() => {});
      },
      { x: target.x, z: target.z, url: BASE_URL },
    );
    // Wait for the BUILD, not for a stopwatch. The static layers arrive after
    // the map artifacts, the walkgrid, the nodes and the villagers — on a slow
    // box that is well past any fixed sleep, and a probe that samples early
    // reports "the client placed NONE" for a client that was still loading.
    await page
      .waitForFunction(
        () => {
          const s = window.__dawned?.mapProps?.stats?.();
          return !!s && s.props + s.pendingProps > 0;
        },
        null,
        { timeout: 120000 },
      )
      .catch(() => {});
    // Then let the seating pass run: props seat as their chunks stream.
    await page.waitForTimeout(8000);

    const stats = await page.evaluate(() => window.__dawned?.mapProps?.stats?.() ?? null);
    if (!stats) fail('window.__dawned.mapProps is not exposed — the manager never built');
    note(
      `placed: ${stats.props} prop(s), ${stats.scatter} scatter instance(s); ` +
        `${stats.pendingProps} still waiting for ground`,
    );
    if (stats.missingModels.length > 0) {
      fail(`models the client could not load: ${stats.missingModels.join(', ')}`);
    }
    if (stats.props === 0 && props.length > 0) {
      fail(`the bake has ${props.length} props and the client placed NONE`);
    }
    ok(`${stats.props} of ${props.length} props are in the scene`);

    await shoot(page, 'props-01-town.png');

    // A second look from a distance: instanced batches with a wrong bounding
    // sphere vanish when the camera moves, which a single close-up would miss.
    await page.keyboard.down('s');
    await page.waitForTimeout(2500);
    await page.keyboard.up('s');
    const after = await page.evaluate(() => window.__dawned?.mapProps?.stats?.() ?? null);
    note(`after walking back: ${after.props} prop(s) still placed`);
    await shoot(page, 'props-02-from-afar.png');

    const fatal = errors.filter((e) => !/favicon|WebGL|SwiftShader/i.test(e));
    if (fatal.length > 0) fail(`client errors:\n  ${fatal.slice(0, 5).join('\n  ')}`);
    ok('no client errors');
    console.log('\n🏘️  The authored world is visible.\n');
  } finally {
    await browser.close();
  }
};

run().catch((error) => fail(String(error)));
