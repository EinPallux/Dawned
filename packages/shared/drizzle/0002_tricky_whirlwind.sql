CREATE TABLE "content_enemies" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_enemies_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
CREATE TABLE "content_spawners" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_spawners_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
ALTER TABLE "content_enemies" ADD CONSTRAINT "content_enemies_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_spawners" ADD CONSTRAINT "content_spawners_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;