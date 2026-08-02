# Dawned — UI / UX Specification

> Desktop-first (1080p & 1440p), custom-designed, animated, **zero serif fonts, zero generic
> rounded-blob AI slop**. The UI is DOM-overlay (React) above the WebGL canvas — crisp text, real
> accessibility, easy iteration — with in-world elements (nameplates, damage numbers, telegraph
> decals) rendered in-canvas. Tech split: [../tech/ARCHITECTURE.md](../tech/ARCHITECTURE.md) §client.

## 1. Design Language — "Cut Facets"

The UI borrows the game's low-poly language: **faceted, angular, layered** — like panels cut from
gemstone and timber, not glassmorphism pills.

- **Shapes:** panels are rectangles with 1–2 clipped corners (8 px 45° cuts) and a thin inner
  bevel line; NO uniform border-radius blobs (radius allowed only on circular elements: minimap,
  buff icons ring, reticle).
- **Structure:** every panel = title bar strip (angular tab) + content on a subtle 2-tone split;
  ornament via thin gold seam lines and small diamond studs at corners (CSS, not images) —
  Kenney Fantasy UI Borders reserved for _accents_ (tooltips seams, dialogue frame) only.
- **Palette:**
  - Ink `#151A26` / Panel `#1E2534` / Panel-light `#28324A` (85–92% opacity over world)
  - Parchment text `#EDE6D4`, muted `#9AA3B5`
  - Gold seam `#C9A34E` (interactive highlight `#F0C46B`)
  - Class accents: Warrior `#D8663A` · Mage `#4FA3E8` · Rogue `#8BC44A` · Cleric `#EFD26E`
  - Semantic: HP `#E04D3F`, Mana `#3E8FE8`, Rage `#D8663A`, Energy `#E8D53E`, Stamina `#57C77B`,
    XP `#8E6FD8`; rarity colors per ITEMS_LOOT.md.
- **Type:** Display **Amaranth** (headings, ability names, zone banners — humanist sans with swagger,
  no serifs); UI/body **Nunito Sans** (600/700 weights, tabular numerals for all counters). Both
  self-hosted woff2. Font sizes: base 15 px @1080p, 17 px @1440p (UI scale setting 90–110%).
- **Iconography:** game-icons.net SVG set, recolored flat parchment-on-ink, one icon per item/
  ability/stat/profession (curation pipeline in tech/ASSET_PIPELINE.md §Icons; attribution in
  CREDITS.md). Never emoji, never mixed icon styles in one surface.

## 2. Motion Rules (the UI is animated, always purposefully)

| Event                                                                                                         | Motion (all GPU-cheap transform/opacity)                                               |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Panel open/close                                                                                              | 140 ms: fade + 8 px rise + clip-corner "unfold" (scaleY 0.98→1); close 100 ms          |
| Hover (buttons/slots)                                                                                         | 80 ms gold seam glow + 1 px lift; active = press 1 px                                  |
| Bars (HP/resource/XP)                                                                                         | fill lerp 200 ms + afterimage ghost bar (damage chip in lighter red, 400 ms lag)       |
| Cooldowns                                                                                                     | radial wipe + end "ready" ping (scale 1.15→1 + tick sound)                             |
| Toasts (loot/quest/discovery)                                                                                 | slide-in right 160 ms, dwell, fade; stack max 5, collapse "+n more"                    |
| Zone banner                                                                                                   | 500 ms letter-spaced fade-in of zone name (Amaranth 42 px) + underline draw; 3 s dwell |
| Level up                                                                                                      | XP bar burst particles (DOM canvas), gold flash frame around HUD 600 ms                |
| Damage numbers (in-canvas)                                                                                    | pop-scale 1.3→1, arc drift, 700 ms; crits 1.6× + shake tick                            |
| Global rule: nothing bounces cartoonishly ≥1.2 scale except crits/level-up; ease `cubic-bezier(.2,.8,.25,1)`. |

## 3. HUD Layout (1920×1080 reference, all anchored responsive)

```
┌─────────────────────────────────────────────────────────────┐
│ [Zone banner: centered top, transient]        [Minimap ◯ TR]│
│ [Buffs/debuffs row under minimap]                           │
│                                                             │
│                    ︿ soft-target plate                      │
│                    (name, HP, cast bar)                     │
│                        · reticle ·                          │
│                                              [Quest tracker]│
│                                              [ 3 pinned    ]│
│ [Chat TL-bottom]                                            │
│ ┌ chat tabs ┐                                               │
│ │ scrollback│      [HP globe┃resource globe]                │
│ └ input ────┘   [stamina slim bar under globes]             │
│            [1][2][3][4][5][6][7][8]  [E][V]                 │
│            [cast bar centered above hotbar]                 │
│ [XP thin bar: full bottom edge, segment ticks]              │
└─────────────────────────────────────────────────────────────┘
```

- **Vitals:** twin faceted globes (HP left, class resource right) flanking the hotbar — angular
  hexagon-cut frames, animated liquid fill (shader-ish CSS), numbers on hover always-on option.
  Rogue combo points: 5 diamond pips arcing over the resource globe.
- **Hotbar:** 8 ability slots (52 px) + `E` consumable + `V` dodge indicator (shows stamina-ready
  state). Keybind glyphs top-left of slots; cooldown radials; resource-insufficient = desaturate +
  brief red seam pulse on attempted use; proc highlights = animated gold seam rotation.
- **Soft-target plate:** floats under reticle target: name, level (skull if 5+ above), HP bar,
  cast/telegraph bar, rank icon (elite/boss). Fades when no candidate.
- **Nameplates (in-canvas):** players always (name + class-color HP sliver + level); enemies at
  ≤30 m or in combat; NPCs per NPCS_ENEMIES.md §6. Scale-with-distance, occlusion-fade.
- **Reticle:** small diamond dot; expands slightly on valid soft-target; turns gold over
  interactables with `F` prompt + radial hold-progress for gathers.

## 4. Screens (full inventory of surfaces)

| Screen                      | Key elements (all follow §1 language)                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login / Register**        | Full-bleed animated 3D vignette (slow camera drift over Dawnshore at sunrise — real scene, not a JPG; `assets/backgrounds/*` used as fallback stills on load error). Angular panel: account name, password, register toggle, version tag, server status pip (online/players). Errors inline, shake 4 px.                                                                                            |
| **Character Select**        | Left: character cards (name, class glyph, level, zone last seen) with hover tilt; right: selected character posed in a 3D diorama (their outfit + weapons, idle + occasional emote), Enter World CTA, delete (type-name confirm modal). Max 5 slots.                                                                                                                                                |
| **Character Create**        | 3-step flow in one screen: (1) class carousel — 4 large cards, hover = ability sizzle list + playstyle line, selected class poses in diorama with signature anim loop; (2) look — body (M/F), skin tone (5 swatches), outfit (Ranger/Peasant set recolors), hairstyle (7) + color (8 swatches), eyebrow/beard toggles; (3) name + claim. Random-look dice button. All changes live on the 3D model. |
| **Inventory (`I`)**         | 48-slot grid + paper-doll (3D preview torso-cam) + gold + weight-free (no encumbrance) + sort/search + junk-sell hint. Drag ghosts are angular cut cards.                                                                                                                                                                                                                                           |
| **Character (`C`)**         | Attributes with +/− staging & confirm, derived stats list with hover formulas (transparency!), resistances, playtime, titles.                                                                                                                                                                                                                                                                       |
| **Skills (`K`)**            | Left: 8 ability tiles with rank/unlock states + drag-to-hotbar; right: 3-branch tree — vertical faceted lattice per branch, nodes as cut hexes, connectors light up on invest, capstone at lattice crown; respec button (Mirror of Dawn deep-link note).                                                                                                                                            |
| **Professions (`J`)**       | 4 profession rows (level bar, tier gates as diamond markers) + codex grid per profession (silhouette → filled on first gather) + stats (gathered counts).                                                                                                                                                                                                                                           |
| **Map (`M`)**               | Painted world map (baked, hand-drawn grade), pan/zoom, fog-of-unknowing, POI/shrine/quest pins, fast-travel from shrine pins (hold-confirm), coords readout. Legend collapsible.                                                                                                                                                                                                                    |
| **Quest Journal (`L`)**     | Per QUESTS_POI.md §4.                                                                                                                                                                                                                                                                                                                                                                               |
| **Dialogue**                | Lower-third panel, Kenney-border accent seam, typewriter, choices as angular chips.                                                                                                                                                                                                                                                                                                                 |
| **Vendor**                  | Two-pane buy/sell with rarity-tinted rows, buyback tab, drag-or-double-click, gold delta preview line.                                                                                                                                                                                                                                                                                              |
| **Loot panel**              | Small anchored panel at bag: rows with icon/name/qty, `F` per-row / Shift+F all, auto-close.                                                                                                                                                                                                                                                                                                        |
| **Settings**                | Tabs: Graphics (quality preset, shadows, foliage density, FX density, FPS cap, FOV), Audio (buses), Controls (full rebind grid, conflict detection), Interface (UI scale, camera shake, damage numbers density, colorblind decals mode, nameplate rules), Account (logout, credits).                                                                                                                |
| **Death screen**            | Desaturate + vignette, "You have fallen." (Amaranth), respawn CTA with shrine name + distance, tip line rotates.                                                                                                                                                                                                                                                                                    |
| **GM panel (`F10`, gated)** | See GM_TOOLS.md.                                                                                                                                                                                                                                                                                                                                                                                    |
| **System modals**           | Disconnect/reconnect overlay with animated dawn glyph; update-required screen; queue-free (20 players!) but capacity message if ever needed.                                                                                                                                                                                                                                                        |

## 5. Chat

Bottom-left, 3 tabs (All / Local / System+Loot), 40% opacity idle → full on hover/focus, Enter to
type, `/w name`, `/local`, `/g` global aliases, GM messages get gold seam, timestamps on hover,
click name → whisper. Emote text commands (`/wave` triggers UAL `Wave`… on the character too —
cheap delight). Profanity filter: off (friends server) but pluggable.

## 6. Onboarding (no tutorial walls)

First spawn: 4 contextual glass-line hints max (move/camera → sprint → attack → screen edge "follow
the road"), each dismisses on doing it. Signposts + quest text carry the rest. A `?` help panel
lists controls & systems for reference. GM onboarding: first GM login toast → GM panel tour.

## 7. Accessibility & Comfort

- Colorblind-safe telegraphs (pattern overlays: stripes=damage, dots=safe); the UI never encodes meaning through color alone.
- UI scale 90–110%, chat font size setting, camera shake 0–100%, screen-flash reduction toggle,
  photosensitivity-safe VFX guideline (no >3 Hz full-screen flashes, ever).
- All panels keyboard-navigable; rebindable everything; AZERTY/QWERTZ detection prompt on first run
  (German-friendly default question — the audience!).

## 8. Anti-slop checklist (applies to every new surface, enforced in review)

- [ ] No default border-radius pills; corners follow §1 cuts.
- [ ] No drop-shadow soup: one shadow token (`0 4px 16px #0008`) max per layer.
- [ ] Real hierarchy: one Amaranth display element per surface; body stays Nunito Sans.
- [ ] Every interactive element has hover/active/disabled/focus states designed, not defaulted.
- [ ] Panel opens with its §2 motion; nothing pops instantly except combat-critical elements.
- [ ] Icons from the curated set only; no emoji, no mixed stroke weights.
- [ ] Text reads at 1080p from 60 cm (min 13 px rendered).
