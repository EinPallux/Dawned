# AGENTS.md — Dawned (game repo)

Instructions for AI coding agents working in this repository. **CLAUDE.md is the canonical,
complete version of these rules — read it first.** This file is the tool-agnostic mirror and adds
nothing beyond it.

## TL;DR for any agent

- **Project:** Dawned — low-poly browser 3D action-combat sandbox MMORPG (5–20 players), VPS-hosted
  (4 GB/1 core, Ubuntu 24.04, play.pathlands.cc). 0.1.0 must be a complete Early Access game, not
  an MVP. Companion repo: **Dawned-Admin** (editor/ops panel).
- **Truth lives in `docs/`:** ROADMAP.md = what to build now (phase gates with DoD);
  docs/design/* = game design; docs/tech/* = architecture/stack/security/deployment;
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
- **State:** P0-P4 complete (owner-verified). P5 (Classes I: ability framework, Warrior &
  Rogue, protocol v7) built and verified in dev 2026-08-03 alongside A1's abilities editor +
  publish v1: shared ability machine both sides run, Rage/Energy+CP resources, server slot
  executor + buffs/DoTs + RMB stances, 28 kit rows authored via the admin editor and
  published (hot reload; live-tune proven), predicted client hotbar + combat HUD cluster +
  VFX v1, basics from content rows, enemy projectile volleys + kiting AI, Spore Ridge ranged
  camp, migration 0005 deploy seeds. browser-p5 (21 asserts) + all earlier smokes green in
  one session, 165 tests, tick p95 1.21 ms under ability fights. Owner items open: P5 DoD
  demo runs (both kits, both camps, /netsim 100 20) + §9 kit checklist + HUD look check;
  non-blocking: P3 real-hardware group session, A0 /admin login check.
