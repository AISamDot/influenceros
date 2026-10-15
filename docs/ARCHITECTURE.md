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
- **Launch personas**: the Persona Architect's documents live in `packages/knowledge/seed/personas/<slug>/` (+ `manifest.json` for niche, timezone, hue). `pnpm db:seed` parses them (`core/src/seed/launch.ts`) and seeds a studio with those personas in SETUP (launch card proposed by the Studio Manager, executed by the timer), all 16 bible sections, the launch fortnight as planned slots with ideas, the product ladder as `idea` products, pending accounts with the chosen handles, and each niche's Field Brain seed (unverified nodes, canon, feeds, experts). No invented metrics, orders or spend. Without the folders (or with `--samples`) it seeds the IOS-1 sample studio. `personas.import` (every 6 h, `IOS_PERSONAS_SOURCE`) adds new folders and turns edited documents into bible vN+1.
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
<!-- <<< stream E architecture -->

<!-- >>> stream F architecture -->
<!-- <<< stream F architecture -->

<!-- >>> stream G architecture -->
<!-- <<< stream G architecture -->

<!-- >>> stream H architecture -->
<!-- <<< stream H architecture -->
