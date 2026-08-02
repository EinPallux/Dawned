# USER_QUESTIONS — decisions I need from you

> Each question has a **recommended default** — the plan currently assumes it. Answer inline under
> each question (edit this file, or just tell me "defaults are fine except #3, #7…"). Once answered,
> I fold the decisions into the docs and delete resolved entries. Nothing in P0–P2 is blocked by
> these; combat-relevant ones (Q1–Q3) should be settled before P3/P4.

## Controls & Combat

**Q1. Camera/control scheme — is mouselook right?**
Planned: BDO/Farever-style pointer-lock mouselook (character turns with camera, LMB/RMB are combat
buttons, `Alt` frees the cursor). Alternative: GW2-style hybrid (free cursor always, hold-RMB to
turn camera, click-to-aim). Mouselook is more "action", hybrid is friendlier for UI-heavy play.
**Recommended: mouselook (as planned).** How did Farever control, if you remember — and which do
you want?
> Answer:

**Q2. Jumping — confirmed yes?** Planned: yes (free jump, no fall damage below ~12 m, fall damage
beyond). Some browser MMOs skip jumping entirely.
**Recommended: yes, with light fall damage.**
> Answer:

**Q3. Dodge input** — planned `V` (also Mouse4) as dedicated dodge key. Alternative: double-tap
direction (feels great but eats WASD responsiveness). **Recommended: dedicated key.**
> Answer:

## World & Content

**Q4. World language — English only?** All content text is planned English-only (code and content
are i18n-ready string keys regardless, so a German pass later is data work, not code work).
**Recommended: English for 0.1.0.**
> Answer:

**Q5. Death penalty** — planned: respawn at attuned shrine + 30 s −15% damage debuff, no XP/item
loss. Harsher options (gold cost, XP debt) exist but fight the casual-friends profile.
**Recommended: as planned (light).**
> Answer:

**Q6. Fast travel** — planned: shrine-to-shrine teleport for scaling gold cost after attunement
(no mounts per spec). Purists might want none at all. **Recommended: as planned — the archipelago
is big enough that zero fast travel will hurt evenings.**
> Answer:

**Q7. Day/night cycle** — planned as **visual-only** in P14 (light/fog tint, ~40 min cycle), with
a `night-only spawns` flag shipped inert (gameplay hooks in 0.2). OK, or skip entirely for 0.1.0?
**Recommended: visual-only in 0.1.0.**
> Answer:

## Accounts & Operations

**Q8. Registration: open or invite code?** The server is for friends. Planned: open registration
with an **optional invite-code toggle** (world setting, default ON with a code you set).
**Recommended: invite code ON.**
> Answer:

**Q9. Password resets without email** — spec says accountname+password only, so recovery = an admin
resets the password from Dawned-Admin (audited). Acceptable? (Alternative: optional recovery email
field — adds scope + privacy surface.) **Recommended: admin-reset only.**
> Answer:

**Q10. Admin panel URL** — planned default `play.pathlands.cc/admin` (zero DNS work). Alternative:
`admin.play.pathlands.cc` subdomain (needs one DNS A-record; slightly cleaner cookie isolation —
Caddyfile includes the variant either way). Also: do you want the optional IP allowlist for the
admin panel? **Recommended: `/admin` path, allowlist off until you ask.**
> Answer:

**Q11. Off-box backups** — nightly backups land on the VPS disk with rotation; a hook exists for
copying them off-box (rclone to a cloud drive, or scp to your PC). Where should they go, if
anywhere? **Recommended: set up rclone to any free cloud storage you have — a VPS-dies scenario
otherwise loses everything.**
> Answer:

## Art & Audio

**Q12. Audio sourcing** — repo has zero audio. Planned: CC0-first curation (Kenney + curated
freesound/GDC packs) processed through our pipeline, full attribution ledger; music = CC0/CC-BY
folk-orchestral loops. Alternatives: you commission/provide tracks, or 0.1.0 ships SFX-only with
minimal music. **Recommended: CC0 curation as planned.** Any taste direction for music beyond
"warm folk adventure"?
> Answer:

**Q13. Character creation scope** — planned options: body (M/F), outfit family (Ranger/Peasant,
recolorable), 7 hairstyles + 8 colors, eyebrows, beard toggle — all from the Quaternius packs.
Skin-tone variants are texture-feasible; include (~+1 asset-pipeline day)? **Recommended: yes,
4–6 skin tones.**
> Answer:

**Q14. Farever reference** — the world layout leans on its map composition (archipelago, biome
color-blocking, bridges). Is there anything *specific* from Farever you want copied closer
(camera distance? UI vibe? specific zone feel?) or deliberately avoided?
> Answer:

## Scope Confirmations (one-word answers fine)

**Q15. Cleric solo-damage identity** — planned as a real battle-priest (smite/hammer kit ~72% of
Rogue DPS, plus self-healing) so healing-mains can solo the whole map. Confirm?
> Answer:

**Q16. 28 side quests + 6 zones + ~210 items + 36 enemy types + 6 bosses** (CONTENT_0.1.md) — does
this match your picture of "full 0.1.0", or do you want any category bigger/smaller before we
lock the world-building phase?
> Answer:
