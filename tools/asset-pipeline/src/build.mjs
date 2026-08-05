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
import {
  compactPrimitive,
  dedup,
  prune,
  weld,
  flatten,
  join,
  resample,
  textureCompress,
} from '@gltf-transform/functions';
import sharp from 'sharp';

/**
 * Substitute for source images that a rule marks broken (`imageOverrides: null`).
 * Recognizable by exact bytes after read, so the placeholder-texture slots can be
 * stripped from materials again before writing. 1×1 white PNG.
 */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+hc2rNAAAAABJRU5ErkJggg==',
  'base64',
);

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const CONFIG_PATH = path.join(REPO_ROOT, 'tools/asset-pipeline/config/packs.json');
export const BAKED_DIR = path.join(REPO_ROOT, 'assets_baked');
export const MANIFEST_PATH = path.join(BAKED_DIR, 'manifest.json');

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

/** Bump when the behavior behind rule options (skinned/animationsOnly/…) changes. */
const OPTION_TRANSFORM_VERSION = 3;

/**
 * Bump when the DEFAULT transform changes — it joins every source hash, so a
 * bump re-bakes the whole tree rather than leaving old outputs behind a cache
 * that only watches the source file.
 *
 * v2: world/prop textures are compressed. Skinned models were the only ones
 * being compressed, which was fine while every prop came from KayKit's tiny
 * shared atlas and stopped being fine the moment a pack shipped 2K bark maps:
 * P10's first tree baked at **23.5 MB** and five of them put the tree over the
 * 64 MB total budget on their own (ASSET_PIPELINE.md §8). The report caught it,
 * which is what the report is for — but the right fix is upstream of the gate.
 */
const PIPELINE_VERSION = 2;

/**
 * Texture ceiling for world props and items, in pixels.
 *
 * 512 rather than the characters' 1024: a tree is looked at from ten metres in
 * a stylised low-poly world, and the packs' 2048² bark maps carry detail the
 * art style never shows. Measured on the P10 set, this is the difference
 * between 87 MB of trees and about 1.5.
 */
const PROP_TEXTURE_MAX = 512;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const slugify = (value) =>
  value
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

/**
 * Manifest paths are part of a committed, cross-platform artifact — normalize to
 * forward slashes so a Windows dev machine writes the same manifest as Linux/CI.
 */
const toPosix = (value) => value.split(path.sep).join('/');

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

/**
 * Every file a glTF depends on (its .bin buffers and textures), with a rule's
 * `imageOverrides` applied — so hashing tracks the files actually baked.
 */
const gatherDependencies = async (filePath, imageOverrides = {}) => {
  if (!filePath.endsWith('.gltf')) return [];
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  const dir = path.dirname(filePath);
  const resolve = (uri) => {
    const override = imageOverrides[uri];
    if (override === null) return null; // broken source image, replaced by a placeholder
    const overridePath = typeof override === 'string' ? override : override?.path;
    return path.join(dir, decodeURIComponent(overridePath ?? uri));
  };
  const uris = [
    ...(raw.buffers ?? []).map((buffer) => buffer.uri),
    ...(raw.images ?? []).map((image) => image.uri),
  ].filter((uri) => typeof uri === 'string' && !uri.startsWith('data:'));
  return uris.map(resolve).filter(Boolean);
};

/**
 * Read a source model. Rules may carry `imageOverrides`, keyed by referenced uri:
 *   - null                      → drop the broken reference (placeholder bytes,
 *                                 slot stripped after load)
 *   - "path/relative/to/model"  → substitute another file's bytes
 *   - { path?, multiplyRGB? }   → substitute and/or color-correct (per-channel
 *                                 linear gain via sharp)
 * Some upstream packs ship dangling texture URIs or only a wrong-variant texture
 * (docs/tech/ASSET_PIPELINE.md §2) — this keeps the raw packs pristine while the
 * baked output gets the intended pixels.
 */
const readDocument = async (sourcePath, imageOverrides) => {
  if (!imageOverrides || !sourcePath.endsWith('.gltf')) {
    return io.read(sourcePath);
  }
  const json = JSON.parse(await readFile(sourcePath, 'utf8'));
  const dir = path.dirname(sourcePath);
  const resources = {};
  const uris = [
    ...(json.buffers ?? []).map((buffer) => buffer.uri),
    ...(json.images ?? []).map((image) => image.uri),
  ].filter((uri) => typeof uri === 'string' && !uri.startsWith('data:'));
  for (const uri of uris) {
    const override = imageOverrides[uri];
    if (override === null) {
      resources[uri] = PLACEHOLDER_PNG;
      continue;
    }
    const spec = typeof override === 'string' ? { path: override } : (override ?? {});
    let bytes = await readFile(path.join(dir, decodeURIComponent(spec.path ?? uri)));
    if (spec.grayscale) {
      // Neutralize to a luminance/shading map — runtime multiply-tints then land
      // on the exact picked hue with the painted strand shading preserved.
      bytes = await sharp(bytes).grayscale().png().toBuffer();
    }
    if (spec.multiplyRGB) {
      // sharp reorders chained ops, so the gain must match the source's real
      // channel count (a 3-channel PNG rejects a 4-length linear()).
      const { channels } = await sharp(bytes).metadata();
      const gain = channels === 4 ? [...spec.multiplyRGB, 1] : [...spec.multiplyRGB];
      bytes = await sharp(bytes).linear(gain, new Array(gain.length).fill(0)).png().toBuffer();
    }
    resources[uri] = bytes;
  }
  return io.readJSON({ json, resources });
};

/** Remove texture slots that still point at placeholder bytes (see readDocument). */
const stripPlaceholderTextures = (document) => {
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (image && Buffer.from(image).equals(PLACEHOLDER_PNG)) {
      texture.dispose(); // detaches it from every material slot
    }
  }
};

/** Keep only allowlisted clips — animation libraries ship hundreds we don't use. */
const filterAnimations = (document, keep) => {
  const kept = new Set(keep);
  const missing = new Set(keep);
  for (const animation of document.getRoot().listAnimations()) {
    if (kept.has(animation.getName())) {
      missing.delete(animation.getName());
      continue;
    }
    // Dispose the whole chain: orphaned channels/samplers would otherwise still
    // parent their accessors, which keeps prune() from reclaiming the key data.
    for (const channel of animation.listChannels()) channel.dispose();
    for (const sampler of animation.listSamplers()) sampler.dispose();
    animation.dispose();
  }
  return [...missing];
};

/** Strip meshes/skins/materials from an animation library — only clips + the bone hierarchy ship. */
const stripToAnimations = (document) => {
  const root = document.getRoot();
  for (const node of root.listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  for (const material of root.listMaterials()) material.dispose();
  for (const texture of root.listTextures()) texture.dispose();
};

/**
 * Cut a skinned mesh down to the triangles weighted to a bone set. Used to derive
 * the head from a fused full-body base: the modular outfits ARE the body below
 * the neck (they ship their own skin geometry), so the base contributes head +
 * neck only and the seam hides inside every outfit's collar/hood
 * (docs/tech/ASSET_PIPELINE.md §2).
 *
 * options: { meshPattern, bones: string[], threshold } — a triangle survives when
 * every vertex carries at least `threshold` total weight on the listed bones.
 */
const cutSkinnedMeshToBones = (document, options) => {
  const meshRegex = new RegExp(options.meshPattern, 'i');
  const boneNames = new Set(options.bones);
  const threshold = options.threshold ?? 0.5;
  const root = document.getRoot();

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    if (!mesh || !skin || !meshRegex.test(mesh.getName() || node.getName())) continue;

    const keptJointIndices = new Set(
      skin
        .listJoints()
        .map((joint, index) => (boneNames.has(joint.getName()) ? index : -1))
        .filter((index) => index >= 0),
    );

    for (const primitive of mesh.listPrimitives()) {
      const joints = primitive.getAttribute('JOINTS_0');
      const weights = primitive.getAttribute('WEIGHTS_0');
      const indices = primitive.getIndices();
      if (!joints || !weights || !indices) continue;

      const jointElement = [0, 0, 0, 0];
      const weightElement = [0, 0, 0, 0];
      const vertexKept = (vertex) => {
        joints.getElement(vertex, jointElement);
        weights.getElement(vertex, weightElement);
        let onBones = 0;
        for (let i = 0; i < 4; i++) {
          if (keptJointIndices.has(jointElement[i])) onBones += weightElement[i];
        }
        return onBones >= threshold;
      };

      const kept = [];
      for (let i = 0; i < indices.getCount(); i += 3) {
        const a = indices.getScalar(i);
        const b = indices.getScalar(i + 1);
        const c = indices.getScalar(i + 2);
        if (vertexKept(a) && vertexKept(b) && vertexKept(c)) kept.push(a, b, c);
      }

      const nextIndices = document
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint32Array(kept))
        .setBuffer(root.listBuffers()[0] ?? document.createBuffer());
      const previous = primitive.getIndices();
      primitive.setIndices(nextIndices);
      previous.dispose();
      compactPrimitive(primitive); // drop the vertex data the cut orphaned
    }
  }
};

/**
 * Character texture policy (docs/tech/ASSET_PIPELINE.md §2): the vibrant low-poly
 * look shades with flat lighting + tints, so 4K normal/roughness/ORM maps from the
 * source packs are dead weight — drop the map slots (numeric factors survive) and
 * let textureCompress shrink what remains to 1024px WebP.
 */
const stripDetailMaps = (document) => {
  for (const material of document.getRoot().listMaterials()) {
    material.setNormalTexture(null);
    material.setOcclusionTexture(null);
    material.setMetallicRoughnessTexture(null);
    material.setEmissiveTexture(null);
  }
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
    pipelineVersion: PIPELINE_VERSION,
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
      const relativeSource = toPosix(path.relative(REPO_ROOT, sourcePath));
      const slug = slugify(path.basename(sourcePath));
      const id = `${rule.category.replace(/\//g, '_')}_${slug}`;

      // Two different source files must never silently share an id: the second
      // would overwrite the first in the manifest and orphan its baked file.
      const claimed = manifest.assets[id];
      if (claimed && claimed.source !== relativeSource) {
        problems.push(
          `id collision: "${id}" is claimed by both ${claimed.source} and ${relativeSource} — rename or re-categorize one`,
        );
        continue;
      }

      // Hash the source *and* its external dependencies so texture-only edits rebuild.
      // Rule options (and the option-transform version) join the hash only when a
      // rule uses them: changing options or their semantics re-bakes those assets
      // without churning the manifest entries of plain rules.
      const dependencies = await gatherDependencies(sourcePath, rule.imageOverrides);
      const hasher = createHash('sha256');
      hasher.update(`pipeline:${PIPELINE_VERSION}`);
      hasher.update(await readFile(sourcePath));
      for (const dependency of dependencies) {
        hasher.update(await readFile(dependency).catch(() => Buffer.alloc(0)));
      }
      if (
        rule.imageOverrides ||
        rule.skinned ||
        rule.animationsOnly ||
        rule.animationKeep ||
        rule.bodyCut
      ) {
        hasher.update(
          JSON.stringify({
            transformVersion: OPTION_TRANSFORM_VERSION,
            imageOverrides: rule.imageOverrides ?? null,
            skinned: rule.skinned ?? false,
            animationsOnly: rule.animationsOnly ?? false,
            animationKeep: rule.animationKeep ?? null,
            bodyCut: rule.bodyCut ?? null,
          }),
        );
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
        document = await readDocument(sourcePath, rule.imageOverrides);
      } catch (error) {
        problems.push(`failed to read ${relativeSource}: ${error.message}`);
        continue;
      }

      if (rule.animationKeep) {
        const missing = filterAnimations(document, rule.animationKeep);
        for (const clip of missing) {
          problems.push(`${id}: animationKeep clip "${clip}" not found in ${relativeSource}`);
        }
      }
      if (rule.animationsOnly) stripToAnimations(document);
      if (rule.imageOverrides) stripPlaceholderTextures(document);
      if (rule.bodyCut) cutSkinnedMeshToBones(document, rule.bodyCut);

      // Structural optimization. Mesh compression (meshopt) lands with the streaming
      // work in P2 — it needs the runtime decoder wired into the client loader.
      // Skinned models keep their node hierarchy: flatten/join would reparent or
      // merge nodes whose names the runtime relies on for rebinding and tinting.
      // Animation libraries keep untargeted leaf bones so hierarchies stay whole;
      // resample() collapses the packs' dense per-frame keys on constant tracks.
      if (rule.animationsOnly) {
        await document.transform(resample(), dedup(), prune({ keepLeaves: true }));
      } else if (rule.skinned) {
        stripDetailMaps(document);
        await document.transform(
          dedup(),
          weld(),
          textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
          prune(),
        );
      } else {
        // Props and items: structural optimization, then the same webp squeeze
        // the characters get at a tighter size. Compression runs BEFORE prune so
        // textures dropped by prune are never encoded in the first place.
        await document.transform(
          dedup(),
          flatten(),
          join(),
          weld(),
          textureCompress({
            encoder: sharp,
            targetFormat: 'webp',
            resize: [PROP_TEXTURE_MAX, PROP_TEXTURE_MAX],
          }),
          prune(),
        );
      }

      const glb = Buffer.from(await io.writeBinary(document));
      const outputHash = sha256(glb).slice(0, 8);
      const outputRelative = toPosix(
        path.join('assets_baked', rule.category, `${slug}.${outputHash}.glb`),
      );
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
export const writeCreditsLedger = async (manifest) => {
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
      // Mixed-author packs (game-icons): CC BY wants every author NAMED here.
      const authorNote = file.author !== info.author ? ` · ${file.author}` : '';
      lines.push(`- \`${file.id}\` — ${file.source}${authorNote}`);
    }
    lines.push('');
  }

  const head = current.split(marker)[0].trimEnd();
  await writeFile(creditsPath, `${head}\n\n${lines.join('\n')}\n`);
};
