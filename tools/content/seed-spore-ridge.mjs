#!/usr/bin/env node
/**
 * Seed the P5 Ranged-archetype test camp (published rows): the Spore Lobber
 * (mushnub model, spore-bolt volleys + panic swat) and its camp spawner east
 * of the shore-glub corridor. Validated through the SHARED schemas before
 * insert — the same gate the server boots with. Idempotent.
 *
 * Usage: node tools/content/seed-spore-ridge.mjs
 */

import pg from 'pg';
import { enemyDefSchema, validateEnemyDef, spawnerDefSchema } from '@dawned/shared';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://dawned:dawned@127.0.0.1:5432/dawned';

const ENEMY = {
  id: 'enemy_spore_lobber',
  name: 'Spore Lobber',
  archetype: 'ranged',
  rank: 'normal',
  levelMin: 3,
  levelMax: 5,
  modelRef: 'enemies_mushnub',
  scale: 1.1,
  hitRadius: 0.5,
  hitHeight: 1.2,
  moveSpeed: 3.2,
  statOverrides: {},
  abilities: [
    {
      id: 'spore_lob',
      weight: 3,
      cooldownMs: 2400,
      rangeMin: 6,
      rangeMax: 16,
      kind: 'projectile',
      coef: 0.8,
      reach: 2.2,
      angleDeg: 90,
      projectileSpeed: 13,
      projectileRadius: 0.35,
      circleRadius: 2.5,
      windupMs: 700,
      recoverMs: 700,
      telegraph: false,
      clip: 'Jump',
    },
    {
      id: 'panic_swat',
      weight: 1,
      cooldownMs: 2000,
      rangeMin: 0,
      rangeMax: 2.2,
      kind: 'melee_arc',
      coef: 0.8,
      reach: 2.2,
      angleDeg: 100,
      projectileSpeed: 18,
      projectileRadius: 0.3,
      circleRadius: 2.5,
      windupMs: 450,
      recoverMs: 600,
      telegraph: false,
      clip: 'Punch',
    },
  ],
  aggroRadius: 14,
  leashRadius: 40,
  socialTag: 'spore_ridge',
  xpMult: 1.1,
};

const SPAWNER = {
  id: 'spawner_spore_ridge',
  kind: 'area',
  x: 16,
  z: 300,
  radius: 5,
  entries: [{ enemyId: 'enemy_spore_lobber', count: 3, level: null }],
  respawnMs: 90_000,
  campTag: 'spore_ridge',
  nightOnly: false,
};

const main = async () => {
  const enemy = enemyDefSchema.parse(ENEMY);
  const problems = validateEnemyDef(enemy);
  if (problems.length > 0) throw new Error(`enemy invalid: ${problems.join('; ')}`);
  const spawner = spawnerDefSchema.parse(SPAWNER);

  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO content_enemies (id, status, def) VALUES ($1, 'published', $2)
     ON CONFLICT (id, status) DO UPDATE SET def = $2, updated_at = now()`,
    [enemy.id, enemy],
  );
  await db.query(
    `INSERT INTO content_spawners (id, status, def) VALUES ($1, 'published', $2)
     ON CONFLICT (id, status) DO UPDATE SET def = $2, updated_at = now()`,
    [spawner.id, spawner],
  );
  await db.end();
  console.log('✅ spore ridge published (enemy_spore_lobber + spawner_spore_ridge)');
};

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
