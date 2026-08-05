-- Repair: the four pilot NPCs were authored with `idleClip = 'Idle'`, and the
-- UAL library's standing-still clip is `Idle_Loop`. A composed rig plays nothing
-- at all for a clip it does not have, so all four villagers stood in Dawnhaven
-- in a bind-pose T — silent everywhere except on screen, which is why it took a
-- screenshot rather than a test to find.
--
-- Ships as a NEW migration rather than an edit to 0019: seed files are
-- append-only history (DATABASE.md §5). UPDATE rather than INSERT ... ON
-- CONFLICT DO NOTHING, because the wrong value is already in the row — this is
-- a repair, and it deliberately only touches rows still holding the bad clip so
-- a later panel retune is never undone by a redeploy.
--
-- The schema default moved to 'Idle_Loop' in the same change, so a fresh NPC
-- authored after this cannot reintroduce it.
UPDATE "content_npcs"
SET "def" = jsonb_set("def", '{idleClip}', '"Idle_Loop"')
WHERE "def"->>'idleClip' = 'Idle';
