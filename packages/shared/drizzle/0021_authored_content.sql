-- Who last wrote each published content row: an authoring script, or a person?
--
-- The content scripts (Dawned-Admin `tools/content/author-*.mjs`) rewrite every
-- row they own on every run. That was harmless while they only ever ran on a
-- throwaway dev box. `deploy/WORLD.sh` runs them on the LIVE server, and
-- UPDATE.sh will run them whenever authored content changes — at which point a
-- number the owner retuned in the panel would be silently reverted to whatever
-- the script's data file says, every deploy, forever.
--
-- This table is the evidence needed to tell the two apart. After a script
-- publishes a row it records the hash of exactly what it wrote. On the next run:
--
--   live hash == recorded hash  →  nobody has touched it since; safe to rewrite
--   live hash != recorded hash  →  a person edited it in the panel; keep theirs
--   no recorded hash            →  never been under a script's management;
--                                   adopt it once and record, so the NEXT run
--                                   can tell (see WORLD.sh's report — the first
--                                   run after this ships is the one adoption
--                                   window, and it is called out on screen)
--
-- `kind` is the content family ('items', 'enemies', 'quests', …) rather than a
-- table name, because one publish rail can span several tables and the scripts
-- think in rails.
CREATE TABLE IF NOT EXISTS "content_authored" (
	"kind" text NOT NULL,
	"row_id" text NOT NULL,
	"hash" text NOT NULL,
	"authored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_authored_pk" PRIMARY KEY("kind","row_id")
);
