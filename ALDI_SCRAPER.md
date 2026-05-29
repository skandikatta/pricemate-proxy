# Aldi Scraper — Architecture & Operations

## Overview

Scrapes all Aldi Australia product categories daily. No API — pure HTML parsing with 4 fallback strategies. Runs as a GitHub Actions cron job, writes to PostgreSQL on the Oracle VM.

## Files

| File | Purpose |
|------|---------|
| `scrape-aldi.js` | Orchestrator — discovers categories, paginates, calls DB |
| `extract-aldi.js` | HTML → products. 4-strategy cascade for resilience |
| `scripts/aldi-health-check.js` | Self-healing category drift detection (Mon + Thu) |
| `.github/workflows/scrape-aldi.yml` | Daily cron (20:00 UTC = 06:00 AEST) |
| `.github/workflows/aldi-health-check.yml` | Mon + Thu 08:00 UTC |

## Data Flow

```
Aldi website (HTML pages)
    │
    ▼ fetch (with retry × 3, 15s timeout, 500ms delay between pages)
    │
extract-aldi.js (per-tile extraction)
    │
    ▼ returns: [{ productId, name, price, wasPrice, isOnSpecial, brand, image, size, cupPrice }]
    │
scrape-aldi.js (dedup across categories, build allProducts + allPrices)
    │
    ├─▶ db.js upsertProducts()         → products table (v1)
    │     └─▶ shadowUpsertProductsV2()  → products_v2 + product_aliases (v2)
    │
    └─▶ db.js insertPriceChanges()      → price_history (v1, change-only)
          └─▶ shadowInsertPriceHistoryV2() → price_history_v2 (v2, change-only)
```

## Extraction Strategies (extract-aldi.js)

Tried in order. First one that returns products wins.

| # | Strategy | Trigger | Resilience |
|---|----------|---------|------------|
| 1 | `data-test` attributes (per-tile) | Default — works today | Breaks if Aldi removes data-test attrs |
| 2 | `aria-label` fallback | Strategy 1 returns 0 | Survives class renames |
| 3 | JSON-LD structured data | Strategy 2 returns 0 | Works if Aldi adds SEO markup |
| 4 | Generic price+text heuristic | All above fail | Last resort, lower accuracy |

If ALL strategies return 0 → scraper logs warning, skips DB write, exits 0 (preserves existing data).

## Category Discovery

1. **Dynamic** — fetches `/products` page, regex-extracts top-level category links
2. **Hardcoded fallback** — `TOP_LEVEL_CATEGORIES` object (15+ categories with IDs)
3. **SKIP list** — categories we intentionally don't scrape: `snow-gear`, `limited-time-only`, `liquor`, `front-of-store`

## Self-Healing Pipeline

`aldi-health-check.yml` runs Mon + Thu and auto-fixes:

| Drift type | Auto-fix | Human needed? |
|-----------|----------|---------------|
| New category appears | Adds to `TOP_LEVEL_CATEGORIES`, commits, triggers scrape | No |
| Category ID changes | Updates ID in hardcoded list, commits | No |
| Category removed | Adds to `SKIP` list, commits | No |
| Extraction broken (0 products) | Opens GitHub issue | **Yes** — HTML changed |

## Key Design Decisions

- **Per-tile extraction** (not flat arrays) — each product's was_price is extracted from its own HTML slice. Order/count changes can't cause misalignment.
- **Change-only writes** — only inserts a `price_history` row when price actually differs from last known. Keeps DB lean.
- **Graceful degradation** — zero products = don't touch DB. Partial data = save what you got.
- **Error classification** — external failures (site down, blocked) exit 0; code bugs exit 1.
- **No browser needed** — pure `fetch()` + regex. 10x faster than Playwright approach.

## What `was_price` means

Aldi shows a red "was $X.XX" label on products currently on sale. The scraper captures this label at scrape time. It's NOT historical data from Aldi — it's a snapshot of what the site showed that day. History is built up over time from daily scrapes.

## DB Tables (Aldi data)

**v1 (live, serving traffic):**
- `products` — catalog (name, brand, size, category, image)
- `price_history` — daily price snapshots (only rows where price changed)

**v2 (shadow-writing, not serving yet):**
- `products_v2` — passport (internal_id per canonical product)
- `product_aliases` — vendor_id → internal_id mapping
- `price_history_v2` — keyed on internal_id, day-granular

## Monitoring

- `SCRAPE_SUMMARY` JSON line in GitHub Actions logs — check `total`, `changes`, `failedCategories`, `onSpecial`
- Health-check opens GitHub issues only when extraction breaks
- Expected: ~2600-2900 products, 0-50 price changes per day, 0-100 specials when sales are active

## Known Limitations

- No `cup_price` in `price_history_v2` yet (needs migration approval)
- Sale status change without price change is not detected (price unchanged but `is_on_special` flips)
- No retry at the individual page level within a category (retry is per-request via `fetchWithRetry`)

## Incident History

| Date | Issue | Resolution |
|------|-------|------------|
| 2026-05-29 | `was_price` alignment bug (flat-array zip) | Per-tile extraction fix (`98da093`) |
| 2026-05-29 | `super-savers` category missing | Auto-added by health-check (`508249c`) |
