# Coles Scraper — Architecture & Operations

## Overview

Scrapes all Coles Australia product categories daily. Uses Coles' Next.js JSON API (`_next/data`) as primary path, with Playwright browser fallback for Imperva blocks. Runs as a GitHub Actions cron job, writes to PostgreSQL on the Oracle VM.

## Files

| File | Purpose |
|------|---------|
| `scrape-coles.js` | Orchestrator — pre-flight, category resolution, pagination, DB writes |
| `coles-preflight.js` | Self-healing pre-flight check + HTML fallback extraction |
| `playwright-fallback.js` | Headless Chromium with stealth plugin for Imperva bypass |
| `scrape-utils.js` | Shared utilities (throttle, retry, progress, stats) |
| `.github/workflows/scrape-coles.yml` | Daily cron (19:00 UTC = 05:00 AEST) |

## Data Flow

```
GitHub Actions (cron 19:00 UTC)
    │
    ▼ Pre-flight (30s) — verify path works before full run
    │
    ├─ Layer 1: Render proxy (pricemate-proxy.onrender.com)
    │     → fetches _next/data/<buildId>/en/browse/<cat>.json
    │     → Fast (~5s/page), no browser needed
    │
    ├─ Layer 2: Playwright + stealth (if Render fails)
    │     → launches Chromium, warms up via homepage (gets Imperva cookies)
    │     → sets store cookie (7674 Hawthorn East VIC)
    │     → fetches same _next/data JSON with browser cookies
    │
    ├─ Layer 3: HTML fallback (if JSON path breaks entirely)
    │     → extracts __NEXT_DATA__ from rendered browse page
    │     → same data, different extraction point
    │
    └─ Layer 4: Graceful exit (preserve existing DB data)
    │
    ▼ Products + prices → db.js → v1 + v2 shadow write
```

## Pre-flight Check (`coles-preflight.js`)

Runs at the start of every scrape (30 seconds). Self-heals these scenarios:

| Problem | Auto-fix |
|---------|----------|
| Render proxy down/sleeping | Discovers fresh buildId, tries direct |
| buildId stale (Coles deployed) | Auto-discovers new buildId from homepage |
| Prices missing (store cookie needed) | Flags Playwright path (has cookie built in) |
| Price field renamed | Tries known alternatives: `pricing.now`, `price`, `currentPrice`, `salePrice` |
| Everything broken | Falls to Playwright, which always works |

**Only case needing human:** Coles completely restructures their JSON in a way no fallback mapping handles (hasn't happened in 2+ years).

## Fallback Chain Detail

### Layer 1: Render Proxy

- Your `index.js` deployed on Render free tier
- Fetches `coles.com.au/_next/data/<buildId>/en/browse/<cat>.json`
- buildId cached 24h, refreshed from homepage
- Fails when: Render asleep (cold start ~30s), Imperva blocks Render IP, buildId expired

### Layer 2: Playwright + Stealth

- `playwright-fallback.js` — headless Chromium with `puppeteer-extra-plugin-stealth`
- Warmup: navigates homepage → Imperva JS challenge executes → 21+ cookies set
- Store cookie: `fulfillmentStoreId=7674` (Hawthorn East VIC) — required for prices
- Extracts buildId from homepage in the same shot
- Fetches `_next/data` JSON via `page.evaluate(fetch(...))` — cookies attach automatically
- Fails when: Imperva defeats stealth (returns <2KB challenge body)

### Layer 3: HTML Fallback

- `coles-preflight.js → extractFromHtml()`
- Fetches the rendered browse page (what customers see)
- Extracts `__NEXT_DATA__` script tag — contains same product JSON
- Works as long as Coles shows prices to customers (always)
- Slower (full page HTML vs JSON endpoint) but impossible to break

### Layer 4: Graceful Exit

- Zero products → skip DB write, preserve existing data
- Exit code 1 → GitHub Actions marks run as failed
- SCRAPE_SUMMARY logs `degraded: true`
- Existing price history in DB stays intact

## Category Discovery

1. **Primary:** Fetches `/api/coles/categories` from Render proxy (parses `__NEXT_DATA__` navigation)
2. **Fallback:** Hardcoded `CATEGORIES` array with `apiTitle` + `fallbackSlug`
3. **Slug rotation handling:** Matches by display title (stable) not slug (rotates)

```js
// Titles are stable, slugs rotate:
{ apiTitle: 'Dairy, Eggs & Fridge', fallbackSlug: 'dairy-eggs-fridge' }
// If Coles renames slug to 'dairy-fridge', discovery finds it by title
```

## Imperva (Anti-Bot) Handling

Coles uses Imperva/Incapsula to block scrapers. What triggers blocks:

| Signal | Blocked? | Our mitigation |
|--------|----------|----------------|
| Datacenter IP (Render, GH Actions) | Sometimes | Playwright fallback |
| No cookies | Always on BFF API | Homepage warmup gets cookies |
| No store selected | Prices = $0 | Store cookie (7674) |
| High request rate | Rarely | AdaptiveThrottle (200-2000ms) |
| Missing User-Agent | Yes | Firefox UA on all requests |
| TLS fingerprint | No (tested) | Not a factor |

## Key Design Decisions

- **Render as primary** — free, fast, handles 95% of runs. Only fails when Imperva flags Render's IP range.
- **Playwright is lazy-loaded** — `require('./playwright-fallback')` only when needed. Saves cold-start time on happy path.
- **Store cookie fix** — Coles returns `pricing.now=0` without a store selected. Cookie `fulfillmentStoreId=7674` fixes this. Prices are nationally uniform; the store just unlocks the data.
- **Change-only writes** — only inserts `price_history` row when price differs from last known.
- **Degradation detection** — compares today's total vs prior catalog. If < 70%, flags it.
- **Retry with backoff** — 3 attempts per page via shared `fetchWithRetry`.
- **Adaptive throttle** — speeds up when Coles responds fast, slows down when slow.

## Workflow Configuration

```yaml
name: Scrape Coles
on:
  schedule:
    - cron: "0 19 * * *"  # 05:00 AEST
  workflow_dispatch:
jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - Install: npm install pg playwright playwright-extra puppeteer-extra-plugin-stealth
      - Install Chromium: npx playwright install --with-deps chromium
      - Wake Render: curl health endpoint (3 attempts)
      - Run: node scrape-coles.js
    env:
      DB_HOST: ${{ secrets.DB_HOST }}
      DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
      OPTION_C_SHADOW_WRITE: "1"
```

## What `was_price` Means for Coles

Coles provides `pricing.was` in their JSON — the price before the current promotion. Unlike Aldi (where we extract from HTML), Coles gives us structured data directly:

```json
{ "pricing": { "now": 3.50, "was": 5.00, "onlineSpecial": true, "promotionType": "HALF_PRICE" } }
```

No alignment bugs possible — each product's pricing is self-contained in the JSON object.

## DB Tables (Coles data)

**v1 (live):**
- `products` — catalog (name, brand, size, category, image)
- `price_history` — daily price snapshots (change-only)

**v2 (shadow-writing):**
- `products_v2` — passport (internal_id)
- `product_aliases` — vendor_id → internal_id
- `price_history_v2` — keyed on internal_id, day-granular

## Monitoring

- `SCRAPE_SUMMARY` JSON in GitHub Actions logs
- Key fields: `total`, `changes`, `failed_categories`, `degraded`, `used_playwright_fallback`, `duration_s`
- Expected: ~33,000 products, 100-500 price changes/day, 10-15 min via Render, 34 min via Playwright
- `[preflight]` log lines show which path was chosen and why

## Known Limitations

- No `cup_price` written to DB (Coles provides `pricing.comparable` but scraper doesn't pass it through yet)
- Playwright installs Chromium on every GH Actions run (~30-60s overhead even when not used)
- No concurrent page fetching yet (sequential within each category — could be 4x faster)
- Render free tier sleeps after 15min inactivity (workflow wakes it with 3 health pings)

## Incident History

| Date | Issue | Resolution |
|------|-------|------------|
| 2026-05-28 | Playwright returned price=0 for all products | Store cookie fix (`94c404d`) — set fulfillmentStoreId=7674 |
| 2026-05-28 | Render was down, entire run via Playwright (34 min) | Render recovered next day; Playwright fallback worked correctly |
| 2026-05-29 | Pre-flight + HTML fallback added | `4d3e69d` — self-healing before each run |
