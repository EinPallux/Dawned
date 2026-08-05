-- A2/A3 map editor draft store (docs/MAP_EDITOR.md).
--
-- Drafts only: the live game still reads baked artifacts under
-- map/<version>/, and nothing here is served to players. Publishing copies a
-- draft into those files and records the version in map_versions.

CREATE TABLE IF NOT EXISTS "map_draft_chunks" (
  "cx" smallint NOT NULL,
  "cy" smallint NOT NULL,
  "heights" bytea NOT NULL,
  "splat" bytea NOT NULL,
  "water_level" real,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_by" bigint,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "map_draft_chunks_cx_cy_pk" PRIMARY KEY("cx","cy")
);
--> statement-breakpoint
ALTER TABLE "map_draft_chunks"
  ADD CONSTRAINT "map_draft_chunks_updated_by_accounts_id_fk"
  FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "map_draft_objects" (
  "id" text PRIMARY KEY NOT NULL,
  "layer" text NOT NULL,
  "def" jsonb NOT NULL,
  "x" real,
  "z" real,
  "cx" smallint,
  "cy" smallint,
  "updated_by" bigint,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_draft_objects"
  ADD CONSTRAINT "map_draft_objects_updated_by_accounts_id_fk"
  FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_draft_objects_layer_idx" ON "map_draft_objects" ("layer");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_draft_objects_chunk_idx" ON "map_draft_objects" ("cx","cy");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "map_checkpoints" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "payload" bytea NOT NULL,
  "chunk_count" integer NOT NULL,
  "object_count" integer NOT NULL,
  "created_by" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_checkpoints"
  ADD CONSTRAINT "map_checkpoints_created_by_accounts_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "map_lock" (
  "id" smallint PRIMARY KEY NOT NULL,
  "holder_account_id" bigint NOT NULL,
  "holder_name" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "takeover_requested_by" text
);
--> statement-breakpoint
ALTER TABLE "map_lock"
  ADD CONSTRAINT "map_lock_holder_account_id_accounts_id_fk"
  FOREIGN KEY ("holder_account_id") REFERENCES "public"."accounts"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "map_versions" (
  "version" text PRIMARY KEY NOT NULL,
  "summary" jsonb NOT NULL,
  "published_by" bigint,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_versions"
  ADD CONSTRAINT "map_versions_published_by_accounts_id_fk"
  FOREIGN KEY ("published_by") REFERENCES "public"."accounts"("id")
  ON DELETE no action ON UPDATE no action;
