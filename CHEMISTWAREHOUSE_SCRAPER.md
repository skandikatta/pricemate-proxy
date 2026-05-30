# Chemist Warehouse Scraper — Architecture & Operations

## Overview

Scrapes all Chemist Warehouse Australia products daily via their sitemap + Next.js `__NEXT_DATA__` extraction. Runs from the Oracle VM (not GitHub Actions runners) because CW geo-blocks non-Australian IPs. GitHub Actions triggers the scrape via SSH.

## Files

| File | Purpose |
|------|---------|
| `scrape-chemistwarehouse.js` | Orchestrator — sitemap fetch, page-by-page extraction, DB writes |
| `scrape-utils.js` | Shared utilities (throttle, retry, progress, stats) |
| `.github/workflows/scrape-chemistwarehouse.yml` | Daily cron (20:00 UTC = 06:00 AEST) — SSHs into VM |

## Data Flow

```
GitHub Actions (cron 20:00 UTC)
    │
    ▼ SSH into Oracle VM (AU IP required — CW geo-blocks non-AU)
    │
    ▼ Preflight: fetch known product page, verify __NEXT_DATA__ extraction works
    │
    ▼ Fetch sitemap: static.chemistwarehouse.com.au/AMS/sitemap/cwh/products.xml
    │   → ~25,000 product URLs
    │
    ▼ For each URL:
    │   ├─ GET product page HTML
    │   ├─ Parse <script id="__NEXT_DATA__"> JSON
    │   ├─ Extract: name, brand, price, RRP, SKU, size, image, category
    │   └─ Batch upsert every 50 products
    │
    ▼ Products + prices → db.js → v1 + v2 shadow write
```

## Why VM (not GitHub Actions runner)?

**Chemist Warehouse geo-blocks non-Australian IPs.** GitHub Actions runners are in the US. The Oracle VM has an Australian IP (Sydney region). The workflow SSHs into the VM to run the scraper where CW can see an AU source IP.

## Extraction Method

CW uses Next.js. Every product page embeds a `<script id="__NEXT_DATA__">` tag containing the full product object as JSON. The scraper:

1. Fetches the raw HTML
2. Regex-extracts the `__NEXT_DATA__` script content
3. Parses `props.pageProps.product.product`
4. Extracts variant[0] for brand, images, prices

**Price extraction:** Finds all `"amount": N.NN` values in the product JSON. First = current/sale price, second = RRP (if higher than current).

**Product ID:** Extracted from URL pattern `/buy/{id}/{slug}`.

**Size:** Regex from product name (e.g. "454g", "250ml", "400 Capsules").

## Key Design Decisions

- **Sitemap-driven** — no category crawling needed. Sitemap lists every product URL.
- **One page per product** — slow (~2 hours for 25K products) but reliable. No bulk API available.
- **Progress persistence** — resumes from last completed product if interrupted (crash recovery).
- **Adaptive throttle** — minDelay 100ms, maxDelay 1500ms, concurrency 6.
- **Separate from grocery endpoints** — CW is pharmacy, not groceries. Not in search/predictions/compare.
- **No barcodes** — CW doesn't expose barcodes in `__NEXT_DATA__`. Layer 0 matching unavailable.

## Expected Output

```
Total: ~25,000 products
Runtime: ~2 hours
Categories: ~47
Price changes/day: varies (CW changes prices frequently)
On special: ~79% (CW marks almost everything as "on special" permanently)
```

## v2 (Passport) Status

- Shadow-write: ✅ enabled (as of 2026-05-30)
- Backfill of existing products: pending (run `backfill-internal-ids.js --store chemistwarehouse`)
- Cross-store matching: NOT applicable (pharmacy ≠ groceries)
- Predictions: NOT active for CW (not in VALID store set on API endpoints)
- Purpose of v2: protect against product ID renames + ready for v1 decommission (Stage 6)

## Monitoring

- `SCRAPE_SUMMARY` JSON in GitHub Actions logs
- Key fields: `store`, `total`, `failed`, `completedAt`
- Expected: ~25,000 products, <500 failed (network timeouts on individual pages)
- High `failed` count (>2000) = site structure changed or geo-block tightened

## Known Behaviors

| Behavior | Impact | Handling |
|----------|--------|----------|
| Geo-blocks non-AU IPs | Can't run from GH Actions directly | SSH into Oracle VM (AU IP) |
| 79% "on special" permanently | Pollutes specials endpoints | CW excluded from `/api/random-specials` and search `special_type` filters |
| No barcodes | Can't do Layer 0 cross-store matching | Not needed — CW is standalone |
| Duplicate categories (case) | `fragrances` vs `Fragrances` | Cosmetic — doesn't affect functionality |
| ~2 hour runtime | Long for a scraper | Progress persistence handles interruptions |
| `__NEXT_DATA__` structure changes | Extraction breaks silently | Preflight catches this — exits gracefully if test product fails |

## Comparison to Grocery Scrapers

| Feature | Chemist Warehouse | Coles/Woolies/Aldi/IGA |
|---------|:-:|:-:|
| In grocery search | ❌ | ✅ |
| In predictions | ❌ | ✅ |
| In cross-store compare | ❌ | ✅ |
| In sale alerts | ❌ (future) | ✅ |
| Geo-blocked | ✅ (AU only) | Coles partial, others no |
| Barcodes | ❌ | IGA ✅, others ❌ |
| v2 shadow-write | ✅ | ✅ |


## Future Improvement: Delta Scrape (revisit after 2026-06-07)

**Problem:** Full scrape takes ~2 hours (25K individual page fetches). If CW behaves like Woolworths, 98%+ of products won't change price on any given day.

**Proposed approach:**
1. Fetch sitemap (free, instant) — get all 25K URLs
2. Compare against yesterday's cached URL list → identify new/removed products
3. For existing products: sample ~500 random pages, check if prices changed
4. If sample shows <1% changed → skip full scrape, only fetch new URLs
5. If sample shows >5% changed (sale event) → full scrape

**Prerequisites (need data first):**
- [ ] 7+ days of CW scrape data to measure daily change rate
- [ ] Confirm sitemap URLs are stable (product IDs don't rotate)
- [ ] Confirm `Last-Modified` or content-hash is feasible for individual pages

**Expected savings:** 2 hours → ~5 minutes on quiet days. Full scrape still runs when changes detected.

**Query to check readiness:**
```sql
SELECT scraped_at::date, COUNT(*) as changes
FROM price_history
WHERE store = 'chemistwarehouse'
GROUP BY scraped_at::date ORDER BY scraped_at::date;
```

When this shows 7+ rows with consistent low change counts, the delta approach is viable.
