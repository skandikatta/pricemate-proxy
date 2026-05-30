# Sweep Ghosts — Pipeline Documentation

## Overview

Nightly job that marks discontinued products as inactive in v2 (`product_aliases`). Runs after all scrapers have finished writing their `last_seen` bumps. Prevents ghost products from appearing in predictions and search results.

## Files

| File | Purpose |
|------|---------|
| `scripts/sweep-ghosts.js` | Flips `active = FALSE` on stale aliases |
| `.github/workflows/sweep-ghosts.yml` | Daily cron (23:30 UTC = 09:30 AEST) |

## How It Works

```
23:30 UTC — all 5 scrapers have finished (latest is CW at ~22:00 UTC)
    │
    ▼ Query: product_aliases WHERE active = TRUE AND last_seen < today - 14 days
    │
    ▼ UPDATE: SET active = FALSE for those rows
    │
    ▼ Report: per-store counts of active/inactive aliases
```

**The 14-day threshold:** A product must go unseen for 14 consecutive days before being swept. This avoids false positives from:
- Weekend scrape failures (recovered Monday)
- Temporary API outages
- Seasonal products that rotate weekly

## Comeback Path (automatic)

If a swept product reappears in a future scrape:
```
db.js:shadowUpsertProductsV2() → SET active = TRUE, last_seen = CURRENT_DATE
```

No manual intervention needed. The next scrape that sees the product automatically reactivates it.

## What Reads the `active` Flag

| Endpoint | Effect of `active = FALSE` |
|----------|---------------------------|
| `/api/eligible-products` | Product excluded from prediction-eligible pool |
| `/api/predictions-batch` | Product excluded from batch results |
| Ghost sweep itself | Won't re-flip already-inactive rows |

## Timing

```
18:30 UTC — Woolworths starts (bumps last_seen for all Woolies products)
19:30 UTC — IGA starts
20:00 UTC — Aldi + CW start
~21:00 UTC — Coles finishes (bumps last_seen for all Coles products)
~22:00 UTC — All scrapers done
23:30 UTC — Sweep runs (safe — everything has been bumped)
```

The 3.5-hour gap after the last scraper ensures no product gets swept just because its scraper hasn't run yet today.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `GHOST_DAYS` | 14 | Days without being seen before marking inactive |
| `DB_HOST` | (required) | PostgreSQL host |
| `DB_PASSWORD` | (required) | PostgreSQL password |

Override via workflow_dispatch: manually trigger with custom `ghost_days` input.

## Monitoring

- `SWEEP_SUMMARY` JSON in logs
- Key fields: `ghost_days`, `flipped`, `duration_ms`, `per_store`
- `flipped: 0` = normal (no new ghosts today)
- First real ghosts expected ~June 11 (14 days after backfill on May 28)

## Rollback

- Disable workflow in GitHub UI (toggle off)
- Reactivate all swept aliases: `UPDATE product_aliases SET active = TRUE WHERE active = FALSE`
- No data loss — sweep only flips a boolean, never deletes rows
