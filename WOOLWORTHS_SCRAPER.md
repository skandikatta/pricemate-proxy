# Woolworths Scraper — Architecture & Operations

## Overview

Scrapes all Woolworths Australia departments daily. Uses their internal browse API (`/apis/ui/browse/category`) with cookie-based session auth. Runs as a GitHub Actions cron job, writes to PostgreSQL on the Oracle VM.

## Files

| File | Purpose |
|------|---------|
| `scrape-woolworths.js` | Orchestrator — pre-flight, department resolution, pagination, DB writes |
| `scrape-utils.js` | Shared utilities (throttle, retry, progress, stats) |
| `.github/workflows/scrape-woolworths.yml` | Daily cron (18:30 UTC = 04:30 AEST) — fires first, slowest scraper |

## Data Flow

```
GitHub Actions (cron 18:30 UTC)
    │
    ▼ Pre-flight (test 1 page, verify cookies + prices)
    │
    ▼ Get cookies (one GET to /shop/browse/fruit-veg, extract Set-Cookie)
    │
    ▼ Discover departments (PiesCategoriesWithSpecials API)
    │
    ▼ For each department (12 total):
    │   ├─ POST /apis/ui/browse/category (page 1, 2, 3... up to 150)
    │   ├─ Refresh cookies every 30 min (session TTL ~60 min)
    │   └─ Stop when: empty response, <10 products (filler), or cap hit
    │
    ▼ Products + prices → db.js → v1 + v2 shadow write
```

## Authentication

Woolworths uses **cookie-based sessions** (no Imperva, no API keys):

1. GET `/shop/browse/fruit-veg` with `redirect: 'manual'`
2. Extract `Set-Cookie` headers (dtCookie, session tokens)
3. Pass cookies on all subsequent POST requests

**Session TTL:** ~60 minutes. Scraper refreshes every 30 min to stay ahead of expiry. Without refresh, later departments silently return 0 products.

## Department Discovery

```js
GET /apis/ui/PiesCategoriesWithSpecials
→ Returns all departments with NodeId + Description
→ Match by display name (stable) not ID (rotates every few months)
→ Fallback to hardcoded IDs if API is down
```

Currently scraping 12 departments:
- Fruit & Veg, Bakery, Poultry/Meat/Seafood, Dairy/Eggs/Fridge
- Pantry, Freezer, Drinks, Personal Care
- Cleaning & Maintenance, Baby, Pet, Front of Store

## Pre-flight Check

Runs at scrape start (built into the pipeline, not a separate workflow):

1. Gets cookies
2. Fetches 1 page of Fruit & Veg
3. Verifies products returned with prices
4. Warns if all prices are $0 (datacenter IP restriction)

## Key Design Decisions

- **Direct API access** — no proxy needed (unlike Coles). Woolworths doesn't use Imperva on their browse API.
- **Cookie refresh every 30 min** — prevents silent auth expiry on long runs.
- **Pagination cap: 150 pages** — Woolworths departments have up to 100+ pages (36 items/page). Cap prevents infinite loops if pagination detection breaks.
- **`< 10 products` = end of category** — Woolworths returns filler/duplicate products on the last page. Fewer than 10 means we've exhausted the real results.
- **Barcode extraction** — Woolworths provides `p.Barcode` which strengthens cross-store matching in v2.
- **cup_price extraction** — `p.CupString` (e.g. "$1.75 per 100g") saved to price_history.

## Woolworths API Details

**Browse endpoint:**
```
POST https://www.woolworths.com.au/apis/ui/browse/category
Content-Type: application/json
Cookie: <session cookies>

{
  "categoryId": "1-E5BEE36E",
  "pageNumber": 1,
  "pageSize": 36,
  "sortType": "TraderRelevance",
  "categoryVersion": "v2",
  ...
}
```

**Response structure:**
```json
{
  "Bundles": [{ "Products": [
    { "Stockcode": 381923, "Name": "Kanzi Apple", "Price": 1.03,
      "WasPrice": 1.03, "IsOnSpecial": false, "Brand": "Kanzi",
      "PackageSize": "each", "Barcode": "0263605000008",
      "CupString": "$1.03 / 1EA", "LargeImageFile": "..." }
  ]}]
}
```

**Note on WasPrice:** Woolworths sets `WasPrice = Price` when NOT on special. Always use `IsOnSpecial` flag to determine sale status, not `WasPrice > Price`.

## Known Behaviors

| Behavior | Impact | Handling |
|----------|--------|----------|
| Session expires after ~60 min | Later departments return 0 products | Cookie refresh every 30 min |
| Datacenter IPs get restricted pricing | `Price: 0` for some products | v2 `CHECK (price > 0)` filters them; v1 uses last-known price |
| Department IDs rotate every few months | Would scrape wrong category | Runtime discovery by name, fallback to hardcoded |
| Last page has < 10 filler products | Would loop forever | `< 10` detection stops pagination |
| `front-of-store` sometimes returns 401 | Loses ~100 products (non-food) | Logged as failed dept, non-critical |

## Monitoring

- `SCRAPE_SUMMARY` JSON in GitHub Actions logs
- Key fields: `total`, `changes`, `failedDepts`, `degraded`, `priorCatalogCount`
- `STATS` line: requests, req/sec, items, errors
- Expected: ~53,000 products, 100-500 changes/day, 45-60 min runtime
- Degradation threshold: < 70% of prior catalog count

## DB Tables (Woolworths data)

**v1 (live):**
- `products` — catalog (name, brand, size, category, image, barcode)
- `price_history` — daily price snapshots (change-only)

**v2 (shadow-writing):**
- `products_v2` — passport (internal_id)
- `product_aliases` — vendor_id → internal_id (with barcode for strong matching)
- `price_history_v2` — keyed on internal_id, day-granular

## Incident History

| Date | Issue | Resolution |
|------|-------|------------|
| 2026-05-29 | Pagination cap (50) too low — 7 depts hit it, lost 35K products | Raised to 150 (`055fd45`) |
| 2026-05-29 | `front-of-store` got 401 at 27 min mark | Cookie refresh at 30 min should catch it; non-critical dept |
| 2026-05-29 | Pre-flight + cup_price + adaptive throttle added | `663d43b` |

## Comparison to Coles/Aldi

| Feature | Woolworths | Coles | Aldi |
|---------|:---:|:---:|:---:|
| Anti-bot | Cookie session only | Imperva (heavy) | None |
| Needs browser | No | Playwright fallback | No |
| Structured JSON | ✅ | ✅ | ❌ (HTML) |
| Barcode available | ✅ | ❌ | ❌ |
| Fallback layers | 1 (cookie refresh) | 4 (Render→direct→Playwright→HTML) | 4 strategies |
| Typical runtime | 45-60 min | 10-34 min | 3-5 min |
| Products | ~53,000 | ~33,000 | ~2,700 |
