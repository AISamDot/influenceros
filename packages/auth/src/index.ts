/**
 * @ios/auth (IOS-2 stream A): Owner login for the dashboard and API. Magic link to the Owner's email via Resend
 * (or a passkey), with a CLI-set hashed password as the fallback; an Owner-only session cookie. The proxy in
 * apps/web/proxy.ts protects every route except /login, /api/auth/*, /api/webhooks/* and /api/cron/* (secret).
 * Stream A fills this package.
 */
export {};
