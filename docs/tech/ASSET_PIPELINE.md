# Dawned — Asset Pipeline

> From `assets/` (1.7 GB of raw packs, many formats) to fast, hash-cached, runtime-ready files.
> Raw packs stay in git as the source of truth; everything served is **generated** by `tools/`
> scripts into `packages/client/public/assets/` (client) and `/var/lib/dawned/assets/` (server-known
> colliders/markers). Inventory of what we have: [../ASSET_INVENTORY.md](../ASSET_INVENTORY.md).

## 1. Principles

1. **Never ship raw packs.** FBX/OBJ/blend never load at runtime; GLB (meshopt-compressed) only.
2. **Manifest-driven.** A generated `asset-manifest.json` (id → file, hash, size, tags, bounds,
   collider ref, thumbnail) is the only way code references assets — no hardcoded paths.
3. **Idempotent & incremental.** `pnpm assets:build` hashes sources; only changed files re-process.
4. **Attribution automated.** Every manifest entry carries `license` + `source`; CREDITS.md is
   generated from it (fails the build if a file lacks provenance).

## 2. Model Pipeline (`tools/convert-models/`)

- **Input tiers:** GLB/GLTF packs pass through gltf-transform directly; FBX-only packs (UAL Unity
  variants, Modular Outfits FBX) convert via **Blender 4 headless** batch script (`--background
--python fbx2glb.py`) run on dev machines only. Decision: baked GLB outputs are **committed to
  the repo** under `assets_baked/` (meshopt-compressed props are ~10–60 kB typical), so VPS builds
  never need Blender installed.
- **gltf-transform pass:** dedup, prune, weld, quantize (POSITION 14-bit ok for props), meshopt
  compression, strip unused UVs/targets, palette-texture verification (KayKit/Quaternius use tiny
  palette PNGs — force NEAREST-free bilinear, power-of-two check), name normalization.
- **Rig assets (as built in P1 — deviation from the original bundle-merge idea):** the Quaternius
  "Universal" packs share one 65-bone rig (verified by the report gate,
  `tools/asset-pipeline/src/verify-characters.mjs`), so pieces bake **individually** and the client
  composes them at load time by name-based skeleton rebinding
  (`packages/client/src/world/characters.ts`) — cheaper than a bake-time merge (no per-combination
  bundles for body × outfit × hair), zero per-frame retarget cost. Supporting rule options in
  `tools/asset-pipeline/config/packs.json`:
  - `skinned` — keep node hierarchy/names (no flatten/join), strip normal/ORM/roughness maps
    (vibrant flat look), basecolors → 1024 px WebP;
  - `bodyCut` — the modular outfits ARE the body below the neck (own skin geometry), so the fused
    base bakes down to head + neck (triangle filter by bone weights; seam hides in every collar);
  - `imageOverrides` — per-uri fixes for the packs' broken/wrong-variant texture refs
    (`null` drop, path repoint, `multiplyRGB` gain, `grayscale` neutralize). Raw packs stay pristine;
  - `animationsOnly` + `animationKeep` — UAL libraries ship mesh-free with only the clips shipped
    phases use (13 in P1; extend the allowlist as phases land). Curves are `resample()`d
    (21 MB source → ~0.7 MB baked).
- **Collision extraction:** per world-prop: auto-generate collider (AABB or convex 12-vert hull or
  cylinder by heuristic + per-asset override file) → written into manifest for both server
  (authoritative) and admin editor (preview).
- Output naming: `assets/models/<category>/<slug>.<contenthash>.glb`.

### 2.1 `mergeClips` — the opposite of the composed rig (P12-C)

Players are composed at load time because the combinations are combinatorial. **Enemies are not**:
the renderer loads one file per model and expects its clips inside it. That is fine for Quaternius,
which ships monsters with their animations embedded, and wrong for KayKit, which ships characters
and a shared `Rig_Medium` library in separate files — the four skeletons baked with **zero clips**
and stood frozen while sliding along the ground (NPCS_ENEMIES.md §4.1).

`mergeClips: ["Animations/gltf/Rig_Medium/Rig_Medium_General.glb", …]` (paths relative to the pack
root) merges those libraries into the character before any other transform, then rebinds every
animation channel **by joint name** onto the mesh's own skeleton. Rules:

- It is a **rebind, not a retarget**. Both documents must carry the same joints under the same
  names; a channel whose joint has no counterpart **throws**, because silently skipping it is how a
  limb ends up not moving with nobody noticing.
- Everything except the clips is disposed explicitly — a library is a whole second character, and
  `prune()` will NOT reclaim it (the merged-in skin keeps its own joints alive, so the model would
  ship two skeletons and animate the invisible one).
- Accessors move onto the character's buffer: a GLB may hold at most one, and each merged document
  brings its own.
- The rule implies `skinned: true` in practice — the prop path's `flatten()`/`join()` would rename
  the very nodes the channels target.
- The library files join the source hash, so editing one re-bakes the characters that use it.
- Pair it with `animationKeep`: the KayKit library is 25 clips and the game plays 8.

Tested in `tools/asset-pipeline/src/merge-clips.test.mjs` against the real pack (one skin left, every
channel bound to it, geometry untouched, a walk cycle that actually moves joints, and a foreign rig
refused) — `vitest` collects `tools/**/*.test.mjs` for this.

### 2.2 The other front doors — OBJ, `scale`, `emissive` (P12-F)

The reader was glTF/GLB only, which left **three packs and ~200 models unreachable for a format
reason**: the Medieval Village Pack, the Low Poly Nature Models and the Desert Assets all ship
Blends/FBX/OBJ. That mattered once the world needed a **campfire** — WORLD.md §5 makes it a real
interactable (sit → +regen "Cozy" 60 s) and the Medieval Village bonfire is the only one in the
entire library. A design-required object blocked by a container format is a worse reason than a
licensing one.

- **`.obj` sources** are converted in memory with `obj2gltf` (the `.mtl` folds into materials) and
  then run the ordinary transform chain — a second front door, not a second pipeline. The `.mtl`
  joins the source hash, so editing a material colour re-bakes. **FBX is deliberately not handled**:
  every OBJ-only pack here ships FBX of the same meshes, so nothing is gained.
- **`scale: <n>`** normalises a pack authored in something other than metres, applied to the scene's
  root nodes before `flatten()` bakes it into the vertices. The Medieval Village pack is ~1/2.5
  scale — its well is 1.25 units tall. This belongs at bake time because a placement deliberately
  carries **no** scale: an interactable row is id/model/position/rotation, and a chest that is the
  right size in one spot is the right size in every spot.
- **`emissive: { "<material>": "#rrggbb" }`** raises a named material's emissive factor. The bonfire
  models its flame as a separate material called `Fire`; without this it is orange triangles lit by
  the sun, and the thing that makes fire read as fire across a dark clearing is that it emits.
  **Throws on a material name the file does not have**, like `mergeClips` throws on an unmatched
  joint — a silent miss ships an unlit campfire nobody notices until they walk past one at night.

**Measure a prop in WORLD space, never from its accessors.** `model-size.mjs` exists because the
naive check (read POSITION min/max) is confidently wrong: it reported the bonfire at 41 cm when it
is 1.02 m, and the KayKit shrine at **one centimetre** when it is 2.4 m tall — a glTF node carries a
transform, and both packs put the scale there. `model-size.test.mjs` pins nine props to loose metre
bands; the failure it guards against is off by 2.5×, not by 10 %.

**One manifest, two producers.** `assets:build` writes models and `assets:icons` writes the
game-icons.net set into the same `manifest.json`. `build()` started from an empty asset map, so a
plain `pnpm assets:build` **deleted all 256 icon entries** — files stayed on disk, the report stayed
green, and every item, ability and node in the game silently lost its icon. It only ever survived
because the habitual order is build-then-icons. Each producer now owns its categories and carries
the rest (`carryForeignAssets`, `FOREIGN_CATEGORIES`), pinned by `manifest-merge.test.mjs`.

## 3. Texture/Image Pipeline

- Palette + splat + particle textures → PNG optimized (sharp: strip metadata, correct sRGB), sizes
  verified (≤2048); UI images → PNG/WebP dual output.
- **Backgrounds** (`assets/backgrounds/*.png`, user-made): optimized + sized to 1080p/1440p double
  set — used on menu screens as fallbacks/vignettes per UI_UX.md.
- Kenney particle sheets → packed atlas (`tools/atlas/`) with JSON frames for the VFX system.
- **Character skin tones (as built in P1):** runtime multiplicative tints over the baked Light
  basecolor (`SKIN_TONES` in `@dawned/shared` appearance.ts) — no texture variants to bake or
  ship. Outfit tints work the same; hair/beard/eyebrow basecolors bake to brightness-normalized
  grayscale so hair-color multiplies land on the exact picked swatch with strand shading intact.

## 4. Icon Pipeline (`tools/icons/`) — every item unique

1. Curated mapping file `tools/config/icon-map.json`: content id → game-icons.net icon name (+
   transform: mirror/rotate/recolor accent) — curation is a per-content-phase task, validated
   (build fails on unmapped items).
2. Downloader pulls SVGs into `assets_vendor/game-icons/` (committed; license CC BY 3.0 recorded
   per icon with author from its metadata).
3. Generator renders themed PNGs: parchment-on-ink base, class/rarity accent tint variants, 64 px
   - 128 px, packed into icon atlases + CSS sprite JSON for the DOM UI.
4. CREDITS.md section auto-regenerated (author list per game-icons attribution requirements).
   Result: the user can later replace any icon by dropping a PNG at the content id path — override dir
   `assets/icons_custom/` wins over generated (their stated plan to hand-make icons someday is a
   first-class path).

> **As built (P5 fix round 7):** steps 1–2 and 4 are live under
> `tools/asset-pipeline` — `config/icon-map.json` maps ability ids to
> `author/name` slugs, `pnpm assets:icons --fetch` vendors the SVGs into
> `assets_vendor/game-icons/` (committed) and the bake strips each icon's
> background rect into `assets_baked/icons/*.svg` with per-icon authors in
> the manifest + CREDITS ledger. Step 3 deviates by design: instead of
> pre-tinted PNG atlases, the HUD renders the white-glyph SVGs as **CSS
> masks**, so ready/insufficient/locked/cooling states are pure CSS tints —
> one asset per icon, every state free. PNG atlases + rarity accents revisit
> at P8 when item icon counts jump. All 28 ability rows carry icons; the
> transform/validation extras in step 1 arrive with the item curation pass.

> **As built (P8-C/E):** the map is sectioned (`abilities`, `items`, …) and a
> new section rides the same fetch/bake with no code change. Abilities MAY
> share a glyph (the three class basics all wear a weapon icon); items may not
> — in a bag the icon IS the item (ITEMS_LOOT.md §8), so the sections listed
> in the map's `$unique` array are checked at load and the bake fails naming
> both offenders. The admin publish pipeline enforces the same rule on item
> rows, so a duplicate is caught whichever end it is authored from. 62 item
> icons are live; CSS masking still carries rarity colour, so step 3's tinted
> atlases stay unnecessary. Weapon and shield MODELS bake as ordinary GLBs
> under `items/weapons`; the client hangs them off the rig's hand bones by
> manifest id (`modelRef` on the item row).

## 5. Audio Pipeline (`tools/audio/`) — sources per AUDIO.md §3 (CC0-first, decided)

`assets/audio_src/<bucket>/` → ffmpeg batch: trim silence, loudness normalize (music −16 LUFS,
SFX −12 dBTP), loop-point metadata (JSON sidecar), OGG Vorbis (music 128k, SFX 96k) →
`assets/audio/<bucket>/<slug>.<hash>.ogg` + manifest entries with license/source (§1.4 applies).

## 6. Terrain & World Bakes (owned by Dawned-Admin publish, formats defined here)

- `map/<version>/chunk_<cx>_<cy>.bin` — heightmap 65×65 f32 + splat weights + water flag (see
  DATABASE.md `content_map_chunks`; disk mirror is what clients fetch, immutable + cached).
- `map/<version>/walkgrid.bin` — 1 m bitfield + slope classes (server + admin debug overlay).
- `map/<version>/placements_<cx>_<cy>.json` — prop/foliage instances per chunk (client streams).
- `map/<version>/worldmap.png` + `minimap_tiles/` — the baked painted map render.
- `content/<version>/bundle.json` — published content snapshot for the client (items, abilities…
  display-relevant fields only — server-only numbers like loot odds stay server-side).

## 7. Client Loading Strategy

- Boot: manifest + login-screen bundle (≤8 MB budget: UI atlas, fonts, login vignette scene subset).
- Char select/create: character bundles (the heaviest single load, ~4–6 MB) — behind the login,
  preloaded during typing.
- World: chunk-driven — terrain bin + placement JSON + referenced model GLBs stream by 5×5
  residency ring, prioritized (terrain > colliding props > decor > foliage); zone-ahead prefetch on
  bridge approach (zone polygon adjacency known).
- Cache: HTTP immutable (hashed names) + IndexedDB pin for models/audio (quota-aware LRU ~200 MB) —
  second login is near-instant; content hash mismatch (`ContentInvalidate`) evicts precisely.

## 8. Dev Ergonomics

`pnpm assets:build` (all), `pnpm assets:watch` (chokidar incremental during art passes),
`pnpm assets:report` (sizes, missing colliders/icons/licenses, budget check vs TECH_STACK budgets —
run in `pnpm check`). Thumbnails for the Admin asset browser are rendered by `tools/thumbs/`
(headless Chromium + three.js orbit shot, 256 px, cached by hash) — the same thumbs power the map
editor's asset palette.
