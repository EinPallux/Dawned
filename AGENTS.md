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
- **State:** P0–P5 complete (owner-verified 2026-08-03; P5 closed after fix rounds 7–8 —
  its machine/resources/stances/HUD/VFX platform and the panel-authored content flow with
  seed migrations 0005/0006 are what P6 extended; never edit an applied migration,
  DATABASE.md §5). **P6 — Classes II is 🟨 built (2026-08-03), owner playtest pending:**
  protocol v8, shared channels + ground/teleport/ally targeting + CC-on-players with
  per-lane DR + root/cleanse/refresh/zone/bonusVs vocabulary, server heal/absorb/zone/homing
  pipeline + Attunement/Grace passives + Focus stance, both caster kits (16 abilities)
  published via the panel (seed migration 0007), client casters per COMBAT.md §4.2
  (cast/channel bars, Q19 ground quick-cast, Q20 ally heals + green plate, STUNNED/ROOTED
  ribbon, shield chips, palette-by-content VFX). GM primitives `/ops/cc` + `/ops/hurt`
  drive the CC/heal paths until P9. Verified: `tools/smoke/browser-p6.mjs` (mage kit,
  CC/DR/interrupt, two-client heals, DPS envelopes, 4-player lag run + tick gate) plus the
  P4/P5 regression smokes on v8. Owner items open: P6 solo-camps parity playtest; the A0
  /admin login check (non-blocking).
