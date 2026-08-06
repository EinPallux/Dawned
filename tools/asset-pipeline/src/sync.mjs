/**
 * Sync baked assets into the client's public directory.
 *
 * `assets_baked/` is the committed pipeline output; the client serves a copy from
 * `packages/client/public/assets/` (vite dev serves it directly, `vite build`
 * folds it into dist). The copy is disposable — this command rebuilds it from
 * scratch on every run, and it is gitignored. The served manifest.json is the
 * baked manifest with `file` fields rewritten to web paths under /assets/.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_PATH, REPO_ROOT } from './build.mjs';

const CLIENT_ASSETS_DIR = path.join(REPO_ROOT, 'packages/client/public/assets');

export const sync = async () => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    throw new Error('no baked manifest — run `pnpm assets:build` first');
  }

  // Clear contents but KEEP the directory inode — a running vite dev server holds
  // the publicDir open, and replacing the directory leaves it serving fallbacks.
  await mkdir(CLIENT_ASSETS_DIR, { recursive: true });
  for (const entry of await readdir(CLIENT_ASSETS_DIR)) {
    await rm(path.join(CLIENT_ASSETS_DIR, entry), { recursive: true, force: true });
  }

  const served = { ...manifest, assets: {} };
  let bytes = 0;
  for (const [id, asset] of Object.entries(manifest.assets ?? {})) {
    // 'assets_baked/<category>/<file>' → served from '/assets/<category>/<file>'.
    const relative = path.relative('assets_baked', asset.file);
    await mkdir(path.join(CLIENT_ASSETS_DIR, path.dirname(relative)), { recursive: true });
    await cp(path.join(REPO_ROOT, asset.file), path.join(CLIENT_ASSETS_DIR, relative));
    served.assets[id] = { ...asset, file: `assets/${relative.split(path.sep).join('/')}` };
    bytes += asset.bytes ?? 0;
  }
  await writeFile(
    path.join(CLIENT_ASSETS_DIR, 'manifest.json'),
    `${JSON.stringify(served, null, 2)}\n`,
  );

  // Map artifacts are deliberately NOT copied (P12-H).
  //
  // They used to be: `assets_baked/map/` was cloned into the client's public dir
  // so `/assets/map/<version>/…` resolved out of the bundle. That made the served
  // map a BUILD-TIME snapshot, and a map is published at RUNTIME — so on the VPS
  // a freshly published world reached the server (which reported it on
  // /api/health) and 404'd in the browser, which is "map failed to load —
  // refresh" with a perfectly healthy world sitting on disk. It never showed in
  // dev because a rebuild follows a publish there as a matter of habit.
  //
  // Both sides serve the bake directory itself now — Caddy in production
  // (deploy/Caddyfile), a middleware in dev and preview (client vite.config.ts) —
  // which also stops every published version being duplicated into the bundle at
  // ~23 MB a piece.

  const count = Object.keys(served.assets).length;
  console.log(
    `assets: synced ${count} files (${(bytes / 1024 / 1024).toFixed(2)} MB)` +
      ` → packages/client/public/assets (maps are served from assets_baked/map)`,
  );
  return { count, bytes };
};
