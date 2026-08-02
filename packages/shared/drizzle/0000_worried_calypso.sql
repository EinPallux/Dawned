CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" "citext" NOT NULL,
	"pass_hash" text NOT NULL,
	"role" text DEFAULT 'player' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_ip" text,
	"last_login_at" timestamp with time zone,
	"last_login_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"by_account_id" bigint,
	"reason" text DEFAULT '' NOT NULL,
	"until" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"name" "citext" NOT NULL,
	"class_id" text NOT NULL,
	"body" text NOT NULL,
	"skin" smallint DEFAULT 0 NOT NULL,
	"outfit" text NOT NULL,
	"outfit_tint" smallint DEFAULT 0 NOT NULL,
	"hair" text DEFAULT 'none' NOT NULL,
	"hair_color" smallint DEFAULT 0 NOT NULL,
	"beard" boolean DEFAULT false NOT NULL,
	"level" smallint DEFAULT 1 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"gold" integer DEFAULT 25 NOT NULL,
	"stat_str" smallint DEFAULT 0 NOT NULL,
	"stat_agi" smallint DEFAULT 0 NOT NULL,
	"stat_int" smallint DEFAULT 0 NOT NULL,
	"stat_vit" smallint DEFAULT 0 NOT NULL,
	"stat_end" smallint DEFAULT 0 NOT NULL,
	"unspent_stat_points" smallint DEFAULT 0 NOT NULL,
	"unspent_skill_points" smallint DEFAULT 0 NOT NULL,
	"pos_x" real,
	"pos_y" real,
	"pos_z" real,
	"yaw" real DEFAULT 0 NOT NULL,
	"zone_id" text,
	"bound_shrine" text,
	"hp" integer,
	"resource" integer,
	"playtime_seconds" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text DEFAULT 'game' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_ip" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_by_account_id_accounts_id_fk" FOREIGN KEY ("by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_name_unique" ON "accounts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "bans_account_idx" ON "bans" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "characters_name_unique" ON "characters" USING btree ("name");--> statement-breakpoint
CREATE INDEX "characters_account_idx" ON "characters" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");