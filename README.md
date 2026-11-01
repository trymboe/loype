# Løype

A private, adaptive running coach: Garmin data in, training intelligence out.

- **Architecture, data model, integration feasibility, plan and risks:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Setup, environment variables and deployment:** [`docs/SETUP.md`](docs/SETUP.md)
- **How every number is calculated:** [`docs/ANALYTICS.md`](docs/ANALYTICS.md)
- **Development checklist:** [`docs/CHECKLIST.md`](docs/CHECKLIST.md)

Stack: Next.js (App Router) · TypeScript · Tailwind · Supabase (Postgres, Auth, Storage) · Vercel · Garmin FIT SDK · Recharts · MapLibre/OpenFreeMap.

```bash
npm install && npm run dev   # app
npm test                     # analytics + ingestion tests
```
