# 2026-05-30 Session Notes

## Pipeline Review & Fixes

### Scrapers checked (all passing ✅)
- **Coles** (run 26662204073): 28,625 products, 19 changes, clean
- **Woolworths** (run 26661123309): 4 groups all passed, ~54K unique products
- **Aldi** (run 26664155087): 2,689 products, 1 change, clean
- **Sweep Ghosts** (run 26670659191): 0 ghosts (expected — backfill was 2 days ago)
- **Send Alerts** (run 26668495739): 1 subscriber, 13K on sale, 0 emails (no new products to alert)

### Fixes applied

1. **Woolworths false degradation warning** — each parallel group compared its partial count against the full 53K catalog. Fixed: threshold now scales by `groupFraction` (departments in group / total departments).

2. **IGA missing OPTION_C_SHADOW_WRITE** — IGA had 0 v2 aliases because the workflow never set the flag. Fixed: added `OPTION_C_SHADOW_WRITE: "1"` to `scrape-iga.yml`.

3. **CW missing OPTION_C_SHADOW_WRITE** — same issue. Fixed: added `export OPTION_C_SHADOW_WRITE=1` to the SSH command in `scrape-chemistwarehouse.yml`.

4. **DB CHECK constraints** — `product_aliases`, `price_history_v2`, and `user_watchlist` only allowed coles/woolworths/aldi. Fixed: added iga, priceline, chemistwarehouse to all three constraints.

### Priceline scraper — SHIPPED ✅
- `scrape-priceline.js` — SAP OCC API, sitemap-driven
- 14,382 products via `api.priceline.com.au/occ/v2/priceline/products/{code}`
- No geo-blocking, no auth, no browser needed
- Runs from GitHub Actions (~12 min estimated)
- First run triggered manually — writing to both v1 and v2 successfully
- Workflow: `.github/workflows/scrape-priceline.yml` (cron 20:30 UTC)
- Commits: `295d919`, `1b47b10`

### Documentation created
- `IGA_SCRAPER.md`
- `CHEMISTWAREHOUSE_SCRAPER.md`
- `PRICELINE_SCRAPER.md`
- `SEND_ALERTS.md`
- `SWEEP_GHOSTS.md`
- `FUTURE_STORES.md`
- Updated `WOOLWORTHS_SCRAPER.md` (fixed 114K→54K, added incident)

## Store Coverage (now 6 stores)

| Store | Products | Method | Status |
|-------|----------|--------|--------|
| Woolworths | 53,925 | Direct API + cookies | ✅ Live |
| Coles | 28,625 | Render proxy + Playwright | ✅ Live |
| Chemist Warehouse | 24,972 | Sitemap + __NEXT_DATA__ (VM) | ✅ Live |
| Priceline | ~14,382 | SAP OCC API | ✅ First run in progress |
| IGA | 3,815 | Storefront gateway API | ✅ Live |
| Aldi | 2,689 | HTML parsing | ✅ Live |

## Future Stores Research

### Ready to build
- **Bunnings** — `__NEXT_DATA__` in search pages, no geo-block, no auth. Easy win. Hardware/home category nobody else covers.

### Hard (blocked)
- **Costco** — Akamai blocks everything. Needs Playwright + member login. High risk.
- **Big W** — 403 on product pages. Needs Playwright or Google Shopping feed.
- **Kmart** — Cloudflare 403 on everything. Limited value (overlap with existing stores).
- **Dan Murphy's** — Imperva. Blocked.

### Not viable
- **Pet stores** (PetCircle, PetBarn, PetStock, My Pet Warehouse) — all blocked or client-rendered. Pet products already covered via Coles/Woolies/CW.
- **Telcos** (Telstra, Optus, Vodafone) — different product category, crowded market (WhistleOut/Finder), client-rendered. Not a fit.

### High potential (different approach)
- **Fuel prices** — public government APIs (FuelWatch WA, NSW FuelCheck). No scraping needed. High daily engagement. Fits brand.

## Still pending (manual action needed)
- [x] ~~Backfill IGA into v2~~ — `backfill-new-stores.js` + GH Actions workflow "Backfill new stores to v2" (trigger manually)
- [x] ~~Backfill CW into v2~~ — same script handles both
- [x] ~~Set API_KEY on VM~~ — done (401 without key confirmed)
- [x] ~~Add API_KEY to Vercel~~ — done (sensitive, redeploy triggered)
- [x] ~~Run `match-products.js --apply` after IGA backfill~~ — included in backfill workflow
- [ ] Point cheapasmate.com domain to Vercel production when ready to go live
- [ ] Clean up stale SUPABASE_KEY and SUPABASE_URL env vars from Vercel (no longer used)

## Commits this session
- `295d919` pricemate-proxy — Priceline scraper + Woolworths fix + IGA/CW shadow-write + docs
- `1b47b10` pricemate-proxy — PRICELINE_SCRAPER.md
- `78f6feb` pricemate-proxy — FUTURE_STORES.md
- `c02d95b` pricemate-proxy — Update FUTURE_STORES.md (Kmart)
- `63230c4` pricemate-proxy — session notes
- `e571141` pricemate — API_KEY header via shared dbFetch helper (16 files)
- `89395bf` pricemate — trigger redeploy for API_KEY env var

## Security Review Fixes (late session)

### P1 fixes applied
1. **`days` param validation** — `/api/price-history` and `/api/price-history-v2` now `parseInt` + clamp (1–365, default 180). Previously non-numeric values caused 500 errors.
2. **Subscribe rate limit** — `/api/alerts/subscribe` now has a dedicated 5 req/min/IP limiter (was only protected by the global 300/min). Prevents email-bombing via the confirmation flow.

### P2 fixes applied
3. **Pool error handler** — `pool.on('error', ...)` added to `db.js`. Prevents unhandled idle-client disconnects from crashing the process.

### Files changed
- `api-server.js` — days param validation on both price-history endpoints
- `alerts.js` — added `express-rate-limit` import + `subscribeLimiter` (5/min/IP)
- `db.js` — pool error handler
