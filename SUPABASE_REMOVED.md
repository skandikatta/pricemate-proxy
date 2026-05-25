# Supabase (removed 2026-05-25)

Previously used Supabase as the primary database. Migrated to self-hosted PostgreSQL on Oracle VM.

## Credentials (if re-enabling)
- Project: `asfnqfhpfufcbjzsrxlz`
- URL: `https://asfnqfhpfufcbjzsrxlz.supabase.co`
- Anon key: stored in Render env vars (`SUPABASE_KEY`)

## What was removed
- `index.js` — `/api/scrape` and `/api/scrape-all` endpoints (wrote to Supabase)
- `scrape-daily.js` — full Supabase-based scraper
- `import-auscost.js` — one-time data import
- `match-products.js`, `match-products-v2.js`, `match-products-ai.js` — product matching (read from Supabase)
- `lib/predictions.ts` (frontend) — now reads from Oracle DB API

## To bring back
1. Re-add `SUPABASE_URL` and `SUPABASE_KEY` env vars
2. Restore files from git history: `git checkout HEAD~10 -- scrape-daily.js match-products-ai.js`
3. Or set up Supabase as a read replica synced from PostgreSQL
