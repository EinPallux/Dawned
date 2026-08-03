-- P5 display repair: push the round-7 ability presentation (game-icons.net
-- icon slugs + the retimed animation blocks) into databases that seeded their
-- kit rows BEFORE round 7. 0005 was edited in place after it had shipped, and
-- drizzle-orm's migrator skips already-applied migrations without comparing
-- content — so any database migrated between P5-E and round 7 kept pre-icon,
-- pre-retime rows forever (owner report: "still all the letters").
-- LESSON, now doctrine (docs/tech/DATABASE.md §5): never edit an applied
-- migration; ship a follow-up one.
--
-- Surgical on purpose: `def || '{"icon":…,"anim":…}'` replaces exactly those
-- two top-level keys and leaves every balance field (costs, coefs, cooldowns,
-- effects) untouched, so panel-tuned rows survive. No status filter: stale
-- DRAFT copies would re-revert the presentation on their next publish.
-- Idempotent — re-setting identical values is a no-op.
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/holy-symbol","anim":{"clip":"Spell_Simple_Shoot","durationMs":500,"moveLockMs":0,"clipSeconds":0.5,"moveSpeedMult":1,"contactFraction":0.6}}'::jsonb WHERE "id" = 'ability_cleric_basic_1';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/holy-symbol","anim":{"clip":"Spell_Simple_Shoot","durationMs":500,"moveLockMs":0,"clipSeconds":0.5,"moveSpeedMult":1,"contactFraction":0.6}}'::jsonb WHERE "id" = 'ability_cleric_basic_2';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/holy-symbol","anim":{"clip":"Spell_Simple_Shoot","durationMs":650,"moveLockMs":0,"clipSeconds":0.5,"moveSpeedMult":1,"contactFraction":0.6}}'::jsonb WHERE "id" = 'ability_cleric_basic_3';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/energy-arrow","anim":{"clip":"Spell_Simple_Shoot","durationMs":500,"moveLockMs":0,"clipSeconds":0.5,"moveSpeedMult":1,"contactFraction":0.6}}'::jsonb WHERE "id" = 'ability_mage_basic_1';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/energy-arrow","anim":{"clip":"Spell_Simple_Shoot","durationMs":500,"moveLockMs":0,"clipSeconds":0.5,"moveSpeedMult":1,"contactFraction":0.6}}'::jsonb WHERE "id" = 'ability_mage_basic_2';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/energy-arrow","anim":{"clip":"Spell_Simple_Shoot","durationMs":650,"moveLockMs":0,"clipSeconds":0.5,"moveSpeedMult":1,"contactFraction":0.6}}'::jsonb WHERE "id" = 'ability_mage_basic_3';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/plain-dagger","anim":{"clip":"Sword_Regular_A","durationMs":400,"moveLockMs":0,"clipSeconds":0.433,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_rogue_basic_1';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/plain-dagger","anim":{"clip":"Sword_Regular_B","durationMs":450,"moveLockMs":0,"clipSeconds":0.533,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_rogue_basic_2';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/plain-dagger","anim":{"clip":"Sword_Regular_C","durationMs":650,"moveLockMs":0,"clipSeconds":2,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_rogue_basic_3';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/broken-bone","anim":{"clip":"Sword_Regular_C","durationMs":850,"moveLockMs":0,"clipSeconds":2,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_rogue_crippling_strike';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/targeting","anim":{"clip":"OverhandThrow","durationMs":700,"moveLockMs":0,"clipSeconds":1.333,"moveSpeedMult":1,"contactFraction":0.5}}'::jsonb WHERE "id" = 'ability_rogue_death_mark';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/bloody-sword","anim":{"clip":"Sword_Attack_Standing","durationMs":850,"moveLockMs":0,"clipSeconds":1.533,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_rogue_eviscerate';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/thrown-daggers","anim":{"clip":"OverhandThrow","durationMs":800,"moveLockMs":0,"clipSeconds":1.333,"moveSpeedMult":1,"contactFraction":0.5}}'::jsonb WHERE "id" = 'ability_rogue_fan_of_knives';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/dripping-knife","anim":{"clip":"Sword_Enter","durationMs":800,"moveLockMs":0,"clipSeconds":1.3,"moveSpeedMult":1,"contactFraction":0.5}}'::jsonb WHERE "id" = 'ability_rogue_poisoned_blades';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/shadow-follower","anim":{"clip":"Sword_Enter","durationMs":700,"moveLockMs":0,"clipSeconds":1.3,"moveSpeedMult":1,"contactFraction":0.5}}'::jsonb WHERE "id" = 'ability_rogue_shadowstep';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"darkzaitzev/smoke-bomb","anim":{"clip":"OverhandThrow","durationMs":700,"moveLockMs":0,"clipSeconds":1.333,"moveSpeedMult":1,"contactFraction":0.4}}'::jsonb WHERE "id" = 'ability_rogue_smoke_veil';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/crossed-swords","anim":{"clip":"Sword_Regular_A","durationMs":450,"moveLockMs":0,"clipSeconds":0.433,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_rogue_twin_strike';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/broadsword","anim":{"clip":"Sword_Regular_A","durationMs":450,"moveLockMs":0,"clipSeconds":0.433,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_warrior_basic_1';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/broadsword","anim":{"clip":"Sword_Regular_B","durationMs":500,"moveLockMs":0,"clipSeconds":0.533,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_warrior_basic_2';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/broadsword","anim":{"clip":"Sword_Regular_C","durationMs":750,"moveLockMs":0,"clipSeconds":2,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_warrior_basic_3';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"delapouite/charging-bull","anim":{"clip":"Shield_Dash","durationMs":700,"moveLockMs":0,"clipSeconds":1.1,"moveSpeedMult":1,"contactFraction":0.9}}'::jsonb WHERE "id" = 'ability_warrior_charge';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/hammer-drop","anim":{"clip":"Sword_Attack","durationMs":900,"moveLockMs":0,"clipSeconds":1.533,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_warrior_crushing_blow';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/quake-stomp","anim":{"clip":"Sword_Attack","durationMs":1000,"moveLockMs":0,"clipSeconds":1.533,"moveSpeedMult":1,"contactFraction":0.6}}'::jsonb WHERE "id" = 'ability_warrior_earthshatter';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/bleeding-wound","anim":{"clip":"Sword_Attack_Standing","durationMs":800,"moveLockMs":0,"clipSeconds":1.533,"moveSpeedMult":1,"contactFraction":0.55}}'::jsonb WHERE "id" = 'ability_warrior_rending_slash';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"delapouite/shield-bash","anim":{"clip":"Shield_OneShot","durationMs":550,"moveLockMs":0,"clipSeconds":0.833,"moveSpeedMult":1,"contactFraction":0.5}}'::jsonb WHERE "id" = 'ability_warrior_shield_bash';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/edged-shield","anim":{"clip":"Shield_OneShot","durationMs":700,"moveLockMs":0,"clipSeconds":0.833,"moveSpeedMult":1,"contactFraction":0.3}}'::jsonb WHERE "id" = 'ability_warrior_shield_wall';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/shouting","anim":{"clip":"Counter_Angry","durationMs":1100,"moveLockMs":0,"clipSeconds":2,"moveSpeedMult":1,"contactFraction":0.4}}'::jsonb WHERE "id" = 'ability_warrior_taunting_shout';
UPDATE "content_abilities" SET "def" = "def" || '{"icon":"lorc/whirlwind","anim":{"clip":"Sword_Heavy_Combo","durationMs":1800,"moveLockMs":0,"clipSeconds":4.333,"moveSpeedMult":0.7,"contactFraction":0.4}}'::jsonb WHERE "id" = 'ability_warrior_whirlwind';
