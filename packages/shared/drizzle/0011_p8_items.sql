CREATE TABLE "character_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"character_id" bigint NOT NULL,
	"item_id" text NOT NULL,
	"container" text NOT NULL,
	"slot" smallint NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"rolled_stats" jsonb,
	"granted_by" text,
	CONSTRAINT "character_items_cell_uq" UNIQUE("character_id","container","slot")
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_items_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
CREATE TABLE "content_loot_tables" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_loot_tables_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
CREATE TABLE "content_vendors" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_vendors_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
ALTER TABLE "character_items" ADD CONSTRAINT "character_items_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_loot_tables" ADD CONSTRAINT "content_loot_tables_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_vendors" ADD CONSTRAINT "content_vendors_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_items_character_idx" ON "character_items" USING btree ("character_id");