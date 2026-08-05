-- P11 — Quests, POIs & Interactables (QUESTS_POI.md, DATABASE.md §3).
--
-- Two content tables on the draft/published pattern every other content type
-- uses, and two per-character tables. Nothing here is destructive: a world that
-- has never had a quest simply has empty tables.

CREATE TABLE IF NOT EXISTS "content_quests" (
  "id" text NOT NULL,
  "status" text NOT NULL,
  "def" jsonb NOT NULL,
  "updated_by" bigint REFERENCES "accounts"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "content_quests_pk" PRIMARY KEY ("id", "status")
);

CREATE TABLE IF NOT EXISTS "content_npcs" (
  "id" text NOT NULL,
  "status" text NOT NULL,
  "def" jsonb NOT NULL,
  "updated_by" bigint REFERENCES "accounts"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "content_npcs_pk" PRIMARY KEY ("id", "status")
);

-- One row per (character, quest). `step` + `counter` is the whole state:
-- steps are ordered and worked one at a time, so a per-step counter array
-- would be a second source of truth for what the index already says.
CREATE TABLE IF NOT EXISTS "character_quests" (
  "character_id" bigint NOT NULL REFERENCES "characters"("id") ON DELETE CASCADE,
  "quest_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "step" smallint NOT NULL DEFAULT 0,
  "counter" integer NOT NULL DEFAULT 0,
  "pinned" boolean NOT NULL DEFAULT false,
  "reward_choice" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "character_quests_pk" PRIMARY KEY ("character_id", "quest_id")
);

-- The journal lists by zone and the tracker reads the pinned few; both start
-- from "this character's quests", so that is the index.
CREATE INDEX IF NOT EXISTS "character_quests_by_character"
  ON "character_quests" ("character_id", "status");

-- Per-character interactable state: a one-shot chest is opened by everyone
-- exactly once rather than raced for (the P8 loot-bag lesson applied to
-- furniture), and shrine attunement is something you did, not something the
-- world is.
CREATE TABLE IF NOT EXISTS "character_interactions" (
  "character_id" bigint NOT NULL REFERENCES "characters"("id") ON DELETE CASCADE,
  "object_id" text NOT NULL,
  "kind" text NOT NULL,
  "count" integer NOT NULL DEFAULT 1,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "character_interactions_pk" PRIMARY KEY ("character_id", "object_id", "kind")
);
