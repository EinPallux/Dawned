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
- **State:** P0-P2 complete (owner-verified). P3 (movement/netcode core/chat v1) built,
  verified and playtest-hardened through five owner fix rounds. P4 — Combat Foundation
  (protocol v6) — built and verified in dev 2026-08-03: shared combat formulas + dodge
  i-frames in the movement step, basic combos, lag-rewound hits, Grunt AI camps (Glub,
  Mushnub) + dummies from published content rows, telegraphs, FCT, death/respawn + Dawned,
  §9 juice pass v1; round-6 owner-session fixes in (flinch overlays, one-shot action
  lifecycle, un-mirrored telegraph cones, shoulder camera, death beat); combat-probe +
  browser-p4 (19 asserts incl. mixer truth) green, P3 smokes still green, tick p95
  1.17 ms in a camp fight; /netsim 100 20 owner-confirmed smooth. A0 (panel foundation)
  built and verified in dev in Dawned-Admin.
  Open owner items: P3 real-hardware 100 ms session, P4 10-minute demo + §9 review + feel
  signoff, A0 /admin login check (ROADMAP status blocks).
