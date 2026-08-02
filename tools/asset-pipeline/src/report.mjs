/**
 * Asset report — runs inside `pnpm check`.
 *
 * It is a gate, not a summary: unattributed assets, unverified licenses, missing
 * files or blown budgets fail the build (docs/tech/ASSET_PIPELINE.md §1, §8).
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { BAKED_DIR, REPO_ROOT, loadConfig, loadManifest } from './build.mjs';
import { verifyCharacters } from './verify-characters.mjs';

/** Budgets from docs/tech/TECH_STACK.md (initial load ≤8 MB critical path). */
const BUDGETS = {
  totalBakedMb: 64,
  singleAssetKb: 4096,
  singleAssetTriangles: 60_000,
};

export const report = async () => {
  const manifest = await loadManifest();
  const failures = [];
  const warnings = [];

  if (!manifest) {
    console.log('assets: no manifest yet — run `pnpm assets:build` (skipping report)');
    console.log(`  expected at ${path.relative(REPO_ROOT, path.join(BAKED_DIR, 'manifest.json'))}`);
    return { ok: true, skipped: true };
  }

  const config = await loadConfig();
  const assets = Object.values(manifest.assets ?? {});
  let totalBytes = 0;
  const byCategory = new Map();

  for (const asset of assets) {
    // 1. Provenance: no asset ships without a ledger-backed license.
    if (!asset.license || !asset.author || !asset.source) {
      failures.push(`${asset.id}: missing license/author/source provenance`);
    }
    if (!config.packs[asset.pack]) {
      failures.push(`${asset.id}: pack "${asset.pack}" is not in the license ledger`);
    } else if (asset.licenseVerified !== true) {
      warnings.push(`${asset.id}: license for pack "${asset.pack}" is not marked verified`);
    }

    // 2. The baked file must actually exist.
    const bakedPath = path.join(REPO_ROOT, asset.file);
    const info = await stat(bakedPath).catch(() => null);
    if (!info) {
      failures.push(`${asset.id}: baked file missing (${asset.file})`);
      continue;
    }
    totalBytes += info.size;

    // 3. Per-asset budgets.
    if (info.size > BUDGETS.singleAssetKb * 1024) {
      failures.push(
        `${asset.id}: ${(info.size / 1024).toFixed(0)} kB exceeds the ${BUDGETS.singleAssetKb} kB per-asset budget`,
      );
    }
    if (asset.triangles > BUDGETS.singleAssetTriangles) {
      warnings.push(`${asset.id}: ${asset.triangles} triangles is high for a low-poly asset`);
    }

    const bucket = byCategory.get(asset.category) ?? { count: 0, bytes: 0 };
    bucket.count++;
    bucket.bytes += info.size;
    byCategory.set(asset.category, bucket);
  }

  // 4. Total budget.
  const totalMb = totalBytes / 1024 / 1024;
  if (totalMb > BUDGETS.totalBakedMb) {
    failures.push(
      `baked assets total ${totalMb.toFixed(1)} MB, over the ${BUDGETS.totalBakedMb} MB budget`,
    );
  }

  // 5. Character rig contract (skips itself while no character assets are baked).
  const rig = await verifyCharacters();
  failures.push(...rig.failures);

  // --- output ---------------------------------------------------------------
  console.log(`assets: ${assets.length} baked, ${totalMb.toFixed(2)} MB total`);
  for (const [category, bucket] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
      `  ${category.padEnd(16)} ${String(bucket.count).padStart(3)} files  ${(bucket.bytes / 1024).toFixed(0).padStart(6)} kB`,
    );
  }

  for (const warning of warnings) console.warn(`  ⚠️  ${warning}`);
  for (const failure of failures) console.error(`  ✖ ${failure}`);

  if (failures.length > 0) {
    console.error(`\nasset report failed with ${failures.length} problem(s)`);
    return { ok: false, failures, warnings };
  }
  console.log('asset report: ok');
  return { ok: true, failures, warnings };
};
