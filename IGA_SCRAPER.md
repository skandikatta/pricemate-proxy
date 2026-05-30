# IGA Scraper — Architecture & Operations

## Overview

Scrapes all IGA Australia products daily via their storefront gateway API. Pure JSON, no bot protection, fastest scraper in the fleet (~90 seconds for full catalogue). Runs as a GitHub Actions cron job, writes to PostgreSQL on the Oracle VM.

## Files

| File | Purpose |
|------|---------|
| `scrape-iga.js` | Orchestrator — paginated search queries, DB writes |
| `scrape-utils.js` | Shared utilities (throttle, retry, stats) |
| `.github/workflows/scrape-iga.yml` | Daily cron (19:30 UTC = 05:30 AEST) |

## Data Flow

```
GitHub Actions (cron 19:30 UTC)
    │
    ▼ Preflight: test search for "milk" — verify API returns products with prices
    │
    ▼ Paginated search: 29 single-char queries (a-z, 1-3) × PAGE_SIZE=50
    │   Each query returns all products whose name/brand contains that letter
    │   Deduplicate by product_id across queries
    │
    ▼ Products + prices → db.js → v1 + v2 shadow write
```

## API Details

**Endpoint:** `https://storefrontgateway.igashop.com.au/api/stores/{STORE_ID}/search`

**Store ID:** `32600` (single store — IGA's online shop is one national catalogue)

**Parameters:** `?q={letter}&take=50&skip={offset}&sort=brand`

**Response:** JSON with `{ total, items: [{ productId, name, brand, priceNumeric, ... }] }`

**Key fields extracted:**
- `productId` — stable SKU identifier
- `priceNumeric` — current price (float)
- `tprPrice[0].priceNumeric` — was-price (if on special)
- `priceSource` — "special" when on promotion
- `barcode` — **IGA exposes barcodes** (enables Layer 0 matching)
- `image.default` — product image URL
- `unitOfSize` — pack size (e.g. "2L", "500g")

## Scraping Strategy

IGA's search API doesn't support `q=*` wildcard. The scraper uses 29 single-character queries (`a-z`, `1-3`) to cover the full catalogue. Each letter catches products whose name or brand contains that character. Overlap is handled by deduplication on `product_id`.

**Coverage gap:** Products with names starting with symbols, numbers >3, or non-ASCII characters could theoretically be missed. In practice, IGA's ~3,800 product catalogue is fully covered by this approach (verified against category tree enumeration).

## Key Design Decisions

- **No auth required** — public API, no cookies, no tokens
- **No geo-blocking** — runs directly from GitHub Actions (US runners work fine)
- **Barcodes available** — strongest cross-store matching signal (Layer 0)
- **Single store ID** — IGA's online shop is one national catalogue, not per-store
- **Adaptive throttle** — minDelay 100ms, maxDelay 1500ms (IGA is fast, no need to be gentle)

## Expected Output

```
Total: ~3,800 unique products
Runtime: ~90 seconds
Categories: 16 (dynamically discovered)
Price changes/day: 1-50 (Aldi-like stability)
```

## v2 (Passport) Status

- Shadow-write: ✅ enabled (as of 2026-05-30)
- Backfill of existing products: ✅ `backfill-new-stores.js --apply` (workflow: "Backfill new stores to v2")
- Cross-store matching: `product_groups.iga_id` column exists (migration 007)
- Matcher coverage: included in `match-products.js` Layer 0 (barcode) + Layers 1-3

## Monitoring

- `SCRAPE_SUMMARY` JSON in GitHub Actions logs
- Key fields: `store`, `total`, `changes`, `failedCategories`, `onSpecial`
- Expected: ~3,800 products, 0-50 changes/day
- `onSpecial: 0` is normal — IGA rarely uses the `priceSource: "special"` flag

## Known Behaviors

| Behavior | Impact | Handling |
|----------|--------|----------|
| `onSpecial` always 0 | No specials detected | IGA uses different promo mechanics — `tprPrice` field checked as fallback |
| Search overlap across letters | Same product in multiple queries | Deduplicated by `product_id` before DB write |
| Category tree exists but unused | Could enumerate more precisely | Letter-search covers full catalogue; simpler code |
