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
- **State:** P0–P6 complete (owner-verified; P6 closed 2026-08-04 — "classes are fine").
  A0's /admin login is confirmed working. **Current phase: P7 — Progression (XP, stats,
  skill trees), incl. the A1 sync point: xp-curve/tree editors in the panel.** The platform:
  the P5/P6 ability machine both sides run (casts/channels, protocol v8), resources +
  stances (Block/Evasive/Focus), the status runtime with CC + per-lane DR, 44
  panel-authored ability rows (hot reload; seed migrations 0005–0007 — never edit an
  applied migration, DATABASE.md §5), heal/absorb/zone/homing pipeline with
  Attunement/Grace, client casters per COMBAT.md §4.2, GM primitives `/ops/cc` +
  `/ops/hurt`. Verified: `tools/smoke/browser-p6.mjs` (mage kit, CC/DR/interrupt,
  two-client heals, envelopes, 4-player lag run + tick p95 1.77 ms) + all earlier smokes
  in one session, 191 unit tests. Heal magnitudes flagged for panel tuning.
