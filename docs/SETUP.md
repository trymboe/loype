# Setup, configuration and deployment

## 1. Supabase

Project: **loype** (`ldqrjypjeikdtkzoqrsn`, region eu-north-1). The Phase 1 schema
(`supabase/migrations/0001_foundations.sql`) is already applied. For a fresh
project, run the files in `supabase/migrations/` in order (SQL editor or `supabase db push`).

Auth settings (Dashboard → Authentication):
1. **Sign In / Providers → Email**: enabled (magic link). You may disable "Allow new users to sign up" *after* your first sign-in.
1. After the first sign-in by email link, set a password under **More → Password**. Password sign-in needs no email, so it works on new browsers and in the iPhone home-screen app (which has its own storage, separate from Safari, and never receives magic links).
2. **URL Configuration**: Site URL = your Vercel production URL; add `https://<your-app>.vercel.app/auth/callback` (and `http://localhost:3000/auth/callback` for local dev) to Redirect URLs.

3. *(Optional, requires custom SMTP: Supabase only allows template edits with your own mail server.)* **Emails → Magic Link** template: replace the body with the following, so each email has both a code (works on any device) and a link that doesn't depend on the browser that requested it:

```html
<h2>Sign in to Løype</h2>
<p>Your sign-in code: <strong style="font-size:24px;letter-spacing:4px">{{ .Token }}</strong></p>
<p>Or <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">sign in with this link</a>.</p>
```

The built-in Supabase mailer only sends a few emails per hour. If you hit "Too many emails requested", wait, or configure custom SMTP (Authentication → Emails → SMTP settings).

Keys (Project settings → API): copy the **anon/publishable** key and the **service_role/secret** key into the environment variables below.

## 2. Environment variables

See `.env.example`. Set them in Vercel (Project → Settings → Environment Variables) and in `.env.local` for local development.

| Variable | Where it comes from | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API settings | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase API settings (anon / publishable) | no |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase API settings (service_role / secret) | **yes** |
| `ALLOWED_EMAIL` | your email; only this address can sign in | no |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` — encrypts the Garmin key and tokens at rest | **yes** |
| `CRON_SECRET` | `openssl rand -hex 32` | **yes** |
| `GARMIN_PERSONAL_API_KEY` | optional; normally pasted in the app instead | **yes** |
| `GARMIN_API_BASE_URL` | optional override if Garmin's data host differs | no |

Changing `TOKEN_ENCRYPTION_KEY` makes stored Garmin secrets unreadable; just paste the Garmin key again.

## 3. Garmin Personal API key

1. Go to <https://connect.garmin.com/app/settings/personalApiToken>, create a key (1-year expiry recommended), accept the terms, copy it (shown once).
2. In Løype: **More → Integrations → Connect Garmin**, paste the key and optionally its expiry date (for reminders).
3. Choose a history start date and press **Import**. Keep the page open for the fastest import; otherwise the scheduler continues it in the background.

## 4. Scheduled sync

- Every 30 minutes Supabase `pg_cron` calls `/api/cron/sync` through `pg_net` (migration `0006`). The migration generates the bearer token itself and keeps it in Supabase Vault (`loype_scheduler_token`); the app checks it with `verify_scheduler_token()`, so nothing has to be copied between Vercel and Supabase.
- The target URL is the Vault secret `loype_app_url` (default `https://loype.vercel.app`). To change it:
  `select vault.update_secret((select id from vault.secrets where name = 'loype_app_url'), 'https://…');`
- If Vercel Deployment Protection ever blocks that URL, add a [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) secret with `select vault.create_secret('<bypass>', 'loype_vercel_bypass');` and the scheduler sends it.
- `vercel.json` also registers a daily Vercel Cron (Hobby plans only allow daily) as a backstop, authenticated with `CRON_SECRET`.
- Check it: `select * from cron.job_run_details order by start_time desc limit 5;` and `select status_code, created from net._http_response order by created desc limit 5;`. More → Integrations shows when the scheduler last ran.

## 5. Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000
npm test                     # analytics, FIT parsing, sync engine
npm run lint && npm run typecheck
```

## 6. Deployment (Vercel)

Vercel project **loype** (team "Trym Bø's projects", functions in `arn1` Stockholm, next to the database) is linked to `trymboe/loype`; every push deploys, `main` goes to production. `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are already set. Add the secret variables from §2, redeploy, then set the Supabase Site URL / redirect URLs to the production domain.

Vercel Deployment Protection (Vercel Authentication) is on by default for `*.vercel.app` URLs. Vercel Cron is unaffected, With Standard Protection the production domain `loype.vercel.app` stays reachable for the pg_cron call in §4; if that ever changes, §4 explains the bypass secret.
