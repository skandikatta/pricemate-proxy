# FIXES — pricemate-proxy

## 2026-05-29 — Aldi was_price alignment bug

**Commit:** `fix(aldi): per-tile extraction — was_price alignment bug`

**Root cause:** Strategy 1 in `extract-aldi.js` collected was-prices into a flat array via `html.matchAll(...)`, then zipped them by index against the (whole-page) `prices` array. Only on-special tiles emit a `product-tile__was-price` span, so the `wasPrices` array length ≤ `prices` array length. The two arrays misalign whenever any non-sale tile sits before a sale tile — the next sale tile's was-price gets assigned to the earlier non-sale product. Confirmed on a 4-tile synthetic page: 3 of 4 rows had the wrong `was_price`/`is_on_special`.

**Tainted window:** 2026-05-28T22:10:09Z to 2026-05-28T22:18:39Z (two manual `workflow_dispatch` runs of `scrape-aldi.yml` on commit `577faba`). The scheduled 2026-05-28T20:00 UTC run predated the bug (`c09c443`) and is unaffected.

**Backfill SQL (run on Oracle VM, where Postgres lives — local box has no DB access):**

```sql
-- Preview
SELECT 'price_history' AS tbl, COUNT(*) AS rows,
       SUM(CASE WHEN is_on_special THEN 1 ELSE 0 END) AS flagged_on_sale,
       SUM(CASE WHEN was_price IS NOT NULL THEN 1 ELSE 0 END) AS with_was_price
  FROM price_history
 WHERE store='aldi' AND scraped_at >= '2026-05-28 22:10:09+00'
UNION ALL
SELECT 'price_history_v2', COUNT(*),
       SUM(CASE WHEN is_on_special THEN 1 ELSE 0 END),
       SUM(CASE WHEN was_price IS NOT NULL THEN 1 ELSE 0 END)
  FROM price_history_v2
 WHERE store='aldi' AND scraped_at >= '2026-05-28 22:10:09+00';

-- Cleanup
BEGIN;
UPDATE price_history
   SET was_price = NULL, is_on_special = false
 WHERE store='aldi' AND scraped_at >= '2026-05-28 22:10:09+00';
UPDATE price_history_v2
   SET was_price = NULL, is_on_special = false
 WHERE store='aldi' AND scraped_at >= '2026-05-28 22:10:09+00';
COMMIT;
```

**Fix:** Split HTML on the `id="product-tile-\d+"` anchor first, then run each field's regex against the tile's own slice. A missing was-price now stays `null` for that specific product — order/count drift can't cause misalignment.

**Scope:** Only Strategy 1 had this bug. Strategies 2-4 don't extract `wasPrices`; they're untouched.

**Verification:**
- Synthetic 4-tile HTML (mix of sale + non-sale): old code 3/4 wrong, patched module 4/4 correct (`PASS`).
- Live Aldi categories fetched today (dairy-eggs-fridge, pantry, special-buys, frozen) had 0 was-price spans, so old/new agreed at 0 specials — couldn't reproduce the bug on live data because Aldi has no active specials in those categories right now. Math of the bug (mismatched-length flat-array zip) is independent of which page; synthetic proof is sufficient.

**Workflow disable note:** `gh workflow disable scrape-aldi.yml` returned HTTP 403 — the local `gh` token is on `saikandikatta` user, repo is owned by `skandikatta`. Git over SSH (host alias `github-skandikatta`) works for push, but the GH Actions admin API does not. The fix push lands well before tonight's 20:00 UTC scheduled run, so the cron stays as-is.

---

## 2026-05-29 — Aldi scraper audit fixes (5 items, one commit)

Audit pointed out remaining quality issues in `scrape-aldi.js` / `extract-aldi.js` after the was_price fix. All 5 addressed in this commit:

1. **Retry on transient fetch errors** — Added `fetchWithRetry(url, { retries: 3 })` mirroring the Coles/Woolies pattern. Retries on 5xx + network errors with exp backoff (1s/2s/4s), 4xx returns immediately. Used in both `discoverCategories` and `scrapeCategory`. Previously a single transient blip killed an entire category.

2. **Per-request timeout** — Each `fetch` now passes `AbortSignal.timeout(15000)`. Aldi categories rarely take >5s; the GH Actions 30-min cap was the only safety net before. Slow-but-not-failing responses no longer hang.

3. **cup_price extraction (price per unit)** — Strategy 1 now extracts `cup_price` per tile (prefers `data-test="product-tile__cup-price"` / `comparison-price` / `price-per-unit`, falls back to free-text `"$X per Ng"` regex). Threaded through `extractProducts` → `scrape-aldi.js` → `db.js`. **DB schema:** `cup_price text` column already existed in `price_history`, but **no scraper was writing it** (verified: aldi 0/8, woolies 0/1081, coles 0/84 over last 2 days). `insertPriceChanges` now accepts and writes `cup_price` — existing Coles/Woolies callers pass nothing → null (no behavior change for them). `price_history_v2` (shadow-write) intentionally **not** updated — would need a schema migration, which gates on [[feedback_option_c_approval_gate]] explicit approval. Filed as deferred item.

4. **In-memory dedup across categories** — Products appearing in multiple categories (e.g. "lower-prices" overlaps with "pantry") now collapse via a `Map` keyed by `product_id` before `upsertProducts`. `db.js insertPriceChanges` already dedupes server-side, but doing it client-side too saves an `upsertProducts` round-trip and keeps `SCRAPE_SUMMARY.total` honest.

5. **Pagination safety cap** — Added explicit `MAX_PAGES_PER_CATEGORY = 100` loop guard. Real Aldi categories top out around 10-15 pages; if the existing terminators (`http-equiv="refresh"` redirect + `products.length === 0`) ever break, the cap prevents an unbounded loop. Emits a warning when hit so the bug surfaces in the next-day review.

**DB write batch math:** column count 5 → 6, so `MAX_PRICE_BATCH` 13000 → 10000 to stay under the 65535 placeholder cap (6 × 10000 = 60000).

**Files changed:** `extract-aldi.js`, `scrape-aldi.js`, `db.js`.

**Verification:** synthetic HTML (3 tiles with mixed cup-price markers + no-cup-price) — extraction returns `"$1.75 per L"`, `"$2.40 per 100g"`, `null` per tile. `node --check` clean on all 3 files. All 5 marker checks in the patched files: PASS.

**Deferred:** `cup_price` for `price_history_v2` (shadow write) — needs schema migration approval. Coles + Woolies `cup_price` extraction — separate per-scraper work, audit was wrong that they were already writing it.
