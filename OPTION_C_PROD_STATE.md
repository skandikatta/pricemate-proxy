# Option C — Live in Production

**Status:** ✅ **SHIPPED** to production on **2026-05-28** (Sydney time).
**Approval policy:** ⛔ **No changes to this logic without Praveen's explicit approval.** See [Change-control rule](#change-control-rule) at bottom.

## What "this logic" means

The **passport + phone-number** pattern for product identity:

- **`products_v2.internal_id`** (UUID) — the *passport*. One per canonical product. Never changes, ever.
- **`product_aliases (store, vendor_id) → internal_id`** — the *phone numbers*. Many per passport (one per store, plus historical aliases when retailers rename SKUs).
- **`price_history_v2`** keyed on `internal_id` — survives all vendor_id churn at Coles / Woolworths / Aldi.

When Coles renames `1234 → 5678` (packaging refresh, rebrand, repack):
1. Matcher detects same brand + size + core name → same product
2. New `5678` alias appended under the existing `internal_id` (active=true)
3. Old `1234` alias marked active=false (audit trail preserved, not deleted)
4. `price_history_v2` rows accumulate against the **same** `internal_id` — no fragmentation

The predictor sees one unbroken history. Cycle detection works across renames.

## Production state (live as of 2026-05-28)

| Layer | State |
|---|---|
| **pg_dump backup** | `/var/lib/postgresql/backups/pre-option-c-20260527T143054Z.dump` (6.0 MB, restore-verified) |
| **Schema** | Migration 005 applied. `products_v2`, `product_aliases`, `price_history_v2` exist alongside Option B's `products` / `price_history` |
| **Backfill** | 76,158 passports · 79,086 aliases · 225,106 price_history rows re-keyed by `internal_id` |
| **Cross-store groups** | 2,818 (Layer 0 barcode: 354 · Layer 1 exact: 1,699 · Layer 2 Levenshtein: 252 · Layer 3 token-sort: 395 · Layer 4 Aldi house: 118) |
| **Audit** | Spot-checked top 200 multi-alias groups — no false-merges. All match on brand + size + core product |
| **Scraper shadow-write** | `OPTION_C_SHADOW_WRITE=1` enabled on all 3 scraper workflows (Coles / Woolworths / Aldi) — dual-writes v1 and v2 |
| **VM API** | `/api/price-history-v2` live in `api-server.js` (backup at `api-server.js.bak.pre-option-c`) |
| **Frontend** | `pricemate/lib/predictions.ts` + `app/api/prices/route.ts` call `/api/price-history-v2`. Vercel auto-deployed |

## What protects against the 757caeb failure mode

Commit `757caeb` (the original "smart ID migration", removed in `01b2755` after the audit caught **896 false-merge groups** in Coles) matched on `normalize(name)` alone. `"full cream milk"` → 14 different vendor_ids, mostly genuinely different SKUs.

The current backfill uses `match-products.js` Layers 0-4, which gate on:

1. **Layer 0** — barcode equality (strongest; 354 groups here)
2. **Layer 1** — exact `(brand + size + core_name)` triple match
3. **Layer 2** — same size + Levenshtein ≤ 3 on core_name, brand still required
4. **Layer 3** — token-sort ratio ≥ 0.80 (or 0.65 for both-store-brand pairs) + brand veto + size match
5. **Layer 4** — Aldi house-brand to Coles/Woolies house-brand or brandless, same size, token-sort ≥ 0.75

Brand and size are **load-bearing**. Removing either reintroduces the false-merge class.

## What's NOT in scope of this ship (deferred)

- **Inline rename detection** in `db.js` — when a scraper sees a fresh vendor_id that's not in any alias, it mints a new passport. The rename stitching is intentionally NOT done inline; it'll be a separate offline pass (`detect-renames.js`) with a manual review queue. Until that ships, new vendor_ids from a retailer rename will start fresh history — same orphan behaviour as today, just on the new schema.
- **Drop v1 tables** (migration 006) — keep `price_history` and `products` for at least 7 days of clean v2 predictions before considering.
- **UI surface** — no "history spans SKUs 1234, 5678" indicator yet. Data is there, render is future work.

## Rollback paths (in increasing disruption)

1. **Frontend only:** `git revert 82fda75 && git push` → Vercel redeploys reading v1.
2. **Shadow write:** `git revert 3c46207 && git push` → scrapers stop writing v2 (v2 data stays in DB).
3. **VM endpoint:** `cp api-server.js.bak.pre-option-c api-server.js && sudo systemctl restart pricemate-api`.
4. **Catastrophic** (data corruption discovered): restore `pre-option-c-20260527T143054Z.dump`.

## Verification queries (run any time)

```sql
-- Daily growth (run morning after a cron run)
SELECT (SELECT COUNT(*) FROM price_history    WHERE scraped_at::date = CURRENT_DATE - 1) AS v1_yesterday,
       (SELECT COUNT(*) FROM price_history_v2 WHERE scraped_at::date = CURRENT_DATE - 1) AS v2_yesterday;

-- Sample cross-store merges
SELECT pv.canonical_name, pv.brand, pv.size,
       ARRAY_AGG(pa.store || ':' || pa.vendor_id ORDER BY pa.store) AS aliases
  FROM products_v2 pv JOIN product_aliases pa ON pa.internal_id = pv.internal_id
  GROUP BY pv.internal_id, pv.canonical_name, pv.brand, pv.size
  HAVING COUNT(*) > 1
  ORDER BY pv.canonical_name LIMIT 20;

-- How many passports have >1 alias today (cross-store-merged products)
SELECT COUNT(*) FROM (
  SELECT internal_id FROM product_aliases
   GROUP BY internal_id HAVING COUNT(*) > 1
) m;

-- Spot-check a specific product's full history across all its aliases
SELECT ph.store, ph.scraped_at::date, ph.price
  FROM price_history_v2 ph
  JOIN product_aliases pa ON pa.internal_id = ph.internal_id
 WHERE pa.store = 'coles' AND pa.vendor_id = '<a real vendor_id>'
 ORDER BY ph.scraped_at;
```

## Commits in this ship

| SHA | Repo | What |
|---|---|---|
| `0e082f9` | pricemate-proxy | shadow-write code in db.js + backfill script + tests + runbook |
| `4123eeb` | pricemate-proxy | backfill honours PGDATABASE for test-DB rehearsal |
| `3c46207` | pricemate-proxy | OPTION_C_SHADOW_WRITE=1 in scraper workflows |
| `d821050` | pricemate | migration 005 + VM read-path patch source |
| `82fda75` | pricemate | frontend cuts predictions read to /api/price-history-v2 |

## Change-control rule

⛔ **The passport + aliases logic is now load-bearing for predictions.** It was designed deliberately, audited extensively (matching the audit findings from `01b2755`), and protects against a known-bad failure mode (`757caeb`'s false-merge class).

**Any change to this logic must be explicitly approved by Praveen before it lands.**

That includes — but is not limited to:

- The `products_v2` / `product_aliases` / `price_history_v2` schema
- The matching strategy in `backfill-internal-ids.js` (especially the brand+size guards)
- The shadow-write code in `db.js` (`shadowUpsertProductsV2`, `shadowInsertPriceHistoryV2`)
- The match-products.js Layer 0-4 thresholds (those layers underpin the rename detection)
- The `/api/price-history-v2` read endpoint behaviour
- The decision to ship inline rename detection (currently deferred)
- Any migration 006 work (dropping v1 tables)

Things that do NOT require approval:
- Reading the data (queries, dashboards, observability)
- Adding tests that pin down current behaviour
- Documentation updates that don't change semantics

## 2026-05-28 — Matcher hardened with variant guards

User reported a2 Milk 2L not showing Coles/Woolies in the compare
modal. Diagnosed → `product_groups` had no row linking the SKUs.
First rebuild attempt false-merged Coles a2 Full Cream Milk 2L
with Woolies a2 Milk Lactose Free Light 2L — Layer 0.5 (image
pHash) bucketed only by brand+size and pHashes for visually
similar carton designs hit Hamming ≤6.

### Variant qualifier guard (match-products.js)

Added `VARIANT_QUALIFIERS` set (33 phrases): `lactose free`,
`gluten free`, `dairy free`, `sugar free`, `fat free`, `no added
sugar`, `reduced sugar`, `reduced fat`, `low fat`, `low carb`,
`high protein`, `long life`, `no salt`, `extra light`, `extra
creamy`, `extra virgin`, `unsweetened`, `light`, `lite`, `skim`,
`decaf`, `decaffeinated`, `salted`, `unsalted`, `organic`, `uht`,
`diet`, `zero`, `keto`, `vegan`, `wholemeal`, `whole grain`,
`multigrain`.

`variantsMatch(nameA, nameB)` requires symmetric qualifier-set
match. Applied as a guard in Layers 0.5, 2, 3, 4 (the layers
where variant mismatches were possible). Layers 0 and 1 already
use exact name match, so they don't need the extra guard.

### Default behaviour change — `--apply` flag

`match-products.js` now defaults to **dry-run** (writes 3,809
groups to `/tmp/match-dryrun.json` for audit) instead of mutating
`product_groups` directly. Pass `--apply` to commit. The
TRUNCATE-then-INSERT pattern in `saveGroups()` is unchanged;
this just gates execution.

### Apply result (2026-05-28)

- Pre-rebuild baseline: 2,462 groups
- Hardened rebuild: **3,809 groups** (+1,347 net new correct matches)
- 41 three-store matches, 3,768 two-store
- The unhardened run would have produced 3,925 groups — 116 of
  those were variant-mismatched false merges, all now rejected
- Backup of pre-rebuild state at `/tmp/product_groups_backup_20260528_050745.sql` on VM (full restore is ~5s)

### Verified post-apply

`/api/compare?productId=9760091&store=coles` (Coles a2 Full Cream
Milk 2L) → matched, returns Coles + Woolies pair correctly.
Same for Lactose Free (different pair) and Lactose Free Light.

## 2026-05-28 — api-server.js committed to git (source-of-truth)

`api-server.js` (the Oracle VM's Express server serving DB-backed
endpoints to Vercel) had NEVER been committed to this repo despite
serving production traffic since 2026-05-27. This session added
several endpoints + hardening to it; all were VM-only until now.
If the VM died, all of it would be lost.

Endpoints in the current snapshot (320 lines):

| Endpoint | Purpose |
|---|---|
| `GET /api/products` | name/store search on `products` table |
| `GET /api/prices` | latest N rows from `price_history` |
| `GET /api/price-history` | legacy v1 timeseries |
| `GET /api/price-history-v2` | Option C v2 timeseries via passport+aliases |
| `GET /api/groups` | Cross-store identity lookup. **Parameterised** as of 2026-05-28 (was string-interpolation SQL-injection vector) |
| `GET /api/eligible-products` | products with ≥ N history rows; powers hero pickFakeDiscount. Supports `food_only=1` |
| `GET /api/search-products` | unified 3-store search with per-store balance + plural-stem (`prawns` ⇄ `prawn`). Replaces the proxy live-scrape path (which was 0-Woolies-result broken) |
| `POST /api/predictions-batch` | NEW 2026-05-28 — batched price history fetch. Replaces the N+1 fan-out in `lib/predictions.ts:getPredictions()` (was 481 round-trips for a milk search → 1 SQL query, 7s → 1.6s) |
| `GET /health` | liveness probe |

`FOOD_CATEGORIES` constant: empirical grocery category list from
the `products` table; used by `/api/eligible-products` and
`/api/search-products` when `food_only=1`.

### Rebuild from scratch if VM dies

```bash
# On a fresh Oracle VM:
git clone github-skandikatta:skandikatta/pricemate-proxy ~/pricemate-proxy
cd ~/pricemate-proxy && npm install
# Restore Postgres dump
psql -U pricemate -d pricemate -f <backup>
# systemd unit + env vars (DB_PASSWORD, RESEND_API_KEY, etc.)
sudo systemctl restart pricemate-api
```


## 2026-05-28 (late) — `special_type` filter + `/api/random-specials`

Two more endpoints added to `api-server.js`:

**`GET /api/random-specials?limit=N&food_only=1`** — returns N random
currently-on-special products (recent 7 days, was_price > price >
0). Powers hero `pickRealSale` which previously fanned out 6
sequential Render proxy queries (~16s cold). Now ~200-300ms.

**`/api/search-products` extended** with `special_type=half|weekly|clearance`:
- half: `price <= was_price * 0.55`
- weekly: any `is_on_special = true`
- clearance: `price <= was_price * 0.4`
- Filters price_history first, then joins products → fast even
  when most products aren't on special
- Optional name + food_only filters compose on top

## 2026-05-28 (latest) — Half Price band fix

`SPECIAL_RATIO` (single number) → `SPECIAL_BAND` ({min, max}).
Half Price now requires `0.35 < price/was_price ≤ 0.65` (i.e.,
35-65% off, ± 15% tolerance around true half-price). User
reported 78%-off Schwarzkopf was getting mis-tagged as Half
Price; now correctly routes to Clearance.

| special_type | Band | Median pctOff (n=200) |
|---|---|---|
| half | 0.35 < ratio ≤ 0.65 | 50% |
| clearance | ratio ≤ 0.35 | 75% |
| weekly | any | 50% |

## 2026-05-29 — Security hardening (P0)

Two P0 issues surfaced during morning code review of `api-server.js`:

### 1. Hard-coded Postgres password removed

`api-server.js` had `password: 'KHGZmj4hqqDfutFw3h2E'` literal in
the `new Pool()` block (committed in `1ab312d` on 2026-05-28 —
the "source-of-truth gap closed" commit *also* pushed the
secret to GitHub). `db.js` (used by every scraper) already
sourced from `process.env.DB_PASSWORD`, so the env path
existed — `api-server.js` just didn't use it.

**Fixed:**
```js
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'pricemate',
  user: 'pricemate',
  password: process.env.DB_PASSWORD,
})
if (!process.env.DB_PASSWORD) {
  console.error('FATAL: DB_PASSWORD env var is not set'); process.exit(1)
}
```

**VM rotation steps (done before commit — order matters; if you
commit first, the new code starts up without DB_PASSWORD set
and the API goes down):**

```bash
# On VM:
sudo -u postgres psql -c "ALTER USER pricemate WITH PASSWORD '<NEW>';"
# Append to systemd EnvironmentFile (same one holding RESEND_API_KEY):
#   Environment="DB_PASSWORD=<NEW>"
sudo systemctl daemon-reload
sudo systemctl restart pricemate-api
curl http://localhost:3001/health  # verify
# Then on dev box:
cd ~/aws/projects/pricemate-proxy && git push
```

**Why no `git filter-repo` history scrub:** private solo repo,
rotation makes the leaked literal inert, force-pushing rewritten
history would break any existing deploy clones referencing old
SHAs. Worth doing only if the repo ever goes public.

### 2. SQL injection on `/api/price-history` (v1 endpoint)

Line 41 interpolated `req.query.days` straight into the SQL
string: `INTERVAL '${days} days'`. The v2 endpoint at line 63
already used the safe pattern `($3 || ' days')::interval` — fix
was to apply the same pattern to v1.

| Before | After |
|---|---|
| `INTERVAL '${days} days'` (string-built) | `($3 \|\| ' days')::interval` with `[..., String(days)]` |

Severity in practice: low (the endpoint is read-only, no auth
gate, only exposes price data — but injectable means it could
return arbitrary rows from any table via `UNION SELECT`).

### Still open from the same review (not in this commit)

- API has zero access control on 10 endpoints — needs `x-api-key` middleware.
- No `helmet`, no `express-rate-limit` middleware installed.
- 8 other files (`backfill-internal-ids`, `compute-image-hashes`,
  `enrich-barcodes-from-off`, `ingest-hagglers-history`,
  `match-products`, `review-matches`, `send-alerts`, `api-server`)
  each construct their own `new Pool()` instead of importing
  the existing `db.js` shared pool. Mechanical consolidation
  pass deferred.
