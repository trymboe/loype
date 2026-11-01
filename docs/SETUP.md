# Setup, configuration and deployment

## 1. Supabase

Project: **loype** (`ldqrjypjeikdtkzoqrsn`, region eu-north-1). The Phase 1 schema
(`supabase/migrations/0001_foundations.sql`) is already applied. For a fresh
project, run the files in `supabase/migrations/` in order (SQL editor or `supabase db push`).

Auth settings (Dashboard → Authentication):
1. **Sign In / Providers → Email**: enabled (magic link). You may disable "Allow new users to sign up" *after* your first sign-in.
2. **URL Configuration**: Site URL = your Vercel production URL; add `https://<your-app>.vercel.app/auth/callback` (and `http://localhost:3000/auth/callback` for local dev) to Redirect URLs.

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

- `vercel.json` registers a daily Vercel Cron (Hobby plans only allow daily).
- For 30-minute syncs, schedule it from Supabase (Database → Extensions: enable `pg_cron` and `pg_net`), then in the SQL editor:

```sql
select vault.create_secret('<CRON_SECRET>', 'loype_cron_secret');
select cron.schedule('loype-sync', '*/30 * * * *', $$
  select net.http_get(
    url := 'https://<your-app>.vercel.app/api/cron/sync',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'loype_cron_secret')),
    timeout_milliseconds := 60000
  );
$$);
```

## 5. Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000
npm test                     # analytics, FIT parsing, sync engine
npm run lint && npm run typecheck
```

## 6. Deployment (Vercel)

Import `trymboe/loype` in Vercel (framework: Next.js, no build overrides), set the environment variables, deploy. Then update the Supabase Site URL / redirect URLs to the production domain.
