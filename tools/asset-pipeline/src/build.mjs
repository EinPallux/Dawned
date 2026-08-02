/**
 * Asset pipeline v1 — raw packs in `assets/` → optimized GLBs in `assets_baked/`
 * plus a manifest that is the ONLY way runtime code may reference an asset
 * (docs/tech/ASSET_PIPELINE.md).
 *
 * Properties that matter:
 *  - idempotent + incremental: sources are hashed, unchanged assets are skipped,
 *  - provenance-complete: an asset without a ledger entry is a build failure,
 *  - deterministic output paths: <category>/<slug>.<hash8>.glb for immutable caching.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, flatten, join } from '@gltf-transform/functions';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const CONFIG_PATH = path.join(REPO_ROOT, 'tools/asset-pipeline/config/packs.json');
export const BAKED_DIR = path.join(REPO_ROOT, 'assets_baked');
export const MANIFEST_PATH = path.join(BAKED_DIR, 'manifest.json');

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const slugify = (value) =>
  value
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

/** Minimal glob: supports `*` inside a path, matched per segment. */
const matchGlob = async (root, pattern) => {
  const segments = pattern.split('/');
  let candidates = [''];
  for (const segment of segments) {
    const next = [];
    for (const prefix of candidates) {
      const dir = path.join(root, prefix);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const regex = new RegExp(
        `^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      );
      for (const entry of entries) {
        if (regex.test(entry.name)) next.push(path.join(prefix, entry.name));
      }
    }
    candidates = next;
  }
  const files = [];
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    const info = await stat(full).catch(() => null);
    if (info?.isFile()) files.push(full);
  }
  return files.sort();
};

/** Every file a glTF depends on (its .bin buffers and textures). */
const gatherDependencies = async (filePath) => {
  if (!filePath.endsWith('.gltf')) return [];
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  const dir = path.dirname(filePath);
  const uris = [
    ...(raw.buffers ?? []).map((buffer) => buffer.uri),
    ...(raw.images ?? []).map((image) => image.uri),
  ].filter((uri) => typeof uri === 'string' && !uri.startsWith('data:'));
  return uris.map((uri) => path.join(dir, decodeURIComponent(uri)));
};

const countTriangles = (document) => {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      const count = indices ? indices.getCount() : (position?.getCount() ?? 0);
      triangles += Math.floor(count / 3);
    }
  }
  return triangles;
};

const computeBounds = (document) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const element = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, element);
        for (let axis = 0; axis < 3; axis++) {
          if (element[axis] < min[axis]) min[axis] = element[axis];
          if (element[axis] > max[axis]) max[axis] = element[axis];
        }
      }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return {
    min: min.map((value) => Number(value.toFixed(4))),
    max: max.map((value) => Number(value.toFixed(4))),
  };
};

export const loadConfig = async () => JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

export const loadManifest = async () => {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
};

export const build = async ({ force = false, verbose = true } = {}) => {
  const config = await loadConfig();
  const previous = (await loadManifest()) ?? { assets: {} };
  const manifest = {
    generatedBy: 'tools/asset-pipeline',
    generatedFor: 'Dawned',
    pipelineVersion: 1,
    assets: {},
  };

  const log = (message) => {
    if (verbose) console.log(message);
  };

  let converted = 0;
  let reused = 0;
  const problems = [];

  for (const rule of config.selection) {
    const pack = config.packs[rule.pack];
    if (!pack) {
      problems.push(`selection references unknown pack "${rule.pack}"`);
      continue;
    }
    if (!pack.license || !pack.source) {
      problems.push(`pack "${rule.pack}" is missing license/source — cannot ship its assets`);
      continue;
    }

    const packRoot = path.join(REPO_ROOT, pack.root);
    const matches = await matchGlob(packRoot, rule.glob);
    if (matches.length === 0) {
      problems.push(`no files matched ${rule.pack}:${rule.glob}`);
      continue;
    }

    for (const sourcePath of matches.slice(0, rule.limit ?? matches.length)) {
      const relativeSource = path.relative(REPO_ROOT, sourcePath);
      const slug = slugify(path.basename(sourcePath));
      const id = `${rule.category.replace(/\//g, '_')}_${slug}`;

      // Hash the source *and* its external dependencies so texture-only edits rebuild.
      const dependencies = await gatherDependencies(sourcePath);
      const hasher = createHash('sha256');
      hasher.update(await readFile(sourcePath));
      for (const dependency of dependencies) {
        hasher.update(await readFile(dependency).catch(() => Buffer.alloc(0)));
      }
      const sourceHash = hasher.digest('hex');

      const existing = previous.assets?.[id];
      if (!force && existing?.sourceHash === sourceHash) {
        const bakedPath = path.join(REPO_ROOT, existing.file);
        if (
          await stat(bakedPath)
            .then(() => true)
            .catch(() => false)
        ) {
          manifest.assets[id] = existing;
          reused++;
          continue;
        }
      }

      let document;
      try {
        document = await io.read(sourcePath);
      } catch (error) {
        problems.push(`failed to read ${relativeSource}: ${error.message}`);
        continue;
      }

      // Structural optimization. Mesh compression (meshopt) lands with the streaming
      // work in P2 — it needs the runtime decoder wired into the client loader.
      await document.transform(dedup(), flatten(), join(), weld(), prune());

      const glb = Buffer.from(await io.writeBinary(document));
      const outputHash = sha256(glb).slice(0, 8);
      const outputRelative = path.join('assets_baked', rule.category, `${slug}.${outputHash}.glb`);
      const outputPath = path.join(REPO_ROOT, outputRelative);

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, glb);

      // Drop any stale build of the same asset (different content hash).
      const siblings = await readdir(path.dirname(outputPath)).catch(() => []);
      for (const sibling of siblings) {
        if (sibling.startsWith(`${slug}.`) && sibling !== path.basename(outputPath)) {
          await rm(path.join(path.dirname(outputPath), sibling), { force: true });
        }
      }

      manifest.assets[id] = {
        id,
        category: rule.category,
        file: outputRelative,
        bytes: glb.byteLength,
        sourceHash,
        source: relativeSource,
        pack: rule.pack,
        packName: pack.name,
        author: pack.author,
        license: pack.license,
        licenseVerified: pack.verified === true,
        licenseUrl: pack.source,
        triangles: countTriangles(document),
        bounds: computeBounds(document),
        animations: document
          .getRoot()
          .listAnimations()
          .map((animation) => animation.getName())
          .filter(Boolean),
      };
      converted++;
      log(`  ✔ ${id} → ${outputRelative} (${(glb.byteLength / 1024).toFixed(1)} kB)`);
    }
  }

  await mkdir(BAKED_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeCreditsLedger(manifest);

  log(
    `\nassets: ${converted} built, ${reused} unchanged, ${Object.keys(manifest.assets).length} total`,
  );
  if (problems.length > 0) {
    console.error('\nProblems:');
    for (const problem of problems) console.error(`  ✖ ${problem}`);
  }
  return { manifest, problems };
};

/** Regenerate the generated section of CREDITS.md from manifest provenance. */
const writeCreditsLedger = async (manifest) => {
  const creditsPath = path.join(REPO_ROOT, 'CREDITS.md');
  const marker =
    '<!-- GENERATED LEDGER BELOW — do not edit by hand; `pnpm assets:build` rewrites it -->';
  const current = await readFile(creditsPath, 'utf8').catch(() => null);
  if (current === null) return;

  const byPack = new Map();
  for (const asset of Object.values(manifest.assets)) {
    if (!byPack.has(asset.pack)) {
      byPack.set(asset.pack, { info: asset, files: [] });
    }
    byPack.get(asset.pack).files.push(asset);
  }

  const lines = [marker, '', '## Per-file ledger', ''];
  if (byPack.size === 0) {
    lines.push('*(no assets baked yet — run `pnpm assets:build`)*');
  }
  for (const [packId, entry] of [...byPack].sort(([a], [b]) => a.localeCompare(b))) {
    const { info, files } = entry;
    lines.push(`### ${info.packName}`);
    lines.push(
      `Pack id \`${packId}\` · author **${info.author}** · license **${info.license}** · ${info.licenseUrl}`,
    );
    lines.push('');
    for (const file of files.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- \`${file.id}\` — ${file.source}`);
    }
    lines.push('');
  }

  const head = current.split(marker)[0].trimEnd();
  await writeFile(creditsPath, `${head}\n\n${lines.join('\n')}\n`);
};
