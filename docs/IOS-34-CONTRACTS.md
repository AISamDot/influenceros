# IOS-3/4 build contracts

Four builders work in parallel on IOS-3 (media) and IOS-4 (distribution and money). This file is what they share: who owns which files, which migration filenames are reserved, the interfaces each stream exports or consumes, how shared files are edited, and the tests that must stay green. Follow it and the four branches merge into `dev` without conflicts.

- **Product spec:** `/Users/hossamhamdy/Desktop/Family/Hossam/Ventures/Influencer-OS/PRD.md`: §3.6 (QC), §3.8 (dashboard), FR-5 to FR-13, FR-20 to FR-22, §7 (integrations), §8 (architecture) and §8.6 (secrets). Where the PRD and the owner rules in §1 disagree, §1 wins. For example, talking reels use Higgsfield Seedance, not HeyGen.
- **Base:** branch from the `dev` commit that added this file (`git log -1 --format=%h -- docs/IOS-34-CONTRACTS.md`).
- **Contract stubs in that commit:**
  - empty packages `@ios/media` (E), `@ios/distribution` (F), `@ios/commerce` (G) and `@ios/products` (H), already composed by `@ios/wiring` and listed in `apps/web`;
  - root scripts `pnpm media|distribution|commerce|products`;
  - the shared types in `packages/agents/src/ios34.ts`;
  - the additive provider interfaces and fakes, including the new `audience` and `storage` members;
  - public persona-site routing in the proxy, the guard and the root layout;
  - persona-page panel stubs, a Settings → Accounts stub and a persona-site stub;
  - marked blocks for E to H in every shared file.

  `pnpm test` and `pnpm build` pass on that commit.

## 1. Owner rules every stream builds to

These are the IOS-2 rules (`docs/IOS-2-CONTRACTS.md` §1) plus the owner's IOS-3/4 decisions:

- **Fully automated:** no manual steps anywhere in the pipeline. The only exceptions are the Owner-only actions in the next point.
- **Killing or retiring a persona always needs the Owner's explicit approval.** So do spending above caps, disclosure or legal text changes, and creating platform accounts. Agents only ever propose these.
- **The Compliance Gate checks legal/platform lines only** (`@ios/content` `runGate` / `gatePost` / `gateReply`). Red never ships.
- **AI disclosure is the platform minimum:**
  - Every post sets the platform AI flag to **true**, always (`AI_FLAG_FIELDS` in `@ios/providers` are the studio's names; the Zernio adapter sends the vendor's, inside `platforms[].platformSpecificData`: TikTok `videoMadeWithAi`, Instagram/Pinterest `isAiGenerated`, YouTube `containsSyntheticMedia`). A post type that can't carry the flag through the API is never sent (TikTok photo posts and TikTok drafts); Facebook has no API field (Meta-side labelling) and is off by default.
  - The platform AI **profile** label is tracked per account (`account.ai_label_ok`).
  - Agents and community replies **never deny being AI**.
  - There's no bio line and no watermark.
- **English only.**
- **Cadence:** 10 posts a week per persona: 3 talking, 3 activity + on-screen text, 2 voiceover, 1 static, 1 carousel. Winners go up to 2–3 a day. The calendar, scripts, Q1 and the pre-render Gate already exist (IOS-2 B) and end with a `media.render` job.
- **Media for the pilot is all Higgsfield**, through the official CLI (installed with npm, never `curl | sh`) or the MCP, at **720p**:
  - Soul ID characters;
  - stills and Nano Banana images;
  - activity clips with Kling 3.0 Turbo, Kling or Wan, from a start image;
  - talking clips with Seedance 2.0/2.5 and `--audio`, at most 15 s each, so a 30 s reel is 2 clips.

  The talking provider stays pluggable: `providers.talking` has a Higgsfield Seedance adapter and a fal Kling AI Avatar v2 fallback.
- **Exports** are 1080×1920 (carousels 1080×1350) with a sharpening pass.
- **Voice** is ElevenLabs (Creator plan), with Higgsfield TTS as an option.
- **Rendering** runs on the Mac worker (Remotion/FFmpeg).
- **Distribution and money:**
  - Zernio for publishing, comments, comment-to-DM and analytics.
  - Lemon Squeezy as merchant of record: one store per persona, a read-only products API, and webhooks.
  - Resend for email.
  - A studio domain with one subdomain per persona.
- **Everything works in fake mode with no keys, and is ready for real keys.** The Keychain names already exist (`pnpm ios secrets status`). Tests never reach a live provider: `vitest.config.ts` sets `IOS_FAKE_PROVIDERS=1` and `IOS_KEYCHAIN=off`.

## 2. Streams, branches and the tests to keep green

| Stream | Branch | Scope |
|---|---|---|
| **E** Media pipeline (IOS-3) | `ios34-e-media` | (1) **Higgsfield adapter** behind `ImageVideoProvider` (+ `TalkingProvider` `higgsfield-seedance`). It shells out to the official CLI (`higgsfield generate create / cost / status`, `upload`) or uses the MCP. It covers: Soul ID training from the persona's look-prompts; character sheet and look-pack stills; Nano Banana stills; image-to-video activity clips (start image); talking clips via Seedance 2.0 at 720p with `--audio` (≤ 15 s, 2 clips per 30 s reel); and a `generate cost` probe that writes model prices into config. Credits are debited through the governor at the actual cost. The fal Kling AI Avatar v2 adapter is the fallback. (2) **Voice:** ElevenLabs TTS on the existing secret, with a Higgsfield TTS option, producing per-persona voice tracks (QC Q2 via `@ios/content` `voiceCheck`). (3) **Render worker** (`media.*` jobs, run by `apps/worker` / the inline worker) on Remotion/FFmpeg, adapting Brand OS `packages/creative` + `apps/creative-worker` patterns. It handles the 5 formats: talking reel (2 clips stitched with cutaways); activity + on-screen text (6–10 s loop); voiceover reel (3 activity shots + narration + captions); static image + caption; carousel (6–8 slides, 4:5). It burns captions in the safe zones, exports 1080×1920 (carousels 1080×1350) with sharpening, applies the persona colour grade, and sets the AI-flag metadata the post record gets. (4) **QC Q3** (avatar: face similarity against the persona reference, using a local face-embedding model with a commercial licence or a vision-model check through the runtime; artefacts; frozen frames). **QC Q4** (FFmpeg ebur128 −14 LUFS ±1, true peak ≤ −1 dBTP, silencedetect > 0.7 s, blackdetect, freezedetect, resolution/fps/duration via ffprobe, caption OCR against the transcript through an OCR interface with a fake). Auto-fix loop at most 2, then block with a report. (5) The `media.render` handler wired after the Gate, with **render thumbnails on the Pipeline board**. |
| **F** Distribution + community + analytics (IOS-4) | `ios34-f-distribution` | (1) **Zernio adapter** (real HTTP behind `PublishProvider`, plus the fake). It handles `publish.prepare` (posts per platform: TikTok and Instagram first, YouTube Shorts after the persona's day 30), **always sets the AI flags true**, verifies the live post and stores the URL. It respects kill switches, the approval engine and publish idempotency, and supports draft-to-inbox mode for trending-sound posts. (2) **Comments and DMs** ingestion (Zernio webhooks or polling) and a **Community worker**. It classifies each item (`COMMUNITY_CLASSES`), then acts by policy: hide spam, reply in persona voice through the Gate reply check, comment keyword → DM with the lead-magnet link, never deny being AI. It escalates S1 (crisis: stop replying, send the approved helpline text only) and S2 to Owner notifications. All third-party text is fenced as untrusted, with reply budgets. (3) **Analytics ingestion:** per-post metrics (views, watch time, likes, saves, shares, follows, profile visits, link clicks) into `metric_snapshot` at 1h/24h/72h/7d, feeding the Profit Engine and per-persona scorecards. (4) **Settings → Accounts** per persona: handles, platform AI-profile-label status and the account-setup sheet (handle, bio, profile image, link, label instructions) the Owner uses to create the accounts. |
| **G** Commerce + audience + persona sites (IOS-4) | `ios34-g-commerce` | (1) **Lemon Squeezy adapter:** read stores and products, verify webhooks (signature), store orders, refunds and subscriptions, and attribute through per-post coupons and short links. The Owner creates LS products from listing packs **only if unavoidable**. Prefer API-less automation: a listing pack plus checkout URLs stored per product, with a clear status in the dashboard. (2) **Persona micro-sites** on the studio domain, one subdomain per persona (host routing is in place; locally `/p/<slug>`). Each has a link-in-bio page, a lead-magnet opt-in page with double opt-in for EU sign-ups, product pages linking to the LS checkout, and a thank-you page with the upsell. Each is styled from the persona's bible palette (`loadPersonaKit`). (3) **Resend:** a list per persona with consent records, a 5-email welcome sequence engine (agent-written, Gate-checked), broadcasts, unsubscribe, a physical-address footer setting and webhook events. (4) **Membership:** LS subscriptions gate a monthly drop (members area on the persona site with magic-link access). Discord gating comes later behind an interface. (5) **Attribution end to end:** post → short link / coupon → order → persona/post P&L (the Profit Engine already reads `orders` attribution). |
| **H** Product Builder + robustness (IOS-4) | `ios34-h-products` | (1) **Product Builder** (PRD FR-9, `workbook-builder` skill). It goes from product brief → structured content (sections, named rules, tick-box trackers, fill-in pages, bonus pages) → styled HTML in the persona's visual identity → PDF via headless Chrome (A4 and US Letter). A Google Sheets / Notion template option sits behind interfaces with fakes. **QC QP:** the PDF opens, fonts are embedded, there's no placeholder text, the TOC and page numbers are right, the links work, and every promised section is present. Then a listing pack and the Owner's v1 card. (2) **Content import:** ready-written manuscripts (markdown files dropped in a folder) render to finished PDFs through the same pipeline. (3) **Robustness:** (a) a **PGlite single-process lock**: any CLI that opens the local DB (`owner` login-link and set-password, `knowledge` import, `db:*` scripts, `content`, `profit`, `worker`, seed) refuses with a clear message, or routes through the running server's API, when another process holds `.data/pglite`. (b) The studio header says "5 personas live" while all are in SETUP: count only TESTING and later states as live, and show the setup count. (c) `pnpm owner login-link` prints the configured app URL and port (`IOS_PUBLIC_URL`, else `PORT`, else 3100), not 3000. |

**Every builder keeps these green, in the foreground, before every handoff:**

```
source ~/.nvm/nvm.sh; nvm use --delete-prefix 22.23.3 --silent
pnpm test        # Vitest across all packages and apps (includes packages/wiring/test, the merge guard)
pnpm build       # pnpm -r typecheck + next build
```

While working, `pnpm vitest run packages/<yours>` is the quick loop.

**Rules for every builder:**
- Never leave a test run going in the background.
- Never push.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit secrets.
- Quote paths: they contain spaces.

**Local databases and servers:** a preview dev server runs on port 3100 from the dev worktree against `.data/pglite`. **Never open that directory from another process** (two processes corrupt PGlite). For any manual run:
- Use a scratch data dir and another port, for example:

  ```
  export PGLITE_DIR="$(mktemp -d)/pglite"
  pnpm db:setup
  pnpm --filter @ios/web exec next dev --hostname 127.0.0.1 --port 3201
  ```
- Don't start a dev server on 3100.
- Tests use in-memory PGlite and are always safe.

**Merge order (integrator):** H → E → F → G. Any order works, because the streams share only the contracts. This order lands the PGlite lock first and lights up the media → publish path next. After each merge, the integrator runs `pnpm install`, `pnpm test` and `pnpm build`. After all four, the integrator adds the cross-stream E2E test in `packages/wiring/test/` (§7).

## 3. How the packages fit together

```
@ios/db ← @ios/core ← @ios/agents (contracts + ios34.ts + runtime)
              ↑                ↑
   @ios/providers        @ios/content · @ios/knowledge · @ios/profit   (IOS-2, read-only libraries now)
   (interfaces + fakes)        ↑
                        @ios/media (E) · @ios/distribution (F) · @ios/commerce (G) · @ios/products (H)
                               ↑
                        @ios/wiring (composition root) ← apps/web, apps/worker, cron tick
```

**Dependencies:**
- E, F, G and H may depend on `@ios/agents`, `@ios/core`, `@ios/db`, `@ios/providers` and, read-only, the IOS-2 packages `@ios/content`, `@ios/knowledge` and `@ios/profit`. Examples: `gatePost`, `gateReply`, `runGate`, `voiceCheck`, `buildListingPack`, `ProductBrief`, `readLaunchDoc` from `@ios/core/seed`, `personasSourceDir`.
- **They never import each other.** Cross-stream work goes through the job queue (§5.1), the database (§5.6) and the shared types in `@ios/agents` `ios34.ts`.
- Each package already lists `agents`, `content`, `core`, `db` and `providers`. Add `@ios/knowledge` or `@ios/profit` to your own `package.json` if you need them.

**Every package's `src/index.ts` exports a `StudioModule`:** `tools`, `jobs`, `schedules` and `liveProviders(env)`. The stubs exist. Replace their bodies and keep the names and signatures. `@ios/wiring` composes all eight modules and throws on a duplicate tool, job kind, schedule or provider member. Nobody edits wiring: you plug in through your own exports.

**Tests:**
- Build services with `createTestStudio()` / `makeTestPersona()` from `@ios/agents/testing`.
- `createFakeProviders()` now includes `audience` (`FakeResendAudience`) and `storage` (`MemoryMediaStore`).
- Never import another package's `test/` folder.
- Never depend on the seed's personas.

## 4. Ownership

You may create and edit only what your stream owns. Anything not listed is frozen for IOS-3/4: ask the integrator.

### Stream E: `ios34-e-media`
- **Packages:**
  - `packages/media/**`;
  - `packages/content/src/board.ts` (Pipeline board read model: real media stages, thumbnails, block reasons);
  - in `packages/providers/src/fakes.ts`, the bodies of `FakeHiggsfield`, `FakeTalking` and `FakeVoice` (behaviour only: keep the members the interfaces require);
  - new files under `apps/worker/src/media/` if the Mac worker needs media-only commands (keep `apps/worker/src/app.ts` and `main.ts` unchanged).
- **`apps/web/` files:**
  - `app/pipeline/**`, `app/api/pipeline/**`, `components/pipeline-*.tsx`;
  - `app/api/media/**` (Owner-only file serving from `providers.storage`);
  - `app/api/public/media/**` (serves **only** `public/…` keys, checked with `isPublicMediaKey`);
  - `components/media-*.tsx`, including `media-persona-panel.tsx`.
- **Migrations:** `0009_e_*.sql`.
- **Tables E may alter:** `asset`, `qc_report`, `qc_defect`, `qc_standard`, plus new tables prefixed `media_` (generation log, price table from the cost probe, persona Soul ID / voice / colour grade). E writes `calendar_slot.status` / `thumbnail_url` / `block_reason` and `persona.portrait_url` / `look_pack` without altering those tables.
- **Namespaces:**
  - tools: `media.*`, `voice.*`;
  - jobs: `media.*` (registers the existing `MEDIA_RENDER_JOB` = `media.render`), `voice.*`;
  - schedules: `media.*`.
- **Agents:** `video-producer` (it may also run `quality-control` tasks for the Q3 vision check).
- **Live providers:** `imageVideo`, `talking`, `voice`, `storage`.
- **Integrations:** the `higgsfield`, `fal` and `elevenlabs` entries (inside the stream E block of `packages/secrets/src/integrations.ts`). Flipping `elevenlabs` to `liveAdapter: true` also turns on B's existing ElevenLabs Speech-to-Text for QC Q2 (intended).

### Stream F: `ios34-f-distribution`
- **Packages:**
  - `packages/distribution/**`;
  - `packages/core/src/publish.ts` (pass the IOS-4 `PublishRequest` fields, vendor media URLs and draft-to-inbox; keep every existing check and the idempotency key);
  - the matching `packages/core/test/publish.test.ts`;
  - in `packages/providers/src/fakes.ts`, the body of `FakeZernio`;
  - in `packages/content/src/monetization.ts`, only the views query in `evaluateValidations`: take the latest snapshot per post, because F writes several windows per post.
- **`apps/web/` files:**
  - `app/settings/accounts/**` (replace the stub), `app/community/**`, `app/api/distribution/**`, `app/api/webhooks/zernio/**`;
  - `components/distribution-*.tsx` (including `distribution-persona-panel.tsx`), `components/community-*.tsx`, `components/accounts-*.tsx`.
- **Migrations:** `0010_f_*.sql`.
- **Tables F may alter:** `post`, `account`, `comment`, `dm_thread`, `escalation`, `metric_snapshot`, plus new tables prefixed `publish_`, `community_` (except `community_member` and `community_event`, which are G's), `analytics_`.
- **Namespaces:**
  - tools: `publish.*`, `community.*`, `analytics.*`, `accounts.*`;
  - jobs: the same (registers `PUBLISH_PREPARE_JOB` = `publish.prepare`);
  - schedules: the same.
- **Agents:** `community-manager`.
- **Live providers:** `publish`.
- **Integrations:** the `zernio` entry.

### Stream G: `ios34-g-commerce`
- **Packages:**
  - `packages/commerce/**`;
  - in `packages/providers/src/fakes.ts`, the bodies of `FakeLemonSqueezy` and `FakeResendAudience`.
- **`apps/web/` files:**
  - `app/p/**` (persona sites; replace the stub), `app/l/**` (short links);
  - `app/api/public/**` **except** `app/api/public/media/**`;
  - `app/api/webhooks/lemonsqueezy/**`, `app/api/webhooks/resend/**`;
  - `app/commerce/**` (Owner dashboard: stores, product status, lists, members), `app/api/commerce/**`;
  - `components/commerce-*.tsx` (including `commerce-persona-panel.tsx`), `components/site-*.tsx`.
- **Migrations:** `0011_g_*.sql`.
- **Tables G may alter:** `product`, `product_listing`, `offer`, `short_link`, `coupon`, `orders`, `refund`, `subscriber`, `email_sequence`, `email_event`, `membership`, `community_member`, `community_event`, plus new tables prefixed `store_`, `site_`, `email_`, `member_`, `consent_`, `commerce_`.
- **Namespaces:**
  - tools: `store.*`, `site.*`, `email.*`, `membership.*`, `attribution.*`;
  - jobs: the same;
  - schedules: the same.
- **Agents:** `email-writer`.
- **Live providers:** `store`, `audience` (Resend lists on the existing `resend.api_key`; A's `email` member stays for sign-in links).
- **Integrations:** the `lemonsqueezy` entry.

### Stream H: `ios34-h-products`
- **Packages:**
  - `packages/products/**`.
  - **Robustness (a), the PGlite lock:**
    - `packages/db/src/client.ts` (`openDb` / `createPglite` take and release the lock) and a new `packages/db/src/lock.ts`;
    - `packages/db/src/cli/*.ts`, `packages/core/src/seed/cli.ts`;
    - `packages/auth/src/cli.ts`, `packages/knowledge/src/cli.ts`, `packages/content/src/cli.ts`, `packages/profit/src/cli.ts`;
    - `apps/worker/src/main.ts`;
    - the matching tests, in a new `packages/db/test/lock.test.ts`.
  - **Robustness (b), the studio header:** `studioTotals` in `packages/core/src/queries.ts`, and the header line and KPI in `apps/web/app/page.tsx`.
  - **Robustness (c), the login link:** `packages/auth/src/cli.ts`. Use `appOrigin()` semantics: `IOS_PUBLIC_URL`, else `PORT`, else 3100.
- **`apps/web/` files:** `app/products/**`, `app/api/products/**`, `components/products-*.tsx` (including `products-persona-panel.tsx`).
- **Migrations:** `0012_h_*.sql`.
- **Tables H may alter:** `product_version`, `product_brief`, plus new tables prefixed `product_build`, `product_manuscript`, `product_template`.
  - H inserts `product` rows for imported manuscripts and moves `product.status` through `building → qc → awaiting_approval`, but never alters the `product` table (that's G).
  - H writes `qc_report` rows (`subject_type 'product'`, `stage 'QP'`) without altering `qc_*` (that's E).
- **Namespaces:**
  - tools: `product.*`, `workbook.*`;
  - jobs: `product.*` (registers `PRODUCT_BUILD_JOB` = `product.build`);
  - schedules: `product.*`.
- **Agents:** `product-builder` (strong tier; loads the `workbook-builder` skill).
- **Live providers:** none in `Providers`. Chrome PDF, Sheets and Notion sit behind H's own interfaces with fakes.

### Frozen (nobody edits during IOS-3/4)
- **`packages/agents/**`**, except your own marked blocks in `contracts.ts` (§6). `src/ios34.ts` is integrator-only.
- **`packages/providers/src/types.ts` and `storage.ts`.** The interfaces in §5.3 are the contract. Need a field? Ask the integrator (§8).
- **`packages/db/**`**, except your own migration files and H's lock files.
- **`packages/core/src/`**, except F's `publish.ts` and H's `queries.ts` (`studioTotals`) and `seed/cli.ts`. That includes `metered.ts`, `approvals.ts`, `policy.ts`, `queue.ts`, `governor.ts`, `killswitch.ts` and `types.ts`.
- **`packages/content/**`, `packages/knowledge/**` and `packages/profit/**`**, except the files named above.
- **`packages/auth/src/guard.ts`, `apps/web/proxy.ts`, `apps/web/app/layout.tsx`.** Public routing is already in place (§5.5).
- **`packages/secrets/**`**, except your own integration entries.
- **`packages/wiring/**`.**
- **`apps/web/package.json`, root `package.json`, `tsconfig.base.json`, `vitest.config.ts`.** Your CLI script already exists (`pnpm media|distribution|commerce|products` → `packages/<yours>/src/cli.ts`). Give it subcommands.
- **`apps/web/app/personas/**`, `app/settings/page.tsx` and the other existing pages.** Your persona-page panel is your own component (§6).
- **`docs/BUILD_PLAN.md` and this file** (integrator only).

## 5. Shared interfaces and types

| Contract | Where | Implemented by | Consumed by |
|---|---|---|---|
| `MEDIA_RENDER_JOB`, `MediaRenderPayload` | `@ios/agents` `contracts.ts` (IOS-2) | B enqueues (exists) | E handles |
| `PUBLISH_PREPARE_JOB`, `PublishPreparePayload`, `RenderedMedia` | `@ios/agents` `ios34.ts` | E enqueues | F handles |
| `enqueueOnceFor` (one cross-stream job per subject) | `ios34.ts` | integrator | E, F, G, H |
| `PRODUCT_BUILD_JOB`, `ProductBuildPayload`, `ProductFile` | `ios34.ts` | H (enqueues and handles) | G reads `product_version.files` |
| `COMMUNITY_CLASSES` / `CommunityClass` | `ios34.ts` | F writes `comment.classification`, `dm_thread.classification` | B's Monetization Agent (`question`, `purchase_intent`), dashboards |
| `METRIC_WINDOWS`, `METRIC_WINDOW_MS` | `ios34.ts` | F writes `metric_snapshot.window` | D (P&L, levers), scorecards |
| `personaSiteUrl`, `shortLinkUrl`, `appOrigin`, `SITE_PATHS`, `RESERVED_SUBDOMAINS` | `ios34.ts` | G serves the pages | F (bio link, DM links), E/H (links in media and PDFs) |
| `PersonaKit`, `loadPersonaKit`, `parsePalette`, `kitColors` | `ios34.ts` | integrator | E (grade, captions), G (sites, emails), H (PDFs) |
| `ImageVideoProvider` (+ `upload`), `TalkingProvider`, `VoiceProvider` | `@ios/providers` | E (live) | E |
| `PublishProvider` (+ IOS-4 members), `AI_FLAG_FIELDS` | `@ios/providers` | F (live) | F, core `publishPost` |
| `StoreProvider` (+ IOS-4 members), `AudienceProvider` | `@ios/providers` | G (live) | G |
| `MediaStore`, `LocalMediaStore`, `MemoryMediaStore`, `mediaUrl`, `isPublicMediaKey` | `@ios/providers` `storage.ts` | E (live member) | E, F, G, H |
| Gate (`runGate`, `gatePost`, `gateReply`), Q2 (`voiceCheck`), listing packs (`buildListingPack`), `ProductBrief` | `@ios/content` | B (done) | E, F, G, H |
| `metered()`, `propose()`, `publishPost()`, `notify()`, `enqueue()`, `audit()` | `@ios/core` | A (done); F owns `publish.ts` now | all |

### 5.1 Jobs, schedules and the cross-stream flow

```
B  pipeline.slot ──► media.render (MediaRenderPayload)                                      [exists]
E  media.render: voice → Q2 → generate (Higgsfield, governor) → render → Q3 → Q4 (≤ 2 fixes)
     ├─ blocked: calendar_slot.status 'blocked' + block_reason + qc_report + notify(Owner)
     └─ passed:  calendar_slot.thumbnail_url = cover; status 'final_gate'
                 enqueue publish.prepare (PublishPreparePayload)       ── once per slot ──►
F  publish.prepare: post per platform ('awaiting_approval', ai_flag true) → post-level Q4 (links, caption,
     hashtags, AI flag, cover) → gatePost (pre_publish) → core propose({ kind: 'post', … }) → slot 'scheduled'
   publish.due (schedule) → publish.post: upload media → core publishPost (kill switches, approval, Gate,
     QC, idempotency key = post id, aiLabel true) → verify → post 'live' + url → slot 'live'
   analytics.pull (schedule) → metric_snapshot at 1h / 24h / 72h / 7d                      ──► D's P&L
   community.poll / webhook → comment, dm_thread → community.handle (classify, act, escalate)
G  attribution sweep → short_link + coupon per scheduled/live post; /l/<code> redirects and counts
   LS webhook → orders (source_post_id, coupon_id, short_link_id) / refund / membership     ──► D's P&L
H  product.sweep → product.build (brief or manuscript) → PDFs A4 + Letter → QP → Gate → product_version v1
     → product 'awaiting_approval' + core propose product_v1 (24 h card)
G  product 'approved' → listing pack + checkout URL status → 'live' once a checkout URL is stored
```

**Job and schedule rules:**
- **Job kinds are `<namespace>.<verb>`** within your namespaces. Enqueue with core `enqueue()`, always with `personaId` for persona work.
- **Handlers are idempotent.** They resume from stored state and throw `DeferJob` to wait without spending an attempt (for example on a capped governor). They pass `ctx.job` through untouched.
- **A cross-stream job is enqueued at most once per subject.** Use `enqueueOnceFor(db, { kind, key, … }, { ever: true })` from `@ios/agents`, with keys like `slot:<slotId>` and `product:<productId>:v<N>`. Its handler is also idempotent per subject.
- **The worker claims only kinds that have a handler.** Until F merges, `publish.prepare` jobs simply wait. Until H merges, nothing enqueues `product.build`.
- **Schedules are cheap and idempotent:** enqueue, don't work inline. D's scheduler runs `allSchedules()` on every tick.
- **Long jobs call `heartbeat()`.** Renders and Higgsfield polling do. On `false`, stop.
- **Media jobs must run on the Mac** (FFmpeg, Chrome, the Higgsfield CLI). In dev the inline worker in the Next server runs them. With `DATABASE_URL`, `pnpm worker` on the Mac does.

### 5.2 Cost and credits

- **Every paid call goes through the governor.** Use core `metered(db, ctx, spec, call, actual)` with `ctx.ref`:
  - Higgsfield: unit `hf_credits`, estimate from E's probed price table, settle with the credits the CLI reports;
  - ElevenLabs, fal and Zernio paid calls: `media_usd`;
  - LLM work goes through `services.runtime.run()` with `costRef`.
- **Refs:**
  - slot media work → `{ type: 'calendar_slot', id: slotId }`;
  - per-post work after publish (community replies, analytics) → `{ type: 'post', id }`;
  - product builds → `{ type: 'product', id }`;
  - email-writer → `{ type: 'persona', id }`.
- **Over a cap the governor refuses.** Defer the job (6 h) and let the Studio Manager reallocate. Never raise a cap: a raise is an Owner proposal.

### 5.3 Providers (`@ios/providers`)

Additive changes in the base commit. Fakes are deterministic, record their calls, and never touch the network.

| Member | Additions | Live owner | Fake |
|---|---|---|---|
| `imageVideo` | optional `prompts` (Soul ID), `model`, `referenceImageUrls`, `resolution` (`'720p'`), `aspect`; **`upload({ filePath })`** | E | `FakeHiggsfield` |
| `talking` | optional `resolution`, `prompt` | E | `FakeTalking` (`higgsfield-seedance` or `fal-kling-avatar`) |
| `voice` | optional `modelId` on `tts` | E | `FakeVoice` (its URLs transcribe back exactly through `FakeTranscriber`) |
| `publish` | `PublishRequest`: `kind`, `title`, `coverUrl`, `mode: 'publish' \| 'draft_inbox'`, `platformOptions`; members `uploadMedia`, `hideComment`, `listDms`, `fetchMetrics`, `listAccounts`, `verifyWebhook`, `parseWebhook` (`DistributionEvent[]`) | F | `FakeZernio` (`inbox`, `accounts`, `sign()`) |
| `store` | `listProducts({ storeId? })`, `listStores`, `createCheckout` (custom data for attribution), `createDiscount`; `StoreProduct.storeId/variantId/checkoutUrl`; `StoreEvent` gains attribution fields and subscription lifecycle events | G | `FakeLemonSqueezy` (`stores`, `sign()`) |
| `audience` (**new**) | `ensureAudience`, `upsertContact`, `send` (with `headers` for List-Unsubscribe), `sendBroadcast`, `verifyWebhook` (Svix headers), `parseWebhook` | G | `FakeResendAudience` |
| `storage` (**new**) | `put`, `putFile`, `get`, `localPath`, `url` | E (`LocalMediaStore` on `IOS_MEDIA_DIR`, default `<repo>/.data/media`; the memory store under Vitest) | `MemoryMediaStore` |

**Rules:**
- **Live adapters live in your own package**, returned from your `liveProviders(env)` only when `env.isLive('<integration>')`. `@ios/wiring` overlays them on the fakes. Two packages supplying the same member is an error.
- **Read keys only through `env.secret(name)`.** Never log them, store them, put them in prompts or argv, or pass them to a subprocess except through its environment. For example, the Higgsfield CLI gets `HIGGSFIELD_API_KEY` / `HIGGSFIELD_API_SECRET` in its child env.
- **New optional secrets exist:** `zernio.webhook_secret` and `resend.webhook_secret`. Without one, the adapter polls instead of accepting webhooks.
- **The AI flag can't be switched off.** `aiLabel: true` is a literal type. A live adapter maps it to `AI_FLAG_FIELDS[platform]` and refuses anything else.
- **Media keys are POSIX paths validated by `isValidMediaKey`.** Only `public/…` keys may be served without the Owner session. Suggested layout:
  - `media/<personaId>/<slotId>/…`;
  - `products/<personaId>/<productId>/v<N>/…`;
  - `public/<personaSlug>/…`.
- **Local tooling stays inside the owning package, behind its own interface with a fake.** That covers FFmpeg/ffprobe, Remotion, OCR, face embeddings, headless Chrome PDF, and Sheets/Notion. There's no system `ffmpeg` on this Mac: use Remotion's bundled binaries or a pinned npm static build, never `brew` or `curl | sh` from code. Tests never need the binaries.

### 5.4 Agents and runtime

- **New agent names, already in `AgentName` and `DEFAULT_ROUTING`:** `video-producer` (standard), `community-manager` (standard; classification passes `tier: 'fast'`), `email-writer` (standard), `product-builder` (strong). Add more only inside your block (§6).
- **Every model call goes through `services.runtime.run()`** with a deterministic `fake()`.
- **Third-party text is untrusted.** Comments, DMs, email replies, web pages and imported manuscripts go inside clearly fenced blocks, and the task sets `trust: { untrusted: true }`. Tools that return such text set `untrustedOutput: true`. Mutating tools the model may call from an untrusted run need `ownerIntent`. Otherwise the registry refuses them.
- **Owner-only actions are never agent tools that act.** These are proposals through the approval engine: kills, cap raises, disclosure or legal text (including the crisis helpline text), and creating accounts.

### 5.5 Public persona sites (routing done in the base commit)

- **Production.** `https://<slug>.<IOS_STUDIO_DOMAIN>/<path>`: the proxy rewrites it to `/p/<slug>/<path>`. `/l/*`, `/api/public/*` and Next's assets pass through unchanged. A persona host can never reach a dashboard page or API: everything else is rewritten under `/p/<slug>`. Reserved subdomains (`RESERVED_SUBDOMAINS`) and nested labels get 421.
- **Local.** `http://localhost:3100/p/<slug>/…` (any port).
- **Public paths (no Owner session):** `/p/*`, `/l/*`, `/api/public/*`, `/api/webhooks/*`. The root layout renders `/p/*` and `/l/*` bare: no nav, no session check, no studio data. G's own `app/p/[slug]/layout.tsx` styles the site from `loadPersonaKit`. The proxy sets `x-ios-site` and strips a client-sent one.
- **Mutating `/api/public/*` calls must be same-origin** (the proxy enforces it). Add rate limits, honeypots and no account enumeration in G's handlers.
- **Fixed paths other streams link to:** `SITE_PATHS.home` (`/`, the profile link) and `SITE_PATHS.freebie` (`/free`, the lead magnet). G owns every other path, for example `/shop/<product>`, `/thanks/<product>`, `/members`, `/unsubscribe`, `/privacy`, `/confirm`.
- **Members' magic-link sessions use their own cookie,** for example `ios_member`. It's host-only and HttpOnly, and is never the Owner's `ios_session`.

### 5.6 Database contracts between streams

| Row | Writer | Contents / rule | Readers |
|---|---|---|---|
| `asset` | E | One per file: `type` (`video`/`image`/`audio`/`carousel`/`thumbnail`), `url` = `storage.url(key)`, `render_meta.storage_key`, `render_meta.ai = { generated: true, tools: [...] }`, `credit_cost`, `usd_cost`, `phash` | F (publish), dashboard |
| `calendar_slot.status` | E (`voice`, `q2`, `rendering`, `q3`, `q4`, `final_gate`, `blocked`); F (`scheduled`, `live`) | Board stages via `stageOf`; `thumbnail_url` = cover; `post_id` = the primary platform post | Pipeline board, persona calendar |
| `qc_report` | E (`asset` Q3/Q4); F (`post` Q4 links and metadata); H (`product` QP) | `details.checks: QcCheck[]`, failures mirrored in `qc_defect` with timestamps / pages / frame grabs | publish path (`post` Q4 must pass), Approvals |
| `post` | F | One per platform per slot, `ai_flag` always true, status per core | D, G (attribution), dashboards |
| `account` | F (Owner actions in Settings → Accounts) | `status`, `handle`, `token_ref` = vendor account ref, `ai_label_ok` | core Gate (`gatePost` ambers a missing profile label), F |
| `metric_snapshot` | F | Post rows: one per `(post_id, window)`, cumulative values, `captured_on` = capture date. Account rows (`post_id` NULL): one per persona, platform and day, with that day's views and the follower count | D, studio wall, scorecards |
| `comment`, `dm_thread`, `escalation` | F | `classification` ∈ `COMMUNITY_CLASSES`; S1/S2 also notify the Owner; `dm_thread.status 'bot_paused'` stops replies | B's monetization (demand signals), dashboard |
| `short_link`, `coupon` | G | Per post (`post_id` / `source_post_id`), created by G's sweep for scheduled/live posts | F (DM link: the post's short link, else `personaSiteUrl(slug, SITE_PATHS.freebie)`), D |
| `orders`, `refund`, `membership`, `subscriber`, `email_*` | G | Attribution: checkout custom data `post_id`, then coupon, then short link | D (P&L), dashboards |
| `product` | B creates at `brief`; H moves `building → qc → awaiting_approval`; core sets `approved`; G sets `live` | G alone alters the table (for example `checkout_url`, store status) | all |
| `product_version` | H | `files: ProductFile[]` (H's migration), `file_url` = the A4 PDF | G (delivery, listing packs) |

### 5.7 Dashboard conventions

- **Owner pages call `requireOwnerPage()`**, and Owner API routes check the session row like A's routes do. New routes are protected automatically by the proxy. Don't add public routes outside §5.5.
- **Your persona-page panel is your own server component**, already rendered on the persona page: `MediaPersonaPanel`, `DistributionPersonaPanel`, `CommercePersonaPanel`, `ProductsPersonaPanel`, with props `{ db, studioId, personaId, slug }`. Catch your own errors and return null on failure.
- **Agent messages go through core `addMessage`** with `role 'agent'`, `author 'agent:<name>'` and `meta.kind`. **Owner notifications go through core `notify`** with a `link` to the page that resolves them.
- **Light/dark tokens and utilities already exist.** Add CSS only inside your block in `globals.css`.

## 6. Editing shared files

**Marked blocks.** Add lines only between your own stream's markers, for example:

```
// >>> stream F nav (append only)
// <<< stream F nav
```

Never edit, reorder or delete anything outside them, including other streams' blocks and the markers themselves.

| File | E / F / G / H blocks for |
|---|---|
| `packages/agents/src/contracts.ts` | `AgentName` members and `DEFAULT_ROUTING` entries (additive only) |
| `packages/secrets/src/integrations.ts` | your integrations' entries (E: higgsfield, fal, elevenlabs; F: zernio; G: lemonsqueezy) |
| `apps/web/components/nav.tsx` | nav links: F `/community`, G `/commerce`, H `/products`, E none needed; Settings stays last |
| `apps/web/next.config.ts` | `serverExternalPackages` (for example `@remotion/renderer`, `@remotion/bundler`, `playwright-core`) |
| `apps/web/app/globals.css` | CSS |
| `pnpm-workspace.yaml` | `onlyBuiltDependencies` |
| `.env.example` | env variables (names and comments, never values) |
| `docs/ARCHITECTURE.md` | your stream's section |

**Your own files on shared pages:**
- Your persona-page panel component, the Settings → Accounts page (F) and the persona-site pages (G). The page that renders each one doesn't change.
- In `packages/providers/src/fakes.ts`, only your own fake classes' bodies (§4). Keep their members and constructor signatures, and don't touch `createFakeProviders`.

**`package.json` files** (JSON has no comments):
- Add third-party dependencies to **your own package's** `package.json` only, pinned to exact versions.
- Don't edit the root or `apps/web` `package.json`. Your package is already a dependency of the web app and of wiring. If a client component needs a library, ask the integrator.

**`pnpm-lock.yaml`:** never hand-merge it. On a conflict, the integrator keeps `dev`, runs `pnpm install` and commits.

**Migrations:**
- Reserved files: `0009_e_*.sql` (E), `0010_f_*.sql` (F), `0011_g_*.sql` (G), `0012_h_*.sql` (H). If you need more than one, use `0009_e_2_*.sql` and so on.
- Never edit `0001`–`0008` or another stream's file, and never rename a migration once committed (the filename is the version).
- A migration may reference only objects from `0001`–`0008` and your own.
- Only the owning stream alters a table (§4).
- Everything must run on PGlite and Supabase Postgres.

## 7. Definition of done

**All streams:**
- `pnpm test` and `pnpm build` green.
- New behaviour covered by tests in your own package, on fakes.
- `docs/ARCHITECTURE.md` updated inside your block.
- The wiring merge guard passes.
- No secrets committed.
- Live adapters exist and switch on with the keys, but tests never use them.

**Per stream (on fakes, tested):**
- **E:**
  - One `media.render` per format (talking, activity_text, voiceover, static, carousel) produces stored assets at the export sizes, a voice track with Q2, Q3 for talking clips, a passing Q4 report and exactly one `publish.prepare` job.
  - A bad clip (frozen frames, wrong loudness, caption mismatch) fixes itself in ≤ 2 loops or blocks the slot with a report and an Owner notification.
  - Credits are debited through the governor at the actual cost, and a capped persona defers.
  - The Pipeline board shows the media stages with thumbnails.
  - `pnpm media sample <format>` produces one real sample per format when the Higgsfield and ElevenLabs keys are present, debited through the governor on a scratch DB. Without keys it reports "pending key".
- **F:**
  - `publish.prepare` creates one post per target platform with the AI flag on, passes the post-level Q4 and Gate, and gets a post approval (veto window or explicit by autonomy).
  - `publish.post` publishes through Zernio with the platform AI flag, verifies, stores the URL, and never double-posts (idempotency key) or publishes past a kill switch.
  - Draft-to-inbox works.
  - Comments and DMs are classified into `COMMUNITY_CLASSES`:
    - spam is hidden;
    - replies pass `gateReply`, and a reply denying being AI is never sent;
    - a keyword comment gets a DM with the right link;
    - crisis pauses the thread, sends only the approved helpline text and notifies the Owner (S1);
    - reply budgets hold.
  - Metrics land at 1h/24h/72h/7d and feed the Profit Engine.
  - Settings → Accounts shows handles, AI-label status and the setup sheet.
- **G:**
  - A signed LS webhook creates an order attributed to the post (custom data, coupon or short link). A bad signature is refused. A replayed event is idempotent. Refunds and subscriptions update their rows.
  - `/p/<slug>` serves the bio, opt-in (double opt-in for EU), product and thank-you pages in the persona's palette. `/l/<code>` redirects and counts.
  - The welcome sequence sends 5 Gate-checked emails with unsubscribe and a physical-address footer.
  - A member signs in by magic link to the monthly drop.
  - Products show listing-pack / checkout-URL status.
- **H:**
  - A brief and a dropped-in manuscript each become A4 and Letter PDFs styled from the persona kit.
  - QP catches placeholder text, missing sections, broken links and unembedded fonts.
  - A passing product gets a listing pack and a 24 h product_v1 card.
  - A second process opening the same PGlite dir is refused with a clear message (and `pnpm owner login-link` works while the server runs, through its API or with a clear refusal).
  - The studio header counts only TESTING+ as live and shows the setup count.
  - `login-link` prints port 3100 by default.

**After all four merges (integrator):** an E2E test on fakes in `packages/wiring/test/`: post → metrics → order → scorecard → kill/scale card. Concretely: a slot rendered → published → metric windows → an attributed order → the persona's P&L and Profit card → a 4-week negative forecast creates one kill proposal that only the Owner can approve.

## 8. Changing a contract

If you need a contract change (a new optional field, a new provider member, a new shared type or job kind), stop and ask the integrator. Don't edit frozen files on your branch. Additive changes land on `dev` first, and every stream then merges `dev` into its branch. Until then, keep the extra data inside your own package or your own tables.
