/**
 * Pins the production serving contracts in deploy/Caddyfile that broke in real
 * playtests and that nothing else exercises (dev serves without Caddy, so these
 * regress silently until someone deploys):
 *
 *  - connect-src must allow blob: — three.js GLTFLoader fetch()es GLB-embedded
 *    textures via blob: URLs; without it the world renders untextured white.
 *  - the admin block must be handle_path (strip /admin) — the panel is built
 *    against stripped paths; plain `handle` makes its SPA fallback answer
 *    asset requests with index.html and the panel renders a blank page.
 *  - font-src must be declared 'self' — both apps ship fonts as same-origin
 *    files; leaving fonts to default-src invites data:-URI regressions.
 *  - manifest.json and index.html must never be cache-immutable, or players
 *    keep resolving assets that no longer exist after a deploy.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const caddyfilePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../deploy/Caddyfile');
const caddyfile = readFileSync(caddyfilePath, 'utf8');
/** The Caddyfile minus comment lines, so assertions can't match dead text. */
const active = caddyfile
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

const cspLine = active.split('\n').find((line) => line.includes('Content-Security-Policy'));

describe('deploy/Caddyfile production contracts', () => {
  it('declares exactly one active Content-Security-Policy', () => {
    const count = active
      .split('\n')
      .filter((line) => line.includes('Content-Security-Policy')).length;
    expect(count).toBe(1);
    expect(cspLine).toBeDefined();
  });

  it('CSP connect-src allows blob: (GLB-embedded texture fetches)', () => {
    expect(cspLine).toMatch(/connect-src [^;]*blob:/);
  });

  it('CSP declares font-src self, without data:', () => {
    expect(cspLine).toMatch(/font-src 'self'/);
    expect(cspLine).not.toMatch(/font-src [^;]*data:/);
  });

  it('admin panel is proxied with the /admin prefix stripped (handle_path)', () => {
    // The panel serves assets at /assets/* and its API at /api/* — the strip
    // is the contract its build (vite base /admin/) relies on.
    const adminBlock = /handle_path \/admin\* \{[^}]*reverse_proxy 127\.0\.0\.1:8082/s;
    expect(active).toMatch(adminBlock);
    expect(active).not.toMatch(/(^|\s)handle \/admin/m);
  });

  it('asset manifest and every HTML route stay non-immutable across deploys', () => {
    expect(active).toMatch(/@manifest path \/assets\/manifest\.json/);
    expect(active).toMatch(/header @manifest Cache-Control "no-cache"/);
    // Everything that is not a hashed asset IS index.html (SPA fallback), and
    // it must carry no-cache — matching only `/` left deep links uncovered,
    // because try_files rewrites after the header directives have run.
    expect(active).toMatch(/@notasset not path \/assets\/\*/);
    expect(active).toMatch(/header @notasset Cache-Control "no-cache"/);
    // API answers are never cached either (the server says so too).
    expect(active).toMatch(/header defer Cache-Control "no-store"/);
    // The manifest exception must come after the blanket immutable rule
    // (later directives win in Caddy) — order is part of the contract.
    const immutableAt = active.indexOf('@immutable path /assets/*');
    const manifestAt = active.indexOf('@manifest path /assets/manifest.json');
    expect(immutableAt).toBeGreaterThan(-1);
    expect(manifestAt).toBeGreaterThan(immutableAt);
  });
});
