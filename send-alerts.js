// send-alerts.js
// Runs daily after the 3 scrapes complete (cron: 0 21 * * * = 7am AEST).
// For every active subscription, finds products matching the scope that hit
// their predicted sale threshold today, and emails the user.
//
// Dedup: a row in email_sends with the same (subscription_id, store,
// product_id) within the last 14 days suppresses re-sending. Catches the
// common "still on sale next day" case so we don't email twice for one cycle.
//
// Env (GH Actions secrets):
//   DB_HOST, DB_PASSWORD             — Postgres on Oracle VM
//   RESEND_API_KEY                   — Resend API key
//   APP_BASE_URL                     — e.g. https://pricemate-seven.vercel.app
//   FROM_ADDRESS                     — e.g. "PriceMate Alerts <alerts@pricemate.app>"
//                                       (or "PriceMate <onboarding@resend.dev>" in sandbox)
//
// Local dev: set those in .env.local; if RESEND_API_KEY is missing, the
// script logs what it would send instead of actually sending. Safe to dry-run.

require('@swc/register')
const { Pool } = require('pg')
const { Resend } = require('resend')
const { render } = require('@react-email/render')
const path = require('path')

// Resolve template paths against the frontend repo (sibling checkout on VM).
// On GH Actions runners we check out both repos in the workflow.
const AlertEmail = require(path.resolve(__dirname, '../pricemate/emails/AlertEmail')).default

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://cheapasmate.com'
const FROM_ADDRESS = process.env.FROM_ADDRESS || 'PriceMate <alerts@cheapasmate.com>'
const REPLY_TO_ADDRESS = process.env.REPLY_TO_ADDRESS || 'hello@cheapasmate.com'
const RESEND_API_KEY = process.env.RESEND_API_KEY
const SALE_THRESHOLD = 0.85   // price <= 85% of normal counts as on-sale
const DEDUP_DAYS = 14         // don't re-alert same product within 14d

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null
if (!resend) console.warn('[send-alerts] RESEND_API_KEY not set — DRY RUN mode')

const pool = new Pool({
  host: process.env.DB_HOST,
  port: 5432,
  database: 'pricemate',
  user: 'pricemate',
  password: process.env.DB_PASSWORD,
})

const storeUrl = {
  coles:      (id) => `https://www.coles.com.au/product/${id}`,
  woolworths: (id) => `https://www.woolworths.com.au/shop/productdetails/${id}`,
  aldi:       () => 'https://www.aldi.com.au/groceries/',  // Aldi doesn't have product URLs
}

async function findActiveSubscriptions() {
  const { rows } = await pool.query(
    `SELECT id, email, frequency, scope, scope_payload, token
     FROM email_subscriptions
     WHERE status = 'active' AND frequency = 'instant'`
  )
  return rows
}

async function findProductsOnSale() {
  // "On sale today" = the most recent price_history row for the product is
  // <= 85% of the mode (most-common) price across the last 180 days.
  // Computed in SQL for efficiency vs N round-trips per product.
  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT DISTINCT ON (store, product_id)
        store, product_id, price AS current_price, scraped_at
      FROM price_history
      WHERE scraped_at >= NOW() - INTERVAL '2 days'
      ORDER BY store, product_id, scraped_at DESC
    ),
    mode AS (
      SELECT store, product_id,
             mode() WITHIN GROUP (ORDER BY price) AS normal_price,
             COUNT(*) AS records
      FROM price_history
      WHERE scraped_at >= NOW() - INTERVAL '180 days'
      GROUP BY store, product_id
      HAVING COUNT(*) >= 5
    )
    SELECT r.store, r.product_id, r.current_price, m.normal_price,
           p.name, p.brand, p.size, m.records
    FROM recent r
    JOIN mode m ON m.store = r.store AND m.product_id = r.product_id
    JOIN products p ON p.store = r.store AND p.product_id = r.product_id
    WHERE r.current_price <= m.normal_price * $1
      AND r.current_price > 0
      AND p.name IS NOT NULL
  `, [SALE_THRESHOLD])
  return rows
}

async function alreadyAlerted(subId, store, productId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM email_sends
     WHERE subscription_id = $1 AND store = $2 AND product_id = $3 AND kind = 'alert'
       AND sent_at >= NOW() - INTERVAL '${DEDUP_DAYS} days'
     LIMIT 1`,
    [subId, store, productId]
  )
  return rows.length > 0
}

async function watchlistFor(email) {
  // The frontend stores watchlist in localStorage (per useWatchlist hook).
  // For the cron to know what each user watches, they need to opt-in to
  // server-side watchlist sync. Until that's built, 'watchlist' scope is
  // skipped here. 'all-specials' is the default that works without sync.
  // TODO when we ship server-side watchlist: SELECT store, product_id
  // FROM user_watchlist WHERE LOWER(user_email) = $1.
  return null
}

async function sendOne(sub, product) {
  const currentPrice = parseFloat(product.current_price)
  const normalPrice = parseFloat(product.normal_price)
  const productUrl = storeUrl[product.store]?.(product.product_id) || APP_BASE_URL
  const unsubscribeUrl = `${APP_BASE_URL}/alerts/unsubscribe?token=${encodeURIComponent(sub.token)}`

  const fullName = [product.name, product.size].filter(Boolean).join(' ')
  const props = {
    productName: fullName,
    store: product.store,
    currentPrice,
    normalPrice,
    cycleDays: null,  // TODO: pull from a pre-computed predictions table once C in FIXES.md ships
    productUrl,
    unsubscribeUrl,
  }

  const subject = `${fullName} is on sale at ${product.store[0].toUpperCase()}${product.store.slice(1)}`

  if (!resend) {
    console.log(`[DRY] would send "${subject}" to ${sub.email} (was $${normalPrice} → $${currentPrice})`)
    return { dry: true }
  }

  const html = await render(AlertEmail(props))
  const text = await render(AlertEmail(props), { plainText: true })

  const result = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sub.email,
    reply_to: REPLY_TO_ADDRESS,
    subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  })

  await pool.query(
    `INSERT INTO email_sends (subscription_id, kind, store, product_id, provider_id)
     VALUES ($1, 'alert', $2, $3, $4)`,
    [sub.id, product.store, product.product_id, result.data?.id || null]
  )
  return { sent: true, id: result.data?.id }
}

async function main() {
  const startedAt = Date.now()
  const subs = await findActiveSubscriptions()
  const onSale = await findProductsOnSale()
  console.log(`[send-alerts] ${subs.length} active 'instant' subs · ${onSale.length} products on sale today`)

  let sentCount = 0, skipCount = 0, dryCount = 0, errCount = 0

  for (const sub of subs) {
    // Determine candidate products for this sub
    let candidates = []
    if (sub.scope === 'all-specials') {
      candidates = onSale
    } else if (sub.scope === 'watchlist') {
      const wl = await watchlistFor(sub.email)
      if (!wl) continue
      const wlSet = new Set(wl.map(w => `${w.store}|${w.product_id}`))
      candidates = onSale.filter(p => wlSet.has(`${p.store}|${p.product_id}`))
    } else if (sub.scope === 'category') {
      // scope_payload = category slug. category is on `products.category`.
      candidates = onSale.filter(p => p.category === sub.scope_payload)
    }

    // Cap at 5 products per email per user — don't spam with 30 specials.
    candidates = candidates.slice(0, 5)

    for (const p of candidates) {
      if (await alreadyAlerted(sub.id, p.store, p.product_id)) { skipCount++; continue }
      try {
        const r = await sendOne(sub, p)
        if (r.dry) dryCount++
        else sentCount++
      } catch (e) {
        console.error(`[send-alerts] failed to send to ${sub.email} for ${p.store}/${p.product_id}: ${e.message}`)
        errCount++
      }
    }
  }

  const summary = {
    date: new Date().toISOString().slice(0, 10),
    subs_active: subs.length,
    products_on_sale: onSale.length,
    sent: sentCount,
    dry_run: dryCount,
    skipped_dedup: skipCount,
    errors: errCount,
    duration_s: Math.round((Date.now() - startedAt) / 1000),
  }
  console.log('SEND_ALERTS_SUMMARY ' + JSON.stringify(summary))
  await pool.end()
  if (errCount > 0) process.exitCode = 1
}

main().catch(e => { console.error('CRASH:', e); process.exit(1) })
