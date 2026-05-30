# Send Alerts — Pipeline Documentation

## Overview

Sends sale alert emails to subscribers when products on their watchlist go on special. Runs after all scrapers complete to ensure fresh data. Uses Resend API for email delivery.

## Files

| File | Purpose |
|------|---------|
| `send-alerts.js` | Main logic — find matching specials, dedup, send emails |
| `alerts.js` | Express routes for subscribe/confirm/unsubscribe/watchlist CRUD |
| `.github/workflows/send-alerts.yml` | Trigger: after Woolworths completes + fallback cron 23:00 UTC |

## Trigger Strategy

```
Woolworths scrape completes (workflow_run event)
    │
    ▼ send-alerts.js fires
    │   By this time: Coles (18:30), Woolies (18:30), IGA (19:30), Aldi (20:00) all done
    │
    ▼ Fallback: cron 23:00 UTC catches the case where Woolies never completes
    │
    ▼ Dedup: if both triggers fire, second run sends 0 emails (no double-sends)
```

**Why trigger on Woolworths?** It's the slowest scraper (~90 min). By the time it finishes, all other scrapers have already completed. This eliminates the race condition where alerts fire before a store's data is fresh.

## How It Works

1. Query `email_subscriptions` for active instant subscribers
2. For each subscriber, check their watchlist products against today's `price_history`
3. If a watched product went on special today (and wasn't already alerted), send email
4. Record the send in `email_sends` to prevent duplicates

## Deduplication

- `skipped_dedup` counter — products already alerted in a previous run today
- `subs_no_new_products` — subscriber's watchlist has nothing new on sale
- Safe to double-trigger (cron + workflow_run) — no duplicate emails ever sent

## Environment Variables

| Var | Source | Purpose |
|-----|--------|---------|
| `DB_HOST` | GH secret | PostgreSQL host |
| `DB_PASSWORD` | GH secret | PostgreSQL password |
| `RESEND_API_KEY` | GH secret | Email delivery |
| `APP_BASE_URL` | GH secret | Links in email (https://cheapasmate.com) |
| `FROM_ADDRESS` | GH secret | Sender (alerts@cheapasmate.com) |
| `REPLY_TO_ADDRESS` | GH secret | Reply-to (hello@cheapasmate.com) |

## Monitoring

- `SEND_ALERTS_SUMMARY` JSON in logs
- Key fields: `subs_active`, `products_on_sale`, `emails_sent`, `errors`
- `emails_sent: 0` with `subs_no_new_products: N` = normal (nothing new to alert on)
- `errors > 0` = Resend API issue, check logs

## DB Tables

- `email_subscriptions` — subscriber list (email, frequency, scope, status, token)
- `email_sends` — audit trail (subscription_id, kind, sent_at)
- Watchlist stored in subscription `scope_payload` JSON

## Current State

- 1 active subscriber (testing phase)
- Fires daily after Woolworths completes
- 13K+ products on sale across all stores
- Dedup working correctly
