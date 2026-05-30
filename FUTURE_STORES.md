# Future Stores — Scraping Feasibility

## Currently Live (6 stores)

| Store | Products | Method | Runtime |
|-------|----------|--------|---------|
| Woolworths | 53,925 | Direct API + cookies | ~90 min |
| Coles | 28,625 | Render proxy + Playwright fallback | ~30 min |
| Chemist Warehouse | 24,972 | Sitemap + `__NEXT_DATA__` (VM, AU IP) | ~2 hours |
| Priceline | ~14,382 | SAP OCC API (sitemap-driven) | ~12 min |
| IGA | 3,815 | Storefront gateway API | 91 sec |
| Aldi | 2,689 | HTML parsing | ~3 min |

## Ready to Build

### Bunnings — ✅ Easy (same as Aldi approach)

- **Method:** `__NEXT_DATA__` in search/category pages (server-rendered Next.js)
- **Geo-blocked:** No
- **Auth required:** No
- **Products:** ~50,000+ (hardware, garden, paint, tools, outdoor)
- **Data available:** name, price, brand, code, image, categories
- **Estimated runtime:** ~30 min (paginated search)
- **Effort:** Low — same pattern as existing scrapers
- **Value:** Hardware/home price comparison (no AU competitor does this)

**Tested 2026-05-30:**
```
GET /search/products?q=drill → 200, __NEXT_DATA__ contains:
  results[].raw.name: "Ryobi 18V ONE+ Drill Driver Starter Kit R18DD22"
  results[].raw.price: 99.98
  results[].raw.brandname: "Ryobi One+"
  results[].raw.code: product ID
```

## Possible But Hard

### Costco AU — ⚠️ Hard (needs login + anti-bot bypass)

- **Method:** Playwright + member login (session-based scraping)
- **Geo-blocked:** Yes (Akamai blocks all automated access, even from AU IP)
- **Auth required:** Yes (Costco membership login)
- **Products:** ~4,000 (grocery + household bulk)
- **Anti-bot:** Akamai (aggressive — blocks sitemap, API, category pages)
- **Risk:** Account suspension if scraping detected
- **Effort:** High — Playwright stealth + cookie management + login flow
- **Value:** High — "is Costco membership worth it?" is a common question

**Tested 2026-05-30:**
```
Sitemap: 403 Access Denied
Category pages: 403
REST API: 403
All from AU IP — Akamai blocks everything without browser session
```

**Approach if attempted:**
1. Playwright with stealth plugin
2. Login with member credentials
3. Navigate category pages, extract product tiles
4. Gentle throttle (1 req/3s) to avoid detection
5. Run from VM (AU IP required)

### Big W — ⚠️ Hard (blocks scrapers)

- **Method:** Would need Playwright or Google Shopping feed
- **Geo-blocked:** Yes (returns 403 on product pages, even from AU IP)
- **Auth required:** No, but anti-bot active
- **Products:** ~10,000 (household, pantry, toys, electronics)
- **Anti-bot:** Active blocking on product pages (category pages return 403)
- **Effort:** High
- **Value:** Medium — household essentials at discount prices

**Tested 2026-05-30:**
```
Sitemap: accessible (product URLs listed)
Product pages: 403 from AU IP
Search pages: Next.js but __NEXT_DATA__ is empty (client-rendered)
```

### Amazon AU Fresh — ⚠️ Medium (official API available)

- **Method:** Product Advertising API (official, requires affiliate approval)
- **Geo-blocked:** N/A (API-based)
- **Auth required:** Yes (affiliate API keys)
- **Products:** ~20,000+ grocery items
- **Anti-bot:** N/A (official API)
- **Effort:** Medium — need to apply for affiliate program, then straightforward
- **Value:** Medium — grocery delivery comparison

### Dan Murphy's / BWS — ⚠️ Hard (Imperva)

- **Method:** Would need Playwright with stealth
- **Geo-blocked:** Yes
- **Auth required:** No
- **Products:** ~15,000 (liquor)
- **Anti-bot:** Imperva (same as Coles — heavy)
- **Effort:** High
- **Value:** Liquor price comparison (niche but loyal audience)

**Tested 2026-05-30:** 403 from AU IP on all endpoints.

## Not Worth Pursuing

| Store | Reason |
|-------|--------|
| Kmart | No grocery/pharmacy overlap, general merchandise only |
| Target AU | Closing stores, limited online |
| Officeworks | Niche (stationery/tech), no overlap with current stores |

## Priority Order (recommended)

1. **Bunnings** — easy win, no competitor does hardware price comparison in AU
2. **Costco** — high user value but high risk/effort. Wait for ACCC mandatory API ruling.
3. **Amazon AU** — apply for affiliate API now, build when approved
4. **Big W** — revisit if ACCC mandates price APIs (would cover Woolworths-owned stores)

## ACCC Mandatory Price API (game-changer, pending)

The ACCC's March 2025 final report recommended:
> "Coles and Woolworths should provide their current prices to third parties using APIs"

Treasury is consulting on this now. If legislated:
- Coles + Woolworths get official APIs (no more scraping needed)
- Likely extends to Aldi (ACCC named all three)
- Timeline: unknown, possibly 2026-2027

This would eliminate scraping risk for the big 3 and potentially open up stores that currently block access.
