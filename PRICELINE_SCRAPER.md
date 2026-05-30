# Priceline Scraper — Architecture & Operations

## Overview

Scrapes all Priceline Australia products daily via their SAP Commerce OCC API. Sitemap-driven (product codes from sitemap, fetched individually via API). No geo-blocking, no auth, no browser needed. Runs directly from GitHub Actions.

## Files

| File | Purpose |
|------|---------|
| `scrape-priceline.js` | Orchestrator — sitemap fetch, OCC API calls, DB writes |
| `scrape-utils.js` | Shared utilities (throttle, retry, stats) |
| `.github/workflows/scrape-priceline.yml` | Daily cron (20:30 UTC = 06:30 AEST) |

## Data Flow

```
GitHub Actions (cron 20:30 UTC)
    │
    ▼ Preflight: fetch product 199919 via OCC API — verify returns name + price
    │
    ▼ Fetch sitemap: priceline.com.au/Product.xml → 14,382 product codes
    │
    ▼ For each code:
    │   GET api.priceline.com.au/occ/v2/priceline/products/{code}?fields=FULL
    │   → JSON: name, brandName, price, previousPrice, categories, images
    │
    ▼ Batch upsert every 50 products → db.js → v1 + v2 shadow write
```

## API Details

**Base URL:** `https://api.priceline.com.au/occ/v2/priceline/products`

**Single product:** `GET /{code}?fields=FULL`

**Search (alternative):** `GET /search?query={term}&pageSize=48&fields=FULL`

**Category browse:** `GET /search?query=:relevance:allCategories:{category}&pageSize=48&fields=FULL`

**Response shape:**
```json
{
  "code": "199919",
  "name": "Panadol Mini Caps Paracetamol 500mg 16 Capsules",
  "brandName": "Panadol",
  "price": { "value": 4.59, "currencyIso": "AUD" },
  "previousPrice": { "value": 6.99 },
  "categories": [{ "name": "Health" }, { "name": "Medicines" }, { "name": "Pain Relief" }],
  "images": [{ "url": "/medias/300Wx300H-199919.jpg?context=..." }],
  "stock": { "stockLevelStatus": "inStock" }
}
```

**Key fields:**
- `code` — stable product ID (numeric string)
- `price.value` — current price
- `previousPrice.value` — was-price (only present when on sale)
- `brandName` — brand (always populated, unlike CW)
- `categories` — hierarchical (Health > Medicines > Pain Relief)
- `images[0].url` — relative to `api.priceline.com.au`

## Scraping Strategy

1. **Sitemap gives all product codes** — `Product.xml` lists every product URL as `/product/{code}/{slug}`
2. **Individual API fetch per product** — one HTTP call per product, returns full JSON
3. **No pagination needed** — sitemap is the index, API is the detail fetch
4. **Adaptive throttle** — 50ms min, 1000ms max, concurrency 6

## Key Design Decisions

- **OCC API over HTML parsing** — Priceline is Angular (client-rendered). HTML pages have no product data without JavaScript. The OCC API is what the Angular app calls internally.
- **Sitemap-driven** — guarantees full catalog coverage without guessing categories
- **No geo-blocking** — works from US-based GitHub Actions runners
- **No auth/cookies** — public API, same as IGA's storefront gateway
- **Individual fetch (not batch)** — OCC API doesn't support multi-product fetch. 14K individual calls at 50ms = ~12 min.

## Expected Output

```
Total: ~14,382 products
Runtime: ~12 minutes
Failed: <100 (404s for discontinued products still in sitemap)
Brands: always populated (unlike CW)
Categories: hierarchical (3 levels)
```

## v2 (Passport) Status

- Shadow-write: ✅ enabled
- Cross-store matching with CW: possible (same pharmacy products, shared brands like Panadol/Swisse/Colgate)
- Predictions: NOT active yet (not in VALID store set on API endpoints)
- Purpose: unbroken price history + ready for v1 decommission

## Comparison to Chemist Warehouse

| Feature | Priceline | Chemist Warehouse |
|---------|:-:|:-:|
| Products | ~14,000 | ~25,000 |
| Method | OCC API (JSON) | `__NEXT_DATA__` (HTML) |
| Geo-blocked | ❌ | ✅ (AU only) |
| Runs on | GitHub Actions | Oracle VM via SSH |
| Runtime | ~12 min | ~2 hours |
| Brand data | ✅ always | ✅ mostly |
| Barcodes | ❌ | ❌ |
| Sale detection | `previousPrice` field | RRP vs current |

## Monitoring

- `SCRAPE_SUMMARY` JSON in GitHub Actions logs
- Key fields: `store`, `total`, `failed`, `completedAt`
- Expected: ~14,000 products, <100 failed
- High `failed` count (>1000) = API may have added auth or changed structure

## Risk: API Blocking

The OCC API is SAP Commerce's standard headless commerce endpoint. Priceline's own Angular frontend depends on it. Blocking it would break their website. Risks:

- **Rate limiting** — handled by adaptive throttle (backs off automatically)
- **Auth headers added** — would need to extract session token from Angular app bootstrap
- **Endpoint path change** — preflight detects this, exits gracefully

**Fallback if API breaks:** Playwright rendering of category pages (slow, ~2h, but works as last resort).

## Known Behaviors

| Behavior | Impact | Handling |
|----------|--------|----------|
| Sitemap includes discontinued products | 404 on fetch | Counted as `failed`, skipped |
| `previousPrice` only present when on sale | Can't detect "was on sale last week" | Same as Woolworths `WasPrice = Price` pattern |
| Some products have no category | Missing category field | Stored as null |
| Image URLs are relative | Need `api.priceline.com.au` prefix | Prepended in extraction |
