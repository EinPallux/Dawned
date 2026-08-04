# AGENTS.md — Dawned (game repo)

Instructions for AI coding agents working in this repository. **CLAUDE.md is the canonical,
complete version of these rules — read it first.** This file is the tool-agnostic mirror and adds
nothing beyond it.

## TL;DR for any agent

- **Project:** Dawned — low-poly browser 3D action-combat sandbox MMORPG (5–20 players), VPS-hosted
  (4 GB/1 core, Ubuntu 24.04, play.pathlands.cc). 0.1.0 must be a complete Early Access game, not
  an MVP. Companion repo: **Dawned-Admin** (editor/ops panel).
- **Truth lives in `docs/`:** ROADMAP.md = what to build now (phase gates with DoD);
  docs/design/_ = game design; docs/tech/_ = architecture/stack/security/deployment;
  docs/CONTENT_0.1.md = content contract; USER_QUESTIONS.md = pending owner decisions.
- **Hard rules:** no shortcut/skeleton implementations · server-authoritative everything ·
  content-as-data (edited via Dawned-Admin, never hardcoded) · TS strict, no `any`, zod at
  boundaries · client↔server share code only via `@dawned/shared` · combat/UI feel specs are
  acceptance criteria · no serif fonts, no generic rounded UI (follow docs/design/UI_UX.md) ·
  desktop-first 1080p/1440p, budgets in docs/tech/TECH_STACK.md · raw `assets/` never served —
  pipeline only (docs/tech/ASSET_PIPELINE.md) with license ledger.
- **Process:** work inside the current ROADMAP phase; run `pnpm check` before claiming done;
  update CHANGELOG.md `[Unreleased]`; update affected docs in the same change; put new design
  questions in USER_QUESTIONS.md with a recommended default.
- **State:** P0–P6 complete (owner-verified; P6 closed 2026-08-04 — "classes are fine";
  A0 /admin login confirmed). **P7 — Progression is built end-to-end (P7-A…E, protocol
  v9), owner playtest pending; its A1-b sync point landed (XP-curve + skill-tree editors
  in the panel).** P7 on top of the P5/P6 caster platform: the XP pipeline (kill tag rule,
  falloff, per-enemy xpMult, xpRate lever, discovery XP, cascading level-ups + §1.3
  juice), attribute allocation + all 96 skill-tree nodes as published rows (seed
  migration 0010 — never edit an applied migration, DATABASE.md §5) with every effect
  kind folding on BOTH sides (effective defs, movement/stamina/attack-speed/resource
  prediction parity), respec, write-through persistence, the C/K panels + XP bar +
  level-up juice + micro menu. Dev levers: `/setlevel`, `/ops/setlevel`, `/ops/cc`,
  `/ops/hurt`. Verified: `tools/smoke/browser-p7.mjs` (legit 1→10 camp grind via the
  published xpRate/xpMult levers, tier gates, respecs, UI, persistence), the node-effect
  matrix test (every published node × rank), p7-probe/two-client/earlier smokes, 263 unit
  tests. Heal magnitudes flagged for panel tuning.
