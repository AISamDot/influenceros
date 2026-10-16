# Influencer OS: Architecture (IOS-1)

A pnpm monorepo: one Next.js app and four small packages. Everything runs end to end on deterministic fakes; real adapters arrive milestone by milestone.

```
apps/web            Next.js 16 (App Router) dashboard + API routes (+ cron tick). Deploys to Vercel.
packages/db         Thin SQL layer (PGlite or Postgres), SQL migrations, migrate CLI, test DB helper.
packages/core       Domain logic: lifecycle, approvals, governor + ledger, queue, kill switches,
                    publish path, chat + notifications, read models, placeholder art, seed.
packages/providers  Provider interfaces + deterministic fakes (no network).
packages/secrets    Keychain secrets (service ai.influencer-os), `ios secrets` CLI, integration status.
```

## Database
- **Migrations:** plain SQL in `packages/db/migrations`, applied in order and tracked in `schema_migrations`. They target Supabase Postgres and also run on PGlite (incl. pgvector).
- **Switch:** `DATABASE_URL` set → Postgres (`pg` pool); unset → PGlite stored in `.data/pglite` (git-ignored). Only one process may open the PGlite dir, so stop `pnpm dev` before `db:seed` / `db:reset`.
- **Query layer:** `Db { query, one, maybeOne, exec, transaction }`. Parameters are positional; jsonb values are passed as `json(value)` strings. `numeric`/`int8` come back as JS numbers on both drivers.
- **Model:** every PRD §8.3 entity, plus `chat_thread`, `chat_message`, `notification` (dashboard-only Owner interaction) and `knowledge_node`, `knowledge_source`, `news_item`, `news_briefing` (Field Brain; `embedding vector`, dimension fixed in IOS-2). Every persona-scoped table has `persona_id`. `order` is a reserved word, so the table is `orders`.
- **Guarantees in the schema:** `audit_log` is append-only (row triggers for UPDATE/DELETE, a statement trigger for TRUNCATE; on Supabase also run the app as a non-owner role with those privileges revoked). The `approval_owner_only_kinds` check makes it impossible to auto-approve kill/retire, spend-above-cap, plan-upgrade and disclosure/legal approvals, or to approve them as anyone but `owner:*`.

## Core rules
- **Lifecycle** (`lifecycle.ts`): PROPOSED → SETUP → TESTING → MONETISING / RE_ANGLE / KILLED → SCALING → BRAND, plus RETIRED. Invalid edges throw. → KILLED / → RETIRED need an Owner-approved kill/retire approval (single use); PROPOSED → SETUP needs the launch card. Every transition writes `persona_state_log` + `audit_log`. Going live (SETUP → TESTING) sets autonomy to the studio `default_autonomy` (L1 by default).
- **Approvals** (`policy.ts`, `approvals.ts`): `propose` (any actor; refuses lifecycle cards with no valid edge, validates spend/disclosure payloads, binds a post approval to one post and reads its stored Gate verdict) → `decide` (Owner only; optional payload hash so what runs is what the card showed) → executor. Modes:
  - `explicit`: kill/retire, spend above caps, plan upgrades, disclosure/legal text; posts at L0; amber posts at L1; posts with no Gate verdict.
  - `auto_after`: persona launch and product v1 cards (24 h by default; studio switch and hours in Settings).
  - `veto_window`: green posts at L1, green/amber at L2 (2 h default). Red never publishes.
  - `sweepAutoApprovals` (`tick()`: Vercel Cron via `vercel.json`, locally the 60 s ticker in `apps/web/instrumentation.ts`) approves due cards/posts and never touches Owner-only kinds. It re-checks the card switch, the persona's current autonomy and the latest Gate verdict first; an approval that fails to execute becomes explicit and notifies the Owner instead of blocking the sweep.
- **Owner-only controls** (`settings.ts`, `killswitch.ts`): only the Owner changes studio settings, raises persona autonomy or caps, or clears a kill switch. Agents/system may only lower autonomy or caps (circuit breakers); lowering autonomy turns queued veto-window posts into explicit approvals.
- **Governor** (`governor.ts`, `metered.ts`): monthly caps per persona and per studio for `llm_usd` and `hf_credits` (`media_usd` is tracked, uncapped). Alert at 80% (audit + notification), refuse at 100%. `meteredProviders()` reserves the estimate as a ledger hold before every paid call (under the debit lock, so concurrent calls can't share headroom), then settles it to the actual cost or releases it on failure; an approved `spend_over_cap` adds a ledger grant.
- **Queue** (`queue.ts`): `job` table, claims with `FOR UPDATE SKIP LOCKED`, exponential backoff with jitter, `dead` after `max_attempts`, at most N running jobs per persona, `DeferJob` (no attempt spent). Every post-claim state change is scoped to the worker's lease (a reaped worker's late result is discarded); long jobs call `heartbeat()`. The stale-lock reaper requeues with backoff, or dead-letters once attempts are used up.
- **Publish path** (`publish.ts`): kill switches (global / persona / platform) + persona state → the post's own approval → Gate not red (a red is released only by `owner:*`; amber needs the Owner unless L2) → QC passed → atomic claim `scheduled → publishing` → provider publish with `aiLabel: true` (enforced by the type) and the post id as idempotency key → verify live.
- **Chat** (`chat.ts`): Studio, Monetization, Quality and one thread per persona. Owner messages persist (persona notes also land in `feedback`); the fake agent composes a numbers-first reply from live data. `POST /api/chat/:id/messages` streams the reply as plain text, the same contract the Agent SDK runtime will use.

## Providers
`LlmProvider`, `ImageVideoProvider` (Higgsfield), `TalkingProvider` (Seedance or fal Kling Avatar), `VoiceProvider`, `PublishProvider` (Zernio), `StoreProvider` (Lemon Squeezy), `EmailProvider` (Resend), `ResearchProvider` (Apify). Fakes are deterministic, record their calls and never touch the network. There is no chat provider: the Owner talks to agents in the dashboard.

## Secrets
macOS Keychain via `@napi-rs/keyring` (service `ai.influencer-os`, account = secret name), the Brand OS pattern. `pnpm ios secrets status|set|unset|import-brandos`; input is hidden and values are never printed. Env vars (Vercel) win over the Keychain. Tests only use `MemoryKeyring`, and `defaultBackend()` returns a null backend under Vitest. Settings → Integrations shows Connected · Pending key · Fake mode per integration.

## Dashboard
Studio wall (persona cards + Studio chat), persona page (hero, look pack, week calendar, posts, product shelf, plan, community, manager chat, Profile tab with the full bible), Approvals (kill proposals first, then explicit items, then countdown cards), Chat, Notifications (bell), Settings (caps, autonomy, approval toggles, kill switches, Gate rules), Integrations; Pipeline, Niches and Money are stubs with live counts. Light/dark via `data-theme`. All pages are dynamic, so builds never touch the database.

Until auth lands (IOS-5): the server binds to 127.0.0.1; `apps/web/proxy.ts` rejects unknown Host headers (DNS rebinding) and cross-site state-changing `/api` calls; JSON routes require `application/json`; pages send `X-Frame-Options: DENY` and `frame-ancestors 'none'`. Approving a kill/retire needs the persona's name typed in a confirm step.

## Run
```
pnpm install
pnpm dev          # migrate + seed if empty, then http://127.0.0.1:3100 (loopback only)
pnpm test         # Vitest (in-memory PGlite per test)
pnpm build        # typecheck all packages + next build
pnpm db:migrate | db:seed | db:reset
pnpm ios secrets status
```

## IOS-2 (agents, content, knowledge, profit)
Built by four parallel streams against the contracts in `docs/IOS-2-CONTRACTS.md`. New packages:

```
packages/agents     Contracts (frozen) + agent runtime, tool registry, Studio Manager, Persona Manager (stream A).
packages/auth       Owner login: magic link / passkey, CLI password fallback, session cookie (stream A).
packages/content    Calendar, Scriptwriter + hook-lab, Monetization v1, Compliance Gate v1, QC Q1/Q2, pipeline (B).
packages/knowledge  Field Brain, embeddings + pgvector retrieval, News Desk, persona importer (stream C).
packages/profit     Profit Engine v1: P&L, levers, lever log, forecast, reports, scheduler (stream D).
packages/wiring     Composition root: every package's tools, jobs, schedules, live adapters and policies.
apps/worker         Local queue worker on the Mac (stream D).
.claude/skills      The studio's own skills, loaded by the Agent SDK (stream C).
```

Each stream documents what it built inside its own block below (append only).

<!-- >>> stream A architecture -->
### Stream A: agent runtime, managers, chat, Owner login

**Runtime** (`packages/agents/src/runtime.ts`). `createServices({ mode })` builds one runtime for every agent:
- `fake` (tests, no key) or `auto`: live when `providers.llm` is the live `AnthropicLlm` (wiring overlays it only when the Anthropic key is present and `IOS_FAKE_PROVIDERS` doesn't force fakes).
- One pipeline for both modes: routing (`task.tier` → D's `RoutingPolicy` → `DEFAULT_ROUTING`; Haiku 5.5 / Sonnet 5.5 / Opus 5.5) → governor hold (refused past a cap, logged `refused`) → engine → settle the actual cost (a failed live run's partial spend is still debited) → `parse` → one `agent_run` row (mode, engine, tokens, cache read/write tokens, tool calls, `CostRef`).
- Engines (`src/live/`): the **Claude Agent SDK** for agent work (tasks with tools or skills) and the **Messages API** for one-shot structured calls. `IOS_AGENT_ENGINE=messages|agent-sdk` forces one.
  - Messages API: cached blocks first as system blocks with `cache_control` on the last (tools sorted for a stable prefix; tool loops also cache the conversation), structured output via `output_config.format`, explicit effort per tier, `stop_reason: "refusal"` → `AgentRefusalError`, server-side refusal fallback on Sonnet/Opus (`IOS_LLM_FALLBACKS=off` disables), spend checked between turns.
  - Agent SDK: `settingSources: ['project']`, `cwd` = repo root (`.claude/skills`), `skills` limited to the task's, `settings.disableSkillShellExecution`, `tools: []` (or `['Skill']`) plus `disallowedTools` (Bash, Write, Edit, Read, web, subagents), registry tools exposed through an in-process MCP server and pre-approved by name, `permissionMode: 'dontAsk'`, `maxBudgetUsd` = governor headroom (capped per run), `persistSession: false`, and a subprocess env with only PATH/HOME and the Anthropic key.
- Streaming stays inside A: `runAgent(services, task, { onText })`; the fake runtime streams its text in chunks.

**Tools and permissions** (`src/tools`, `src/registry.ts`). `studio.*` (overview, personas, propose_kill, pause_posting, delegate, adopt_rule), `persona.*` (status, posts, lower_controls), `bible.*` (read, revise), `playbook.*`, `feedback.*` (recent; `decide` is Owner-only), `approvals.*` (pending, withdraw; `decide` is Owner-only), `chat.notify_owner`. The registry refuses unknown tools, Owner-only tools for agents, callers outside a tool's allowlist, another persona's id for a persona-scoped caller, personas outside the studio, and an agent caller carrying an Owner actor; mutating calls are audited. Kills, cap or autonomy raises, disclosure/legal text and accounts are only ever proposed.

**Managers** (`src/agents`, `src/chat.ts`, `src/feedback.ts`).
- Studio Manager: Studio chat, all studio tools (plus other streams' tools it may see), kill proposals as approval cards in the thread, pause posting, delegation to persona managers, @mentions bring the persona's manager into the thread. Cached context: the studio rules.
- Persona Manager: cached context = studio rules → bible vN → playbook. Feedback loop: classify (fast tier, structured) → restate with before/after → one-off applies now; persona rule / strategy wait for the Owner's Apply (button or "yes"); studio-wide becomes a proposed studio rule → Bible vN+1 (previous version superseded) or a playbook rule → `feedback.applied` audit → confirmation. Compliance/identity sections become a `legal_text_change` approval. `/status`, `/bible`, `/pause`, `/resume` shortcuts.
- Monetization and Quality threads run their agents with B's `monetization.*` / `gate.*` / `qc.*` tools.
- Jobs/schedules: `agent.recover_publishing` (every 5 min via `studio.recover_publishing`), `agent.feedback_effects` (daily via `persona.feedback_effects`: views/saves per post the week before vs after each applied change).

**Owner login** (`packages/auth`, `apps/web/proxy.ts`, `app/login`, `app/api/auth/*`). Magic link to `OWNER_EMAIL` via Resend (live adapter `ResendEmail`; the link lands on `/login/verify`, whose button posts the one-time token so mail scanners can't use it), or the fallback password set with `pnpm owner set-password` (scrypt). Sessions are rows plus an HMAC-signed `ios_session` cookie (HttpOnly, SameSite=Lax, Secure on https, 14 days). The proxy checks the signature and expiry on every request and protects everything except `/login`, `/api/auth/*`, `/api/webhooks/*`, `/api/cron/*` and `/api/health`; pages, server actions and A's API routes also check the session row (sign-out and `pnpm owner sessions revoke` take effect at once). Deployed without `AUTH_SECRET`, protected routes fail closed. Attempts are throttled. `IOS_AUTH=off` works only on loopback and never when deployed.

**IOS-1 recheck fixes.** Kill/retire approvals need the typed persona name and the payload hash in `decide()` itself, so the form, JSON and tool paths all enforce it. Queue claims carry a per-claim `lease_token`; every post-claim update matches on it. A post whose verify throws (or reports "processing") keeps its external id in `publishing`; `recoverPublishing()` re-verifies it, reschedules a never-confirmed publish (the idempotency key prevents a double post) and fails it after repeated verify failures, telling the Owner.
<!-- <<< stream A architecture -->

<!-- >>> stream B architecture -->
### Content (stream B, `packages/content`)

```
calendar.ts      Weekly plan per persona: CadencePolicy target (winner cadence 17/wk for SCALING/BRAND when the policy is default),
                 format × purpose mix, posting windows in the persona's zone (1/day, then 2–3 on the strongest days), a CTA
                 keyword on every slot, sell slots booked from the Monetization Agent's sellQueue, News Desk ideas first,
                 titles for the rest from the calendar-planner agent. Idempotent per week.
hooks.ts         Hook-lab: 10 hooks across 10 types, scored in code (length, address, interrupt, persona words, fatigue,
                 compliance/banned/duplicate exclusions); ship 1 + 2 A/B variants of other types.
script.ts        Scriptwriter: 40–90 words / 15–30 s for the ear, caption, on-screen text, carousel copy, visual brief, claims
                 (each factual claim cites a KnowledgeHit id). enforceScript = the maker's deterministic fixes.
qc.ts            Q1 (English only, hook first, length/duration, CTA keyword, repeats, TTS pronunciation → `voiceover`, uncited
                 claims, persona voice, spelling, caption, visual brief) and Q2 (TranscribeProvider re-transcription, word
                 alignment, WER ≤ 8%, misheard key words, cut-off ending, pace, pauses, voice id). qc_report + qc_defect.
gate.ts          Compliance Gate v1: deterministic red/amber rules (legal/platform lines only) + a fast-tier model second
                 opinion that can only add findings. Script (pre_render), reply (never deny AI) and post (AI flag, profile label).
monetization.ts  Demand intake (comments, DMs, refunds, sibling sales, market scan), Product Opportunity Score (8 weighted
                 factors), honest validation (comment keyword, pass mark 50 or 2%), briefs (product row at 'brief'), listing
                 packs (Lemon Squeezy + Etsy, Gate-checked), launch plans (real deadlines only), sellQueue for the calendar.
pipeline.ts      processSlot: idea → script → Q1 (max 2 fix loops) → Gate → media.render (MediaRenderPayload); resumable from
                 calendar_slot.status, never enqueues media twice; red → blocked with the reason + an Owner notification.
jobs.ts          Jobs calendar.plan_week, pipeline.slot, monetization.cycle, qc.voice (budget refusals → DeferJob). Schedules
                 calendar.weekly_plan (daily), pipeline.advance (30 min), monetization.weekly_cycle (Mon 06:00 UTC); enqueue only.
tools.ts         16 agent tools in calendar.*, hooks.*, script.*, gate.*, qc.*, monetization.*, pipeline.* (persona-scoped).
live.ts          `transcribe` live adapter: ElevenLabs Speech-to-Text (Scribe) on `elevenlabs.api_key`, live only when the
                 ElevenLabs integration is live; otherwise FakeTranscriber.
board.ts         Pipeline board and slot-detail read models (apps/web /pipeline and /pipeline/[slotId], /api/pipeline).
```

- **Migration `0005_b_content.sql`:** calendar_slot gains `week_start`, `posting_window`, `cta_keyword`, `product_id`, `script_id`,
  `block_reason`, `meta` and the pipeline statuses (incl. IOS-3's); script gains `slot_id`, `format`, `hook`, `voiceover`,
  `on_screen_text`, `carousel`, `visual_brief`, `evidence`, `claims`, `word_count`, `est_seconds`, `fix_loops`; demand_signal,
  product_opportunity, product, validation_test and launch gain v1 fields; new `product_listing`.
- **Cost refs:** slot work → `calendar_slot`; briefs and listing packs → `product`; calendar titles and replies → `persona`.
- **Dry run:** `pnpm content dry-run [--winner] [--tz <zone>]` (in-memory, fakes). Real DB: `pnpm content plan|run|monetize <slug>`.
<!-- <<< stream B architecture -->

<!-- >>> stream C architecture -->
### Stream C: Field Brain, News Desk, skills, launch personas (`packages/knowledge`, `.claude/skills`, `packages/core/src/seed`)

- **Field Brain** (`field-brain.ts`, PRD §3.10, FR-23.1). One per niche (`persona.niche`, case-folded), shared by its personas. `knowledge.build` maps the field (`WebResearchProvider.mapField`: canon, experts, curriculum), lets the `knowledge-builder` agent plan missing nodes up to ~120 (fake mode adds none), then queues one `knowledge.research_node` job per node not verified in 7 days. Research (`researchTopic`) stores a synthesis, cited facts (quotes ≤ 25 words, each citation linked to a `knowledge_source` row), frameworks and questions, sets `last_verified_at`, and embeds the node. Spend is metered as `llm_usd` with `CostRef { type: 'knowledge', id: studioId }`; a capped governor defers the job (6 h) instead of burning retries.
- **Embeddings + retrieval** (`embed.ts`, `service.ts`). 384-d vectors with `embedding_model` recorded per row; retrieval only compares vectors from the current embedder and `knowledge.embed_pending` re-embeds anything else. Migration `0006_c_knowledge.sql` adds partial HNSW indexes on `(embedding::vector(384))` (cosine). `createKnowledgeService` = `retrieve` (nodes + 30 days of news; Reddit is excluded from evidence; keyword fallback when the embedder is down) and `latestBriefing`. Tool `knowledge.retrieve` exposes it to agents; every hit id is claim evidence.
- **News Desk** (`news.ts`, FR-23.2). `news.daily_scan` (05:00 UTC) queues `news.scan` per niche: fetch the niche's RSS sources (seeded feeds, else a Google News search feed), skip items older than 7 days, canonicalise URLs, dedupe near-identical headlines across outlets (`duplicate_of`, `coverage`), embed, score 0–100 (recency, source credibility, relevance to the niche profile, coverage), then queue one `news.briefing` per persona. The `news-desk` agent (fast tier) writes why-it-matters and the persona's take within the bible's stance rules; the briefing is stored in `news_briefing`, posted to the persona chat (`meta.kind 'briefing'`, `agent:news-desk`), and its fast-reaction ideas become `idea` rows with `source.type 'news'` and a 48 h `expires_at`. Cost ref `news`.
- **Live adapters** (`live/`, returned by `liveProviders`). `webResearch`: Claude Sonnet 5.5 with `web_search_20260209` + `web_fetch_20260209`, prompt-cached system block, `pause_turn` continuation, server-side refusal fallback, JSON repair on the fast tier; cost = tokens + $0.01/search; live only when the Anthropic integration is. `feeds`: HTTP RSS/Atom with a host allowlist (built-in + `IOS_FEED_ALLOWLIST` + the studio's own seed feeds), no private addresses, redirects re-checked, 10 s / 3 MB caps. `embeddings`: local `bge-small-en-v1.5` via transformers.js (model cached in `.data/models`, loaded lazily, resolved from this package) or Voyage (`IOS_EMBEDDINGS=voyage`). `IOS_FAKE_PROVIDERS` keeps any of them on fakes (Vitest sets it).
- **Skills**: ten studio skills in `.claude/skills/<name>/SKILL.md`, our own text, no `allowed-tools`, no shell lines; `validateSkills()` checks them and `skillBlock()` sends one as a prompt-cached block.
- **Launch personas** (archived 16 Oct, see below): the Persona Architect's documents lived in `packages/knowledge/seed/personas/<slug>/` (+ `manifest.json` for niche, timezone, hue). `pnpm db:seed` parses them (`core/src/seed/launch.ts`) and seeds a studio with those personas in SETUP (launch card proposed by the Studio Manager, executed by the timer), all 16 bible sections, the launch fortnight as planned slots with ideas, the product ladder as `idea` products, pending accounts with the chosen handles, and each niche's Field Brain seed (unverified nodes, canon, feeds, experts). No invented metrics, orders or spend. Without the folders (or with `--samples`) it seeds the IOS-1 sample studio. `personas.import` (every 6 h, `IOS_PERSONAS_SOURCE`) adds new folders and turns edited documents into bible vN+1.
- **Dashboard**: `/knowledge` (Field Brain coverage, search as agents see it, briefings, top stories), `POST /api/knowledge/build`, `POST /api/news/scan`, `GET /api/knowledge/search`, `GET /api/news/briefing`.
- **CLI**: `pnpm knowledge status | build <niche> [--inline] | embed | retrieve <niche> <query> | scan <niche> [--inline] | brief <slug> | personas sync|import | skills check`.
<!-- <<< stream C architecture -->

<!-- >>> stream D architecture -->
### Stream D: Profit Engine, scheduler, worker (`packages/profit`, `apps/worker`)
- **P&L** (`pnl.ts`, FR-24.1): one pass over a window loads orders (+ refunds; attributed to a post by `source_post_id`, then the coupon's source post, then the short link's post) and `credit_ledger` debits (holds and grants excluded; attributed by ref: `post`, `calendar_slot` → the slot's post, `product`, else persona/studio overhead). LLM and media USD → cents, Higgsfield credits at the Profit Engine's credit price (`profit_setting`, default 4.4¢). Grains: post, persona, format, product, platform. Every grain of a window sums to the same totals: what can't be placed lands in `overhead` / `unattributed` / `studio` rows, and a persona's unattributed sales are spread over its posts by views (`allocatedRevenueCents`). `weeklySeries` buckets the same facts by week.
- **Forecast** (`forecast.ts`, FR-24.4): per persona, a log-linear sales trend (shrunk toward 0 with little history, ±20%/week) with lognormal noise, historical fee/refund share and the recent cost level (the current partial week blends in); 1,000 seeded runs × 13 weeks, summed run by run with studio overhead into the studio total. Returns weekly and 90-day P10/median/P90, the rest-of-month band and consecutive negative-median weeks. Stored weekly in `profit_forecast`.
- **Levers** (`levers.ts`, FR-24.2), each logged in `profit_lever_action` (before/after, rationale, expected monthly impact, review date) plus an audit entry and a `decision` row, then measured after the review window (change in the scope's weekly profit vs the baseline; routing: LLM spend saved):
  - cadence: raise while net revenue per post ≥ 3× cost per post, trim below 1× (within `CADENCE_BOUNDS` 7–21), written to `profit_cadence_override` from next Monday;
  - format mix: one slot a week from the least to the most profitable format (every format ≥ 1, none > half the week);
  - credit reallocation: next week's pool (studio caps / 4.35) split 70/20/10 by profit per credit into `budget_allocation` (never above a persona's cap; caps themselves are never raised);
  - model routing: step the scriptwriter down a tier while QC Q1 passes ≥ 90%, revert automatically below 85% (`profit_routing_override`).
- **Policies**: `createCadencePolicy` (B's calendar) and `createRoutingPolicy` (A's runtime) read those overrides; defaults otherwise.
- **Kill candidates** (`kill.ts`): forecast median negative 4+ weeks and ≥ 3 weeks of history → core `proposeKill` as the Studio Manager with `evidence.source = 'profit-engine'` (retire for BRAND), only when nothing is pending and not within 14 days of an Owner rejection. Never executed by the engine.
- **Outputs**: `profitCard` (Studio wall), `rankActions` ("how do we make more profit": levers in dry run plus Owner-only actions such as kills and cap raises, products and price tests, ranked by impact × confidence), the Weekly Profit Report (`report.ts`: numbers computed, opening paragraph by the `profit-engine` agent through the runtime with a deterministic fallback; posted once per week into the Studio chat, `meta.kind 'profit_report'`). Tools: `profit.pnl|more_profit|lever_log|card|run_levers|weekly_cycle|weekly_report`, `forecast.get|run`, `budget.status` (Persona Managers read their own persona only; acting tools are studio-level callers only).
- **Scheduler and tick** (`scheduler.ts`): `studioTick` = core `tick()` + every due `ScheduledTask` from `allSchedules()`, with the last successful run and a 5-minute claim per task in `scheduler_run`. Profit schedules only enqueue (`enqueueOnce`): `profit.weekly_cycle` (Mondays 06:00 UTC → job: measure, forecast, levers, kill candidates, report) and `profit.daily_measure` (05:00 UTC). Vercel Cron → `/api/cron/tick` (Bearer `CRON_SECRET`, timing-safe compare); on the Mac the server's ticker (`instrumentation.ts`) and `pnpm worker`.
- **Worker** (`worker.ts`, `apps/worker`): claim loop over core `runOnce` with `allJobs()` handlers (only kinds with a handler are claimed, so `media.render` waits for IOS-3), each handler gets `{ services, job, heartbeat }`. In dev it runs inline in the Next server (`IOS_WORKER`, default inline without `DATABASE_URL`); `pnpm worker [run|once|tick|status]` runs it standalone against Postgres (it refuses to open PGlite while the dev server is up).
- **Money page** (`/money`): P&L by period and grain, 90-day fan chart and per-persona forecasts, ranked actions, lever log, credits vs caps and the weekly allocation. Read API: `/api/profit/{pnl,actions,card,forecast,levers}`. CLI: `pnpm profit pnl|forecast|actions|levers|measure|cycle|settings`.
<!-- <<< stream D architecture -->

## IOS-3/4 (media, distribution, commerce, products)
Built by four parallel streams against the contracts in `docs/IOS-34-CONTRACTS.md`. New packages:

```
packages/media         Higgsfield adapter, voice, Remotion/FFmpeg render worker for the 5 formats, QC Q3/Q4 (stream E).
packages/distribution  Zernio publishing, community worker, analytics ingestion, Settings → Accounts (stream F).
packages/commerce      Lemon Squeezy, persona micro-sites, Resend lists and sequences, membership, attribution (G).
packages/products      Product Builder (brief/manuscript → PDF A4 + Letter), QC QP, listing packs (stream H).
```

Shared since the contracts commit:
- **Contracts** (`packages/agents/src/ios34.ts`): the cross-stream job payloads (`publish.prepare`, `product.build`), `ProductFile`, `COMMUNITY_CLASSES`, `METRIC_WINDOWS`, persona-site URLs (`personaSiteUrl`, `shortLinkUrl`), `loadPersonaKit` (bible palette → layout colours) and `enqueueOnceFor`.
- **Providers:** additive members on Higgsfield, Zernio and Lemon Squeezy, plus two new members:
  - `audience`: Resend audiences, contacts, broadcasts and sequence sends;
  - `storage`: a `MediaStore`; keys are validated and only `public/…` keys are ever served without the Owner session.
- **Public persona sites:**
  - `<slug>.<IOS_STUDIO_DOMAIN>` is rewritten by the proxy to `/p/<slug>/…`. A persona host can't reach the dashboard.
  - `/p/*`, `/l/*` and `/api/public/*` are public.
  - The root layout renders site pages bare.

Each stream documents what it built inside its own block below (append only).

<!-- >>> stream E architecture -->
### Media pipeline (IOS-3, stream E: `packages/media`)

`media.render` (queued by B's pipeline after the pre-render Gate) runs on the Mac worker and resumes from `media_render.state`:

1. **Voice** (talking, voiceover): `providers.voice.tts` (ElevenLabs Creator; Higgsfield TTS with `IOS_VOICE_PROVIDER=higgsfield`) → stored track → **Q2** (`@ios/content` `voiceCheck`). A failed Q2 re-voices (≤ 2), then blocks. The persona's voice is designed once (`media_profile.voice_id`).
2. **Generate** (Higgsfield via the official CLI, 720p): Soul ID from the look prompts (once per persona, after Q2), stills (Soul / Nano Banana), image-to-video clips (Kling 3.0 Turbo → Kling → Wan), talking clips via Seedance with `--audio` (the voice split at sentence ends into ≤ 15 s chunks, uploaded with `higgsfield upload`). fal Kling AI Avatar v2 is the pluggable fallback (`IOS_TALKING_PROVIDER=fal`). Every call goes through `metered()`: `hf_credits` estimated from `media_price` (the weekly `higgsfield generate cost` probe), settled at the credits the CLI reports; USD calls in `media_usd`; each logged in `media_generation`.
3. **Q3** (talking): face similarity of sampled frames against the persona's face reference (Apple Vision feature prints via `vision/ios-vision.swift`), one face per frame, freezedetect. Failing clips are regenerated (≤ 2), then the slot blocks.
4. **Render** (`FfmpegToolkit`: pinned `ffmpeg-static`/`ffprobe-static`, sharp for text layers and cards): talking = 2 clips stitched with a b-roll cutaway; activity + text = an 8 s loop with timed on-screen lines; voiceover = 3 clips + narration + captions; static = 1080×1920 image + headline; carousel = 6–8 slides at 1080×1350. Upscale with lanczos + unsharp, the persona grade (`eq` + `colorbalance` from the bible palette), captions inside the platform safe zones, single-pass loudnorm, AI-generated container metadata, `render_meta.ai` on every asset.
5. **Q4**: ebur128 (−14 LUFS ±1, true peak ≤ −1 dBTP), silencedetect (> 0.7 s), blackdetect, freezedetect, ffprobe size/fps/duration, caption OCR (Apple Vision) against the script, safe zones, AI flag, cover, CTA, caption length, hashtags. The maker fixes (re-normalise two-pass, re-size captions, regenerate the clip, re-voice, re-render) at most twice, then the slot is `blocked` with the report and an Owner notification.
6. **Hand-over**: cover asset → `calendar_slot.thumbnail_url` (the Pipeline board) → status `final_gate` → exactly one `publish.prepare` (`enqueueOnceFor`, key `slot:<id>`) with `aiGenerated: true`.

Without keys everything runs on `FakeToolkit` / `FakeOcr` / `FakeFaceMatcher` (JSON stand-ins, SVG frames), so every format renders end to end in tests and the dev server. A spoken post never mixes a live voice with fake generations: it waits with "pending key". Owner-only files are served by `/api/media/<key>`; `/api/public/media/<key>` serves only `public/…` keys. Schedules: `media.cost_probe` (weekly), `media.prepare_personas` (daily Soul ID + voice + look pack), `media.sweep` (hourly re-queue of dead renders, block after 3). CLI: `pnpm media status | sample <format> | probe-costs` (samples run on a scratch database).
<!-- <<< stream E architecture -->

<!-- >>> stream F architecture -->
### Stream F: distribution, community, analytics (IOS-4)

**Publishing** (`packages/distribution/src/publishing.ts`, core `publishPost`):
- `publish.prepare` (E enqueues once per slot) creates one `post` per target platform with `ai_flag` true and the platform's AI field in `post.meta.platform_options` (TikTok `video_made_with_ai`, Instagram `is_ai_generated`, YouTube `containsSyntheticMedia`). Video goes to TikTok + Instagram, plus YouTube Shorts from the persona's day 30; static and carousel go to Instagram only, because TikTok refuses the AI flag on direct photo posts. Then post-level Q4 (`qc_report` subject `post`), `gatePost`, and core `propose({ kind: 'post' })`; the slot goes `scheduled`. No active account → `DeferJob` 6 h + one Owner notification.
- `publish.due` (every minute) queues `publish.post` for approved posts at their time, skipping anything behind a kill switch. `publish.post` uploads the stored media to Zernio once (`post.meta.vendor_media_urls`), then core `publishPost` (kill switches, approval, Gate, QC, idempotency key = post id, `aiLabel: true`, IOS-4 request fields from `post.meta`) → verify → `live` + URL → slot `live`.
- Trending-sound posts (`trendingSound`) go to the TikTok app inbox as drafts (`mode: 'draft_inbox'`); recovery keeps them pending for 72 h instead of failing them.
- Live adapter: `ZernioPublisher` (REST, `ROUTES` in `zernio.ts`), on when `zernio.api_key` is present. It writes the AI flag last and refuses any option that says otherwise. Webhooks (`/api/webhooks/zernio`) need `zernio.webhook_secret`; without it the worker polls.

**Community** (`community.ts`): `community.poll` (every 10 min) and the webhook store `comment` / `dm_thread` rows (unique per external id); `community.handle` classifies (`COMMUNITY_CLASSES`: rules first, then a fast model on fenced, untrusted text; the rules' safety classes always win) and acts:
- spam/abuse hidden; threats, crisis, minors and legal/press are S1 (`community_pause`, thread `bot_paused`, critical notification); crisis gets only the Owner-approved helpline text (an Owner-only `legal_text_change` with `payload.purpose = 'crisis_helpline'`, proposed automatically the first time);
- partnership, personal health/money/legal questions and hostile "are you real?" are S2 (warn notification, holding reply where it fits);
- keyword comments get a DM with the post's short link (G) or the persona's `/free` page; other comments get a reply in voice.
- Every reply/DM passes `gateReply` and is sent only when green; a denial of being AI falls back to the honest template. Budgets: 25 replies per post, 20 replies and 15 DMs per persona per hour.

**Analytics** (`analytics.ts`): `analytics.pull` (every 15 min) captures cumulative metrics per post at 1h/24h/72h/7d (`metric_snapshot."window"`, unique per post and window; a capture later than the next window is skipped) and rolls up one account row per persona, platform and day (the day's growth, followers carried forward). The Profit Engine reads the latest snapshot per post; `personaScorecard` feeds the persona panel and `analytics.scorecard`.

**Accounts** (`accounts.ts`, `/settings/accounts`): the setup sheet per persona (handle suggestion, bio without an AI line, portrait, link-in-bio `personaSiteUrl`, AI-label steps; YouTube from day 30). Only the Owner records and changes accounts; `accounts.sync` (every 6 h) links accounts connected in Zernio by handle (`token_ref` = Zernio account id), activates them and reads the AI profile label when the vendor exposes it. The Gate ambers posts from accounts without the label.

Migration `0010_f_distribution.sql`: `post.meta`, `account.meta`, comment/DM/escalation columns, `metric_snapshot."window"`, `community_pause`. CLI: `pnpm distribution status|sheet|accounts|sync|scorecard|pull|poll|due|crisis-text`.
<!-- <<< stream F architecture -->

<!-- >>> stream G architecture -->
### Stream G: commerce, audience, persona sites (`packages/commerce`, migration `0011_g_commerce.sql`)
- **Lemon Squeezy** (`live/lemonsqueezy.ts`, live when `lemonsqueezy.api_key` + `webhook_secret` exist): reads stores and products (+ variants), creates checkouts (custom data) and per-post discount codes, verifies `X-Signature` (hex HMAC-SHA256) and maps `order_created`, `order_refunded`, `subscription_*` to `StoreEvent`s. Fees are estimated at 5% + 50¢ (webhooks don't carry them); the sale is the net-of-tax total.
- **Products, API-less first** (`store.ts`): `store.product_sweep` builds the Gate-checked listing pack (B's `buildListingPack`) for every approved product, matches the store product through the read-only API and stores its checkout URL; otherwise `store_status = 'awaiting_listing'` and the Owner gets one notification to create the listing from the pack (or paste the checkout URL on `/commerce`). A stored URL makes the product `live`. Free lead magnets go live as `free` (delivered by email). `store.sync` links stores to personas by slug (one store per persona).
- **Attribution** (`attribution.ts`, `checkout.ts`): `attribution.sweep` gives every outgoing post a short link (`/l/<code>` → the sell product's page or `/free`, `?src=`) and sell posts a 10% / 30-day coupon (created in the store when linked). The buy button (`/api/public/checkout`) appends `checkout[custom][post_id|short_link|coupon|product_id|persona_id]` and `checkout[discount_code]` to the stored URL (or creates an API checkout). The order webhook attributes custom-data `post_id`, then the coupon, then the short link (`orders.attribution`), so D's P&L by post works unchanged.
- **Webhooks** (`webhooks.ts`): `/api/webhooks/lemonsqueezy` and `/api/webhooks/resend` (Svix). Bad signature → 401; each event is claimed once in `commerce_webhook_event` inside the processing transaction (replays → `duplicate`). Refunds keep one cumulative row per order (`refund.store_ref`).
- **Audience** (`audience.ts`, `sequences.ts`, live `ResendAudience` on `resend.api_key`): one Resend audience per persona (`email_list`), sign-ups with `consent_record`s, double opt-in for EU/EEA/UK/CH and unknown regions (edge country header), honeypot, rate limits (`site_rate_limit`), identical responses (no enumeration). The `email-writer` writes a 5-email welcome sequence (days 0/1/3/5/7), each email Gate-checked; red gets one rewrite, then stays a draft with an Owner notice. `email.send_due` sends due steps (claimed per enrolment) with List-Unsubscribe one-click headers, the unsubscribe link and the physical-address footer; with no address nothing marketing sends. Broadcasts (`email.broadcast`) are Gate-checked. Bounces stop sequences; complaints and Resend unsubscribes unsubscribe.
- **Membership** (`membership.ts`): LS subscriptions → `membership` (trial/active; past due with 7-day grace; cancelled until `ends_at`). Members sign in by magic link (one-time, 20 min, POST to use) → `ios_member` cookie (host-only, HttpOnly; `member_session` stores the hash). `membership.monthly_drop` makes the month's `member_drop` from the newest approved membership-rung product, or briefs a members pack (B's `briefProduct`) and waits; ready drops are emailed to members. `CommunityGate` is the Discord interface for later.
- **Sites** (`apps/web/app/p/[slug]/**`, `components/site-*.tsx`): link in bio, `/free` (opt-in), `/shop/<product>`, `/thanks/<product>` (upsell = next ladder rung), `/confirm`, `/unsubscribe`, `/members` (+ `/verify`), `/privacy`, styled from `loadPersonaKit` colours. Public endpoints under `/api/public/*` (subscribe, confirm, unsubscribe incl. RFC 8058, checkout, download, members, site portrait/cover). Only lead-magnet files (download token), member drops (session) and the persona's own images are served.
- **Owner**: `/commerce` (settings, stores, product store status with listing packs and checkout URLs, lists, members, posts that sell, orders) and the persona-page panel. Tools: `store.status|sync`, `site.urls`, `email.list_stats|write_welcome|broadcast`, `membership.stats`, `attribution.post_report|ensure_links`. CLI: `pnpm commerce status|urls <slug>`.
<!-- <<< stream G architecture -->

<!-- >>> stream H architecture -->
### Stream H: Product Builder and robustness (`packages/products`)
- **Flow** (`build.ts`, job `product.build`, idempotent per product version): a Monetization Agent brief (the `product-builder` agent, strong tier, `workbook-builder` skill; deterministic fake writer without a key) or an imported manuscript (`manuscript.ts`, parsed as written, never rewritten) → `ProductDoc` (sections of blocks: paragraphs, named rules, worked examples, tick-box checklists, tracker grids, fill-in pages, tables, callouts; bonus pages) → next-step page and credits page (AI character, "General education, not professional advice", the niche's referral) → deterministic pagination per paper size (`layout.ts`: fixed pages, so the TOC and page numbers are known before printing) → HTML in the persona kit (`html.ts`, `loadPersonaKit` colours made print-safe) → PDF A4 and US Letter through headless Chrome (`pdf.ts`: `--dump-dom` measures overflow, `--print-to-pdf` prints; no browser outside fake mode → the job defers, never a fake PDF) → **QC QP** (`qp.ts` over `inspect.ts`, a structural PDF reader: opens, paper size, fonts embedded, file size, page count = layout, no placeholder text, every promised section present and non-empty, credits page, TOC pages and working internal links, page-number sequence, no overflow, links (syntax in fake mode; HEAD/GET live, own persona sites by syntax), doubled words) with ≤ 2 fix loops (overflow → looser layout; content defects of a brief → rewrite with the QP feedback; a manuscript blocks with the report) → Compliance Gate on the product text (red blocks) → files in storage (`products/<personaId>/<productId>/v<N>/<slug>-a4|letter.pdf`, cover SVG under `public/<slug>/products/…`, Sheets/Notion templates when the format or front matter asks) → `product_version` (files: `ProductFile[]`, `file_url` = A4) → v1: `buildListingPack`, product `awaiting_approval` and a `product_v1` card (24 h auto-approve by studio policy). Later versions with the same sections are approved without a card (FR-9.3); changed sections notify the Owner. Blocked builds write `qc_report` (QP) + `qc_defect` rows and notify the Owner with a link to `/products#<id>`.
- **Content import:** markdown in `IOS_MANUSCRIPTS_DIR` (default `<repo>/.data/manuscripts/<persona-slug>/*.md`); the `product.inbox` schedule enqueues `product.scan_inbox` only when unseen content is waiting; each file is imported once per content hash (`product_manuscript`), an edited file with the same slug rebuilds an unapproved v1 or becomes the next version. `pnpm products render <file.md>` renders and QP-checks a manuscript with no database (safe while the server runs).
- **Backends** (`backends.ts`, not in `Providers`): PDF renderer, link checker, `SheetsTemplateProvider` / `NotionTemplateProvider` (fakes store a CSV/markdown export and return `.invalid` links; the Google Sheets and Notion adapters switch on once `google.sheets_token`, `notion.api_key` and `notion.template_parent_id` exist as secrets).
- **Schedules / jobs / tools:** `product.sweep` (5 min: briefed products without a version → `product.build` once per version), `product.inbox` (2 min); tools `product.build`, `product.status`, `product.import_manuscript`, `workbook.outline`. Migration `0012_h_products.sql`: `product_version.files/source/page_count/qc_report_id/content_hash/outline`, `product_brief.source`, `product_build`, `product_manuscript`, `product_template`.
- **Dashboard:** `/products` (status, QP, files, rebuild, manuscript instructions), `ProductsPersonaPanel`, `POST /api/products/<id>/build`, Owner-only file downloads at `/api/products/files/<key>`. CLI: `pnpm products render|sample|import|inbox|build|status`.
- **PGlite single-process lock** (`packages/db/src/lock.ts`): `createPglite(dir)` (so `openDb`, `getDb`, every CLI and the worker) takes `<dataDir>.lock` atomically with the holder's pid, role and origin; another live process gets `DbLockedError` with a clear message (the dev server's URL; `pnpm owner login-link` points at its `/login`); stale locks from dead processes are taken over; `db:reset` refuses to wipe a held dir.
- **Studio header:** `studioTotals` returns `live` (TESTING and later, `PUBLISHING_STATES`) and `setup` (PROPOSED/SETUP) next to `active`. **Login link:** `IOS_PUBLIC_URL`, else `PORT`, else 3100.
<!-- <<< stream H architecture -->

## Persona Generator and archive (Owner decision, 16 Oct; PRD §3.12)
```
packages/generator   Draft model, 7-step generator, scorecard + distinctness, launch, archive restore, generator.* tools.
```
- **Archive.** The 14 Oct launch five (rosa, margot, dot, sal/Walt, ambrose) moved to `packages/knowledge/seed/archive/2026-10-16/` with everything (four documents per persona, `products/` manuscripts from the Owner's copy in `Ventures/Influencer-OS/_archive/personas-2026-10-16`, `manifest.json`, `archive.json`). `core/src/seed/archive.ts` reads archives by date label (`IOS_ARCHIVE_DIR` overrides the root). The default seed is now an **empty studio** (`seed()` → `kind: 'empty'`: studio, QC standard, threads, a Studio Manager note pointing to /generator and /archive); `seed({ personas })` and `--samples` still work.
- **Restore.** `restoreFromArchive` (`pnpm knowledge personas restore <slug|all> [--from <date|dir>]`, the Archive page's Restore) imports the documents exactly through the existing importer as **PROPOSED** with an **Owner-only launch card** (`payload.owner_only`, explicit, no timer; the DB check `approval_owner_only_kinds` refuses any non-Owner decider or auto-approval) and opens a draft at step 7 (review) linked to the persona. Approving the launch there moves it to SETUP.
- **Soft archive.** New persona state `ARCHIVED` (+ `archived_at`, `archived_from_state`, `archive_reason`; migration 0014). `core/src/archive.ts`: a never-launched persona (PROPOSED/SETUP, never live) can be archived by the Owner or the Studio Manager; a launched one needs the Owner (typed name on the dashboard) or an approved Owner-only `persona_archive` card (agents propose it via `generator.propose_archive`). Archiving withdraws pending cards (posts back to draft) and keeps every row; ARCHIVED is outside every working state, and the active-persona filters (`NOT IN ('KILLED','RETIRED','ARCHIVED')`) skip it. Restore (Owner only) returns it to the state it left; one archived before launch gets a fresh Owner-only launch card and its review draft back. Killing keeps its own explicit approval.
- **Generator.** `persona_draft` (state jsonb with seven steps, `version`, `scores`, `persona_id`, `archive_ref`), `persona_draft_version` (a snapshot per change) and `persona_draft_message` (the draft's chat). Steps: opportunity (ranked niches with evidence and scores, or the Owner's idea first), concept (3 options with premise, contrast, mechanic, 5 hooks, first product and the win scorecard), character (fields with alternatives), look (anchors, wardrobe, palette, settings; Higgsfield character sheets + Apple Vision drift/face check when live, placeholder portraits otherwise), voice (3 previews through `providers.voice`), content and money (pillars, series, hook bank, ladder, first product brief), review (scorecard, distinctness vs studio + archive, risks, readiness). Each step is a Studio Manager run (structured output, merged over the library draft) with the deterministic library (`library.ts`, `fake.ts`) as the fake and the fallback. Picking an option drafts the next step; earlier changes mark later steps stale. Scorecard (captivation 30, demand 20, ladder 15, gap 10, producibility 15, line safety 10) and distinctness (lexical signature: name, niche, identity/lore/look/voice tokens) are computed in code (`score.ts`).
- **Chat.** `/api/generator/<draft>/chat?step=N` (same contract as the chat API; the dashboard's ChatPanel drives it). Generator chat runs are untrusted (drafts hold outside evidence), so `generator.revise_step|pick_option|regenerate_step|mix_concepts` (mutating, with `ownerIntent`) run only when the Owner's message asks; questions and background runs are refused by the registry. Without a key the Studio Manager maps instructions itself ("combine A's look with B's mechanic", "make her older and drier", "call him …", "pick B", "regenerate", "$19") through the same gated tool.
- **Launch.** `launchDraft` refuses any actor but the Owner; `generator.launch` is `ownerOnly`. The draft becomes a LaunchPersona (all 16 Appendix A sections + a palette table, the first fortnight as 20 slots in the 10-a-week mix, the product ladder as ideas, handles as pending accounts, the niche's Field Brain seed) through `importLaunchPersona`, then the Owner's decision on its launch card moves it to SETUP and `knowledge.build` is queued.
- **Dashboard.** `/generator` (start from evidence or an idea; drafts in progress), `/generator/[draftId]` (stepper, step panels with pick/edit/mix/swap/regenerate, chat, version history, Approve launch with a confirmation tick), `/archive` (archived documents with Restore, archived personas, archived drafts), persona page archive banner/panel, studio wall empty state, Approvals routes Owner-only launch cards to the generator review.

## IOS-5 (growth radar, world, production playbook, formats + stories)
Built against `docs/IOS-5-CONTRACTS.md` (four parallel streams I–L).
```
packages/radar        Apify scrapers, tracked accounts + weekly snapshots, outlier scoring, trend clustering, Viral Remix (stream I).
packages/world        World Bible, real-time grounding (Open-Meteo), storyline, continuity ledger, no-repeat engine, Pinterest (stream J).
packages/production   Prompt compiler, character sheet, BOPA look pack, location lock, camera styles, niche filter, hook templates (stream K).
packages/formats      Per-persona Format Plans and the Stories engine (stream L).
```
- **Cross-stream services** live on `StudioServices` (`packages/agents/src/ios5.ts`): `radar` (I), `world` (J), `prompts` (K) and `formatPlans` (L). Each has a null / basic default in `defaults.ts` and is composed by `@ios/wiring` from the stream's `create*` factory, which gets the finished services lazily.
- **Formats.** `PostFormat` adds `photo_dump`, `text_note`, `facecam_screen`, `reply_comment`, `news_greenscreen` and `meme` as optional formats (migration `0016_ios5_formats.sql`), each with a script shape (`FORMAT_SHAPE`). A `FormatMix` always has the five core formats; optional formats are on when their count is > 0.
- **Hooks already in place:** the calendar asks `world.beatsForWeek` (beats in `calendar_slot.meta.story`); Q1 runs `world.checkContent` with the slot's concept fingerprint; an approved script and a sent community reply go to `world.recordApproved`; Persona Generator step 1 merges `radar.opportunityEvidence`, step 6 drafts `formatPlans.recommend` and `world.draftWorld` into the draft (`setDraftExtension` edits them), and the Owner's launch adopts both.
- **Providers.** New `weather` (Open-Meteo) and `pinterest` (API v5) members (J owns the live adapters); `research.runActor` takes `maxItems` and returns `costUsd` (I owns the live Apify adapter; `FakeApify.fixture()` serves test fixtures); `publish` gains optional `storyCapabilities` / `fetchStoryMetrics` and `kind: 'story'` (L).

<!-- >>> stream I architecture -->
### Growth Radar, Winner Finder and Viral Remix (IOS-5 stream I, `packages/radar`)

PRD §3.15 items 1 and 9–12. Public data only, through Apify actors at low volume; no proxies, no ban evasion.

- **Apify adapter** (`apify.ts`): `ApifyResearch` is the live `research` member (REST v2: start the run with `maxItems`, long-poll, read the dataset, report `usageTotalUsd`; the token goes in the Authorization header only). It switches on with `apify.token` (env `APIFY_TOKEN` or the Keychain). Normalisers turn Instagram profile / reel / hashtag / search and TikTok profile / hashtag items into `ScrapedProfile` / `ScrapedPost`. Fake mode: `fixtures.ts` registers deterministic `demo_*` datasets on `FakeApify` (test fixtures win).
- **Config** (`radar_config`): actor ids and pay-per-result prices per scraper kind, per-run limits, per-niche seeds. Every run goes through `runScrape` → `meteredApify` (governor, ledger provider `apify`, the studio's `apify_weekly_cap_usd` over the trailing 7 days), estimate = `maxItems × price`, logged in `radar_run`.
- **Discovery** (`discovery.ts`): niches from active personas, recent generator drafts and Owner seeds; hashtag + keyword search scrapers, related-profile expansion from seed accounts, and the accounts behind outliers in the hashtag sample → `tracked_account` (capped per niche and platform).
- **Track and score** (`snapshot.ts`, `store.ts`, `scoring.ts`): a weekly `profile_snapshot` per account plus its recent posts (`radar_post`). Per post: outlier = views ÷ the median of the creator's last 20 other posts (likes for stills and carousels), ≥ 5× outlier, ≥ 10× strong; views ÷ followers; (saves + shares) ÷ views; recency ≤ 14 d. Per account: velocity (Δ followers/week), acceleration, breakout signals, growth score, `accelerating`; a first pass (reel views ÷ followers, age, post count) until two snapshots exist.
- **Review** (`review.ts`): high-growth accounts' top posts → the `trend-scout` agent with every caption, transcript and bio inside `fenceUntrusted`, `trust: { untrusted: true }`, no tools → hook type, PostFormat, structure, length, camera, CTA, topic, replicability, monetisation (structured; heuristics in fake mode and as the fallback). Cadence comes from post dates.
- **Insights** (`insights.ts`, `cluster.ts`): trends = a hook / format / topic / sound adopted by ≥ 2 accelerating accounts in 14 days, scored adoption velocity × average outlier (`radar_trend`); format and cadence benchmarks (`RadarService.formatBenchmarks`, read by stream L's Format Plan); monetisation patterns (`monetisationPatterns`, and `demand_signal` rows with source `radar` via `addSignal`); opportunity evidence for Generator step 1.
- **Winner Finder and Viral Remix** (`winners.ts`, `remix.ts`): a per-persona shortlist ranked by the composite winner score (outlier, views ÷ followers, depth, recency, replicability, monetisation fit, novelty); internal winners (≥ 2× the persona's median on views and saves + shares). A winner becomes a `remix_brief` (same mechanic, our persona, world and voice; structure only) checked with `world.checkConcept`, then an `idea` (status `new`, `source.type` `remix` / `double_down`). Avatar-heavy mechanics validate first as `activity_text`; optional formats fall back to their core shape unless the persona's Format Plan has them on.
- **Flow** (`jobs.ts`): schedule `radar.weekly` (once per ISO week, only for studios with something to scan) → `radar.scan` per niche → `radar.finish` → `remix.weekly` per active persona → `radar.report` (the Trend Report in the Studio chat from `agent:trend-scout`, `meta.kind 'trend_report'`, marked untrusted, plus a `/radar` notification). Over the weekly cap a scan defers until spend rolls out of the 7-day window; the cap itself is Owner-only (`/radar`, `POST /api/radar/cap`).
- **Tools**: `radar.report`, `radar.benchmarks`, `radar.patterns`, `radar.scan`, `radar.seed`, `winners.shortlist`, `winners.internal`, `remix.brief`, `remix.list`. Reads that carry scraped labels set `untrustedOutput`; every write has an `ownerIntent`.
- **Dashboard**: `/radar` (benchmarks by format, trends, remix briefs, growing accounts, outliers, Apify spend and the cap), `RadarGeneratorPanel` on Generator step 1, `GET /api/radar/overview`, `POST /api/radar/scan`. CLI: `pnpm radar demo | status | report | scan [--now] | shortlist <slug> | seed <niche>`.
<!-- <<< stream I architecture -->

<!-- >>> stream J architecture -->
<!-- <<< stream J architecture -->

<!-- >>> stream K architecture -->
<!-- <<< stream K architecture -->

<!-- >>> stream L architecture -->
<!-- <<< stream L architecture -->
