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
- **Rig assets:** Universal Base Characters + UAL animation GLBs are retargeted **once at build
  time** into per-class "character bundles": base mesh + outfit variants + hair meshes + the ~80
  clips we actually use (clip allowlist in `tools/config/clips.json`), sharing one skeleton —
  runtime does zero retargeting.
- **Collision extraction:** per world-prop: auto-generate collider (AABB or convex 12-vert hull or
  cylinder by heuristic + per-asset override file) → written into manifest for both server
  (authoritative) and admin editor (preview).
- Output naming: `assets/models/<category>/<slug>.<contenthash>.glb`.

## 3. Texture/Image Pipeline
- Palette + splat + particle textures → PNG optimized (sharp: strip metadata, correct sRGB), sizes
  verified (≤2048); UI images → PNG/WebP dual output.
- **Backgrounds** (`assets/backgrounds/*.png`, user-made): optimized + sized to 1080p/1440p double
  set — used on menu screens as fallbacks/vignettes per UI_UX.md.
- Kenney particle sheets → packed atlas (`tools/atlas/`) with JSON frames for the VFX system.

## 4. Icon Pipeline (`tools/icons/`) — every item unique
1. Curated mapping file `tools/config/icon-map.json`: content id → game-icons.net icon name (+
   transform: mirror/rotate/recolor accent) — curation is a per-content-phase task, validated
   (build fails on unmapped items).
2. Downloader pulls SVGs into `assets_vendor/game-icons/` (committed; license CC BY 3.0 recorded
   per icon with author from its metadata).
3. Generator renders themed PNGs: parchment-on-ink base, class/rarity accent tint variants, 64 px
   + 128 px, packed into icon atlases + CSS sprite JSON for the DOM UI.
4. CREDITS.md section auto-regenerated (author list per game-icons attribution requirements).
Result: the user can later replace any icon by dropping a PNG at the content id path — override dir
`assets/icons_custom/` wins over generated (their stated plan to hand-make icons someday is a
first-class path).

## 5. Audio Pipeline (`tools/audio/`) — pending source decision (USER_QUESTIONS)
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
