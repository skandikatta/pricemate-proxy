# Price History Refactor — Bug + Options + Decisions

**Status:** ✅ **RESOLVED 2026-05-26 via Option B** (commit `01b2755`).
- Deleted the `upsertProducts` ID-migration block entirely
- Renamed vendor_ids now treated as new products
- Verified live: Coles scrape `26436156691` completed all 15 categories, zero `duplicate key` errors
- pg_dump backup: `backups/pre-option-b-20260526T061603Z.dump` (local + on VM `/var/lib/postgresql/backups/`)
- Audit before stripping: 896 normalized-name duplicate groups in Coles alone — past "successful" migrations were silently merging unrelated SKUs, confirming Option B was the right call. Option C (internal-UUID) deferred per recommendation; only revisit if prediction telemetry shows fragmentation hurts.

Historical analysis below preserved for context.

---

**Origin:** 2026-05-25 scrape run https://github.com/skandikatta/pricemate-proxy/actions/runs/26418284219
**Affected categories that day:** `dairy-eggs-fridge`, `fruit-vegetables`, `deli`, `chips-chocolates-snacks` (4 of 15 failed)

---

## The bug (root cause confirmed)

Every failure hit the same Postgres unique constraint:

```
ERROR: duplicate key value violates unique constraint "price_history_store_product_id_scraped_at_key"
```

Constraint (verified live on Oracle VM Postgres):
```
price_history_store_product_id_scraped_at_key  UNIQUE  btree (store, product_id, scraped_at)
```

It is **NOT** the `INSERT ... ON CONFLICT DO NOTHING` in `db.js:130-131` that's failing — that clause matches the constraint correctly.

The failing statement is the **UPDATE inside the ID-migration path**:

```js
// db.js:62
await pool.query(
  'UPDATE price_history SET product_id = $1 WHERE store = $2 AND product_id = $3',
  [p.product_id, store, oldId]
)
```

The UPDATE has no conflict handling. It blows up when both `OLD` and `NEW` already have a row at the same `scraped_at`.

### Why it triggers now

`price_history` contains massive same-`scraped_at` backfill buckets:

| scraped_at | distinct product_ids |
|---|---|
| 2026-05-23 00:00:00+00 | **11,956** |
| 2023-11-21 00:00:00+00 | 7,153 |
| 2024-09-22 00:00:00+00 | 302 |
| 2024-10-11 00:00:00+00 | 187 |
| 2024-09-18 00:00:00+00 | 170 |

With ~12k coles products sharing one `scraped_at`, any ID migration where both old and new IDs land in that bucket will collide. `scrape-coles.js:45-49` catches the exception per-category and `break`s out → that category fails for the rest of the day.

---

## Why this matters beyond "fix the crash"

The product goal is **price-cycle prediction** ("when does this milk go on sale next?"). The training signal is `price_history`. Two structural issues with the current schema:

1. **Vendor IDs change.** Coles renames products (`1234 → 5678`) without warning. Each rename today either (a) crashes the scrape via the UPDATE collision, or (b) silently rewrites history. Both fragment the time series.
2. **The current migration uses normalised-name matching to detect renames.** That matching is fragile — see Challenge 1 below.

Lose continuous history → predictor sees half-cycles → wrong predictions.

---

## The three options on the table

### Option A — 3-line minimum fix (ship today)

Wrap the migration UPDATE in conflict-safe handling: detect the unique-violation, skip that one product's migration, continue the batch.

```js
try {
  await pool.query(
    'UPDATE price_history SET product_id = $1 WHERE store = $2 AND product_id = $3',
    [p.product_id, store, oldId]
  )
} catch (e) {
  if (e.code !== '23505') throw e  // 23505 = unique_violation
  // Skip this product's history migration; the new vendor_id will start fresh history.
  continue
}
```

- **Effort:** 30 min
- **Risk:** Low (additive, easily reverted)
- **Trade-off:** Churned products lose history continuity. For the ~1-5% of products that get renamed, the predictor sees a discontinuity. Acceptable starting point.

### Option B — Delete the migration entirely (also ship today)

Remove the `upsertProducts` migration block (db.js lines ~51-80) altogether. When Coles renames a product, just treat the new ID as a new product. Don't be clever.

- **Effort:** 1 hour (delete code + rewrite tests)
- **Risk:** Low
- **Trade-off:** Same as A — churned products lose continuity. But the code is simpler and the failure class is gone. Recommended over A unless we believe the migration was doing useful work — see Challenge 2.

### Option C — Internal-ID refactor (the "right" long-term answer)

Decouple vendor IDs from internal product identity. Vendor IDs become *aliases* attached to a permanent internal UUID.

**New schema:**

```
products
  internal_id      UUID PRIMARY KEY      ← yours forever
  canonical_name   text                  ← normalised name, the matching key
  brand, size, category, image
  first_seen, last_seen

product_aliases                          ← vendor IDs live here
  internal_id      UUID
  store            text
  vendor_id        text
  active           bool
  first_seen, last_seen
  UNIQUE (store, vendor_id)

price_history                            ← keyed on YOUR id
  internal_id      UUID
  store            text                  ← still tracked for cross-vendor analysis
  scraped_at       timestamptz
  price, was_price, is_on_special, cup_price
  UNIQUE (internal_id, scraped_at)
```

When Coles renames `1234 → 5678`: add an alias row, append today's price. **No UPDATE on price_history. Ever.** The unique-violation bug class is impossible.

Cross-vendor matching (the existing `product_groups` table with `coles_id` / `woolworths_id` / `aldi_id`) is subsumed naturally: same `internal_id` → all that product's histories across all stores.

- **Effort:** 1-2 weeks (migration script, db.js rewrite, validation against copy of prod DB, cut over)
- **Risk:** Medium (migration touches every row of `price_history`, has a destructive dedup step)
- **Trade-off:** Locks in the architecture from `pricemate/OBSERVATIONS.md` (research doc). Required *eventually*; debatable *now*.

---

## Walk-through example — same product across all 3 options

**Setup:** Coles milk. Day 1 vendor_id=1234 @ $3.50. Day 2 → $2.50 (sale). Day 3 Coles renames to 5678, price back to $3.50.

### Option A / B (no internal IDs)
```
products:      [1234] → deleted at Day 3 (Option B keeps 1234, adds 5678)
price_history: rows for 1234 (Days 1-2)
               rows for 5678 (Day 3 onwards)
```
Predictor query `WHERE product_id = 5678 AND is_on_special` misses Day 2's sale. Fragmentation = small data loss per churn event.

### Option C (internal IDs)
```
products:         ABC-001 (created Day 1, unchanged forever)
product_aliases:  ABC-001 ↔ coles/1234  (Day 1)
                  ABC-001 ↔ coles/5678  (added Day 3, no UPDATE)
price_history:    all rows under ABC-001
```
Predictor query `WHERE internal_id = 'ABC-001' AND is_on_special` sees the full history. No fragmentation.

---

## "Store only on change" rule (CamelCamelCamel-style)

Already implemented in `db.js:117-122`:

```js
const changed = prices.filter(p => {
  const last = lastPrices[p.product_id]
  return last === undefined || last !== parseFloat(p.price)
})
```

Sparse rows = each row is a *state change event*, perfect signal for cycle detection. Keep this rule regardless of which option (A/B/C) we pick. Confirmed: also documented in `pricemate/OBSERVATIONS.md` lines 831-854.

Query pattern for "price on day X":
```sql
SELECT price FROM price_history
WHERE internal_id = $1 AND scraped_at <= $2
ORDER BY scraped_at DESC LIMIT 1
```
Fast with index on `(internal_id, scraped_at DESC)`.

---

## Red-team challenges (against the Option C / internal-ID design)

### Challenge 1 — name-matching is the fragile bit, both schemas inherit it
Both the current code and Option C use `normalize(name)` to detect renames. If `normalize("Full Cream Milk 2L")` ever matches two genuinely different products (different brands, different recipes), Option C silently glues their histories into one `internal_id`. The predictor then sees a Frankenstein cycle. **Audit name-match quality before trusting either design.**

### Challenge 2 — past migrations may have already corrupted price_history
The migration UPDATE has been running daily for weeks. Every time it *succeeded* (no collision), it merged history across vendor IDs based on the same fragile name match. Some of those merges may have been wrong. The internal-id refactor *inherits* that pollution. Spot-check before locking in Option C.

### Challenge 3 — cross-vendor matching is harder than I made it sound
Coles "Full Cream Milk 2L" ≠ Woolies "Full Cream Milk 2L" (different brands, different products). Auto-linking them by name = WORSE predictions, not better. The existing `product_groups` table does careful manual matching; Option C should preserve that, not auto-subsume it.

### Challenge 4 — the migration script is itself the riskiest move
`DELETE ... USING` removes data. Backfilling `internal_id` across 100k+ rows locks the table for minutes. Mid-run interruption = half-state, no clean rollback except `pg_dump` restore + downtime. Plan validation on a *copy* of the DB before any production touch.

### Challenge 5 — storage capacity is a non-issue
DB is on Oracle VM (192.9.191.233), not Supabase. ~46 GB free. Storage isn't the constraint. "Store only changes" matters for *signal quality* not capacity.

### Challenge 6 — YAGNI for a solo project
~400 products today, 1,500 planned. ID churn affects maybe 1-5% per week. Option A is 3 lines + ships today. Option C is 1-2 weeks of work + migration risk. Am I selling a Ferrari to fix a flat tyre?

---

## Recommendation

**Now: Option B** (delete the migration). Simplest, removes the crash class, accepts known-cost fragmentation for the small number of churned products.

**Later: Option C** *if* prediction telemetry proves the fragmentation hurts. Don't pre-build it.

Never: leave the current code as-is.

---

## Pre-work before any path

1. **Audit past migrations.** Query `products` for rows where current id differs from any historical id; spot-check 20-30 that the name-match merge looked correct. If a high error rate → name matcher needs work first.
2. **`pg_dump` of `price_history` and `products`** to local disk before any schema change. Safety net.
3. **Run `/codex challenge`** on this doc for a third-party adversarial pass before committing to any path.

---

## Files involved

- `pricemate-proxy/db.js` — `upsertProducts()`, `insertPriceChanges()`, the failing migration UPDATE
- `pricemate-proxy/scrape-coles.js` — calls the DB functions; catches per-category errors
- `pricemate-proxy/.github/workflows/scrape-coles.yml` — daily cron
- `pricemate/OBSERVATIONS.md` — full research doc (competitor analysis, prediction algorithm, storage strategy)
- Oracle VM `192.9.191.233` — Postgres host, DB `pricemate`, user `pricemate`

---

## Next session checklist

- [ ] Decide A / B / C
- [ ] Run audit query for past-migration accuracy
- [ ] `pg_dump` backup
- [ ] (Optional) `/codex challenge` this doc
- [ ] If C: write migration SQL, test on a `pricemate_test` copy of the DB first
