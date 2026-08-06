# CREDITS — Dawned

Dawned is built on generously licensed art. This file is partly hand-written (this header + pack
credits) and partly **generated** (the per-file ledger section is produced by the asset pipeline
from manifest provenance data — see docs/tech/ASSET_PIPELINE.md; builds fail if a served asset has
no ledger entry). An in-game credits screen renders this file.

## Asset packs

| Source | Packs (in `assets/`) | License |
|---|---|---|
| **Quaternius** (quaternius.com) | Universal Base Characters, Modular Character Outfits – Fantasy, Universal Animation Library 1 [PRO] & 2 [Standard], Monster Bundle, Animated Fish Bundle, Ultimate Nature Kit 2 [Standard], Stylized Nature MegaKit [Standard], Fantasy Props MegaKit [Standard], **Ultimate Fantasy Buildings Kit [Standard]**, Cube World, Farm, Pirate bundles | CC0 1.0 Universal. Two of these ship `License_Standard.txt` in-folder stating exactly that; **Ultimate Nature Kit 2 and the Buildings Kit do not**, and are shipped on the judgement that they are the same publisher, the same `[Standard]` packaging and the same glTF export as their siblings. Written down rather than assumed — if that is ever wrong, these two are what to pull. |
| **KayKit** (Kay Lousberg, kaylousberg.com) | Adventurers 2.0 FREE, Skeletons 1.1 FREE, Fantasy Weapon Bits, RPG Tools Bits, ResourceBits, Forest Nature Pack, Low Poly Dungeon Pack, Halloween Bundle | CC0 (credit appreciated — hereby given!) |
| **Kenney** (kenney.nl) | Fantasy UI Borders, Particle Pack | CC0 |
| Various (Sketchfab & itch sources) | Low Poly Fantasy Weapons, Misc Weapons MiniPoly, Gems & Ores, Nature/Rocks/Desert/Egypt/**Medieval Village** packs, Noise Texture Pack | Per-pack — **license verification is a gate** before any file is served. P10 wanted the Gems & Ores pack for its ore-in-stone rocks and did **not** use it: the folder carries no license file and its glTF is a third-party conversion, so its provenance cannot be attributed. The mining nodes are tinted KayKit rocks instead. P12 wanted the **Medieval Village Pack** for Sungraze farmsteads and did not use it for the same reason — no license file, FBX/OBJ only, unattributable; the farmsteads come from the Buildings Kit's own `Farm_*` and `Windmill_*` models instead. |
| **Owner-made** | `assets/backgrounds/*` (menu/board art) | Project-internal |

## Icons
Item/ability/UI icons derived from **game-icons.net** — CC BY 3.0. Individual icon authors
(Lorc, Delapouite, and others) are credited per-icon in the generated ledger below and on the
in-game credits screen, per the license's attribution requirement.

## Fonts
- **Amaranth** (Gesine Todt) — SIL OFL 1.1
- **Nunito Sans** (Vernon Adams et al.) — SIL OFL 1.1

## Audio
To be curated (CC0-first) — every file will be listed in the generated ledger with source, author
and license. See docs/design/AUDIO.md.

## Inspiration
Farever, Guild Wars 2 and Black Desert Online inspired the feel. No assets, code, text or maps
from these games are used.

---

<!-- GENERATED LEDGER BELOW — do not edit by hand; `pnpm assets:build` rewrites it -->

## Per-file ledger

### Game-icons.net
Pack id `game-icons` · author **caro-asercion (game-icons.net)** · license **CC-BY-3.0** · https://creativecommons.org/licenses/by/3.0/

- `icon_caro-asercion__round-potion` — assets_vendor/game-icons/caro-asercion/round-potion.svg
- `icon_cathelineau__tree-face` — assets_vendor/game-icons/cathelineau/tree-face.svg · cathelineau (game-icons.net)
- `icon_darkzaitzev__hooded-figure` — assets_vendor/game-icons/darkzaitzev/hooded-figure.svg · DarkZaitzev (game-icons.net)
- `icon_darkzaitzev__smoke-bomb` — assets_vendor/game-icons/darkzaitzev/smoke-bomb.svg · DarkZaitzev (game-icons.net)
- `icon_delapouite__amber-mosquito` — assets_vendor/game-icons/delapouite/amber-mosquito.svg · Delapouite (game-icons.net)
- `icon_delapouite__armor-upgrade` — assets_vendor/game-icons/delapouite/armor-upgrade.svg · Delapouite (game-icons.net)
- `icon_delapouite__armored-boomerang` — assets_vendor/game-icons/delapouite/armored-boomerang.svg · Delapouite (game-icons.net)
- `icon_delapouite__backpack` — assets_vendor/game-icons/delapouite/backpack.svg · Delapouite (game-icons.net)
- `icon_delapouite__bandana` — assets_vendor/game-icons/delapouite/bandana.svg · Delapouite (game-icons.net)
- `icon_delapouite__bracer` — assets_vendor/game-icons/delapouite/bracer.svg · Delapouite (game-icons.net)
- `icon_delapouite__bread-slice` — assets_vendor/game-icons/delapouite/bread-slice.svg · Delapouite (game-icons.net)
- `icon_delapouite__cape-armor` — assets_vendor/game-icons/delapouite/cape-armor.svg · Delapouite (game-icons.net)
- `icon_delapouite__charging-bull` — assets_vendor/game-icons/delapouite/charging-bull.svg · Delapouite (game-icons.net)
- `icon_delapouite__chest-armor` — assets_vendor/game-icons/delapouite/chest-armor.svg · Delapouite (game-icons.net)
- `icon_delapouite__circling-fish` — assets_vendor/game-icons/delapouite/circling-fish.svg · Delapouite (game-icons.net)
- `icon_delapouite__clownfish` — assets_vendor/game-icons/delapouite/clownfish.svg · Delapouite (game-icons.net)
- `icon_delapouite__coal-pile` — assets_vendor/game-icons/delapouite/coal-pile.svg · Delapouite (game-icons.net)
- `icon_delapouite__dolphin` — assets_vendor/game-icons/delapouite/dolphin.svg · Delapouite (game-icons.net)
- `icon_delapouite__dwarf-face` — assets_vendor/game-icons/delapouite/dwarf-face.svg · Delapouite (game-icons.net)
- `icon_delapouite__eel` — assets_vendor/game-icons/delapouite/eel.svg · Delapouite (game-icons.net)
- `icon_delapouite__emerald-necklace` — assets_vendor/game-icons/delapouite/emerald-necklace.svg · Delapouite (game-icons.net)
- `icon_delapouite__fish-monster` — assets_vendor/game-icons/delapouite/fish-monster.svg · Delapouite (game-icons.net)
- `icon_delapouite__fish-scales` — assets_vendor/game-icons/delapouite/fish-scales.svg · Delapouite (game-icons.net)
- `icon_delapouite__flanged-mace` — assets_vendor/game-icons/delapouite/flanged-mace.svg · Delapouite (game-icons.net)
- `icon_delapouite__gauntlet` — assets_vendor/game-icons/delapouite/gauntlet.svg · Delapouite (game-icons.net)
- `icon_delapouite__gloves` — assets_vendor/game-icons/delapouite/gloves.svg · Delapouite (game-icons.net)
- `icon_delapouite__gold-nuggets` — assets_vendor/game-icons/delapouite/gold-nuggets.svg · Delapouite (game-icons.net)
- `icon_delapouite__gold-stack` — assets_vendor/game-icons/delapouite/gold-stack.svg · Delapouite (game-icons.net)
- `icon_delapouite__grass` — assets_vendor/game-icons/delapouite/grass.svg · Delapouite (game-icons.net)
- `icon_delapouite__hand-bandage` — assets_vendor/game-icons/delapouite/hand-bandage.svg · Delapouite (game-icons.net)
- `icon_delapouite__health-potion` — assets_vendor/game-icons/delapouite/health-potion.svg · Delapouite (game-icons.net)
- `icon_delapouite__herbs-bundle` — assets_vendor/game-icons/delapouite/herbs-bundle.svg · Delapouite (game-icons.net)
- `icon_delapouite__honey-jar` — assets_vendor/game-icons/delapouite/honey-jar.svg · Delapouite (game-icons.net)
- `icon_delapouite__hot-meal` — assets_vendor/game-icons/delapouite/hot-meal.svg · Delapouite (game-icons.net)
- `icon_delapouite__katana` — assets_vendor/game-icons/delapouite/katana.svg · Delapouite (game-icons.net)
- `icon_delapouite__knee-bandage` — assets_vendor/game-icons/delapouite/knee-bandage.svg · Delapouite (game-icons.net)
- `icon_delapouite__knee-pad` — assets_vendor/game-icons/delapouite/knee-pad.svg · Delapouite (game-icons.net)
- `icon_delapouite__leather-armor` — assets_vendor/game-icons/delapouite/leather-armor.svg · Delapouite (game-icons.net)
- `icon_delapouite__leg-armor` — assets_vendor/game-icons/delapouite/leg-armor.svg · Delapouite (game-icons.net)
- `icon_delapouite__light-helm` — assets_vendor/game-icons/delapouite/light-helm.svg · Delapouite (game-icons.net)
- `icon_delapouite__locked-heart` — assets_vendor/game-icons/delapouite/locked-heart.svg · Delapouite (game-icons.net)
- `icon_delapouite__log` — assets_vendor/game-icons/delapouite/log.svg · Delapouite (game-icons.net)
- `icon_delapouite__magic-potion` — assets_vendor/game-icons/delapouite/magic-potion.svg · Delapouite (game-icons.net)
- `icon_delapouite__manta-ray` — assets_vendor/game-icons/delapouite/manta-ray.svg · Delapouite (game-icons.net)
- `icon_delapouite__meal` — assets_vendor/game-icons/delapouite/meal.svg · Delapouite (game-icons.net)
- `icon_delapouite__medicines` — assets_vendor/game-icons/delapouite/medicines.svg · Delapouite (game-icons.net)
- `icon_delapouite__metal-boot` — assets_vendor/game-icons/delapouite/metal-boot.svg · Delapouite (game-icons.net)
- `icon_delapouite__mighty-force` — assets_vendor/game-icons/delapouite/mighty-force.svg · Delapouite (game-icons.net)
- `icon_delapouite__mineral-pearls` — assets_vendor/game-icons/delapouite/mineral-pearls.svg · Delapouite (game-icons.net)
- `icon_delapouite__necklace-display` — assets_vendor/game-icons/delapouite/necklace-display.svg · Delapouite (game-icons.net)
- `icon_delapouite__pearl-earring` — assets_vendor/game-icons/delapouite/pearl-earring.svg · Delapouite (game-icons.net)
- `icon_delapouite__pearl-necklace` — assets_vendor/game-icons/delapouite/pearl-necklace.svg · Delapouite (game-icons.net)
- `icon_delapouite__piranha` — assets_vendor/game-icons/delapouite/piranha.svg · Delapouite (game-icons.net)
- `icon_delapouite__ring` — assets_vendor/game-icons/delapouite/ring.svg · Delapouite (game-icons.net)
- `icon_delapouite__ring-mould` — assets_vendor/game-icons/delapouite/ring-mould.svg · Delapouite (game-icons.net)
- `icon_delapouite__rolled-cloth` — assets_vendor/game-icons/delapouite/rolled-cloth.svg · Delapouite (game-icons.net)
- `icon_delapouite__rupee` — assets_vendor/game-icons/delapouite/rupee.svg · Delapouite (game-icons.net)
- `icon_delapouite__seedling` — assets_vendor/game-icons/delapouite/seedling.svg · Delapouite (game-icons.net)
- `icon_delapouite__shark-fin` — assets_vendor/game-icons/delapouite/shark-fin.svg · Delapouite (game-icons.net)
- `icon_delapouite__sharp-halberd` — assets_vendor/game-icons/delapouite/sharp-halberd.svg · Delapouite (game-icons.net)
- `icon_delapouite__shield-bash` — assets_vendor/game-icons/delapouite/shield-bash.svg · Delapouite (game-icons.net)
- `icon_delapouite__shoulder-armor` — assets_vendor/game-icons/delapouite/shoulder-armor.svg · Delapouite (game-icons.net)
- `icon_delapouite__skirt` — assets_vendor/game-icons/delapouite/skirt.svg · Delapouite (game-icons.net)
- `icon_delapouite__sleeveless-jacket` — assets_vendor/game-icons/delapouite/sleeveless-jacket.svg · Delapouite (game-icons.net)
- `icon_delapouite__slippers` — assets_vendor/game-icons/delapouite/slippers.svg · Delapouite (game-icons.net)
- `icon_delapouite__sperm-whale` — assets_vendor/game-icons/delapouite/sperm-whale.svg · Delapouite (game-icons.net)
- `icon_delapouite__spiked-dragon-head` — assets_vendor/game-icons/delapouite/spiked-dragon-head.svg · Delapouite (game-icons.net)
- `icon_delapouite__stone-pile` — assets_vendor/game-icons/delapouite/stone-pile.svg · Delapouite (game-icons.net)
- `icon_delapouite__stone-wall` — assets_vendor/game-icons/delapouite/stone-wall.svg · Delapouite (game-icons.net)
- `icon_delapouite__sunflower` — assets_vendor/game-icons/delapouite/sunflower.svg · Delapouite (game-icons.net)
- `icon_delapouite__sunrise` — assets_vendor/game-icons/delapouite/sunrise.svg · Delapouite (game-icons.net)
- `icon_delapouite__thor-hammer` — assets_vendor/game-icons/delapouite/thor-hammer.svg · Delapouite (game-icons.net)
- `icon_delapouite__tomahawk` — assets_vendor/game-icons/delapouite/tomahawk.svg · Delapouite (game-icons.net)
- `icon_delapouite__tree-growth` — assets_vendor/game-icons/delapouite/tree-growth.svg · Delapouite (game-icons.net)
- `icon_delapouite__tribal-gear` — assets_vendor/game-icons/delapouite/tribal-gear.svg · Delapouite (game-icons.net)
- `icon_delapouite__tusks-flag` — assets_vendor/game-icons/delapouite/tusks-flag.svg · Delapouite (game-icons.net)
- `icon_delapouite__underwear-shorts` — assets_vendor/game-icons/delapouite/underwear-shorts.svg · Delapouite (game-icons.net)
- `icon_delapouite__war-axe` — assets_vendor/game-icons/delapouite/war-axe.svg · Delapouite (game-icons.net)
- `icon_delapouite__warhammer` — assets_vendor/game-icons/delapouite/warhammer.svg · Delapouite (game-icons.net)
- `icon_delapouite__whale-tail` — assets_vendor/game-icons/delapouite/whale-tail.svg · Delapouite (game-icons.net)
- `icon_delapouite__wood-beam` — assets_vendor/game-icons/delapouite/wood-beam.svg · Delapouite (game-icons.net)
- `icon_delapouite__wood-club` — assets_vendor/game-icons/delapouite/wood-club.svg · Delapouite (game-icons.net)
- `icon_delapouite__wool` — assets_vendor/game-icons/delapouite/wool.svg · Delapouite (game-icons.net)
- `icon_irongamer__armored-pants` — assets_vendor/game-icons/irongamer/armored-pants.svg · irongamer (game-icons.net)
- `icon_kier-heyl__dwarf-helmet` — assets_vendor/game-icons/kier-heyl/dwarf-helmet.svg · kier-heyl (game-icons.net)
- `icon_lorc__acorn` — assets_vendor/game-icons/lorc/acorn.svg · Lorc (game-icons.net)
- `icon_lorc__anvil-impact` — assets_vendor/game-icons/lorc/anvil-impact.svg · Lorc (game-icons.net)
- `icon_lorc__armor-vest` — assets_vendor/game-icons/lorc/armor-vest.svg · Lorc (game-icons.net)
- `icon_lorc__aura` — assets_vendor/game-icons/lorc/aura.svg · Lorc (game-icons.net)
- `icon_lorc__axe-swing` — assets_vendor/game-icons/lorc/axe-swing.svg · Lorc (game-icons.net)
- `icon_lorc__barbute` — assets_vendor/game-icons/lorc/barbute.svg · Lorc (game-icons.net)
- `icon_lorc__battle-axe` — assets_vendor/game-icons/lorc/battle-axe.svg · Lorc (game-icons.net)
- `icon_lorc__beams-aura` — assets_vendor/game-icons/lorc/beams-aura.svg · Lorc (game-icons.net)
- `icon_lorc__belt-buckles` — assets_vendor/game-icons/lorc/belt-buckles.svg · Lorc (game-icons.net)
- `icon_lorc__black-hole-bolas` — assets_vendor/game-icons/lorc/black-hole-bolas.svg · Lorc (game-icons.net)
- `icon_lorc__bleeding-wound` — assets_vendor/game-icons/lorc/bleeding-wound.svg · Lorc (game-icons.net)
- `icon_lorc__bloody-sword` — assets_vendor/game-icons/lorc/bloody-sword.svg · Lorc (game-icons.net)
- `icon_lorc__bolt-shield` — assets_vendor/game-icons/lorc/bolt-shield.svg · Lorc (game-icons.net)
- `icon_lorc__bone-knife` — assets_vendor/game-icons/lorc/bone-knife.svg · Lorc (game-icons.net)
- `icon_lorc__book-aura` — assets_vendor/game-icons/lorc/book-aura.svg · Lorc (game-icons.net)
- `icon_lorc__boot-prints` — assets_vendor/game-icons/lorc/boot-prints.svg · Lorc (game-icons.net)
- `icon_lorc__boot-stomp` — assets_vendor/game-icons/lorc/boot-stomp.svg · Lorc (game-icons.net)
- `icon_lorc__boots` — assets_vendor/game-icons/lorc/boots.svg · Lorc (game-icons.net)
- `icon_lorc__bordered-shield` — assets_vendor/game-icons/lorc/bordered-shield.svg · Lorc (game-icons.net)
- `icon_lorc__bowie-knife` — assets_vendor/game-icons/lorc/bowie-knife.svg · Lorc (game-icons.net)
- `icon_lorc__breastplate` — assets_vendor/game-icons/lorc/breastplate.svg · Lorc (game-icons.net)
- `icon_lorc__broadsword` — assets_vendor/game-icons/lorc/broadsword.svg · Lorc (game-icons.net)
- `icon_lorc__broken-bone` — assets_vendor/game-icons/lorc/broken-bone.svg · Lorc (game-icons.net)
- `icon_lorc__broken-bottle` — assets_vendor/game-icons/lorc/broken-bottle.svg · Lorc (game-icons.net)
- `icon_lorc__broken-heart-zone` — assets_vendor/game-icons/lorc/broken-heart-zone.svg · Lorc (game-icons.net)
- `icon_lorc__broken-skull` — assets_vendor/game-icons/lorc/broken-skull.svg · Lorc (game-icons.net)
- `icon_lorc__bubbling-flask` — assets_vendor/game-icons/lorc/bubbling-flask.svg · Lorc (game-icons.net)
- `icon_lorc__bull-horns` — assets_vendor/game-icons/lorc/bull-horns.svg · Lorc (game-icons.net)
- `icon_lorc__burning-embers` — assets_vendor/game-icons/lorc/burning-embers.svg · Lorc (game-icons.net)
- `icon_lorc__burning-tree` — assets_vendor/game-icons/lorc/burning-tree.svg · Lorc (game-icons.net)
- `icon_lorc__cake-slice` — assets_vendor/game-icons/lorc/cake-slice.svg · Lorc (game-icons.net)
- `icon_lorc__candle-flame` — assets_vendor/game-icons/lorc/candle-flame.svg · Lorc (game-icons.net)
- `icon_lorc__checked-shield` — assets_vendor/game-icons/lorc/checked-shield.svg · Lorc (game-icons.net)
- `icon_lorc__cheese-wedge` — assets_vendor/game-icons/lorc/cheese-wedge.svg · Lorc (game-icons.net)
- `icon_lorc__claw-slashes` — assets_vendor/game-icons/lorc/claw-slashes.svg · Lorc (game-icons.net)
- `icon_lorc__cowled` — assets_vendor/game-icons/lorc/cowled.svg · Lorc (game-icons.net)
- `icon_lorc__crested-helmet` — assets_vendor/game-icons/lorc/crested-helmet.svg · Lorc (game-icons.net)
- `icon_lorc__crossed-swords` — assets_vendor/game-icons/lorc/crossed-swords.svg · Lorc (game-icons.net)
- `icon_lorc__crystal-cluster` — assets_vendor/game-icons/lorc/crystal-cluster.svg · Lorc (game-icons.net)
- `icon_lorc__crystal-growth` — assets_vendor/game-icons/lorc/crystal-growth.svg · Lorc (game-icons.net)
- `icon_lorc__crystal-shine` — assets_vendor/game-icons/lorc/crystal-shine.svg · Lorc (game-icons.net)
- `icon_lorc__crystal-wand` — assets_vendor/game-icons/lorc/crystal-wand.svg · Lorc (game-icons.net)
- `icon_lorc__curled-leaf` — assets_vendor/game-icons/lorc/curled-leaf.svg · Lorc (game-icons.net)
- `icon_lorc__curvy-knife` — assets_vendor/game-icons/lorc/curvy-knife.svg · Lorc (game-icons.net)
- `icon_lorc__daisy` — assets_vendor/game-icons/lorc/daisy.svg · Lorc (game-icons.net)
- `icon_lorc__dead-wood` — assets_vendor/game-icons/lorc/dead-wood.svg · Lorc (game-icons.net)
- `icon_lorc__diamond-hard` — assets_vendor/game-icons/lorc/diamond-hard.svg · Lorc (game-icons.net)
- `icon_lorc__dorsal-scales` — assets_vendor/game-icons/lorc/dorsal-scales.svg · Lorc (game-icons.net)
- `icon_lorc__dragon-head` — assets_vendor/game-icons/lorc/dragon-head.svg · Lorc (game-icons.net)
- `icon_lorc__dripping-honey` — assets_vendor/game-icons/lorc/dripping-honey.svg · Lorc (game-icons.net)
- `icon_lorc__dripping-knife` — assets_vendor/game-icons/lorc/dripping-knife.svg · Lorc (game-icons.net)
- `icon_lorc__dust-cloud` — assets_vendor/game-icons/lorc/dust-cloud.svg · Lorc (game-icons.net)
- `icon_lorc__eclipse-flare` — assets_vendor/game-icons/lorc/eclipse-flare.svg · Lorc (game-icons.net)
- `icon_lorc__edged-shield` — assets_vendor/game-icons/lorc/edged-shield.svg · Lorc (game-icons.net)
- `icon_lorc__emerald` — assets_vendor/game-icons/lorc/emerald.svg · Lorc (game-icons.net)
- `icon_lorc__energy-arrow` — assets_vendor/game-icons/lorc/energy-arrow.svg · Lorc (game-icons.net)
- `icon_lorc__fire-bottle` — assets_vendor/game-icons/lorc/fire-bottle.svg · Lorc (game-icons.net)
- `icon_lorc__fire-wave` — assets_vendor/game-icons/lorc/fire-wave.svg · Lorc (game-icons.net)
- `icon_lorc__fireball` — assets_vendor/game-icons/lorc/fireball.svg · Lorc (game-icons.net)
- `icon_lorc__fish-corpse` — assets_vendor/game-icons/lorc/fish-corpse.svg · Lorc (game-icons.net)
- `icon_lorc__fishbone` — assets_vendor/game-icons/lorc/fishbone.svg · Lorc (game-icons.net)
- `icon_lorc__fishing-hook` — assets_vendor/game-icons/lorc/fishing-hook.svg · Lorc (game-icons.net)
- `icon_lorc__fist` — assets_vendor/game-icons/lorc/fist.svg · Lorc (game-icons.net)
- `icon_lorc__flaming-sheet` — assets_vendor/game-icons/lorc/flaming-sheet.svg · Lorc (game-icons.net)
- `icon_lorc__foot-trip` — assets_vendor/game-icons/lorc/foot-trip.svg · Lorc (game-icons.net)
- `icon_lorc__frozen-orb` — assets_vendor/game-icons/lorc/frozen-orb.svg · Lorc (game-icons.net)
- `icon_lorc__gavel` — assets_vendor/game-icons/lorc/gavel.svg · Lorc (game-icons.net)
- `icon_lorc__gem-chain` — assets_vendor/game-icons/lorc/gem-chain.svg · Lorc (game-icons.net)
- `icon_lorc__gem-pendant` — assets_vendor/game-icons/lorc/gem-pendant.svg · Lorc (game-icons.net)
- `icon_lorc__gems` — assets_vendor/game-icons/lorc/gems.svg · Lorc (game-icons.net)
- `icon_lorc__ghost` — assets_vendor/game-icons/lorc/ghost.svg · Lorc (game-icons.net)
- `icon_lorc__glass-heart` — assets_vendor/game-icons/lorc/glass-heart.svg · Lorc (game-icons.net)
- `icon_lorc__glowing-hands` — assets_vendor/game-icons/lorc/glowing-hands.svg · Lorc (game-icons.net)
- `icon_lorc__gold-scarab` — assets_vendor/game-icons/lorc/gold-scarab.svg · Lorc (game-icons.net)
- `icon_lorc__gooey-eyed-sun` — assets_vendor/game-icons/lorc/gooey-eyed-sun.svg · Lorc (game-icons.net)
- `icon_lorc__gooey-molecule` — assets_vendor/game-icons/lorc/gooey-molecule.svg · Lorc (game-icons.net)
- `icon_lorc__hammer-drop` — assets_vendor/game-icons/lorc/hammer-drop.svg · Lorc (game-icons.net)
- `icon_lorc__hand` — assets_vendor/game-icons/lorc/hand.svg · Lorc (game-icons.net)
- `icon_lorc__heart-bottle` — assets_vendor/game-icons/lorc/heart-bottle.svg · Lorc (game-icons.net)
- `icon_lorc__heat-haze` — assets_vendor/game-icons/lorc/heat-haze.svg · Lorc (game-icons.net)
- `icon_lorc__holy-symbol` — assets_vendor/game-icons/lorc/holy-symbol.svg · Lorc (game-icons.net)
- `icon_lorc__hood` — assets_vendor/game-icons/lorc/hood.svg · Lorc (game-icons.net)
- `icon_lorc__horned-helm` — assets_vendor/game-icons/lorc/horned-helm.svg · Lorc (game-icons.net)
- `icon_lorc__hot-spices` — assets_vendor/game-icons/lorc/hot-spices.svg · Lorc (game-icons.net)
- `icon_lorc__ice-spear` — assets_vendor/game-icons/lorc/ice-spear.svg · Lorc (game-icons.net)
- `icon_lorc__incense` — assets_vendor/game-icons/lorc/incense.svg · Lorc (game-icons.net)
- `icon_lorc__leaf-skeleton` — assets_vendor/game-icons/lorc/leaf-skeleton.svg · Lorc (game-icons.net)
- `icon_lorc__leaf-swirl` — assets_vendor/game-icons/lorc/leaf-swirl.svg · Lorc (game-icons.net)
- `icon_lorc__leather-boot` — assets_vendor/game-icons/lorc/leather-boot.svg · Lorc (game-icons.net)
- `icon_lorc__leather-vest` — assets_vendor/game-icons/lorc/leather-vest.svg · Lorc (game-icons.net)
- `icon_lorc__magic-shield` — assets_vendor/game-icons/lorc/magic-shield.svg · Lorc (game-icons.net)
- `icon_lorc__magic-swirl` — assets_vendor/game-icons/lorc/magic-swirl.svg · Lorc (game-icons.net)
- `icon_lorc__mailed-fist` — assets_vendor/game-icons/lorc/mailed-fist.svg · Lorc (game-icons.net)
- `icon_lorc__metal-bar` — assets_vendor/game-icons/lorc/metal-bar.svg · Lorc (game-icons.net)
- `icon_lorc__metal-scales` — assets_vendor/game-icons/lorc/metal-scales.svg · Lorc (game-icons.net)
- `icon_lorc__meteor-impact` — assets_vendor/game-icons/lorc/meteor-impact.svg · Lorc (game-icons.net)
- `icon_lorc__missile-swarm` — assets_vendor/game-icons/lorc/missile-swarm.svg · Lorc (game-icons.net)
- `icon_lorc__mushroom` — assets_vendor/game-icons/lorc/mushroom.svg · Lorc (game-icons.net)
- `icon_lorc__mushroom-cloud` — assets_vendor/game-icons/lorc/mushroom-cloud.svg · Lorc (game-icons.net)
- `icon_lorc__oak` — assets_vendor/game-icons/lorc/oak.svg · Lorc (game-icons.net)
- `icon_lorc__piercing-sword` — assets_vendor/game-icons/lorc/piercing-sword.svg · Lorc (game-icons.net)
- `icon_lorc__plain-dagger` — assets_vendor/game-icons/lorc/plain-dagger.svg · Lorc (game-icons.net)
- `icon_lorc__plate-claw` — assets_vendor/game-icons/lorc/plate-claw.svg · Lorc (game-icons.net)
- `icon_lorc__pointy-sword` — assets_vendor/game-icons/lorc/pointy-sword.svg · Lorc (game-icons.net)
- `icon_lorc__poison-bottle` — assets_vendor/game-icons/lorc/poison-bottle.svg · Lorc (game-icons.net)
- `icon_lorc__portal` — assets_vendor/game-icons/lorc/portal.svg · Lorc (game-icons.net)
- `icon_lorc__potion-ball` — assets_vendor/game-icons/lorc/potion-ball.svg · Lorc (game-icons.net)
- `icon_lorc__psychic-waves` — assets_vendor/game-icons/lorc/psychic-waves.svg · Lorc (game-icons.net)
- `icon_lorc__quake-stomp` — assets_vendor/game-icons/lorc/quake-stomp.svg · Lorc (game-icons.net)
- `icon_lorc__relic-blade` — assets_vendor/game-icons/lorc/relic-blade.svg · Lorc (game-icons.net)
- `icon_lorc__robe` — assets_vendor/game-icons/lorc/robe.svg · Lorc (game-icons.net)
- `icon_lorc__rock` — assets_vendor/game-icons/lorc/rock.svg · Lorc (game-icons.net)
- `icon_lorc__root-tip` — assets_vendor/game-icons/lorc/root-tip.svg · Lorc (game-icons.net)
- `icon_lorc__rune-stone` — assets_vendor/game-icons/lorc/rune-stone.svg · Lorc (game-icons.net)
- `icon_lorc__sacrificial-dagger` — assets_vendor/game-icons/lorc/sacrificial-dagger.svg · Lorc (game-icons.net)
- `icon_lorc__saphir` — assets_vendor/game-icons/lorc/saphir.svg · Lorc (game-icons.net)
- `icon_lorc__scale-mail` — assets_vendor/game-icons/lorc/scale-mail.svg · Lorc (game-icons.net)
- `icon_lorc__sea-dragon` — assets_vendor/game-icons/lorc/sea-dragon.svg · Lorc (game-icons.net)
- `icon_lorc__shadow-follower` — assets_vendor/game-icons/lorc/shadow-follower.svg · Lorc (game-icons.net)
- `icon_lorc__shard-sword` — assets_vendor/game-icons/lorc/shard-sword.svg · Lorc (game-icons.net)
- `icon_lorc__sharp-smile` — assets_vendor/game-icons/lorc/sharp-smile.svg · Lorc (game-icons.net)
- `icon_lorc__shield-echoes` — assets_vendor/game-icons/lorc/shield-echoes.svg · Lorc (game-icons.net)
- `icon_lorc__shining-claw` — assets_vendor/game-icons/lorc/shining-claw.svg · Lorc (game-icons.net)
- `icon_lorc__shouting` — assets_vendor/game-icons/lorc/shouting.svg · Lorc (game-icons.net)
- `icon_lorc__skull-crack` — assets_vendor/game-icons/lorc/skull-crack.svg · Lorc (game-icons.net)
- `icon_lorc__sliced-bread` — assets_vendor/game-icons/lorc/sliced-bread.svg · Lorc (game-icons.net)
- `icon_lorc__spear-hook` — assets_vendor/game-icons/lorc/spear-hook.svg · Lorc (game-icons.net)
- `icon_lorc__spiked-mace` — assets_vendor/game-icons/lorc/spiked-mace.svg · Lorc (game-icons.net)
- `icon_lorc__spiral-bottle` — assets_vendor/game-icons/lorc/spiral-bottle.svg · Lorc (game-icons.net)
- `icon_lorc__spiral-shell` — assets_vendor/game-icons/lorc/spiral-shell.svg · Lorc (game-icons.net)
- `icon_lorc__spotted-mushroom` — assets_vendor/game-icons/lorc/spotted-mushroom.svg · Lorc (game-icons.net)
- `icon_lorc__standing-potion` — assets_vendor/game-icons/lorc/standing-potion.svg · Lorc (game-icons.net)
- `icon_lorc__star-prominences` — assets_vendor/game-icons/lorc/star-prominences.svg · Lorc (game-icons.net)
- `icon_lorc__star-swirl` — assets_vendor/game-icons/lorc/star-swirl.svg · Lorc (game-icons.net)
- `icon_lorc__steeltoe-boots` — assets_vendor/game-icons/lorc/steeltoe-boots.svg · Lorc (game-icons.net)
- `icon_lorc__stone-axe` — assets_vendor/game-icons/lorc/stone-axe.svg · Lorc (game-icons.net)
- `icon_lorc__stone-block` — assets_vendor/game-icons/lorc/stone-block.svg · Lorc (game-icons.net)
- `icon_lorc__stone-sphere` — assets_vendor/game-icons/lorc/stone-sphere.svg · Lorc (game-icons.net)
- `icon_lorc__stone-tablet` — assets_vendor/game-icons/lorc/stone-tablet.svg · Lorc (game-icons.net)
- `icon_lorc__sun` — assets_vendor/game-icons/lorc/sun.svg · Lorc (game-icons.net)
- `icon_lorc__sun-radiations` — assets_vendor/game-icons/lorc/sun-radiations.svg · Lorc (game-icons.net)
- `icon_lorc__sunbeams` — assets_vendor/game-icons/lorc/sunbeams.svg · Lorc (game-icons.net)
- `icon_lorc__surrounded-shield` — assets_vendor/game-icons/lorc/surrounded-shield.svg · Lorc (game-icons.net)
- `icon_lorc__sword-hilt` — assets_vendor/game-icons/lorc/sword-hilt.svg · Lorc (game-icons.net)
- `icon_lorc__targeting` — assets_vendor/game-icons/lorc/targeting.svg · Lorc (game-icons.net)
- `icon_lorc__teleport` — assets_vendor/game-icons/lorc/teleport.svg · Lorc (game-icons.net)
- `icon_lorc__tentacle-strike` — assets_vendor/game-icons/lorc/tentacle-strike.svg · Lorc (game-icons.net)
- `icon_lorc__thorny-vine` — assets_vendor/game-icons/lorc/thorny-vine.svg · Lorc (game-icons.net)
- `icon_lorc__thrown-daggers` — assets_vendor/game-icons/lorc/thrown-daggers.svg · Lorc (game-icons.net)
- `icon_lorc__tied-scroll` — assets_vendor/game-icons/lorc/tied-scroll.svg · Lorc (game-icons.net)
- `icon_lorc__tornado` — assets_vendor/game-icons/lorc/tornado.svg · Lorc (game-icons.net)
- `icon_lorc__tree-branch` — assets_vendor/game-icons/lorc/tree-branch.svg · Lorc (game-icons.net)
- `icon_lorc__trident` — assets_vendor/game-icons/lorc/trident.svg · Lorc (game-icons.net)
- `icon_lorc__trousers` — assets_vendor/game-icons/lorc/trousers.svg · Lorc (game-icons.net)
- `icon_lorc__vine-whip` — assets_vendor/game-icons/lorc/vine-whip.svg · Lorc (game-icons.net)
- `icon_lorc__visored-helm` — assets_vendor/game-icons/lorc/visored-helm.svg · Lorc (game-icons.net)
- `icon_lorc__volcano` — assets_vendor/game-icons/lorc/volcano.svg · Lorc (game-icons.net)
- `icon_lorc__walking-boot` — assets_vendor/game-icons/lorc/walking-boot.svg · Lorc (game-icons.net)
- `icon_lorc__water-splash` — assets_vendor/game-icons/lorc/water-splash.svg · Lorc (game-icons.net)
- `icon_lorc__wave-strike` — assets_vendor/game-icons/lorc/wave-strike.svg · Lorc (game-icons.net)
- `icon_lorc__whirlwind` — assets_vendor/game-icons/lorc/whirlwind.svg · Lorc (game-icons.net)
- `icon_lorc__winged-leg` — assets_vendor/game-icons/lorc/winged-leg.svg · Lorc (game-icons.net)
- `icon_lorc__wizard-staff` — assets_vendor/game-icons/lorc/wizard-staff.svg · Lorc (game-icons.net)
- `icon_lorc__wolverine-claws` — assets_vendor/game-icons/lorc/wolverine-claws.svg · Lorc (game-icons.net)
- `icon_sbed__crush` — assets_vendor/game-icons/sbed/crush.svg · sbed (game-icons.net)
- `icon_sbed__vial` — assets_vendor/game-icons/sbed/vial.svg · sbed (game-icons.net)
- `icon_skoll__bracers` — assets_vendor/game-icons/skoll/bracers.svg · Skoll (game-icons.net)
- `icon_skoll__fangs` — assets_vendor/game-icons/skoll/fangs.svg · Skoll (game-icons.net)
- `icon_willdabeast__chain-mail` — assets_vendor/game-icons/willdabeast/chain-mail.svg · willdabeast (game-icons.net)
- `icon_willdabeast__orb-wand` — assets_vendor/game-icons/willdabeast/orb-wand.svg · willdabeast (game-icons.net)
- `icon_willdabeast__round-shield` — assets_vendor/game-icons/willdabeast/round-shield.svg · willdabeast (game-icons.net)

### KayKit Dungeon Asset Pack 1.1
Pack id `kaykit-dungeon` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `world_props_chest` — assets/world/KayKit Low Poly Dungeon Pack/Assets/gltf/chest.gltf
- `world_props_pillar_decorated` — assets/world/KayKit Low Poly Dungeon Pack/Assets/gltf/pillar_decorated.gltf

### KayKit Forest Nature Pack 1.0 FREE
Pack id `kaykit-forest` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `world_nature_bush_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Bush_1_A_Color1.gltf
- `world_nature_bush_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Bush_1_B_Color1.gltf
- `world_nature_bush_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Bush_1_C_Color1.gltf
- `world_nature_grass_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_A_Color1.gltf
- `world_nature_grass_1_a_singlesided_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_A_Singlesided_Color1.gltf
- `world_nature_grass_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_B_Color1.gltf
- `world_nature_grass_1_b_singlesided_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_B_Singlesided_Color1.gltf
- `world_nature_rock_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_1_A_Color1.gltf
- `world_nature_rock_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_1_B_Color1.gltf
- `world_nature_rock_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_1_C_Color1.gltf
- `world_nature_rock_2_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_2_A_Color1.gltf
- `world_nature_rock_2_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_2_C_Color1.gltf
- `world_nature_rock_2_e_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_2_E_Color1.gltf
- `world_nature_rock_3_d_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_3_D_Color1.gltf
- `world_nature_rock_3_h_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_3_H_Color1.gltf
- `world_nature_tree_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_1_A_Color1.gltf
- `world_nature_tree_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_1_B_Color1.gltf
- `world_nature_tree_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_1_C_Color1.gltf
- `world_nature_tree_2_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_2_A_Color1.gltf
- `world_nature_tree_bare_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_Bare_1_A_Color1.gltf
- `world_nature_tree_bare_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_Bare_1_B_Color1.gltf
- `world_nature_tree_bare_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_Bare_1_C_Color1.gltf

### KayKit Resource Bits 1.0 FREE
Pack id `kaykit-resourcebits` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `world_nature_wood_log_b` — assets/world/KayKit_ResourceBits_1.0_FREE/Assets/gltf/Wood_Log_B.gltf

### KayKit Skeletons 1.1 FREE
Pack id `kaykit-skeletons` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `enemies_skeleton_mage` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Mage.glb
- `enemies_skeleton_minion` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Minion.glb
- `enemies_skeleton_rogue` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Rogue.glb
- `enemies_skeleton_warrior` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Warrior.glb

### KayKit RPG Tools Bits 1.0 FREE
Pack id `kaykit-tools` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `items_tools_axe` — assets/items/KayKit_RPGToolsBits_1.0_FREE/Assets/gltf/axe.gltf
- `items_tools_pickaxe` — assets/items/KayKit_RPGToolsBits_1.0_FREE/Assets/gltf/pickaxe.gltf

### KayKit Fantasy Weapons Bits 1.0 FREE
Pack id `kaykit-weapons` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `items_weapons_axe_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/axe_A.gltf
- `items_weapons_axe_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/axe_B.gltf
- `items_weapons_axe_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/axe_C.gltf
- `items_weapons_dagger_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/dagger_A.gltf
- `items_weapons_dagger_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/dagger_B.gltf
- `items_weapons_fistweapon_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/fistweapon_A.gltf
- `items_weapons_fistweapon_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/fistweapon_B.gltf
- `items_weapons_halberd` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/halberd.gltf
- `items_weapons_hammer_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/hammer_A.gltf
- `items_weapons_hammer_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/hammer_B.gltf
- `items_weapons_hammer_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/hammer_C.gltf
- `items_weapons_shield_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/shield_A.gltf
- `items_weapons_shield_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/shield_B.gltf
- `items_weapons_shield_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/shield_C.gltf
- `items_weapons_spear_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/spear_A.gltf
- `items_weapons_staff_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/staff_A.gltf
- `items_weapons_staff_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/staff_B.gltf
- `items_weapons_sword_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_A.gltf
- `items_weapons_sword_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_B.gltf
- `items_weapons_sword_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_C.gltf
- `items_weapons_sword_d` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_D.gltf
- `items_weapons_sword_e` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_E.gltf
- `items_weapons_wand_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/wand_A.gltf

### Quaternius Universal Base Characters (Standard)
Pack id `quaternius-base-characters` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_hair_beard` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Beard.gltf
- `characters_hair_buns` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Buns.gltf
- `characters_hair_buzzed` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Buzzed.gltf
- `characters_hair_buzzedfemale` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_BuzzedFemale.gltf
- `characters_hair_long` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Long.gltf
- `characters_hair_simpleparted` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_SimpleParted.gltf
- `characters_superhero_female_fullbody` — assets/player_characters/Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Female_FullBody.gltf
- `characters_superhero_male_fullbody` — assets/player_characters/Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf

### Quaternius Ultimate Fantasy Buildings Kit (Standard)
Pack id `quaternius-buildings` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_buildings_barracks_firstage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Barracks_FirstAge_Level1.gltf
- `world_buildings_dock_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Dock_FirstAge.gltf
- `world_buildings_farm_firstage_level2_wheat` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Farm_FirstAge_Level2_Wheat.gltf
- `world_buildings_houses_firstage_1_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_FirstAge_1_Level2.gltf
- `world_buildings_houses_firstage_2_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_FirstAge_2_Level1.gltf
- `world_buildings_houses_firstage_3_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_FirstAge_3_Level1.gltf
- `world_buildings_houses_secondage_1_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_SecondAge_1_Level1.gltf
- `world_buildings_logs` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Logs.gltf
- `world_buildings_market_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Market_FirstAge_Level2.gltf
- `world_buildings_mine` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Mine.gltf
- `world_buildings_port_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Port_FirstAge_Level2.gltf
- `world_buildings_storage_firstage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Storage_FirstAge_Level1.gltf
- `world_buildings_storage_secondage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Storage_SecondAge_Level1.gltf
- `world_buildings_temple_firstage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Temple_FirstAge_Level1.gltf
- `world_buildings_towerhouse_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/TowerHouse_FirstAge.gltf
- `world_buildings_towncenter_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/TownCenter_FirstAge_Level2.gltf
- `world_buildings_wall_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Wall_FirstAge.gltf
- `world_buildings_wall_secondage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Wall_SecondAge.gltf
- `world_buildings_walltowers_door_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/WallTowers_Door_FirstAge.gltf
- `world_buildings_walltowers_secondage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/WallTowers_SecondAge.gltf
- `world_buildings_watchtower_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/WatchTower_FirstAge_Level2.gltf
- `world_buildings_windmill_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Windmill_FirstAge.gltf

### Quaternius Fantasy Props MegaKit (Standard)
Pack id `quaternius-fantasy-props` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_props_banner_2` — assets/world/Fantasy Props Mega Kit[Standard]/Exports/glTF/Banner_2.gltf
- `world_props_crate_wooden` — assets/world/Fantasy Props Mega Kit[Standard]/Exports/glTF/Crate_Wooden.gltf

### Quaternius Animated Fish Bundle
Pack id `quaternius-fish` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_nature_goldfish` — assets/world/Quaternius Animated Fish Bundle/Goldfish.glb
- `world_nature_koi` — assets/world/Quaternius Animated Fish Bundle/Koi.glb
- `world_nature_red_snapper` — assets/world/Quaternius Animated Fish Bundle/Red Snapper.glb
- `world_nature_swordfish` — assets/world/Quaternius Animated Fish Bundle/Swordfish.glb
- `world_nature_yellow_tang` — assets/world/Quaternius Animated Fish Bundle/Yellow Tang.glb

### Quaternius Monster Bundle
Pack id `quaternius-monsters` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `enemies_alpaking` — assets/enemy_models/Quaternius Monster Bundle/Alpaking.glb
- `enemies_alpaking_evolved` — assets/enemy_models/Quaternius Monster Bundle/Alpaking Evolved.glb
- `enemies_armabee` — assets/enemy_models/Quaternius Monster Bundle/Armabee.glb
- `enemies_armabee_evolved` — assets/enemy_models/Quaternius Monster Bundle/Armabee Evolved.glb
- `enemies_birb` — assets/enemy_models/Quaternius Monster Bundle/Birb.glb
- `enemies_blue_demon` — assets/enemy_models/Quaternius Monster Bundle/Blue Demon.glb
- `enemies_bunny` — assets/enemy_models/Quaternius Monster Bundle/Bunny.glb
- `enemies_cactoro` — assets/enemy_models/Quaternius Monster Bundle/Cactoro.glb
- `enemies_cat` — assets/enemy_models/Quaternius Monster Bundle/Cat.glb
- `enemies_chicken` — assets/enemy_models/Quaternius Monster Bundle/Chicken.glb
- `enemies_demon` — assets/enemy_models/Quaternius Monster Bundle/Demon.glb
- `enemies_dino` — assets/enemy_models/Quaternius Monster Bundle/Dino.glb
- `enemies_dragon` — assets/enemy_models/Quaternius Monster Bundle/Dragon.glb
- `enemies_dragon_evolved` — assets/enemy_models/Quaternius Monster Bundle/Dragon Evolved.glb
- `enemies_frog` — assets/enemy_models/Quaternius Monster Bundle/Frog.glb
- `enemies_ghost` — assets/enemy_models/Quaternius Monster Bundle/Ghost.glb
- `enemies_ghost_skull` — assets/enemy_models/Quaternius Monster Bundle/Ghost Skull.glb
- `enemies_glub` — assets/enemy_models/Quaternius Monster Bundle/Glub.glb
- `enemies_glub_evolved` — assets/enemy_models/Quaternius Monster Bundle/Glub Evolved.glb
- `enemies_goleling` — assets/enemy_models/Quaternius Monster Bundle/Goleling.glb
- `enemies_goleling_evolved` — assets/enemy_models/Quaternius Monster Bundle/Goleling Evolved.glb
- `enemies_green_blob` — assets/enemy_models/Quaternius Monster Bundle/Green Blob.glb
- `enemies_hywirl` — assets/enemy_models/Quaternius Monster Bundle/Hywirl.glb
- `enemies_monkroose` — assets/enemy_models/Quaternius Monster Bundle/Monkroose.glb
- `enemies_mushnub` — assets/enemy_models/Quaternius Monster Bundle/Mushnub.glb
- `enemies_mushnub_evolved` — assets/enemy_models/Quaternius Monster Bundle/Mushnub Evolved.glb
- `enemies_mushroom_king` — assets/enemy_models/Quaternius Monster Bundle/Mushroom King.glb
- `enemies_ninja` — assets/enemy_models/Quaternius Monster Bundle/Ninja.glb
- `enemies_orc` — assets/enemy_models/Quaternius Monster Bundle/Orc.glb
- `enemies_orc_enemy` — assets/enemy_models/Quaternius Monster Bundle/Orc Enemy.glb
- `enemies_pigeon` — assets/enemy_models/Quaternius Monster Bundle/Pigeon.glb
- `enemies_pink_blob` — assets/enemy_models/Quaternius Monster Bundle/Pink Blob.glb
- `enemies_squidle` — assets/enemy_models/Quaternius Monster Bundle/Squidle.glb
- `enemies_tribal` — assets/enemy_models/Quaternius Monster Bundle/Tribal.glb
- `enemies_wizard` — assets/enemy_models/Quaternius Monster Bundle/Wizard.glb
- `enemies_yeti` — assets/enemy_models/Quaternius Monster Bundle/Yeti.glb

### Quaternius Ultimate Nature Kit 2 (Standard)
Pack id `quaternius-nature-kit2` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_nature_birchtree_2` — assets/world/Ultimate Nature Kit2[Standard]/glTF/BirchTree_2.gltf
- `world_nature_bush_small_flowers` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Bush_Small_Flowers.gltf
- `world_nature_deadtree_4` — assets/world/Ultimate Nature Kit2[Standard]/glTF/DeadTree_4.gltf
- `world_nature_flower_1_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_1_Clump.gltf
- `world_nature_flower_2_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_2_Clump.gltf
- `world_nature_flower_4_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_4_Clump.gltf
- `world_nature_flower_5_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_5_Clump.gltf
- `world_nature_mapletree_2` — assets/world/Ultimate Nature Kit2[Standard]/glTF/MapleTree_2.gltf

### Quaternius Modular Character Outfits — Fantasy (Standard)
Pack id `quaternius-outfits-fantasy` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_female_peasant` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Female_Peasant.gltf
- `characters_female_ranger` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Female_Ranger.gltf
- `characters_male_peasant` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Peasant.gltf
- `characters_male_ranger` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf

### Quaternius Stylized Nature MegaKit (Standard)
Pack id `quaternius-stylized-nature` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_nature_commontree_3` — assets/world/Stylizied Mega Nature Kit[Standard]/glTF/CommonTree_3.gltf
- `world_nature_fern_1` — assets/world/Stylizied Mega Nature Kit[Standard]/glTF/Fern_1.gltf
- `world_nature_twistedtree_2` — assets/world/Stylizied Mega Nature Kit[Standard]/glTF/TwistedTree_2.gltf

### Quaternius Universal Animation Library 1 (PRO)
Pack id `quaternius-ual1` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_ual1` — assets/player_characters/Universal Animation Library 1[PRO]/Unreal-Godot/UAL1.glb

### Quaternius Universal Animation Library 2 (Standard)
Pack id `quaternius-ual2` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_ual2_standard` — assets/player_characters/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb

