# Option C — internal_id (passport) + product_aliases (phone numbers) — Apply Runbook

> **✅ APPLIED to prod 2026-05-28.** Live-state document: [`OPTION_C_PROD_STATE.md`](./OPTION_C_PROD_STATE.md).
>
> **⛔ Changes to this logic require Praveen's explicit approval** — see change-control rule in OPTION_C_PROD_STATE.md.
>
> Stages 0-5 executed; Stage 6 (drop v1 tables, migration 006) intentionally deferred until ≥7 days of clean v2 predictions.
>
> This document is preserved as the procedure of record. If you need to re-run any stage (e.g. on a clone, or for a future similar migration), the commands below still apply.

**Pre-reqs:** Option B in force (was current state). `match-products.js` Layers 0-4 with brand+size guards (already shipped).
**Design source:** `pricemate-proxy/REFACTOR_PRICE_HISTORY.md` (Option C section).

This runbook walks the cutover from vendor_id-keyed `price_history` to internal_id-keyed `price_history_v2`. It is intentionally **staged** — dual-write for a week before flipping reads, drop old tables only after sustained verification.

## Why staged

757caeb (the original "smart ID migration") shipped in one step and corrupted data silently — the audit later found 896 false-merge groups in Coles, e.g. "full cream milk" mapping to 14 different vendor_ids. Option C reuses `match-products.js` Layers 0-4 (brand + size + barcode guards, not just name) which dramatically reduces the false-merge class, but staging the rollout means we can **observe** the merge groups before committing predictions to them.

## Stage 0 — Backup (REQUIRED, do not skip)

On the Oracle VM:

```bash
TS=$(date +%Y%m%dT%H%M%SZ)
sudo -u postgres pg_dump -d pricemate -F c -f /var/lib/postgresql/backups/pre-option-c-${TS}.dump
sudo -u postgres ls -lh /var/lib/postgresql/backups/pre-option-c-*.dump | tail -3
# Copy off the VM:
scp ubuntu@<vm>:/var/lib/postgresql/backups/pre-option-c-${TS}.dump ~/backups/
```

Verify the dump is restorable into a scratch DB before touching prod:

```bash
sudo -u postgres createdb pricemate_test_restore
sudo -u postgres pg_restore -d pricemate_test_restore /var/lib/postgresql/backups/pre-option-c-${TS}.dump
sudo -u postgres psql -d pricemate_test_restore -c "SELECT COUNT(*) FROM price_history;"
sudo -u postgres dropdb pricemate_test_restore
```

## Stage 1 — Apply migration 005 (additive, low-risk)

```bash
sudo -u postgres psql -d pricemate -f ~/pricemate/migrations/005_option_c_passport_aliases.sql
```

Expected output: `CREATE EXTENSION`, `CREATE TABLE` × 3, `CREATE INDEX` × 7, `GRANT` × 4.

Verify the new tables exist and are empty:

```sql
\d products_v2
\d product_aliases
\d price_history_v2
SELECT COUNT(*) FROM products_v2;       -- 0
SELECT COUNT(*) FROM product_aliases;   -- 0
SELECT COUNT(*) FROM price_history_v2;  -- 0
```

## Stage 2 — Rehearse the backfill on a test DB clone

**Do not run backfill on prod first.** Clone, rehearse, audit, then prod.

```bash
sudo -u postgres dropdb --if-exists pricemate_test
sudo -u postgres createdb pricemate_test
sudo -u postgres pg_restore -d pricemate_test \
  /var/lib/postgresql/backups/pre-option-c-${TS}.dump

# Apply migration 005 onto the test clone too
sudo -u postgres psql -d pricemate_test \
  -f ~/pricemate/migrations/005_option_c_passport_aliases.sql

# Dry-run first
cd ~/pricemate-proxy
DB_HOST=localhost DB_PASSWORD=$PRICEMATE_DB_PASSWORD \
  PGDATABASE=pricemate_test \
  node backfill-internal-ids.js
# Inspect the audit JSON it writes — backfill-audit-*.json
ls -lt backfill-audit-*.json | head -1
```

**Audit checklist (open the JSON):**

- `match_counts` — distribution across Layer 0-4. Layer 0 (barcode) is the most trusted; Layer 4 (Aldi house brand) is the most aggressive.
- `merged_passports_sample_top200` — the JSON lists passports sorted by alias count (most-merged first). Scan for obviously-wrong merges:
  - Different brands paired together? → 757caeb-class bug returning. Stop.
  - Different sizes paired together? → Bug. Stop.
  - Sensible cross-store matches (Coles Pauls 2L ↔ Woolies Pauls 2L)? → Good.
- If anything looks wrong, do NOT run `--apply` on prod. Investigate match-products.js layer thresholds first.

**Spot-check a known rename** (if you have one — Aldi seasonal rotations are a good source):
```sql
-- Pick a recently-retired Aldi product_id and a similar-looking new one.
-- Did backfill merge them? Should it have?
```

When you trust the dry-run:
```bash
# Apply to TEST clone first
DB_HOST=localhost DB_PASSWORD=$PRICEMATE_DB_PASSWORD \
  PGDATABASE=pricemate_test \
  node backfill-internal-ids.js --apply

# Verify on test
sudo -u postgres psql -d pricemate_test <<'SQL'
SELECT 'products_v2' AS t, COUNT(*) FROM products_v2
UNION ALL SELECT 'aliases', COUNT(*) FROM product_aliases
UNION ALL SELECT 'price_history_v2', COUNT(*) FROM price_history_v2;
-- Multi-alias passports (cross-store + within-store merges)
SELECT internal_id, COUNT(*) AS n
  FROM product_aliases GROUP BY internal_id HAVING COUNT(*) > 1
  ORDER BY n DESC LIMIT 20;
SQL
sudo -u postgres dropdb pricemate_test
```

## Stage 3 — Apply backfill on PROD

```bash
cd ~/pricemate-proxy
DB_HOST=localhost DB_PASSWORD=$PRICEMATE_DB_PASSWORD \
  node backfill-internal-ids.js                 # dry-run
ls -lt backfill-audit-*.json | head -1          # review the new audit file
DB_HOST=localhost DB_PASSWORD=$PRICEMATE_DB_PASSWORD \
  node backfill-internal-ids.js --apply         # commit to prod
```

Verify:
```sql
SELECT COUNT(*) FROM products_v2;       -- should be ≈ COUNT(*) FROM products minus merge gains
SELECT COUNT(*) FROM product_aliases;   -- should == COUNT(*) FROM products
SELECT COUNT(*) FROM price_history_v2;  -- should == COUNT(*) FROM price_history
```

## Stage 4 — Turn on dual-write in the scraper

The new `db.js` shadow-write code is gated on `OPTION_C_SHADOW_WRITE=1`. The scraper runs as a systemd service or via GitHub Actions; wherever its env lives, set the flag.

If running on the VM via systemd:
```bash
sudo systemctl edit pricemate-scraper   # or whichever unit
# Add under [Service]:
#   Environment=OPTION_C_SHADOW_WRITE=1
sudo systemctl daemon-reload
sudo systemctl restart pricemate-scraper
```

If running via GitHub Actions: add `OPTION_C_SHADOW_WRITE=1` to the workflow env.

For at least **7 days**, watch:
- `price_history` grows the same as it always has (Option B intact)
- `price_history_v2` grows alongside it
- Counts should be approximately equal day-over-day
- Scraper logs are clean (no `[shadow-v2 ...]` warnings)

```sql
-- Daily growth check
SELECT
  (SELECT COUNT(*) FROM price_history WHERE scraped_at::date = CURRENT_DATE) AS v1_today,
  (SELECT COUNT(*) FROM price_history_v2 WHERE scraped_at::date = CURRENT_DATE) AS v2_today;
```

## Stage 5 — Cut over the read path

Apply the VM patch:

```bash
# On the VM
cd ~/pricemate-proxy
# Append vm-patches/2026-05-28-option-c-read-path.js content to api-server.js
# OR require it as a module and wire app.get('/api/price-history-v2', ...)
sudo systemctl restart pricemate-api

# Smoke test (use a real product_id from your DB)
curl 'http://localhost:3001/api/price-history-v2?store=coles&product_id=12345&days=180'
```

Frontend cutover (separate Vercel deploy):

```ts
// In pricemate/lib/predictions.ts, line ~202 — flip the endpoint:
const res = await fetch(
  `${DB_API}/api/price-history-v2?product_id=${encodeURIComponent(productId)}&store=${store}&days=180`,
  ...
)
```

Watch predictions for **7 days**. Compare against v1 for sanity:
- Pick 10 popular products. Hit both v1 and v2 endpoints. Diff the returned series. v2 should be ≥ v1 in row count (more rows when aliases stitched history across renames).
- Any product where v2 produces a wildly different prediction than v1 was likely a false-merge — investigate.

## Stage 6 — Drop old tables (migration 006, future commit)

After 7+ days of stable predictions on v2 reads:
- Write `migrations/006_drop_v1_price_history.sql` (DROP TABLE price_history; rename price_history_v2 → price_history; etc.)
- Update db.js scrapers to write to canonical names (the wrappers go away)
- Remove `OPTION_C_SHADOW_WRITE` env flag
- Remove the v1 endpoint on the VM

Don't do step 6 until v2 reads have been correct in production for at least a week.

## Rollback plans

**During Stage 1-2** (additive, no writes to v1 disturbed): just drop the v2 tables.
```sql
DROP TABLE IF EXISTS price_history_v2 CASCADE;
DROP TABLE IF EXISTS product_aliases CASCADE;
DROP TABLE IF EXISTS products_v2 CASCADE;
```

**During Stage 3-4** (backfilled, dual-writing): turn off shadow writes, leave the v2 tables in place (or drop if you want a clean slate).
```bash
# Remove OPTION_C_SHADOW_WRITE=1 from the scraper env, restart
```

**During Stage 5** (read cut over to v2): flip the frontend back to v1.
```ts
// Revert the predictions.ts endpoint change. Old v1 endpoint still serves.
```

**Catastrophic** (data wrong, need to rebuild from scratch): restore from `pre-option-c-${TS}.dump` taken in Stage 0.

## Pre-flight checklist

- [ ] Stage 0: pg_dump taken AND verified restorable
- [ ] Stage 1: migration 005 applied, v2 tables exist + empty
- [ ] Stage 2: rehearsed backfill on `pricemate_test` clone, audited JSON
- [ ] Stage 3: backfill applied on prod, counts verified
- [ ] Stage 4: shadow-write enabled, 7+ days of clean dual-write
- [ ] Stage 5: VM patch applied, frontend cut over to v2, 7+ days clean
- [ ] Stage 6: write + apply migration 006 (deferred)
