/**
 * Production never serves the dev island.
 *
 * `assets_baked/map/dev-2` is COMMITTED — 8.7 MB of test island that ships to
 * the VPS with every `git pull`. The pointer that says which world is live
 * (`current.json`) is machine state and is not in git, so on a real box the
 * dev island is the thing sitting there when the pointer is missing.
 *
 * Both halves used to fall back to it silently: the server when `current.json`
 * could not be read, and the client when the health request failed. Either one
 * produces a game that looks like the update did nothing — which is exactly how
 * P12-H was found — and together they can put two players on different worlds.
 *
 * Owner, 2026-08-06: "No Dev Server, No Dev Instance, No Dev Island, nothing."
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAP_VERSION } from '@dawned/shared';
import { resolveMapVersion } from './terrain.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dawned-map-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveMapVersion', () => {
  it('reads the published pointer', async () => {
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({ version: 'map-1786008720' }));
    expect(await resolveMapVersion(dir)).toBe('map-1786008720');
    expect(await resolveMapVersion(dir, { allowDevFallback: false })).toBe('map-1786008720');
  });

  it('falls back to the dev island in a dev checkout', async () => {
    expect(await resolveMapVersion(dir)).toBe(MAP_VERSION);
  });

  it('REFUSES the dev island in production, and says how to fix it', async () => {
    await expect(resolveMapVersion(dir, { allowDevFallback: false })).rejects.toThrow(
      /No published world/,
    );
    await expect(resolveMapVersion(dir, { allowDevFallback: false })).rejects.toThrow(/ROLLBACK/);
  });

  it('refuses a pointer that is present but corrupt', async () => {
    // A full disk truncates a file mid-write; that must not read as "no world,
    // use the dev one" either.
    await writeFile(path.join(dir, 'current.json'), '{"version":');
    await expect(resolveMapVersion(dir, { allowDevFallback: false })).rejects.toThrow(
      /No published world/,
    );
  });
});

describe('the client does not guess which world it is on', () => {
  it('has no fallback on the health call', () => {
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../client/src/game/run-world.ts',
      ),
      'utf8',
    );
    const block = source.slice(source.indexOf('api\n    .health()'));
    const openCall = block.slice(0, block.indexOf('.then(async ({ zones })'));
    // A `.catch` between health() and open() is the bug: it hands `undefined`
    // to MapSource, which then streams the compiled-in dev version.
    expect(openCall).not.toMatch(/\.catch\(/);
    expect(openCall).toContain('mapSource.open(serverVersion)');
  });
});
