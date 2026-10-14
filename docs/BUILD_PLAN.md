# Influencer OS: Build Plan

**Product spec:** `/Users/hossamhamdy/Desktop/Family/Hossam/Ventures/Influencer-OS/PRD.md`. It is the source of truth. Read the sections a task needs, not the whole file.
**Started:** 14 Oct 2026. **Target:** a 5-persona pilot live around 1 Nov 2026, once Hossam's accounts exist.
**Mode:** lean. Make it work, keep it simple, test what matters, no audit loops.

## Ground rules
- **Repository and files**
  - The git directory lives outside iCloud at `~/Library/Application Support/InfluencerOS/vcs/influencer-os.git`.
  - Builders work in the dev worktree at `~/Library/Application Support/InfluencerOS/worktrees/dev` (branch `dev`), where `node_modules` lives.
  - The Desktop folder `Hossam/influencer-os` is the `main` checkout. It is fast-forwarded at milestone ends.
- **Commits:** local checkpoint commits are fine. Push `dev` and `main` to `origin` at milestone ends (owner-approved, 14 Oct). Never commit secrets.
- **Stack:**
  - Node 22 (`~/.nvm` v22.23.3), pnpm 10, TypeScript and a pnpm monorepo.
  - Next.js app (dashboard + API + cron) targeting **Vercel**.
  - Postgres schema as plain SQL migrations targeting **Supabase**. Local dev and tests use **PGlite** (no Docker on this Mac).
  - A render worker that runs on the Mac (Remotion/FFmpeg, forked from Brand OS `packages/creative` and `apps/creative-worker`) and pulls jobs from the database queue.
- **Integrations go behind provider interfaces with fakes.** That covers LLM (Claude Agent SDK, API key), Higgsfield (MCP/CLI), fal.ai, ElevenLabs, Zernio, Lemon Squeezy, Resend, Apify and Telegram. Everything must run end to end on fakes before any account exists.
- **Secrets:** use environment variables or a vault only. No real keys in code, tests or logs. Claude never enters keys: Hossam pastes them via a setup script.
- **Brand OS stays separate.** Nothing personal (its `knowledge/`, stories, facts) is copied. Copy Brand OS code patterns only.
- **Tests:** run them in the foreground, and never finish while a test run is still going in the background.

## Milestones

| # | Milestone | Scope (PRD refs) | Done when |
|---|---|---|---|
| **IOS-1** | Foundation + studio wall | Monorepo; DB schema (§8.3 incl. Monetization, QC and Membership entities); persona registry + lifecycle state machine (§4); **approval engine** (§3.7: kill = explicit Owner approval, no timeout; 24 h auto-approve cards; spend caps); cost governor and credit ledger; audit log; Postgres job queue; provider interfaces + fakes; **dashboard v0 with the visual studio wall + persona page shell** (§3.8); seed with 5 sample personas and placeholder portraits | `pnpm test` green; `pnpm dev` shows the studio wall with 5 persona cards; a kill proposal can only execute after an Owner approval |
| IOS-2 | Agents | Claude Agent SDK runtime + model routing (Haiku/Sonnet/Opus), caching and per-persona caps; **Studio Manager** (niche scoring, persona drafting, weekly kill/scale proposals); **Persona Manager** (bible, plan, weekly calendar = 10 posts per §FR-4.3/4.3a, feedback loop); **Monetization Agent v1** (lead magnet + entry product briefs); Scriptwriter (hooks, blueprints, scripts); Compliance Gate v1 (§3.4 incl. halal screen); QC Q1/Q2; Telegram studio bot with forum topics | A dry run on fakes goes from niche → persona → week calendar → scripts with QC + Gate results; kill flow works over Telegram + dashboard |
| IOS-3 | Media pipeline | Higgsfield adapter (CLI/MCP: Soul ID, stills, activity clips, Seedance talking with audio at 720p; `generate cost` probe); voice (Higgsfield TTS / ElevenLabs); render worker for the 5 formats (talking, activity + text, voiceover, static, carousel), export 1080×1920; C2PA tag; QC Q3/Q4 (FFmpeg loudness/black/freeze, transcript diff, face similarity) | Fakes and one real sample per format render and pass QC |
| IOS-4 | Distribution + money | Zernio publishing (AI labels, scheduling, verification, comments, comment-to-DM); community worker + escalations; Lemon Squeezy listing packs + webhooks + attribution; Resend lists and sequences; analytics ingestion and scorecards; dashboard v1 (calendar thumbnails, pipeline board, money, niches board) | E2E on fakes: post → metrics → order → scorecard → kill/scale card |
| IOS-5 | Pilot go-live | Setup script for keys; connect real accounts; deploy to Vercel/Supabase; runbook; launch 5 personas | 5 personas live, posting 10/week, Hossam ≤ 60 min/day |

## Status
- 14 Oct: plan written; IOS-1 started.
- 14 Oct: **IOS-1 built** (branch `dev`).
  - Monorepo: `apps/web` (Next.js 16), `packages/db`, `packages/core`, `packages/providers`, `packages/secrets`. See `docs/ARCHITECTURE.md`.
  - Schema: two SQL migrations covering §8.3 (incl. Monetization, Quality, Membership, Audience) plus chat, notifications and Field Brain / News Desk tables (pgvector). Runs on PGlite locally, Supabase via `DATABASE_URL`.
  - Lifecycle state machine with state log + append-only audit log. Approval engine: kill/retire and other Owner-only kinds are explicit with no timer (enforced in code and by a DB check); 24 h auto-approve cards (studio switch + hours); post autonomy L0/L1/L2 with veto window. Approve/reject API.
  - Cost governor + credit ledger (persona and studio monthly caps, alert 80%, refuse 100%, metered providers, grants via spend approvals). Postgres job queue (SKIP LOCKED, backoff, per-persona cap). Global/persona/platform kill switches checked before every publish.
  - Provider interfaces + deterministic fakes (LLM, Higgsfield, talking, voice, Zernio, Lemon Squeezy, Resend, Apify). No Telegram: internal chat threads + notification centre with a streaming fake agent.
  - Secrets: Keychain (`ai.influencer-os`), `pnpm ios secrets status|set|unset|import-brandos`, Settings → Integrations (Connected · Pending key · Fake mode).
  - Seed: 1 studio, 5 personas (Testing ×3, Monetising, Scaling) with deep Appendix A profiles, 10-slot week calendars, metrics, orders, products, chats, a pending kill proposal for Theo, a 24 h product card, an L0 post, a veto-window post and a spend-above-cap request.
  - Dashboard v0: studio wall + Studio chat, persona page (calendar, posts, shelf, plan, community, Profile tab, manager chat), Approvals, Chat, Notifications, Settings, Integrations; Pipeline/Niches/Money stubs. Light/dark, responsive.
  - Tests: Vitest, 49 passing (migrations, lifecycle, approvals, 24 h cards, governor, queue, kill switches, chat, seed, providers, secrets).
