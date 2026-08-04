CREATE TABLE "character_discoveries" (
	"character_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_discoveries_character_id_kind_ref_id_pk" PRIMARY KEY("character_id","kind","ref_id")
);
--> statement-breakpoint
ALTER TABLE "character_discoveries" ADD CONSTRAINT "character_discoveries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;