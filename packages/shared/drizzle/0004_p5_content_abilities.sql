CREATE TABLE "content_abilities" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_abilities_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
ALTER TABLE "content_abilities" ADD CONSTRAINT "content_abilities_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;