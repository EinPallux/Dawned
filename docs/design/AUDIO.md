# Dawned — Audio Direction & Plan

> The repo currently contains **no audio assets** (verified). Audio is nonetheless a 0.1.0 feature:
> a silent MMORPG fails the "alive" pillar. This doc sets direction, the required asset list, the
> sourcing strategy, and the tech approach. Sourcing decided (2026-08-02): CC0-first per §3.

## 1. Direction
- **Music:** warm, melodic, small-ensemble folk-orchestral loops (think cozy adventure, not epic
  trailer). One identity motif ("dawn theme") reused across zone tracks in different moods. Volume
  ducks in combat under the combat layer; silence is allowed (tracks breathe with gaps — 60–90 s
  music, 30–60 s ambience-only).
- **Ambience:** per-zone beds (meadow birds/surf · deep forest · autumn wind + leaves · dry wind +
  insects · canyon wind + distant rumbles · grove shimmer) + positional emitters (waterfalls, surf
  lines, campfires, taverns, bees).
- **SFX:** chunky, readable, low-poly-friendly (short, punchy, slightly toy-like — matches art;
  no hyperreal gore). Combat clarity beats realism: distinct silhouette per sound like per shape.
- **UI:** soft wooden/parchment ticks; gold "seam" shimmer for confirmations; distinct rarity
  stingers on loot (Rare+ only — scarcity keeps the dopamine honest).

## 2. Required Asset List (0.1.0)
| Bucket | Count (≈) | Notes |
|---|---|---|
| Music: zone tracks | 7 | 1 per zone + Dawnhaven town + login theme (login = the motif, statement version) |
| Music: combat layer | 2 | generic combat + boss layer (additive stems over zone track) |
| Ambience beds | 9 | loopable 60 s+ — 7 zone beds + rain bed + storm layer (weather system) |
| Positional emitters | 11 | waterfall, surf, fire, tavern walla, bees, wind gusts, mine drips, thunder one-shots (3 distance variants)… |
| Combat SFX | ~70 | per class: 3 basic whooshes+impacts, 8 ability casts/impacts; shared: hits (3 surfaces), crits, dodge, block, parry-stagger, death (player/enemy sizes S/M/L), telegraph warn, projectile loops |
| Enemy vocals | ~25 | 1 aggro + 1 hurt + 1 death per family (blob/mush/bee/ghost/skeleton/orc/alpaking/dino/demon/golem/yeti/dragon…) — pitch-shift variants acceptable |
| World/profession | ~20 | chop ×3, mine ×3, pick, splash/cast/reel/catch, node deplete/respawn, chest, loot bag, coin |
| UI | ~20 | hover, click, open/close, tab, toast, quest accept/complete, level-up fanfare (the ONE big flourish), error, rarity stingers ×3 |
| **Total** | **~185 files** | tracked in a manifest with per-file source + license |

## 3. Sourcing (decided: CC0-first curation)
1. **Kenney CC0 audio packs** (UI, impacts, interface) — style-consistent with our art sources.
2. **Curated CC0 from freesound/Sonniss GDC packs** (ambience, foley) — each file logged in
   CREDITS manifest even when CC0 (traceability).
3. **Music:** CC0/CC-BY instrumental loops curated for the motif-mood (CC-BY listed in CREDITS +
   in-game credits screen); owner-provided/commissioned tracks stay welcome as later swaps.
4. Light processing pass (trim, loudness -16 LUFS music / -12 SFX peaks, loop points, OGG 96–128k)
   via a scripted ffmpeg pipeline in `tools/` — sources kept in `assets/audio_src/`, shipped OGGs
   generated (see tech/ASSET_PIPELINE.md).

## 4. Tech (client)
- WebAudio graph: buses Master → {Music, Ambience, SFX, UI} (settings sliders persist);
  PannerNodes for positional SFX (linear rolloff, 40 m max audible); voice cap 24 with
  priority-steal (combat > world > ambience); round-robin pools (min 3 variants for repeated SFX)
  with ±4% pitch jitter.
- Music system: zone crossfade 4 s on polygon crossing; combat layer fades in at aggro (1 s), out
  8 s after combat; boss stem on boss aggro. All driven by the same zone/ambience profile data the
  admin editor edits.
- Server involvement: none (audio is presentation; events already exist in the replication stream).
- Loading: audio lazy-loads per zone manifest chunk; login theme + UI bank preload (<1.5 MB).

## 5. Mix principles
Combat readability ladder (loud→quiet): your crits/big hits > telegraph warnings
> incoming damage > your basics > enemy vocals > world > music. Duck music −6 dB in combat, −12 dB
during boss ults. Never let UI outshout combat. One full-mix pass is a P14 checklist item with
per-bus limiting.
