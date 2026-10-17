# IOS-5 build contracts

Four builders work in parallel on IOS-5: the Growth Radar (I), the persona's world (J), the production playbook (K), and Format Plans with Stories (L). This file is what they share:

- who owns which files;
- which migration filenames are reserved;
- the interfaces each stream exports or consumes;
- how shared files are edited;
- the tests that must stay green.

Follow it and the four branches merge into `dev` without conflicts.

- **Product spec:** `/Users/hossamhamdy/Desktop/Family/Hossam/Ventures/Troupe-House/PRD.md`. The sections you need:
  - §3.12 (Persona Generator) and §3.13 (Pinterest inspiration boards);
  - §3.14 (grounded universe, storyline, continuity, no-repeat) and §3.15 (production playbook, Winner Finder, Growth Radar);
  - FR-4.3 to FR-4.3d (cadence, Format Plan, Stories) and FR-24 (Profit Engine levers);
  - §7 (integrations).

  Where the PRD and the owner rules in §1 disagree, §1 wins.
- **Base:** branch from the `dev` commit that added this file (`git log -1 --format=%h -- docs/IOS-5-CONTRACTS.md`).
- **Contract stubs in that commit:**
  - **New packages:** empty `@troupe/radar` (I), `@troupe/world` (J), `@troupe/production` (K) and `@troupe/formats` (L). Each exports a StudioModule plus its service factory. They are composed by `@troupe/wiring`, listed in the web app, and run with `pnpm radar|world|production|formats`.
  - **Shared contracts** in `packages/agents/src/ios5.ts`:
    - the services `RadarService`, `WorldService`, `PromptCompiler` and `FormatPlanService`;
    - the Story, format, grounding and prompt types;
    - `fingerprintOf`;
    - `meteredApify` and its weekly cap.

    These are now members of `StudioServices` (`radar`, `world`, `prompts`, `formatPlans`), with null / basic defaults in `defaults.ts`.
  - **Six new optional formats** in `PostFormat`: `photo_dump`, `text_note`, `facecam_screen`, `reply_comment`, `news_greenscreen` and `meme`. They come with `FORMAT_SHAPE` and migration `0016_ios5_formats.sql`. The migration extends every format CHECK and lets `qc_report` / `gate_result` take `subject_type 'story_frame'`. The base commit also adds the `FormatMix` type, so a cadence mix can hold optional formats.
  - **Hooks in the existing pipeline**, so no stream edits these files:
    - the calendar asks `world.beatsForWeek`;
    - every script brief carries `world.grounding` and the slot's beat;
    - Q1 runs `world.checkContent`;
    - approved scripts and sent community replies go to `world.recordApproved`;
    - Persona Generator step 1 merges `radar.opportunityEvidence`;
    - step 6 drafts `formatPlans.recommend` and `world.draftWorld`, which `setDraftExtension` can edit;
    - the Owner's launch adopts both;
    - the Monetization Agent's market scan runs through `meteredApify`.
  - **Providers:**
    - new `weather` (Open-Meteo) and `pinterest` (API v5) members, with fakes;
    - `research.runActor` takes `maxItems` and returns `costUsd`, and `FakeApify.fixture()` serves test fixtures;
    - `publish` gains `kind: 'story'` and the optional `storyCapabilities` / `fetchStoryMetrics`.
  - **Settings and secrets:** the `pinterest.access_token` secret, the `open-meteo` and `pinterest` integration entries, and the studio setting `apify_weekly_cap_usd` (default $10).
  - **Dashboard stubs:** the `/radar` page; persona-page panels (`FormatsPersonaPanel`, `StoriesPersonaPanel`, `WorldPersonaPanel`, `ProductionPersonaPanel`); generator panels (`RadarGeneratorPanel` on step 1, `FormatsGeneratorPanel` and `WorldGeneratorPanel` on step 6); and the Pipeline `StoriesLane`.
  - **Marked blocks** for I to L in every shared file.
  - **A fix to the base:** HEAD `40b4b28` did not typecheck (`Record<PostFormat, …>` literals missing the two optional formats). The base fixes it with `FormatMix` and complete format records.

  `pnpm test` and `pnpm build` pass on that commit.

## 1. Owner rules every stream builds to

These are the IOS-2 and IOS-3/4 rules (`docs/IOS-2-CONTRACTS.md` §1, `docs/IOS-34-CONTRACTS.md` §1) plus the current owner rules:

- **Fully automated:** no manual steps anywhere.
- **Owner approval:**
  - Kills need the Owner's explicit approval.
  - So does any persona launch from the Persona Generator: agents draft and recommend, and the Owner approves the launch.
  - Raising a cap is always an Owner action, including the Apify weekly cap. Agents propose it; they never do it.
- **The Compliance Gate checks legal/platform lines only.**
  - First-person stories, situations and lore are allowed.
  - The only story block is a story used as **proof that a product works**.
- **AI flags are always true on posts.** Personas never deny being AI.
- **English only.**
- **Media is all Higgsfield**, through the MCP/CLI:
  - generated at 720p and exported at 1080×1920;
  - clips are 10 s or shorter and stitched together.
- **Services:**
  - Zernio for publishing; Lemon Squeezy; Resend.
  - Apify, whose token already exists in the Keychain / secrets mechanism.
  - Pinterest: build it fully and leave it pending its key.
- **No real-person likeness.**
  - Pinterest pins and scraped creators' images are **never** used as a face or identity reference: they are mood and format inspiration only.
  - `ImagePromptSpec` takes mood as **text descriptors**.
  - `CompiledPrompt.references` holds only the persona's own identity and location refs.
  - J's mood board feeds the face check that blocks a look too close to a picked pin.
- **Scraping rules:**
  - No proxies or ban evasion.
  - Public data only, via Apify actors, at low volume (`maxItems` is always set).
  - **Every Apify run goes through `meteredApify`**. It enforces the governor and the studio's weekly cap.
- **Everything works in fake mode with no keys** (fixtures) and is ready for real keys. `vitest.config.ts` forces `TROUPE_FAKE_PROVIDERS=1` and `TROUPE_KEYCHAIN=off`.
- **Tool permissions are enforced in the tool registry.**
  - Scraped captions, transcripts, bios and comments are **untrusted**. Fence them with `fenceUntrusted` from `@troupe/content`, and run agents over them with `trust: { untrusted: true }`.
  - A tool that returns scraped text sets `untrustedOutput: true`.
  - Mutating tools reachable from an untrusted run need `ownerIntent`. Untrusted content never triggers a mutating tool.
- **The Owner's ask behind stream L (16 Oct):**
  - Use more static and written posts.
  - The Studio Manager recommends each persona's mix while the persona is generated: talking reels, reels with a text overlay, voiceover reels, static images, carousels and the other library formats.
  - Stories are a priority.

## 2. Streams, branches and the tests to keep green

| Stream | Branch | Scope |
|---|---|---|
| **I** Growth Radar + Winner Finder + Viral Remix | `ios5-i-radar` | PRD §3.15 items 9–11 and the Viral Remix. (1) **Apify adapter**: real HTTP behind `ResearchProvider` (the live `research` member) plus fixture-backed fakes. It covers Instagram profile, reels, hashtag and search scrapers, and TikTok profile and hashtag scrapers. Actor IDs live in I's config table. Pay-per-result estimates go through `meteredApify` (weekly cap). (2) **Discovery per niche:** seed hashtags, keywords and accounts from the persona and the generator, related-profile expansion, and the accounts behind outliers, stored as `tracked_account` rows. (3) **Weekly `profile_snapshot`:** follower velocity (Δ/week), acceleration, and breakout signals (a young account with high followers per post; reel views ≫ followers). Without history, a first pass uses recent reel views ÷ followers, account age and post count. (4) **Outlier scoring per reel:** views ÷ the creator's median over the last 20 posts (≥ 5× outlier, ≥ 10× strong; `OUTLIER`), views ÷ followers, (saves + shares) ÷ views, recency ≤ 14 days, replicability, monetisation fit and novelty. Internal winners are our posts beating the persona's median by 2–3× (`INTERNAL_WINNER_LIFT`); they become double-down ideas. (5) **Content review** of high-growth accounts' top reels: transcript plus an LLM / vision analysis through the runtime (`trend-scout`, untrusted). It extracts hook type, format (classified into our `PostFormat` values), structure, length, camera style, CTA, cadence and monetisation (bio link, products, Fanvue, brand deals) as structured output. (6) **Trend clustering:** a hook, format, topic or sound adopted by several accelerating accounts within 14 days, scored by adoption velocity × average outlier score. (7) **Feedback:** a weekly Trend Report in the Studio chat; Studio Manager tools `radar.report`, `winners.shortlist` and `remix.brief`; `RadarService` (opportunity evidence for Generator step 1, format and cadence benchmarks for L's Format Plan, monetisation patterns, which also go to the Monetization Agent as `demand_signal` rows with source `radar` through `addSignal` from `@troupe/content`). **Viral Remix:** a winner becomes a remix brief: the same mechanic with our persona, our world and a new concept that passes `world.checkConcept`. It also becomes an `idea` in the calendar. (8) **`/radar` page:** growing accounts, outliers, trends and remix briefs, plus the weekly Apify cap setting (Owner, `updateSettings`). Schedules run in the worker. Tests cover the scoring maths, clustering and fenced content. |
| **J** World Bible + storyline + continuity + no-repeat + Pinterest | `ios5-j-world` | PRD §3.13 and §3.14. (1) **World Bible per persona:** region, city or town, home, recurring places, people, seasons and local holidays. It's written at generation time (`draftWorld` in step 6, adopted at launch) and is editable (persona panel, generator panel, chat tools). (2) **Real-time grounding** (`grounding`): local date, season, time of day and real local weather through Open-Meteo (no key; fake in tests). `Grounding.block` already reaches every script brief. K's compiler puts it in every visual prompt. `checkContent` checks wardrobe, light and topical references against it. (3) **Storyline:** a ~12-week season arc of chapters, each with beats, tension and a payoff. `beatsForWeek` assigns beats to the planner's slots (stored in `calendar_slot.meta.story`). The Persona Manager maintains it and can be steered in chat (`storyline.*` tools). (4) **Fact / continuity ledger:** facts extracted from every approved script, story frame and reply through `recordApproved` (names, ages, events, possessions, opinions). `checkContent` blocks contradictions. (5) **No-repeat engine:** a concept fingerprint (`ConceptFingerprint`: premise + hook type + topic + format + key line), embedded per persona with `providers.embeddings` and pgvector. A concept too close to the persona's history is blocked. Series episodes must add a new beat. Near-duplicate wording is blocked studio-wide. It is exposed as `checkConcept` and inside `checkContent`. (6) **Pinterest:** the official API v5 adapter (the live `pinterest` member; the OAuth token is pending). It publishes boards and pins for products and carousels (AI disclosure in the description), and searches boards for inspiration where the API allows. There is an Apify Pinterest scraper fallback (through `meteredApify`) for inspiration boards. The board feeds the generator and the Studio Manager as mood and format only (`moodBoard`), never as a face reference. |
| **K** Production playbook + new format renderers | `ios5-k-production` | PRD §3.12 notes, §3.15 items 1–8, and FR-4.3c's format library. (1) **Prompt compiler** (`PromptCompiler`): five image blocks (`IMAGE_PROMPT_BLOCKS`: subject/identity, wardrobe, setting/location lock, camera/lens/realism, lighting/grounding) and five video blocks (`VIDEO_PROMPT_BLOCKS`: start frame, action, camera motion, audio/speech, constraints). Speech runs at 2.5–3 words a second (`SPEECH_WPS`, `speechSeconds`), with no timecodes. Every talking prompt carries the accent, and every video prompt carries `NO_CAPTIONS`. Every prompt carries `Grounding.block`. It's used by K's renderers and by L's story frames. (2) **5-view character sheet** (front, side, back, front close-up, top-down) plus a detail strip, used as the identity reference, and 4 core reference images in varied settings. (3) **BOPA look pack:** backgrounds as a 3×3 grid with an upscaled pick; outfits through a keep-identity edit; poses as a 2×2 grid; angles in degrees. Commit `40b4b28` added only the PRD text and types, so build it here. (4) **Location lock and consistency chain:** each World Bible place gets a locked reference set, and the last frame or still feeds the next shot. Never chain from a rejected frame, and never drop the face ref. (5) **Realism camera styles** (`CAMERA_STYLES`), chosen per slot and recorded (`calendar_slot.meta.production.camera`). (6) **Niche filter** in the generator (the five questions; niche vs format) and a **hook-template library** seeded from the Licbe resources (inspiration, not copied). (7) **Render templates** in the worker for the new formats: `photo_dump` (5–10 casual stills, IG carousel, 4:5 or 1:1); `text_note` (a text-on-image note or quote card, static); `facecam_screen` (the persona in a corner over a generated screen recording or slides); `reply_comment` (a talking or text answer to a top comment, with the comment rendered as a sticker-like overlay and the commenter's handle anonymised); `news_greenscreen` (the persona over a News Desk headline card, never a real outlet's logo); `meme` (a relatable text post). K also builds their script rules, Q1 rules and Q3/Q4 expectations. |
| **L** Per-persona Format Plan + Stories engine | `ios5-l-formats` | PRD FR-4.3c and FR-4.3d (read them in full). (1) **Format types:** the six values, their CHECK constraints and `FORMAT_SHAPE` are already in the base (migration `0016`). L owns what they mean in planning. (2) **Format Plan per persona** (`FormatPlanService`, L's tables). It's approved with the launch (`adoptPlan`) and editable on the persona page and in chat (`formats.*` tools). Each plan has weekly counts per format, optional formats on or off, Stories per day and their daily mix, and a reason and cost per week for every line. The Studio Manager recommends it in Generator step 6 (`recommend`), from the archetype, niche benchmarks (`services.radar.formatBenchmarks`, with a default when null), the product ladder and the budget. The CadencePolicy reads it, and the Profit Engine's format lever re-tunes it weekly within bounds from per-format results (reach, follows, saves/shares, clicks, revenue per post ÷ cost per post). (3) **New studio default:** 10 feed posts = talking 2, activity_text 2, voiceover 1, static 2, carousel 2, photo_dump 1. The winner default scales proportionally to ~17. Update `DEFAULT_CADENCE`, `WINNER_CADENCE`, the tests, the calendar and the policies so the core-format invariants still hold (each core format ≥ 1; mixes sum to `postsPerWeek`). (4) **Stories engine:** 3–5 frames a day per persona, made natively (`STORY_FRAME_KINDS`). The daily mix is: a world / where-I-am-today frame (`world.grounding`); a storyline beat (`world.beatsForWeek` with one slot at the frame's time); a feed reshare; an engagement keyword frame; and a sell frame on sell days. Frames are stills + text (`services.prompts.image` → Higgsfield still → text overlay at 1080×1920). They pass QC and the Gate (`subject_type 'story_frame'`), and their facts go to `world.recordApproved`. Publishing goes through Zernio (`kind: 'story'`) where `storyCapabilities` says the platform supports it, after core `assertCanPublish` (kill switches), with the AI flag on. The Persona Manager curates the highlight sets (`HIGHLIGHT_SETS`). Story metrics are ingested (`fetchStoryMetrics`: reach, replies, taps forward and back, exits). There's a Stories lane on the Pipeline board and on the persona page. (5) **Verify the archive:** the 5 archived launch personas must be archived (restorable) in a fresh local DB, and the default seed must be an empty studio. Fix it if not. |

**Every builder keeps these green, in the foreground, before every handoff:**

```
source ~/.nvm/nvm.sh; nvm use --delete-prefix 22.23.3 --silent
pnpm test        # Vitest across all packages and apps (includes packages/wiring/test, the merge guard)
pnpm build       # pnpm -r typecheck + next build
```

While working, `pnpm vitest run packages/<yours>` is the quick loop. `packages/agents/test/ios5.test.ts` is the contract test.

**Rules for every builder:**
- Never leave a test run going in the background.
- Never push.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit secrets.
- Quote paths: they contain spaces.
- The repo identity is AISamDot.

**Local databases and servers:** a preview dev server may be running on port 3100 from the dev worktree against `.data/pglite`.
- **Never open that directory from another process.** Two processes corrupt PGlite, and the lock refuses anyway.
- `next build` writes `apps/web/.next`. Run it in your own worktree, never in the dev worktree while its server runs.
- For any manual run, use a scratch data dir and another port:

  ```
  export PGLITE_DIR="$(mktemp -d)/pglite" TROUPE_MEDIA_DIR="$(mktemp -d)"
  pnpm db:setup
  pnpm --filter @troupe/web exec next dev --hostname 127.0.0.1 --port 3201
  ```
- Tests use in-memory PGlite and are always safe.

**Merge order (integrator):** L → J → K → I. Any order works, because the streams share only the contracts.
- This order lands the new cadence default first.
- Then the world checks, which change Q1 for every slot.
- Then the renderers for the formats L turns on.
- Then the Radar that fills L's benchmarks.

After each merge the integrator runs `pnpm install`, `pnpm test` and `pnpm build`. After all four, the integrator adds a cross-stream E2E test (§7).

## 3. How the packages fit together

```
@troupe/db ← @troupe/core ← @troupe/agents (contracts + ios34.ts + ios5.ts + runtime + null defaults)
              ↑                ↑
   @troupe/providers        @troupe/content · @troupe/knowledge · @troupe/profit · @troupe/generator · @troupe/distribution · @troupe/commerce · @troupe/products
   (interfaces + fakes)        ↑                                   (existing; read-only unless §4 says otherwise)
                         @troupe/media (K owns it in IOS-5)
                               ↑
          @troupe/radar (I) · @troupe/world (J) · @troupe/production (K) · @troupe/formats (L)
                               ↑
                        @troupe/wiring (composition root) ← apps/web, apps/worker, cron tick
```

**Dependencies:**
- I, J, K and L may depend on `@troupe/agents`, `@troupe/core`, `@troupe/db` and `@troupe/providers`, and read-only on the existing packages. Examples:
  - `fenceUntrusted`, `runGate`, `gatePost`, `saveGateResult`, `saveQcReport` and `addSignal` from `@troupe/content`;
  - `addMessage` and `notify` from `@troupe/core`;
  - `knowledge` retrieval;
  - the existing exports of `@troupe/media` (`mediaDeps` face compare, the storage helpers). K keeps those signatures stable.
- **The four new packages never import each other.** Cross-stream work goes through the four services on `StudioServices` (§5), the job queue and the database.
  - `@troupe/media` may import `@troupe/production`.
  - `@troupe/production` never imports `@troupe/media`, so there is no cycle.
  - `@troupe/generator` may import `@troupe/production`. Only K edits the generator's `package.json`.
- Add third-party dependencies to your own package's `package.json` only, pinned to exact versions.

**Every package's `src/index.ts` exports a `StudioModule`** (`tools`, `jobs`, `schedules`, `liveProviders(env)`) **plus its service factory**:
- I: `createRadarService`;
- J: `createWorldService`;
- K: `createPromptCompiler`;
- L: `createFormatPlanService`.

A factory has the type `ServiceFactory<T> = (base, services) => T`. `services()` returns the finished `StudioServices` (with the runtime, registry and the other three services). Call it lazily, inside a method, never in the factory body.

The stubs exist: replace their bodies and keep the names and signatures. `@troupe/wiring` composes every module and throws on a duplicate tool, job kind, schedule or provider member. Nobody edits wiring.

**Tests:**
- Build services with `createTestStudio()` / `makeTestPersona()` from `@troupe/agents/testing`. `createTestStudio` takes the IOS-5 factories, for example `createTestStudio({ world: createWorldService })` to test with your real service.
- The other streams' services are the null defaults, so never assume another stream's behaviour in your tests.
- Never import another package's `test/` folder. Never depend on the seed's personas.

## 4. Ownership

You may create and edit only what your stream owns. Anything not listed is frozen for IOS-5: ask the integrator (§8).

### Stream I: `ios5-i-radar`
- **Packages:**
  - `packages/radar/**`;
  - in `packages/providers/src/fakes.ts`, the body of `FakeApify`. Keep `fixture()`, `fixtures`, `USD_PER_ITEM`, `runActor` and `topPosts`, and the fallback item for unknown actors.
- **`apps/web/` files:**
  - `app/radar/**` (replace the stub), `app/api/radar/**`;
  - `components/radar-*.tsx`, including `radar-generator-panel.tsx`.
- **Migrations:** `0017_i_*.sql`.
- **Tables:**
  - new `tracked_account`, `profile_snapshot`, `remix_brief`, and tables prefixed `radar_` (for example `radar_config` for actor IDs and seeds, `radar_post`, `radar_review`, `radar_trend`, `radar_run`);
  - I inserts `idea` rows (`source.type` `'remix'` or `'double_down'`, status `'new'`) and `demand_signal` rows (source `'radar'`) without altering those tables.
- **Namespaces:**
  - tools: `radar.*`, `winners.*`, `remix.*`. These must exist, with `callers` including `studio-manager`: `radar.report`, `winners.shortlist`, `remix.brief`;
  - jobs: `radar.*`, `winners.*`, `remix.*`;
  - schedules: `radar.*`.
- **Agents:** `trend-scout` (standard).
- **Live providers:** `research` (Apify, on `apify.token`).
- **Integrations:** the `apify` entry (flip `liveAdapter: true`).
- **Service:** `createRadarService` → `RadarService`.

### Stream J: `ios5-j-world`
- **Packages:**
  - `packages/world/**`;
  - in `packages/providers/src/fakes.ts`, the bodies of `FakeWeather` and `FakePinterest` (keep their members and the `fixed`, `boards` and `pins` fields).
- **`apps/web/` files:**
  - `app/world/**` (optional), `app/api/world/**`;
  - `app/generator/world-actions.ts` (new; server actions that call `setDraftExtension(…, 'world', …)` and pick pins);
  - `components/world-*.tsx`, including `world-persona-panel.tsx` and `world-generator-panel.tsx`.
- **Migrations:** `0018_j_*.sql`.
- **Tables:**
  - new tables prefixed `world_`, `storyline_`, `continuity_`, `concept_` (for example `concept_fingerprint` with `embedding vector(384)`, the `EMBEDDING_DIM`), `inspiration_` and `pinterest_`;
  - `calendar_slot.meta.story` is written by the calendar hook from `beatsForWeek`. J may update that key (only that key) when the Owner re-steers the storyline.
- **Namespaces:**
  - tools: `world.*`, `storyline.*`, `continuity.*`, `norepeat.*`, `pinterest.*`, `inspiration.*`;
  - jobs and schedules: the same.
- **Agents:** `continuity-keeper` (fast; fact extraction and contradiction checks).
- **Live providers:** `weather` (Open-Meteo, no key), `pinterest` (API v5, `pinterest.access_token`).
- **Integrations:** the `open-meteo` and `pinterest` entries.
- **Service:** `createWorldService` → `WorldService`.

### Stream K: `ios5-k-production`
- **Packages:**
  - `packages/production/**`.
  - `packages/media/**`: stream E is done, so K owns the media package for IOS-5. That covers render templates for the new formats, `FORMAT_SPEC`, the compiler in every generation, the character sheet / look pack / location lock in `profile.ts`, and the Q3/Q4 expectations per format. Keep the existing exports' signatures.
  - In `packages/content/src/`:
    - `script.ts`: `FORMAT_RULES`, `visualBrief`, `fakeScript` and `enforceScript` for the new formats. Keep `ScriptBrief`'s fields, including the IOS-5 `grounding` and `beat`.
    - `qc.ts`: Q1 timing and motion rules (2.5–3 wps, no timecodes, accent, no baked-in text, two-handed actions flagged), per-format Q1. Keep `checkScript`'s signature and `saveQcReport`.
    - `hooks.ts`: the hook-template library.
  - In `packages/generator/src/`:
    - `media.ts` (look step: the 5-view sheet, BOPA, 4 core refs, the face check against `world.moodBoard` pins);
    - in `fake.ts`, only the look functions `placeholderLook` and `sheetPrompt`;
    - `score.ts` (the niche filter in producibility);
    - the generator's `package.json` (to add `@troupe/production`).
  - In `packages/providers/src/fakes.ts`, the bodies of `FakeHiggsfield`, `FakeTalking` and `FakeVoice`, behaviour only.
  - New files under `apps/worker/src/media/` if the Mac worker needs them.
- **`apps/web/` files:**
  - `components/production-*.tsx`, including `production-persona-panel.tsx`;
  - `components/media-*.tsx`;
  - `app/api/media/**`, `app/api/production/**`.
- **Migrations:** `0019_k_*.sql`.
- **Tables:**
  - may alter `asset`, `qc_report`, `qc_defect`, `qc_standard` and the `media_*` tables (the media package's own);
  - new tables prefixed `production_`, `location_` (for example `location_lock`) and `hook_template`;
  - writes `calendar_slot.meta.production` (camera style, location, chain refs) and `persona.look_pack` without altering those tables.
- **Namespaces:**
  - tools: `media.*`, `voice.*`, `production.*`, `look.*`, `location.*`, `prompt.*`;
  - jobs: `media.*` (it still owns `media.render` → `publish.prepare`), `voice.*`, `production.*`, `look.*`;
  - schedules: `media.*`, `production.*`.
- **Agents:** `video-producer` (existing). Add more only inside the K block.
- **Live providers:** `imageVideo`, `talking`, `voice`, `storage` (moved over from E unchanged).
- **Integrations:** the `higgsfield`, `fal` and `elevenlabs` entries (inside the stream E block).
- **Service:** `createPromptCompiler` → `PromptCompiler`.

### Stream L: `ios5-l-formats`
- **Packages:**
  - `packages/formats/**`.
  - `packages/agents/src/contracts.ts`: only the `stream L default cadence` block (`DEFAULT_CADENCE`). `packages/agents/src/defaults.ts`: only the `stream L winner cadence` block (`WINNER_CADENCE`). Also the matching assertions in `packages/agents/test/contracts.test.ts` and `ios5.test.ts` ("keeps the core-format invariant").
  - `packages/content/src/calendar.ts` (format mix incl. optional formats, `assignMix` / `PREFER`, `normaliseCadence`; keep the `beatsForWeek` hook and `meta.story`), and in `packages/content/src/persona.ts` only its `FORMATS` constant. Also `packages/content/test/calendar.test.ts`.
  - `packages/profit/src/policies.ts` (the CadencePolicy reads the Format Plan; `FORMATS`, `formatBounds`, `scaleTarget`, `validTarget`), the format-mix lever `planFormatMix` in `packages/profit/src/levers.ts` (it writes the plan within bounds; the other levers stay), and the matching profit tests.
  - `packages/distribution/src/zernio.ts` and `platforms.ts`: only story publishing (`kind: 'story'`), `storyCapabilities` and `fetchStoryMetrics` on the live adapter. In `packages/providers/src/fakes.ts`, the story members of `FakeZernio` (`storySupport`, `storyMetrics`, `storyCapabilities`, `fetchStoryMetrics`).
  - Archive check (5): `packages/core/src/seed/**` and `packages/core/test/seed.test.ts`, only if a fix is needed.
- **`apps/web/` files:**
  - `components/formats-*.tsx` (including `formats-persona-panel.tsx` and `formats-generator-panel.tsx`);
  - `components/stories-*.tsx` (including `stories-persona-panel.tsx` and `stories-lane.tsx`);
  - `app/generator/formats-actions.ts` (new; calls `setDraftExtension(…, 'formatPlan', …)`);
  - `app/stories/**` (optional), `app/api/formats/**`, `app/api/stories/**`.
- **Migrations:** `0020_l_*.sql`.
- **Tables:**
  - new tables prefixed `format_plan` and `story_` (for example `story_frame`, `story_highlight`, `story_metric`);
  - `profit_cadence_override` rows are written as before (L may add columns in its migration).
- **Namespaces:**
  - tools: `formats.*`, `stories.*`, `highlights.*`;
  - jobs and schedules: the same.
- **Agents:** `stories-producer` (standard).
- **Live providers:** none new (story support rides on F's `publish` adapter, edited as above).
- **Service:** `createFormatPlanService` → `FormatPlanService`.

### Frozen (nobody edits during IOS-5)
- **`packages/agents/**`**, except your own marked blocks (§6) and L's cadence blocks. `src/ios5.ts`, `ios34.ts`, `runtime.ts` and `defaults.ts` outside L's block are integrator-only.
- **`packages/providers/src/types.ts` and `storage.ts`.**
- **`packages/core/**`**, except L's seed check. That includes `types.ts`: the format values and `FORMAT_SHAPE` are fixed. Also `settings.ts`, `metered.ts`, `governor.ts`, `killswitch.ts` and `publish.ts`.
- **`packages/db/**`**, except your own migration files.
- **In `packages/content/**`:** `pipeline.ts` (the world hooks are in place), `gate.ts`, `board.ts`, `monetization.ts`, `jobs.ts` and `tools.ts`, plus everything else not assigned in §4.
- **`packages/generator/src/`:** `steps.ts`, `types.ts`, `launch.ts`, `review.ts`, `chat.ts` and `tools.ts`. The extension hooks and `setDraftExtension` are in place.
- **`packages/distribution/**`** (except L's story parts), **`packages/commerce/**`, `packages/products/**`, `packages/knowledge/**`.**
- **`packages/profit/**`**, except L's files.
- **`packages/secrets/**`**, except your own integration entries. The `pinterest.access_token` secret already exists.
- **`packages/wiring/**`**, `apps/worker/src/app.ts` and `main.ts`.
- **`apps/web/package.json`**, the root `package.json`, `tsconfig.base.json` and `vitest.config.ts`. Your CLI script already exists (`pnpm radar|world|production|formats`): give it subcommands.
- **Existing pages** under `apps/web/app/` (`personas/**`, `generator/**` except your new actions file, `pipeline/**`, `settings/**`, and the rest). Your panels are your own components, already rendered (§5.7).
- **`docs/BUILD_PLAN.md` and this file** (integrator only).

## 5. Shared interfaces and types

| Contract | Where | Implemented by | Consumed by |
|---|---|---|---|
| `RadarService` (`formatBenchmarks`, `opportunityEvidence`, `monetisationPatterns`), `FormatBenchmark`, `OpportunityEvidence`, `MonetisationPattern`, `OUTLIER`, `INTERNAL_WINNER_LIFT` | `@troupe/agents` `ios5.ts` | I (`createRadarService`) | L (`recommend`, lever), generator step 1 (hook in place), Studio Manager |
| `WorldService` (`grounding`, `beatsForWeek`, `checkContent`, `recordApproved`, `checkConcept`, `draftWorld`, `adoptWorld`, `moodBoard`), `Grounding`, `SlotBeat`, `ConceptFingerprint`, `NoRepeatResult`, `WorldDraft`, `fingerprintOf` | `ios5.ts` | J (`createWorldService`) | content pipeline + calendar (hooks in place), K (grounding block, mood descriptors, face check vs pins), L (world frame, beat frame, ledger), I (`checkConcept` on remix briefs), generator (hooks in place) |
| `PromptCompiler` (`image`, `video`), `ImagePromptSpec`, `VideoPromptSpec`, `CompiledPrompt`, `CAMERA_STYLES`, `IMAGE_PROMPT_BLOCKS`, `VIDEO_PROMPT_BLOCKS`, `SPEECH_WPS`, `speechSeconds`, `CLIP_MAX_S`, `NO_CAPTIONS` | `ios5.ts` | K (`createPromptCompiler`; `basicPromptCompiler` until then) | K's renderers, L's story-frame stills |
| `FormatPlanService` (`recommend`, `planFor`, `adoptPlan`), `FormatPlan`, `FormatPlanLine`, `StoriesPlan`, `STORY_FRAME_KINDS`, `STORIES_PER_DAY`, `HIGHLIGHT_SETS` | `ios5.ts` | L (`createFormatPlanService`) | generator step 6 + launch (hooks in place), L's CadencePolicy, K (which formats a persona uses) |
| `PostFormat` + `OptionalFormat` (6 new values), `FORMAT_SHAPE`, `scriptShape`, `isOptionalFormat`, `POST_FORMATS` | `@troupe/core` `types.ts` | base commit (migration 0016) | all |
| `FormatMix`, `CadenceTarget` | `@troupe/agents` `contracts.ts` | L (the defaults, the policy) | calendar, levers |
| `meteredApify`, `apifyWeekSpendUsd`, `ApifyWeeklyCapError`, `APIFY_PROVIDER`; studio setting `apify_weekly_cap_usd` | `ios5.ts`; `@troupe/core` settings | base commit | I, J, the Monetization Agent's market scan |
| `ServiceFactory`, `CreateServicesOptions.radar/world/prompts/formatPlans` | `contracts.ts` | base commit | wiring, tests |
| `setDraftExtension`, `DraftState.radar/world/formatPlan`, `withRadarEvidence` | `@troupe/generator` | base commit | I, J, L (panels, actions, tools) |
| `ScriptBrief.grounding/beat`, `draftText`, `q1WithFixes({ world })` | `@troupe/content` | base commit (K owns `script.ts` from here) | K, J |
| `saveQcReport` / `saveGateResult` with `subjectType 'story_frame'` | `@troupe/content` | base commit | L |
| `fenceUntrusted`, `runGate`, `gatePost`, `addSignal` | `@troupe/content` | existing | I, J, L |

### 5.1 Jobs, schedules and the cross-stream flow

```
calendar.weekly_plan → planWeek: cadence (L's policy → Format Plan) → world.beatsForWeek (J) → slots (meta.story)
pipeline.slot: idea → hook-lab → script (brief.grounding + brief.beat from J) → Q1 (+ world.checkContent: grounding,
  continuity, no-repeat) → Gate → world.recordApproved (J's ledger + fingerprint) → media.render (K: compiler +
  grounding + location lock + camera style → Higgsfield → template per format → Q3/Q4) → publish.prepare (F, as before)
community reply sent → world.recordApproved (reply)
I  radar.* schedules → meteredApify scrapes → tracked_account / profile_snapshot / radar_* → scores, clusters
   → weekly Trend Report (Studio chat) · winners.shortlist · remix.brief → world.checkConcept → idea (calendar)
   → demand_signal (source 'radar') for the Monetization Agent · RadarService for L and the generator
J  world.* schedules (weather cache, storyline upkeep) · pinterest.* (boards/pins for products and carousels)
L  stories.* schedules → 3–5 frames/day: kinds from the plan → prompts.image (K) + world.grounding/beat (J) → still +
   text → QC + Gate (story_frame) → world.recordApproved → assertCanPublish → publish (kind 'story') where supported
   → stories.metrics · formats lever weekly (profit) re-tunes the plan within bounds
Generator: step 1 radar.opportunityEvidence · step 6 formatPlans.recommend + world.draftWorld (+ moodBoard pins in the
   look step, K) · launch (Owner only) → formatPlans.adoptPlan + world.adoptWorld inside the launch transaction
```

**Job and schedule rules** (as before):
- **Names:** job kinds are `<namespace>.<verb>`, within your namespaces. Enqueue with core `enqueue()`, always with `personaId` for persona work.
- **Handlers are idempotent.** They resume from stored state and throw `DeferJob` to wait without spending an attempt. Defer on `BudgetExceededError` or `ApifyWeeklyCapError` (until the week rolls over).
- **One cross-stream job per subject:** `enqueueOnceFor(db, { kind, key, … }, { ever: true })`.
- **Schedules** enqueue; they don't work inline.
- **Long jobs** call `heartbeat()`.
- **Media jobs run on the Mac.**

### 5.2 Cost and credits

- **Every paid call goes through the governor.**
  - LLM work: `services.runtime.run()` with `costRef`.
  - Higgsfield: K's existing `hfSpend` / `metered`.
  - Apify: **only** `meteredApify` (unit `media_usd`, provider `'apify'`, weekly cap). I keeps per-actor pay-per-result prices in its config; the estimate is `maxItems × price`.
  - Open-Meteo is free.
  - Pinterest API calls are free (no metering), but low volume.
- **Refs:**
  - Radar runs → `{ type: 'studio', id }` (studio-level research), or `{ type: 'persona', id }` for persona seeds;
  - J's Pinterest fallback → `{ type: 'persona', id }` or `{ type: 'studio', id }` for drafts;
  - story frames → `{ type: 'persona', id }` (L may add `ref_type 'story_frame'` rows; the ledger's `ref_type` is free text).
- **Over a cap the governor refuses.** Defer. Never raise a cap: a raise is an Owner proposal.

### 5.3 Providers (`@troupe/providers`)

| Member | IOS-5 change | Live owner | Fake |
|---|---|---|---|
| `research` | `runActor({ actor, input, maxItems?, timeoutS? }) → { runId, items, costUsd? }` | I | `FakeApify`: `fixture(actor or prefix, items or fn)`, `USD_PER_ITEM`; unknown actors return one sample item |
| `weather` (**new**) | `current({ lat, lon, timezone })`, `geocode({ name, country? })` | J | `FakeWeather` (seasonal curve by latitude, rain on some days; `fixed` overrides) |
| `pinterest` (**new**) | `listBoards`, `createBoard`, `createPin`, `searchPins` (`supported: false` → Apify fallback) | J | `FakePinterest` (`boards`, `pins`) |
| `publish` | `PublishRequest.kind` adds `'story'`; optional `storyCapabilities()` and `fetchStoryMetrics()` | L (story parts of F's Zernio adapter) | `FakeZernio.storySupport` (Instagram only by default), `storyMetrics` |

**Rules (unchanged):**
- **Live adapters live in your own package.** Return them from your `liveProviders(env)` only when `env.isLive('<integration>')`. Two packages supplying the same member is an error.
- **Read keys only through `env.secret(name)`.**
- **The AI flag is a literal `true`.**
- **Local tooling stays behind your own interface with a fake.**

### 5.4 Agents and runtime

- **New agent names**, already in `AgentName` and `DEFAULT_ROUTING`: `trend-scout` (I, standard), `continuity-keeper` (J, fast), `stories-producer` (L, standard). K uses `video-producer`.
- **Every model call** goes through `services.runtime.run()` with a deterministic `fake()`.
- **Untrusted text:**
  - Scraped captions, transcripts, bios, comments and pin descriptions go inside `fenceUntrusted` blocks.
  - The task sets `trust: { untrusted: true }`.
  - Tools that return such text set `untrustedOutput: true`.
  - Mutating tools need `ownerIntent` to run from an untrusted context.
- **Studio Manager tools** (`radar.report`, `winners.shortlist`, `remix.brief`, `formats.*`, `inspiration.*`) set `callers` to include `'studio-manager'`. Persona-scoped steering tools (`storyline.*`, `formats.plan_*`, `highlights.*`) include `'persona-manager'`.
- **Owner-only actions stay proposals:** raising caps (including the Apify weekly cap) and launching personas.

### 5.5 Persona Generator extensions

- **Step 1:** the base merges `services.radar.opportunityEvidence` into each option's evidence (flag `'S'`) and keeps it in `state.radar`. I renders `RadarGeneratorPanel`.
- **Step 6:** the base fills `state.formatPlan` (`formatPlans.recommend`) and `state.world` (`world.draftWorld`) whenever the content step is drafted or regenerated.
  - L renders and edits the plan: `FormatsGeneratorPanel`, `app/generator/formats-actions.ts` → `setDraftExtension(services, draftId, 'formatPlan', plan, { actor, expectVersion })`.
  - J renders and edits the world (`WorldGeneratorPanel`, `world-actions.ts`), and the mood board pins.
  - Every edit is a new draft version.
- **Step 4 (K):** the look step uses `world.moodBoard({ draftId })`: descriptors as mood, pins only for the "too similar" face check.
- **Launch:** inside the Owner's launch transaction the base calls `formatPlans.adoptPlan(tx, …)` and `world.adoptWorld(tx, …)` when the draft has them. Use the `db` you are given (it's the transaction); never `services.db` there.

### 5.6 Database contracts between streams

| Row / key | Writer | Contents / rule | Readers |
|---|---|---|---|
| `calendar_slot.meta.story` | the calendar hook (from J's `beatsForWeek`); J on re-steer | `SlotBeat` | pipeline (script brief), L (beat frames), dashboards |
| `calendar_slot.meta.production` | K | `{ camera, location, chain }` | dashboards, K |
| `calendar_slot.format` | the calendar (L's plan) | any `PostFormat`; optional formats only when the persona's plan has them on | K (render template), all |
| `idea` (`source.type 'remix' / 'double_down'`) | I | `status 'new'`, `format` set, `source.remix_brief_id`; the calendar books it like any new idea | calendar |
| `demand_signal` (source `'radar'`) | I via `addSignal` | monetisation patterns per persona niche | Monetization Agent |
| `qc_report` / `gate_result` with `subject_type 'story_frame'` | L | via `saveQcReport` / `saveGateResult` | Approvals, dashboards |
| `credit_ledger` rows with provider `'apify'` | `meteredApify` only | the weekly cap sums the trailing 7 days | I's `/radar`, Money |
| `studio.settings.apify_weekly_cap_usd` | Owner (`updateSettings`) | USD per trailing 7 days | `meteredApify` |

### 5.7 Dashboard conventions

- **Owner pages call `requireOwnerPage()`**; the route test enforces it. Owner API routes check the session like the existing routes. Don't add public routes.
- **Your panels are your own server components, already rendered.** Keep the names and props, catch your own errors and return null on failure:
  - persona page: `FormatsPersonaPanel` and `StoriesPersonaPanel` (L), `WorldPersonaPanel` (J), `ProductionPersonaPanel` (K), all with props `{ db, studioId, personaId, slug }`;
  - generator: `RadarGeneratorPanel` (step 1, I), `FormatsGeneratorPanel` and `WorldGeneratorPanel` (step 6, L and J), with props `{ draft, studioId }`;
  - Pipeline: `StoriesLane` (L), with props `{ db, studioId, personaId }`.
- **Agent messages** go through core `addMessage` (`role 'agent'`, `author 'agent:<name>'`, `meta.kind`, e.g. `'trend_report'`). **Owner notifications** go through core `notify` with a `link`.
- **Add CSS only inside your block** in `globals.css`.

## 6. Editing shared files

**Marked blocks.** Add lines only between your own stream's markers, for example `// >>> stream I nav (append only)` … `// <<< stream I nav`. Never edit, reorder or delete anything outside them, including other streams' blocks and the markers themselves.

| File | I / J / K / L blocks for |
|---|---|
| `packages/agents/src/contracts.ts` | `AgentName` members and `DEFAULT_ROUTING` entries (additive only); L also the `stream L default cadence` block |
| `packages/agents/src/defaults.ts` | L only: the `stream L winner cadence` block |
| `packages/secrets/src/integrations.ts` | I: `apify`; J: `open-meteo`, `pinterest`; K keeps the stream E block (higgsfield, fal, elevenlabs) |
| `apps/web/components/nav.tsx` | I `/radar` (in place); J/L optional pages; Settings stays last |
| `apps/web/next.config.ts` | `serverExternalPackages` |
| `apps/web/app/globals.css` | CSS |
| `pnpm-workspace.yaml` | `onlyBuiltDependencies` |
| `.env.example` | env variables (names and comments, never values) |
| `docs/ARCHITECTURE.md` | your stream's section |

**`package.json` files:** your own package's only (K also the generator's); exact versions; never the root or `apps/web`. **`pnpm-lock.yaml`:** never hand-merge it; on a conflict the integrator keeps `dev`, runs `pnpm install` and commits.

**Migrations:**
- **Reserved files:** `0017_i_*.sql` (I), `0018_j_*.sql` (J), `0019_k_*.sql` (K), `0020_l_*.sql` (L). For more than one, use `0017_i_2_*.sql` and so on. `0016_ios5_formats.sql` is the base commit's.
- Never edit `0001`–`0016` or another stream's file, and never rename a committed migration.
- A migration may reference only objects from `0001`–`0016` and your own.
- Only the owning stream alters a table (§4).
- Everything runs on PGlite (pgvector included) and Supabase Postgres.

## 7. Definition of done

**All streams:**
- `pnpm test` and `pnpm build` are green.
- New behaviour is covered by tests in your own package, on fakes.
- `docs/ARCHITECTURE.md` is updated inside your block.
- The wiring merge guard passes.
- No secrets are committed.
- Live adapters exist and switch on with the keys, but tests never use them.

**Per stream (on fakes, tested):**
- **I:**
  - Fixture-backed scrapes create `tracked_account` and weekly `profile_snapshot` rows, and every run is debited through `meteredApify`. A run past the weekly cap defers.
  - The scoring maths is tested on fixtures: outlier ratio against the median of the last 20 posts, ≥ 5× / ≥ 10×, views ÷ followers, (saves + shares) ÷ views, recency, breakout signals, velocity and acceleration, and the first pass without history.
  - Clustering finds a trend adopted by ≥ 2 accelerating accounts within 14 days, scored by adoption velocity × average outlier score.
  - Scraped captions and transcripts are fenced. A caption containing instructions never triggers a mutating tool (registry refusal test).
  - The weekly Trend Report lands in the Studio chat. The three Studio Manager tools work.
  - `RadarService` returns benchmarks, evidence and patterns.
  - A remix brief passes `checkConcept` and books an idea.
  - `/radar` renders.
- **J:**
  - A World Bible is drafted in step 6 and adopted at launch.
  - Grounding comes from `FakeWeather` (season, time of day, weather, holidays, sunrise / sunset) and its block reaches the script prompt.
  - `checkContent` flags a summer-dress-in-December brief and a daylight-at-6-pm-in-a-Yorkshire-November brief.
  - `beatsForWeek` tags the planned slots.
  - The ledger records facts from an approved script and a reply, and blocks "my sister Angie" → "my brother Angelo".
  - The no-repeat engine blocks a near-duplicate concept (persona) and near-duplicate wording (studio), and requires a new beat for a series episode.
  - Pinterest creates boards and pins on the fake, and falls back to Apify (metered) when search is unsupported.
  - `moodBoard` returns descriptors and pins, and no code path passes a pin as an image reference.
- **K:**
  - The compiler emits the five image blocks and the five video blocks. Speech length follows 2.5–3 wps, with no timecodes. Every talking prompt carries the accent; every video prompt carries `NO_CAPTIONS` and the grounding block.
  - The 5-view sheet, the detail strip, the 4 core refs and the BOPA flow work on fakes.
  - A location lock and the frame chain work (never from a rejected frame).
  - The camera style is recorded per slot.
  - The niche filter and hook templates are in the generator.
  - One `media.render` per new format (`photo_dump`, `text_note`, `facecam_screen`, `reply_comment` with an anonymised handle, `news_greenscreen` with no outlet logo, `meme`) produces stored assets at the export sizes, passes Q4 and hands over exactly one `publish.prepare`.
- **L:**
  - The new default (2/2/1/2/2/1) and the winner default (~17) hold the core-format invariants in the calendar, the policies and the levers.
  - `recommend` uses the archetype, `formatBenchmarks` (or the default), the ladder and the budget, with a reason and cost per line. The plan is adopted at launch, editable (persona page, chat, generator), read by the CadencePolicy, and re-tuned by the format lever within bounds.
  - The Stories engine makes 3–5 frames a day with the right mix (a sell frame only on sell days). The frames pass QC + Gate (`story_frame`) and reach the ledger. They publish as `kind: 'story'` only where `storyCapabilities` says so, after the kill-switch check, with the AI flag.
  - Highlights are curated. Story metrics are ingested.
  - The Stories lane renders on the Pipeline board and on the persona page.
  - The archive check passes on a fresh DB.

**After all four merges (integrator):** an E2E on fakes in `packages/wiring/test/`:
1. a draft with Radar evidence;
2. step 6 with a Format Plan and a World Bible;
3. the Owner's launch;
4. a week planned from the plan with beats;
5. a script grounded and checked;
6. a `photo_dump` slot rendered with compiled prompts;
7. a day of story frames published to Instagram;
8. story metrics feeding the format lever.

## 8. Changing a contract

If you need a contract change (a new optional field, a new service method, a new provider member, a new shared type or job kind), stop and ask the integrator. Don't edit frozen files on your branch. Additive changes land on `dev` first, and every stream then merges `dev` into its branch. Until then, keep the extra data inside your own package or your own tables.
