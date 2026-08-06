/**
 * Icon pipeline (docs/tech/ASSET_PIPELINE.md §4): curated game-icons.net SVGs
 * for ability/item/stat tiles.
 *
 *  - `--fetch` downloads the mapped icons from the game-icons/icons GitHub
 *    repo into `assets_vendor/game-icons/<author>/<name>.svg` (committed —
 *    builds never depend on the network).
 *  - The bake drops each icon's solid background rect and keeps the white
 *    glyph on transparency: the HUD renders them as CSS masks, so every
 *    ready/insufficient/locked state is a tint, not a separate asset.
 *  - Manifest entries carry per-icon authors (CC BY 3.0 requires naming
 *    them); the CREDITS ledger regenerates like any other pack.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BAKED_DIR, MANIFEST_PATH, REPO_ROOT, loadManifest, writeCreditsLedger } from './build.mjs';

const MAP_PATH = path.join(REPO_ROOT, 'tools/asset-pipeline/config/icon-map.json');
const VENDOR_DIR = path.join(REPO_ROOT, 'assets_vendor/game-icons');
const RAW_BASE = 'https://raw.githubusercontent.com/game-icons/icons/master';

/** Icon authors in use → display names for the ledger (game-icons.net pages). */
const AUTHOR_NAMES = {
  lorc: 'Lorc',
  delapouite: 'Delapouite',
  darkzaitzev: 'DarkZaitzev',
  skoll: 'Skoll',
  sbed: 'sbed',
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const toPosix = (value) => value.split(path.sep).join('/');

/**
 * Sections named in `$unique` may not reuse a glyph: for items, the icon IS
 * the item at a glance (ITEMS_LOOT.md §8), so two rows sharing one makes a bag
 * unreadable. The panel refuses duplicates at publish; this refuses them at
 * bake, which is the earlier and cheaper of the two places to find out.
 */
const assertUniqueIcons = (map) => {
  for (const section of map.$unique ?? []) {
    const entries = map[section];
    if (!entries) throw new Error(`icon-map $unique names a missing section: ${section}`);
    const owners = new Map();
    const collisions = [];
    for (const [id, slug] of Object.entries(entries)) {
      const first = owners.get(slug);
      if (first) collisions.push(`${slug} — ${first} and ${id}`);
      else owners.set(slug, id);
    }
    if (collisions.length > 0) {
      throw new Error(
        `icon-map section "${section}" reuses ${collisions.length} icon(s):\n  ${collisions.join('\n  ')}`,
      );
    }
  }
};

const loadMap = async () => {
  const map = JSON.parse(await readFile(MAP_PATH, 'utf8'));
  assertUniqueIcons(map);
  return map;
};

/**
 * Unique author/name slugs referenced by the map, across every section
 * (`abilities`, `items`, …). Sections are additive: a new content type gets a
 * key here and its icons ride the same fetch/bake without touching this code.
 */
const uniqueIcons = (map) =>
  [
    ...new Set(
      Object.entries(map)
        .filter(([key]) => !key.startsWith('$'))
        .flatMap(([, section]) => Object.values(section)),
    ),
  ].sort();

export const fetchIcons = async () => {
  const map = await loadMap();
  let fetched = 0;
  let kept = 0;
  // Every miss, not the first. game-icons slugs are typed from memory of a
  // 4 000-icon library and a content pass adds them a hundred at a time —
  // throwing on the first bad one turns a five-minute fix into a hundred
  // round trips, which is the same lesson `placeAll` learned about wishes.
  const missing = [];
  for (const slug of uniqueIcons(map)) {
    const target = path.join(VENDOR_DIR, `${slug}.svg`);
    const existing = await readFile(target, 'utf8').catch(() => null);
    if (existing) {
      kept++;
      continue;
    }
    const response = await fetch(`${RAW_BASE}/${slug}.svg`);
    if (!response.ok) {
      missing.push(`${slug} (HTTP ${response.status})`);
      continue;
    }
    const svg = await response.text();
    if (!svg.includes('<svg')) {
      missing.push(`${slug} (response is not an SVG)`);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, svg);
    fetched++;
    console.log(`  ↓ ${slug}`);
  }
  console.log(`icons: ${fetched} fetched, ${kept} already vendored`);
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} icon(s) do not exist in game-icons:\n  • ${missing.join('\n  • ')}`,
    );
  }
};

/**
 * Strip the solid background rect game-icons ship (`M0 0h512v512H0z`) and
 * keep the glyph paths. The result is a white glyph on transparency — the
 * HUD masks it, so the SVG's own fill never shows.
 */
const stripBackground = (svg) => svg.replace(/<path d="M0 0h512v512H0z"(?: fill="[^"]*")?\/>/, '');

export const bakeIcons = async ({ verbose = true } = {}) => {
  const map = await loadMap();
  const manifest = (await loadManifest()) ?? { assets: {} };
  const log = (message) => {
    if (verbose) console.log(message);
  };

  let built = 0;
  let reused = 0;
  for (const slug of uniqueIcons(map)) {
    const [author, name] = slug.split('/');
    const id = `icon_${author}__${name}`;
    const sourceRelative = toPosix(path.join('assets_vendor/game-icons', `${slug}.svg`));
    const raw = await readFile(path.join(REPO_ROOT, sourceRelative), 'utf8').catch(() => null);
    if (raw === null) {
      throw new Error(`icon source missing: ${sourceRelative} — run \`pnpm assets:icons --fetch\``);
    }
    const sourceHash = sha256(raw);
    const existing = manifest.assets[id];
    if (existing?.sourceHash === sourceHash) {
      reused++;
      continue;
    }

    const baked = stripBackground(raw);
    if (baked === raw) {
      throw new Error(`icon ${slug}: background rect not found — layout changed upstream?`);
    }
    const outputHash = sha256(Buffer.from(baked)).slice(0, 8);
    const outputRelative = toPosix(
      path.join('assets_baked', 'icons', `${author}__${name}.${outputHash}.svg`),
    );
    const outputPath = path.join(REPO_ROOT, outputRelative);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, baked);

    // Drop stale bakes of the same icon (content hash changed).
    const siblings = await readdir(path.dirname(outputPath)).catch(() => []);
    for (const sibling of siblings) {
      if (
        sibling.startsWith(`${author}__${name}.`) &&
        sibling !== path.basename(outputPath) &&
        sibling.endsWith('.svg')
      ) {
        await writeFile(path.join(path.dirname(outputPath), sibling), baked).catch(() => {});
      }
    }

    manifest.assets[id] = {
      id,
      category: 'icons',
      file: outputRelative,
      bytes: Buffer.byteLength(baked),
      sourceHash,
      source: sourceRelative,
      pack: 'game-icons',
      packName: 'Game-icons.net',
      author: `${AUTHOR_NAMES[author] ?? author} (game-icons.net)`,
      license: 'CC-BY-3.0',
      licenseVerified: true,
      licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
      triangles: 0,
      bounds: null,
      animations: [],
      /** author/name slug content rows reference via their `icon` field. */
      iconSlug: slug,
    };
    built++;
    log(`  ✔ ${id} → ${outputRelative} (${(Buffer.byteLength(baked) / 1024).toFixed(1)} kB)`);
  }

  await mkdir(BAKED_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeCreditsLedger(manifest);
  log(`icons: ${built} baked, ${reused} unchanged`);
  return { built, reused };
};
