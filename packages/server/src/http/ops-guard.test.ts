/**
 * The `/ops/*` gate, pinned as a PROPERTY rather than route by route.
 *
 * It used to be six lines copied into all nineteen handlers. All nineteen had
 * them — which is exactly the failure mode worth guarding: nothing made the
 * twentieth route carry them, and a missed one is an unauthenticated lever that
 * grants items, sets levels and teleports players. The source assertion below
 * reads the router file and fails if any `/ops/` route is declared while the
 * single `onRequest` hook that gates them is missing, so the protection cannot
 * be removed without a test going red.
 *
 * The config assertions cover the other half: production must not boot on the
 * secret that is written down in this repository.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(resolve(here, 'routes.ts'), 'utf8');

const PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://real:real@10.0.0.1:5432/dawned',
  SESSION_PEPPER: 'x'.repeat(32),
};

describe('the /ops gate is structural, not per-handler', () => {
  it('declares ops routes and gates them in exactly one place', () => {
    const opsRoutes = routes.match(/app\.(get|post)\('\/ops\//g) ?? [];
    expect(opsRoutes.length).toBeGreaterThan(10);

    // One hook, matching every /ops/ URL, checking both localhost and the secret.
    const hook = routes.match(/addHook\('onRequest'[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(hook).toContain("startsWith('/ops/')");
    expect(hook).toContain('LOCALHOST');
    expect(hook).toContain('secretMatches');

    // And NO handler carries its own copy any more — a copy is how the rule
    // drifts, and how a route ends up with a stale version of it.
    expect(routes.match(/ops API is localhost-only/g)).toHaveLength(1);
    expect(routes.match(/bad ops secret/g)).toHaveLength(1);
  });

  it('compares the secret in constant time', () => {
    // `!==` on a secret leaks its length and a matching prefix through timing.
    expect(routes).toContain('timingSafeEqual');
    expect(routes).not.toMatch(/x-ops-secret'\]\s*!==/);
  });
});

describe('production refuses development secrets', () => {
  it('boots with a real ops secret', () => {
    const config = loadConfig({ ...PROD_ENV, OPS_SECRET: 'a'.repeat(64) });
    expect(config.NODE_ENV).toBe('production');
  });

  it('refuses the default ops secret, which is public', () => {
    expect(() => loadConfig({ ...PROD_ENV, OPS_SECRET: 'dev-only-ops-secret-change-me' })).toThrow(
      /OPS_SECRET must be set explicitly/,
    );
  });

  it('still allows the default outside production', () => {
    expect(() =>
      loadConfig({
        ...PROD_ENV,
        NODE_ENV: 'development',
        OPS_SECRET: 'dev-only-ops-secret-change-me',
      }),
    ).not.toThrow();
  });
});
