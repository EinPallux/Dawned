-- P10 gathering professions (docs/design/PROFESSIONS.md).
--
-- Two tables:
--
--   content_resource_nodes  — what a birch IS: profession, tier, yields, procs,
--                             channel and respawn times, models. Draft/published
--                             like every other content table, authored in the
--                             panel's Professions page. The map editor's `node`
--                             layer places them; a placement is just an id and a
--                             position, so retuning birchwood is ONE row rather
--                             than the two hundred trees that share it.
--
--   character_professions   — one row per (character, profession). The four
--                             level independently (§1.3), so this is rows rather
--                             than four more columns on `characters`: a fifth
--                             profession after 0.1.0 becomes content, not a
--                             migration of the hottest table in the schema.
--
-- The discovered-material CODEX deliberately gets no table of its own — it is
-- `character_discoveries` with kind='codex', which already exists and whose
-- primary key is the dedupe. The server groups those entries by profession from
-- the published node defs when it builds ProfessionSync; storing the grouping
-- would be storing something derivable.

CREATE TABLE IF NOT EXISTS "content_resource_nodes" (
  "id" text NOT NULL,
  "status" text NOT NULL,
  "def" jsonb NOT NULL,
  "updated_by" bigint,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "content_resource_nodes_id_status_pk" PRIMARY KEY ("id", "status")
);
--> statement-breakpoint
ALTER TABLE "content_resource_nodes"
  ADD CONSTRAINT "content_resource_nodes_updated_by_accounts_id_fk"
  FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "character_professions" (
  "character_id" bigint NOT NULL,
  "profession" text NOT NULL,
  "level" smallint DEFAULT 1 NOT NULL,
  "xp" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "character_professions_character_id_profession_pk"
    PRIMARY KEY ("character_id", "profession")
);
--> statement-breakpoint
ALTER TABLE "character_professions"
  ADD CONSTRAINT "character_professions_character_id_characters_id_fk"
  FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id")
  ON DELETE cascade ON UPDATE no action;
