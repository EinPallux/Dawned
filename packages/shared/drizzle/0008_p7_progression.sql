CREATE TABLE "character_skills" (
	"character_id" bigint NOT NULL,
	"node_id" text NOT NULL,
	"ranks" smallint DEFAULT 1 NOT NULL,
	CONSTRAINT "character_skills_character_id_node_id_pk" PRIMARY KEY("character_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "content_skill_nodes" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_skill_nodes_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
CREATE TABLE "content_xp_curve" (
	"id" text NOT NULL,
	"status" text NOT NULL,
	"def" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_xp_curve_id_status_pk" PRIMARY KEY("id","status")
);
--> statement-breakpoint
ALTER TABLE "character_skills" ADD CONSTRAINT "character_skills_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_skill_nodes" ADD CONSTRAINT "content_skill_nodes_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_xp_curve" ADD CONSTRAINT "content_xp_curve_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;