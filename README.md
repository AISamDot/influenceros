# Influencer OS

A studio of openly AI influencer personas, each run by its own Persona Manager agent. A Studio Manager runs the whole studio end to end.

- Product spec: `../Ventures/Influencer-OS/PRD.md`
- Build plan: `docs/BUILD_PLAN.md` · Architecture: `docs/ARCHITECTURE.md`

## Run it
Node 22 and pnpm 10 (`source ~/.nvm/nvm.sh && nvm use 22.23.3`).

```
pnpm install
pnpm dev        # migrates + seeds local PGlite if empty, then serves http://127.0.0.1:3100 (loopback only)
pnpm test       # Vitest
pnpm build      # typecheck + Next.js build
pnpm db:reset   # wipe and reseed local PGlite (stop `pnpm dev` first)
pnpm ios secrets status
```

Set `DATABASE_URL` to use Postgres/Supabase instead of local PGlite. Every integration runs on a deterministic fake until its key and adapter exist (see Settings → Integrations).
