# IOS-2 build contracts

Four builders work in parallel on IOS-2. This file is what they share: who owns which files, which migration filenames are reserved, the interfaces each stream exports or consumes, how shared files are edited, and the tests that must stay green. If you follow it, the four branches merge into `dev` without conflicts.

- **Product spec:** `/Users/hossamhamdy/Desktop/Family/Hossam/Ventures/Influencer-OS/PRD.md` (§3.1–3.11, §4, FR-4, FR-20, FR-21, FR-23, FR-24, §8.4–8.6).
- **Base:** branch from the `dev` commit that added this file (`git log -1 --format=%h -- docs/IOS-2-CONTRACTS.md`).
- **Contract stubs in that commit:** `packages/agents/src/contracts.ts`, the new provider interfaces and fakes, and empty packages `agents`, `auth`, `content`, `knowledge`, `profit`, `wiring` plus `apps/worker`. All are wired into the web app, scripts and Vitest already. `pnpm test` and `pnpm build` pass on it.

## 1. Owner rules every stream builds to

- **What wins:** reach plus sales.
- **The Gate enforces legal/platform lines only.** It blocks:
  - fabricated results used to sell;
  - fake credentials;
  - disease-cure or dangerous medical claims;
  - specific securities or crypto calls;
  - guaranteed returns or income;
  - undisclosed sponsorships.

  Opinions and general education pass.
- **AI disclosure is the platform minimum:** the post-level AI flag plus the platform's AI profile label. Agents never deny being AI when sincerely asked. There's no bio line and no watermark.
- **English only.**
- **No Telegram.** Everything happens in the dashboard (chats, approval cards, notifications).
- **Persona creative decisions are fully delegated to the Studio Manager.** It notifies the Owner; no approval is needed. **Killing or retiring a persona always needs the Owner's explicit approval** (approval engine, no timer).
- **Cadence:** 10 posts per persona per week.
  - Formats: 3 talking, 3 activity + text, 2 voiceover, 1 static, 1 carousel.
  - Purposes: about 6 reach, 2–3 trust, 1–2 sell.
  - Every post has a CTA, usually a comment keyword.
  - Winners scale to 2–3 a day.
- **Fully automated:** no manual steps anywhere in the pipeline.
- **The Profit Engine lives inside the Studio Manager** (PRD §3.11, FR-24).
- **Agents:**
  - They run on the Claude Agent SDK with an Anthropic API key, and on a fake LLM when there's no key.
  - Model tiers: fast = `claude-haiku-5-5`, standard = `claude-sonnet-5-5`, strong = `claude-opus-5-5`.
  - Prompt caching is on.
  - Per-persona caps go through the existing governor.
- **Everything runs end to end on fakes.** Tests never reach a live provider: `vitest.config.ts` sets `IOS_FAKE_PROVIDERS=1` and `IOS_KEYCHAIN=off`.

## 2. Streams, branches and the tests to keep green

| Stream | Branch | Scope |
|---|---|---|
| **A** Agent runtime + chat + login | `ios2-a-runtime` | (1) Agent runtime: Claude Agent SDK, model routing, prompt caching, governor debit per run, `agent_run` logging, tool permissions in code, fake LLM with no key. (2) Studio Manager (studio queries, kill proposals through the approval engine, delegation, @mention routing) and Persona Manager (chat; feedback loop: classify → before/after → apply as bible vN+1 or a playbook rule → audit). (3) Streaming real-agent chat in the dashboard; the fake path stays for no-key mode. (4) Owner login: magic link via Resend (or a passkey), a CLI-set hashed password as fallback, an Owner-only session cookie; every route is protected except webhooks and the secret-protected cron. (5) IOS-1 recheck gaps: the JSON approve path requires the typed name and the payload hash for kills; the queue lease is tied to a per-claim token; posts stuck in `publishing` when verify throws get a recovery path. |
| **B** Content | `ios2-b-content` | (1) Weekly calendar per persona: 10 slots with the format and purpose mix, a CTA keyword and posting windows, scaling to 2–3 a day for winners. (2) Scriptwriter with hook-lab: 10 hooks per idea, scored; ship 1 plus 2 A/B variants. Scripts of 15–30 s (40–90 words) written for the ear, plus captions, on-screen text and carousel copy. (3) Monetization Agent v1: demand signals, Product Opportunity Score, briefs, listing packs (Lemon Squeezy fields plus an Etsy variant), launch plan, no fake scarcity. (4) Compliance Gate v1: green/amber/red, the AI-flag requirement, the never-deny-AI rule for replies. (5) QC Q1 (script) and Q2 (voice re-transcribe diff via `TranscribeProvider`). (6) Pipeline idea → script → Q1 → Gate → queued for media, shown on the Pipeline board. |
| **C** Knowledge | `ios2-c-knowledge` | (1) Knowledge Builder: a Field Brain per niche (curriculum nodes with cited synthesis, source canon, expert map) via `WebResearchProvider`. Local embeddings, pgvector retrieval and a retrieval tool. (2) News Desk: daily scan (RSS, Google News RSS, subreddit and YouTube RSS, real fetch with an allowlist), dedupe, score, a morning briefing per persona, a fast-reaction idea queue. (3) The studio's own skills in `.claude/skills`. (4) Import the 5 launch personas as the seed, replacing the samples. |
| **D** Profit + worker + cron | `ios2-d-profit` | (1) Profit Engine v1: P&L views; automatic levers within bounds; a lever log with expected and measured impact; kill-candidate proposals; the Profit card; the Weekly Profit Report in the Studio chat; a "make more profit" tool. (2) A 90-day Monte Carlo forecast (P10/median/P90). (3) `apps/worker` on the Mac plus cron tick wiring (Vercel Cron → `/api/cron/tick` with a secret; the local tick too). (4) Money page: P&L, credits, lever log. |

**Every builder keeps these green, in the foreground, before every handoff:**

```
source ~/.nvm/nvm.sh; nvm use --delete-prefix 22.23.3 --silent
pnpm test        # Vitest across all packages and apps (includes packages/wiring/test, the merge guard)
pnpm build       # pnpm -r typecheck + next build
```

While working, `pnpm vitest run packages/<yours>` is the quick loop. Never leave a test run going in the background. Never push. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit secrets.

**Merge order (integrator):** A → C → B → D. Any order works because the streams share only the contracts, but this order lights up features soonest. After each merge, the integrator runs `pnpm install`, `pnpm test` and `pnpm build`.

## 3. How the packages fit together

```
@ios/db ← @ios/core ← @ios/agents (contracts + runtime) ← @ios/content / @ios/knowledge / @ios/profit
                                     ↑                                   ↑
                         @ios/providers (interfaces + fakes)      @ios/wiring (composition root)
                                                                        ↑
                                                       apps/web, apps/worker, cron tick
```

- **B, C and D depend only on `@ios/agents`, `@ios/core`, `@ios/db` and `@ios/providers`.** They never import each other. Cross-stream calls go through the service interfaces in §5.4, the tool registry (§5.2) or the database (§5.7).
- **Every package's `src/index.ts` exports a `StudioModule`:**

  ```ts
  export const tools: ReadonlyArray<ToolDef<any, any>>;     // registered for agents
  export const jobs: JobHandlerMap;                          // queue handlers, by job kind
  export const schedules: readonly ScheduledTask[];          // run by the scheduler on each tick
  export function liveProviders(env: ProviderEnv): Partial<Providers>;  // live adapters you own
  ```

  plus its factories:
  - `@ios/knowledge` → `createKnowledgeService(base)`;
  - `@ios/profit` → `createCadencePolicy(base)` and `createRoutingPolicy(base)`.

  Stubs of all of these exist; replace their bodies, keep the names and signatures.
- **`@ios/wiring` composes all four.** It has `allTools()`, `allJobs()`, `allSchedules()`, `resolveProviders()` and `createStudioServices(db)`, and it throws on a duplicate tool, job kind, schedule or provider member.
  - Nobody edits wiring during IOS-2. Plugging in happens through your own exports.
  - `packages/wiring/test/wiring.test.ts` is the merge guard.
- **Tests** build services with `createTestStudio()` / `makeTestPersona()` from `@ios/agents/testing`: a fresh PGlite, one studio, fake providers and the fake runtime.
  - Never import another package's `test/` folder.
  - Never depend on the seed's personas. Only stream C tests the seed.

## 4. Ownership

You may create and edit only what your stream owns. Anything not listed is frozen for IOS-2: ask the integrator.

### Stream A: `ios2-a-runtime`
- `packages/agents/**`, except `src/contracts.ts`: frozen; additive edits only inside A's marked blocks (§6).
  - `src/testing.ts` and `src/defaults.ts`: A may extend them, but must keep their current exports and signatures (B, C and D use them).
- `packages/auth/**`.
- `packages/core/src/` files:
  - `approvals.ts`, `policy.ts`, `queue.ts`, `publish.ts`, `metered.ts`, `chat.ts`, `killswitch.ts`, `settings.ts`, `index.ts`;
  - any new `packages/core/src/*.ts` A needs;
  - the matching `packages/core/test/*.test.ts` (except `seed.test.ts`).
- `packages/secrets/**`: e.g. `liveAdapter: true` for `anthropic` and `resend`.
- `apps/web/` files:
  - `proxy.ts`, `next.config.ts` (except other streams' blocks);
  - `app/layout.tsx`, `app/page.tsx` (except the `<ProfitCard>` line);
  - `app/login/**`, `app/api/auth/**`, `app/api/chat/**`, `app/api/approvals/**`, `app/api/kill-switches/**`, `app/api/notifications/**`, `app/api/health/**`;
  - `app/chat/**`, `app/approvals/**`, `app/notifications/**`, `app/personas/**`, `app/settings/**`, `app/niches/**`, `app/error.tsx`, `app/not-found.tsx`;
  - `components/*` that already exist (except `profit-card.tsx`), plus new `components/chat-*.tsx`, `components/auth-*.tsx` and `components/approval-*.tsx`;
  - `components/nav.tsx` (except other streams' blocks);
  - `lib/**`.
- Migrations: `0004_a_*.sql`.
- Namespaces:
  - tools: `studio.*`, `persona.*`, `approvals.*`, `chat.*`, `feedback.*`, `bible.*`, `playbook.*`;
  - jobs: `agent.*`, `chat.*`;
  - schedules: `studio.*`, `persona.*`.
- Agents: `studio-manager`, `persona-manager`.
- Live providers: `llm`, `email` (Resend, for magic links).

### Stream B: `ios2-b-content`
- `packages/content/**`.
- `apps/web/` files:
  - `app/pipeline/**` (replace the stub), `app/api/pipeline/**`, `app/api/content/**`;
  - new `components/pipeline-*.tsx` and `components/content-*.tsx`.
- Migrations: `0005_b_*.sql`.
- Namespaces:
  - tools: `calendar.*`, `content.*`, `script.*`, `hooks.*`, `monetization.*`, `gate.*`, `qc.*`, `pipeline.*`;
  - jobs: the same namespaces, and B enqueues `media.render` (IOS-3 registers its handler);
  - schedules: `calendar.*`, `monetization.*`, `pipeline.*`.
- Agents: `calendar-planner`, `scriptwriter`, `monetization-agent`, `compliance-gate`, `quality-control`.
- Live providers: `transcribe` (optional in IOS-2: the fake is enough).

### Stream C: `ios2-c-knowledge`
- `packages/knowledge/**`, including persona seed data under `packages/knowledge/seed/personas/<slug>/`.
- `.claude/skills/<name>/**`: the ten skills in `SKILL_NAMES`.
  - No other `.claude/` files: no `settings.json`, no `CLAUDE.md`. They would also steer the builders' own sessions in this repo.
- `packages/core/src/seed/**`, `packages/core/src/art.ts` and `packages/core/test/seed.test.ts` (the seed replacement).
- `apps/web/` files: `app/knowledge/**`, `app/api/knowledge/**`, `app/api/news/**`, and new `components/knowledge-*.tsx` and `components/news-*.tsx`.
- Migrations: `0006_c_*.sql`.
- Namespaces:
  - tools: `knowledge.*`, `news.*`;
  - jobs: `knowledge.*`, `news.*`, `personas.*` (import);
  - schedules: `knowledge.*`, `news.*`.
- Agents: `knowledge-builder`, `news-desk`.
- Live providers: `embeddings`, `webResearch`, `feeds`.

### Stream D: `ios2-d-profit`
- `packages/profit/**`, `apps/worker/**`.
- `packages/core/src/tick.ts`.
- `apps/web/` files:
  - `app/money/**` (replace the stub), `app/api/cron/**`, `app/api/profit/**`;
  - `components/profit-card.tsx` (the Studio wall already renders it), and new `components/profit-*.tsx` and `components/money-*.tsx`;
  - `instrumentation.ts`, `vercel.json`.
- Migrations: `0007_d_*.sql`.
- Namespaces:
  - tools: `profit.*`, `budget.*`, `forecast.*`;
  - jobs: `profit.*`;
  - schedules: `profit.*`, `scheduler.*`.
- Agents: `profit-engine`.
- Policies: `createCadencePolicy`, `createRoutingPolicy`.

### Frozen (nobody edits during IOS-2)
- `packages/db/**`, except adding your own migration files.
- `packages/providers/**`, except additive optional fields agreed with the integrator (§8).
- `packages/core/src/types.ts`, `errors.ts`, `audit.ts`, `governor.ts`, `lifecycle.ts`, `notifications.ts`, `queries.ts`.
- `packages/wiring/**`.
- `tsconfig.base.json`, `vitest.config.ts`.
- Root `package.json`: the scripts `worker`, `owner`, `content`, `knowledge` and `profit` already point at stub entry points you own (`apps/worker/src/main.ts`, `packages/auth/src/cli.ts`, `packages/content/src/cli.ts`, `packages/knowledge/src/cli.ts`, `packages/profit/src/cli.ts`). Give them subcommands; don't add scripts.
- `docs/BUILD_PLAN.md` and this file (integrator only).

## 5. Shared interfaces and types

| Contract | Package / file | Implemented by | Consumed by |
|---|---|---|---|
| `AgentRuntime`, `AgentTask`, `AgentResult` | `@ios/agents` `contracts.ts` | A (fake runtime already works) | A, B, C, D |
| `ToolDef`, `ToolRegistry`, `ToolPermissionError` | `@ios/agents` `contracts.ts`, `registry.ts` | A | all (each registers its own tools) |
| `StudioServices`, `createServices`, `ServiceBase` | `@ios/agents` | A | all |
| `KnowledgeService`, `KnowledgeHit`, `Briefing` | `@ios/agents` `contracts.ts` | C (`createKnowledgeService`) | B, A |
| `CadencePolicy`, `CadenceTarget`, `DEFAULT_CADENCE`, `CADENCE_BOUNDS` | `@ios/agents` `contracts.ts` | D (`createCadencePolicy`) | B |
| `RoutingPolicy`, `DEFAULT_ROUTING`, `MODEL_IDS` | `@ios/agents` `contracts.ts` | D (`createRoutingPolicy`) | A |
| `JobContext`, `StudioJobHandler`, `ScheduledTask`, `StudioModule`, `ProviderEnv` | `@ios/agents` `contracts.ts` | all export them; D runs them | D (worker, tick) |
| `PipelineStage`, `GateCheck`, `QcCheck`, `MEDIA_RENDER_JOB`, `MediaRenderPayload` | `@ios/agents` `contracts.ts` | B | D, dashboard, IOS-3 |
| `LlmProvider` (+ `LlmCacheBlock`), `LLM_PRICES`, `llmCostUsd` | `@ios/providers` | A (live) | A |
| `TranscribeProvider` (Whisper) | `@ios/providers` | B (live optional) | B (QC Q2) |
| `EmbeddingProvider`, `EMBEDDING_DIM = 384` | `@ios/providers` | C | C |
| `WebResearchProvider`, `FeedProvider` | `@ios/providers` | C | C |
| `CostRef`, `MeterContext.ref` | `@ios/core` | A owns `metered.ts` | all (writes), D (reads) |
| Profit read models (`PnlRow`, `LeverAction`, `Forecast`, `ProfitAction`, `ProfitCardData`) | `@ios/profit` `types.ts` | D | D pages, Studio Manager via `profit.*` tools |

### 5.1 Agent runtime (`@ios/agents`)

```ts
interface AgentRuntime {
  readonly mode: 'live' | 'fake';
  run<T = string>(task: AgentTask<T>): Promise<AgentResult<T>>;
}
interface AgentTask<T> {
  agent: AgentName; scope: { studioId: string; personaId: string | null };
  label: string;                     // agent_run.summary
  tier?: ModelTier;                  // else RoutingPolicy, else DEFAULT_ROUTING
  system: string; cached?: LlmCacheBlock[]; skills?: SkillName[]; prompt: string;
  tools?: string[];                  // registry names the model may call
  maxTokens?: number;
  parse?: (value: unknown) => T;     // structured output validator (throw to reject)
  jsonSchema?: object;
  fake: () => T;                     // REQUIRED: deterministic output for no-key mode and tests
  costRef?: CostRef;                 // P&L attribution
}
interface AgentResult<T> { output: T; text: string; mode; model; runId; costUsd; toolCalls }
```

- **Every model call goes through `services.runtime.run()`.** Nobody calls `providers.llm` directly.
- **One run does all of this:** routing → governor reserve → model (with the cached blocks first and tools) → settle → one `agent_run` row. It throws `BudgetExceededError` past a cap and logs the run as `refused`.
- **Fake mode is what tests and no-key installs use.** It returns `task.fake()` through the same metering and logging path. The stub in the base commit already does this; A keeps that behaviour and adds the live path.
- **What A owns in the live path:**
  - Model ids come from `MODEL_IDS` (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`).
  - Prompt caching: cached blocks go first as system blocks, with `cache_control` on the last; no timestamps or ids inside them. Check `cache_read_input_tokens`.
  - On these models: structured outputs through `output_config.format` (forced `tool_choice` returns a 400; no assistant prefill); handle `stop_reason: 'refusal'`.
  - Agent SDK runs use `settingSources: ['project']` with `cwd` at the repo root (so `.claude/skills` resolves), `disableSkillShellExecution: true`, and `tools` / `disallowedTools` as the hard limits: no Bash, Write or Edit for studio agents. Only registry tools are exposed. Verify option names against the Agent SDK docs before use.
  - For simple one-shot structured calls, the Messages API (`@anthropic-ai/sdk`) is fine behind the same `run()`.
  - `mode: 'auto'` goes live only when `ProviderEnv.isLive('anthropic')`.
- **Chat streaming** stays A-internal. The HTTP contract of `POST /api/chat/:threadId/messages` is unchanged: a `text/plain` stream of the reply, an `x-message-id` header, and the reply persisted in `chat_message`.

### 5.2 Tool registry and permissions

```ts
interface ToolDef<I, O> {
  name: string;                        // '<namespace>.<verb>' (your namespaces only, §4)
  description: string;
  scope: 'persona' | 'studio';
  ownerOnly?: boolean; callers?: Caller[]; mutates?: boolean;
  inputSchema: object;                 // JSON Schema, type object, additionalProperties false, snake_case keys
  parse(raw: unknown): I;              // throw on bad input
  run(ctx: ToolContext, input: I): Promise<O>;
}
```

The registry enforces permissions in code:
- unknown tools are refused;
- `ownerOnly` tools are refused for every agent and for the system;
- `callers` is an allowlist;
- `persona` scope requires `persona_id`. A Persona Manager (its `ctx.personaId` is set) may only pass its own id, and the persona must be in the caller's studio;
- successful `mutates` calls are audited.

**Owner-only actions are never agent tools that act.** Agents can only propose them through the approval engine:
- killing or retiring a persona;
- spending above caps, plan upgrades;
- raising autonomy or caps (agents may lower them);
- disclosure or legal text;
- creating accounts.

Tool outputs are plain JSON-serialisable data.

### 5.3 Providers (`@ios/providers`)

| Member | Interface | Live adapter owner | Fake |
|---|---|---|---|
| `llm` | `complete(req: LlmRequest)`; `LlmRequest.cached` (cache blocks) and `json` are new | A | `FakeLlm` |
| `transcribe` | `transcribe({ audioUrl, language?, prompt? }) → { text, words[{word,startS,endS}], durationS, costUsd }` | B (optional) | `FakeTranscriber`: returns exactly what `FakeVoice.tts` synthesised for that URL; `createFakeProviders({ mishear })` simulates errors |
| `embeddings` | `embed(texts) → number[][]`, `dimensions = EMBEDDING_DIM (384)`, unit vectors | C (local model, e.g. transformers.js `bge-small-en-v1.5`; Voyage optional) | `FakeEmbeddings`: hashed bag of words |
| `webResearch` | `mapField({ niche, maxSources?, maxNodes? }) → FieldMap`; `researchTopic({ niche, path, title, questions?, maxSources? }) → TopicResearch` (synthesis, facts with citations, frameworks, questions, sources, `costUsd`) | C (Claude `web_search_20260209` / `web_fetch_20260209` server tools) | `FakeWebResearch` |
| `feeds` | `fetchFeed({ url, limit? }) → FeedItem[]`; the live adapter refuses hosts outside its allowlist | C | `FakeFeeds` |

Rules:
- **Live adapters live in your own package** and are returned from your `liveProviders(env)`. `@ios/wiring` overlays them on the fakes, and two packages supplying the same member is an error.
- **Read keys through `env.secret(name)`.** Never log them, store them or put them in prompts.
- **Every paid call is metered.** The LLM is metered by the runtime. Other paid methods return `costUsd`, and the caller wraps them in core `metered(db, ctx, spec, call, actual)`:
  - `llm_usd` for Anthropic-backed research;
  - `media_usd` for transcription.

  Pass `ctx.ref` in both cases.
- **`LLM_PRICES` now holds the current list prices** (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per million tokens, plus cache read and write rates).

### 5.4 Cross-stream services (`StudioServices`)

```ts
interface StudioServices { db; providers; now; runtime; tools; knowledge; cadence; routing }

interface KnowledgeService {                                   // C implements; default returns nothing
  retrieve(q: { studioId; niche; query; k?; kinds?: ('node'|'news')[] }): Promise<KnowledgeHit[]>;
  latestBriefing(personaId): Promise<Briefing | null>;
}
interface CadencePolicy { target(personaId, weekStart): Promise<CadenceTarget> }   // D implements; B reads
interface RoutingPolicy { tierFor({ studioId, personaId, agent }): Promise<ModelTier | null> }  // D implements; A reads
```

- **Claim evidence (B):** every factual claim in a script must cite a `KnowledgeHit.id` (store the ids with the script, e.g. in a `script.evidence` column added by B's migration, and in `MediaRenderPayload.evidence`). Q1 flags uncited factual claims. With the default (empty) knowledge, B degrades to "opinion / general education only" and still passes its tests.
- **Cadence:** `CadenceTarget` has `postsPerWeek` plus a `formatMix` and a `purposeMix`, each summing to `postsPerWeek`.
  - The default is `DEFAULT_CADENCE` (10: 3/3/2/1/1; 6 reach, 3 trust, 1 sell).
  - D's levers stay within `CADENCE_BOUNDS` (7–21 a week).
  - B's calendar takes the target as given and books the sell slots in Monetization Agent order.

### 5.5 Jobs and schedules

```ts
type StudioJobHandler = (ctx: { services; job: JobRow; heartbeat(): Promise<boolean> }) => Promise<unknown>;
interface ScheduledTask { name; due(now, lastRunAt | null): boolean; run(services, now): Promise<unknown> }
```

- **Job kinds are `<namespace>.<verb>`** within your namespaces. Enqueue with core `enqueue()`, always with `personaId` for persona work (per-persona isolation).
- **Handlers are idempotent.** They throw `DeferJob` to postpone without spending an attempt, and they pass `ctx.job` through untouched: A is adding a per-claim lease token to it.
- **The worker claims only kinds that have a handler**, so `media.render` jobs wait for IOS-3.
- **D's scheduler** records each schedule's last successful run in a D table and runs `allSchedules()` on every tick.
  - Ticks come from Vercel Cron → `/api/cron/tick` with `Authorization: Bearer $CRON_SECRET`, and on the Mac from the dev ticker.
  - Schedules must be cheap (enqueue, don't work inline) and idempotent.
- **With local PGlite only one process can open the data directory.** So in dev the worker loop runs inside the Next server (`instrumentation.ts`, `IOS_WORKER=inline`), and the standalone `pnpm worker` needs `DATABASE_URL` or a stopped dev server.

### 5.6 Content pipeline (B produces; D, the dashboard and IOS-3 consume)

- **Stages** (`PIPELINE_STAGES`): idea → script → q1 → gate → media_queued → (IOS-3: voice, q2, render, q3, q4, final_gate) → scheduled → live, plus `blocked` with a reason. The Pipeline board shows them with thumbnails and the reason for any block.
- **Rows B writes:**

  | Row | Contents |
  |---|---|
  | `calendar_slot` | One per planned post: `slot_at` (UTC, inside the persona's posting window, `persona.timezone`), `format`, `purpose`, `pillar`, `title`, `idea_id`. B owns the slot status values; its migration may extend the status check, e.g. `media_queued`, `blocked`. |
  | `idea` | Ideas for the slots. |
  | `script` | `hooks` (shipped hook + 2 A/B variants + the scored lab), `body`, `caption`, `cta_keyword`, `hashtags`. |
  | `qc_report` | `subject_type 'script'`, `stage 'Q1'`; `details.checks: QcCheck[]`, failures mirrored in `qc_defect`. |
  | `gate_result` | `subject_type 'script'`, `stage 'pre_render'`, `checks: GateCheck[]`. |

  Then green or amber → `enqueue({ kind: MEDIA_RENDER_JOB, personaId, payload: MediaRenderPayload })`. Red never proceeds.
- **The Gate on replies:** `gate_result.subject_type 'reply'`. Never denying being AI is a red rule.
- **Every ledger debit for a slot's work** uses `costRef: { type: 'calendar_slot', id: slotId }`, so D can attribute cost to the post the slot becomes (`calendar_slot.post_id`).

### 5.7 Cost attribution and Profit Engine read models

- **`CostRef.type`** is one of `'calendar_slot' | 'post' | 'product' | 'knowledge' | 'news' | 'chat_thread' | 'persona' | 'studio'`. It's written to `credit_ledger.ref_type` and `ref_id` via `MeterContext.ref` / `AgentTask.costRef`.
- **Which ref to use:**

  | Work | Ref |
  |---|---|
  | Slot content | `calendar_slot` |
  | Product briefs and listing packs | `product` (B creates the `product` row at status `brief`) |
  | Field Brain | `knowledge` (id = studio id) |
  | News Desk | `news` (id = studio id) |
  | Manager chats | `chat_thread` |
  | Anything else | `persona` or `studio` |

- **D builds P&L by post, persona, format, product and platform** from:
  - `credit_ledger` debits;
  - `orders` (`source_post_id`, `product_id`, `amount_cents`, `fee_cents`, `status`) and `refund`;
  - `post`, `metric_snapshot` and `calendar_slot`.

  It returns the types in `packages/profit/src/types.ts` (amounts in cents; Higgsfield credits converted at D's credit-price setting).
- **Every lever action is logged** with its expected and measured impact.
- **Lever bounds:**
  - Agents may only lower persona caps or autonomy (`updatePersonaControls` enforces it). A cap raise is a proposal for the Owner, never applied.
  - Cadence stays within `CADENCE_BOUNDS`.
  - Routing overrides only change tiers.
- **Kill candidates** (forecast negative for 4+ weeks): D calls core `proposeKill({ proposedBy: STUDIO_MANAGER, evidence: { source: 'profit-engine', … } })`, only when no kill or retire is already pending for that persona (one pending per persona is enforced by a unique index). It never executes the kill.

### 5.8 Chat and dashboard conventions

- **Agent messages go through core `addMessage`** with:
  - `role: 'agent'`;
  - `author: 'agent:<agent-name>'`;
  - `meta.kind` set to one of `'reply' | 'approval_card' | 'briefing' | 'profit_report' | 'notice'`, plus `meta.runId` and `meta.fake` (true in fake mode).

  A's chat panel renders `approval_card` (`meta.approvalId`) inline. The others render as text.
- **Who posts what:**
  - C posts each morning briefing into that persona's thread (`kind 'briefing'`, author `agent:news-desk`) and stores `news_briefing`.
  - Fast-reaction ideas become `idea` rows with `source = { type: 'news', news_item_id, briefing_date, expires_at }`, which B's calendar can pick up.
  - D posts the Weekly Profit Report into the Studio thread (`kind 'profit_report'`, author `agent:profit-engine`).
- **A's chat answers all four thread kinds.**
  - Studio → `studio-manager`, persona → `persona-manager`.
  - Monetization and Quality run the thread's agent (`monetization-agent`, `quality-control`) with B's `monetization.*`, `gate.*` and `qc.*` tools.
  - @mentions in the Studio chat bring in that persona's manager.
- **Login (A)** protects every page and API route.
  - Public: `/login`, `/api/auth/*`, `/api/webhooks/*`, `/api/cron/*` (Bearer `CRON_SECRET`) and a minimal `/api/health`.
  - New routes from B, C or D are protected automatically. Don't add public routes.
  - Mutating API routes keep the same-origin and JSON checks.

## 6. Editing shared files

**Marked blocks.** Some shared files have one block per stream:

```
// >>> stream B nav (append only)
// <<< stream B nav
```

You may add lines only between your own stream's markers, and you never edit, reorder or delete anything outside them (including other blocks and the markers). Insertions in different blocks merge cleanly in git. The files with blocks:

| File | Blocks for |
|---|---|
| `apps/web/components/nav.tsx` | nav links (`LINKS`); Settings stays last |
| `apps/web/next.config.ts` | `serverExternalPackages` (native or WASM deps, e.g. `onnxruntime-node`) |
| `apps/web/app/globals.css` | CSS (prefer existing tokens and utilities) |
| `pnpm-workspace.yaml` | `onlyBuiltDependencies` |
| `.env.example` | env variables (names and comments, never values) |
| `packages/agents/src/contracts.ts` | `AgentName` members and `DEFAULT_ROUTING` entries (additive only) |
| `docs/ARCHITECTURE.md` | your stream's section |

**`package.json` files** (JSON has no comments):
- Add third-party dependencies to **your own package's** `package.json` only, pinned to exact versions.
- Don't edit the root `package.json` (your script is already there).
- Don't edit `apps/web/package.json`: the workspace packages are already listed. If a page needs a client-side library, ask the integrator.

**`pnpm-lock.yaml`:** never hand-merge it. On a conflict, the integrator keeps the `dev` side, runs `pnpm install` to regenerate it, and commits.

**Migrations:**
- Reserved files: `0004_a_*.sql` (A), `0005_b_*.sql` (B), `0006_c_*.sql` (C), `0007_d_*.sql` (D). If you need more than one, use `0004_a_2_*.sql` and so on.
- Never edit `0001`–`0003` or another stream's file, and never rename a migration once committed (the filename is the version).
- A migration may only reference objects from `0001`–`0003` and your own, because the others aren't in your branch.
- Only the owning stream alters a table:

  | Stream | Tables it may alter |
  |---|---|
  | A | `job` (lease token), `agent_run`, `chat_*`, `approval`, `post` (publish recovery), new auth tables |
  | B | `calendar_slot`, `idea`, `script`, `gate_result`, `qc_*`, `product`, `product_*`, `demand_signal`, `validation_test`, `launch`, `offer` |
  | C | `knowledge_*`, `news_*` (C fixes `embedding` to `vector(384)` and adds the index) |
  | D | `budget_allocation`, `credit_ledger` indexes, `experiment`, `kill_scale_proposal`, its own tables (lever log, forecasts, schedule runs, cadence and routing overrides) |

- Everything must run on PGlite and Supabase Postgres.

## 7. Definition of done per stream

**All streams:**
- `pnpm test` and `pnpm build` green.
- New behaviour is covered by tests in your own package, on fakes.
- `docs/ARCHITECTURE.md` is updated inside your block.
- The wiring merge guard passes.
- No secrets are committed.

Per stream, these must work on fakes and be tested:
- **A:**
  - A Studio chat message streams a reply from the runtime.
  - A Persona Manager can't touch another persona or an Owner-only action.
  - A kill proposal can be approved only by the Owner, with the typed name and the payload hash on both the form and JSON paths.
  - Unauthenticated requests are refused.
  - The lease token and the publishing recovery are tested.
- **B:**
  - A dry run (`pnpm content dry-run` or similar) goes persona → week of 10 slots → scripts with hook-lab → Q1 → Gate → `media.render` jobs.
  - The Pipeline board shows it.
  - The Gate's red rules match §1.
  - Q2 catches a misheard word through `FakeTranscriber`.
- **C:**
  - A Field Brain built on `FakeWebResearch` is retrievable by similarity.
  - A News Desk scan on `FakeFeeds` dedupes, scores, writes a briefing and reaction ideas.
  - The ten skills exist (our own text; no `allowed-tools`, no `!` shell lines).
  - The seed loads the 5 launch personas (or keeps the samples if the folders are missing).
- **D:**
  - P&L views from a seeded ledger.
  - Levers log expected and measured impact and respect their bounds.
  - The forecast returns P10/median/P90.
  - A 4-week negative forecast creates one kill proposal.
  - The Profit card and Money page render.
  - The Weekly Profit Report posts to the Studio chat.
  - `pnpm worker` runs jobs, and `/api/cron/tick` runs the core tick plus due schedules.

## 8. Changing a contract

If you need a contract change (a new optional field, a new service method), stop and ask the integrator. Don't edit frozen files on your branch. Additive changes land on `dev` first; every stream then merges `dev` into its branch. Until then, keep the extra data inside your own package or your own tables.
