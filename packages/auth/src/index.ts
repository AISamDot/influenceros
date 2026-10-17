/**
 * @troupe/auth (IOS-2 stream A): Owner login for the dashboard and API. A magic link to the Owner's email via Resend,
 * with a CLI-set scrypt password as the fallback; an Owner-only signed session cookie backed by a session row.
 * apps/web/proxy.ts runs `authorize` (from '@troupe/auth/guard', no database) on every request: everything is
 * protected except /login, /api/auth/*, /api/webhooks/*, /api/cron/* (Bearer CRON_SECRET) and /api/health.
 */
export * from './guard';
export * from './owner';
