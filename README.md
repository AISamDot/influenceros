# Troupe House

A studio of openly AI influencer personas, each run by its own Persona Manager agent. A Studio Manager runs the whole studio end to end.

- Product spec: `../Ventures/Troupe-House/PRD.md`
- Build plan: `docs/BUILD_PLAN.md` · Architecture: `docs/ARCHITECTURE.md`

## Run it
Node 22 and pnpm 10 (`source ~/.nvm/nvm.sh && nvm use 22.23.3`).

```
pnpm install
pnpm dev        # migrates + seeds local PGlite if empty (an empty studio), then serves http://127.0.0.1:3100 (loopback only)
pnpm test       # Vitest
pnpm build      # typecheck + Next.js build
pnpm db:reset   # wipe and reseed local PGlite (stop `pnpm dev` first)
pnpm troupe secrets status
pnpm knowledge personas archived|restore <slug|all>|archive <slug|all>   # the persona archive
```

New personas are co-created in the Persona Generator (`/generator`); the 14 Oct launch five are archived (`/archive`).

Set `DATABASE_URL` to use Postgres/Supabase instead of local PGlite. Every integration runs on a deterministic fake until its key and adapter exist (see Settings → Integrations).
