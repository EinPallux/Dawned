-- A3-d map editor collections (Dawned-Admin docs/MAP_EDITOR.md §2.2, §3).
--
-- Two editor-side things the owner builds up over months and would be furious
-- to lose to a cleared browser cache:
--
--   selection  — a named set of object ids ("Dawnhaven harbour props")
--   prefab     — a named group of rows with RELATIVE offsets, stampable
--                anywhere ("market stall set")
--
-- Neither reaches the game. Prefabs flatten to plain placements the moment they
-- are stamped, so the bake never learns they exist; selections are pure UI.
-- They live in Postgres rather than localStorage because they are shared
-- between the owner and any GM, and because "my prefabs are gone" is not a
-- sentence a tool should ever produce.

CREATE TABLE IF NOT EXISTS "map_editor_collections" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_by" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_editor_collections"
  ADD CONSTRAINT "map_editor_collections_created_by_accounts_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_editor_collections_kind_idx"
  ON "map_editor_collections" ("kind");
