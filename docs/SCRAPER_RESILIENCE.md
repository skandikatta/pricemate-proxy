# Scraper Resilience & Disaster Recovery Plan

## Current Protections (already built)

- Preflight checks (all 6 scrapers)
- Adaptive throttle + retry with backoff (all)
- Graceful exit on external failure (all)
- Ghost sweep (daily, marks stale products inactive)
- Change-only storage (ON CONFLICT DO NOTHING)
- Playwright fallback (Coles only)
- Category auto-discovery (Coles/Woolies)
- Progress persistence (Coles/Woolies/CW)
- Degradation threshold (Coles/Woolies only)
- Price > 0 check on v2 shadow-write

## TODO: Priority Fixes

| # | Fix | Effort | Impact |
|---|---|:---:|:---:|
| 1 | Automated daily DB backup (pg_dump cron) | 15 min | 🔴 Critical |
| 2 | Degradation alert on IGA/CW/Priceline | 10 min | 🟡 High |
| 3 | Price validation (reject $0, negative, >$9999) on v1 path | 10 min | 🟡 High |
| 4 | Rate-of-change guard (alert if >20% prices change in one day) | 10 min | 🟡 High |
| 5 | Email alert when scraper fails (via Resend) | 30 min | 🟡 High |
| 6 | Scrape audit log (track each run for rollback) | 1 hour | 🟡 Medium |
| 7 | VM fallback cron (if GH Actions misses a day) | 20 min | 🟢 Medium |
| 8 | Disk usage alert | 5 min | 🟢 Low |
| 9 | Proxy rotation (for when IPs get blocked) | 2 hours | 🟢 Low |

## Disaster Scenarios & Recovery

### Store changes/blocks API
- Preflight catches it → exits clean → no bad data
- Fix: investigate next day, update scraper
- Coles has Playwright fallback; others need manual fix

### VM goes down
- Recovery: daily backup → spin new VM → restore dump → resume
- Max data loss: 1 day
- Rebuild script: `OPTION_C_PROD_STATE.md` has full instructions

### GitHub Actions fails
- Fix: VM fallback cron at 23:00 UTC runs critical scrapers locally
- Check: `SELECT COUNT(*) FROM price_history WHERE scraped_at::date = CURRENT_DATE`
- If < 10 rows today → trigger local scrape

### Bad data written (scraper bug)
- Rate-of-change guard flags suspicious runs (>20% prices changed)
- Rollback: `DELETE FROM price_history WHERE store='X' AND scraped_at::date = 'YYYY-MM-DD'`
- Predictions auto-recalculate on next query

### Database corruption/loss
- Daily pg_dump cron (7-day rotation)
- WAL archiving for point-in-time recovery (future)
- Off-site backup to S3 or private repo (future)

## Implementation Details

### 1. Automated daily DB backup
```bash
# Add to VM crontab:
0 4 * * * pg_dump -U pricemate pricemate | gzip > /var/lib/postgresql/backups/daily-$(date +\%a).sql.gz
```
Keeps 7 rotating backups (Mon-Sun). ~50MB compressed at current DB size.

### 2. Degradation alert (add to IGA/CW/Priceline scrapers)
```javascript
const priorCount = await getStoreProductCount(store)
// ... after scrape ...
if (priorCount && total < priorCount * 0.70) {
  console.warn(`⚠️ DEGRADATION: ${store} returned ${total} (expected ~${priorCount})`)
}
```

### 3. Price validation (add to db.js insertPriceChanges)
```javascript
prices = prices.filter(p => {
  const n = parseFloat(p.price)
  return Number.isFinite(n) && n > 0 && n < 9999
})
```
Already exists for v2 path. Add to v1 path too.

### 4. Rate-of-change guard
```javascript
const changeRate = changed.length / prices.length
if (changeRate > 0.20 && prices.length > 100) {
  console.warn(`⚠️ SUSPICIOUS: ${(changeRate*100).toFixed(1)}% of ${store} prices changed`)
}
```

### 5. Email alert on failure
```javascript
// In each scraper's catch block:
if (process.env.RESEND_API_KEY && total === 0) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'alerts@cheapasmate.com',
      to: ['hello@cheapasmate.com'],
      subject: `⚠️ ${store} scraper failed`,
      html: `<p>${store} returned 0 products. Check GitHub Actions.</p>`,
    }),
  })
}
```

### 6. VM fallback cron
```bash
# Add to VM crontab — only fires if GH Actions missed today:
0 23 * * * cd ~/pricemate-proxy && source /etc/pricemate-env && [ $(psql -h localhost -U pricemate -d pricemate -t -c "SELECT COUNT(*) FROM price_history WHERE scraped_at::date = CURRENT_DATE") -lt 10 ] && node scrape-woolworths.js && node scrape-coles.js
```

## Redundancy (future, when revenue justifies cost)

| Level | What | When |
|---|---|---|
| Multi-path scraping | 2 methods per store | When a store blocks primary |
| Multi-region VM | Second VM in different region | When paying customers depend on uptime |
| Read replica | Postgres replica for API | When API > 100 req/sec |
| Proxy rotation | Residential proxies for blocked stores | When IP bans become frequent |
| Off-site backup | S3 or private repo | When DB > 1GB |
