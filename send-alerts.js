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
//   APP_BASE_URL                     — e.g. https://cheapasmate.com
//   FROM_ADDRESS                     — e.g. "PriceMate <alerts@cheapasmate.com>"
//   REPLY_TO_ADDRESS                 — e.g. "hello@cheapasmate.com"
//
// Self-contained: HTML template inlined (no @swc/register, no cross-repo
// checkout for .tsx templates). The React Email source in
// skandikatta/pricemate/emails/AlertEmail.tsx is the dev-time reference;
// when you change the design there, regenerate the renderAlertHtml
// function below.
//
// Local dev: set env in .env; if RESEND_API_KEY is missing, the script
// logs what it would send instead of actually sending. Safe to dry-run.

const { Pool } = require('pg')
const { Resend } = require('resend')

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

const STORE_NAME = { coles: 'Coles', woolworths: 'Woolworths', aldi: 'Aldi' }

// HTML escape — every user-controlled value goes through this before
// landing in the template string. Same set as alerts.js on the VM.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Inline AlertEmail template (mirror of pricemate/emails/AlertEmail.tsx).
// Inline styles + table layouts so Outlook 2007 renders correctly.
function renderAlertHtml({ productName, store, currentPrice, normalPrice, cycleDays, productUrl, unsubscribeUrl }) {
  const savings = (normalPrice - currentPrice).toFixed(2)
  const pctOff = Math.round(((normalPrice - currentPrice) / normalPrice) * 100)
  const storeName = STORE_NAME[store] || store
  const cycleBlurb = cycleDays
    ? `This product has been half-price roughly every <strong style="color:#f1f0ff">${cycleDays} days</strong> for the last 6 months. Today's price matches the bottom of that cycle — historically the cheapest it gets.`
    : `Today's price is below 85% of the typical price for this product, based on 6 months of history.`
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#080520;font-family:Manrope,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:24px 12px;color:#f1f0ff">
<div style="max-width:520px;margin:0 auto;background:#0f0a2a;border-radius:16px;border:1px solid rgba(255,255,255,0.08);overflow:hidden">
  <div style="padding:20px 24px;border-bottom:1px solid rgba(255,255,255,0.08)">
    <table style="width:100%" role="presentation"><tr>
      <td style="vertical-align:middle;font-size:14px;font-weight:700;letter-spacing:-0.01em"><span style="color:#a78bfa">M</span> PriceMate</td>
      <td style="vertical-align:middle;text-align:right;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em">Sale alert</td>
    </tr></table>
  </div>
  <div style="padding:24px">
    <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:700;letter-spacing:-0.02em;line-height:1.2;color:#f1f0ff">${esc(productName)}</h1>
    <p style="margin:0 0 20px 0;font-size:13px;color:#9ca3af">On sale right now at <strong style="color:#f1f0ff">${esc(storeName)}</strong></p>
    <div style="padding:16px;border-radius:12px;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.30);margin-bottom:20px">
      <table style="width:100%" role="presentation"><tr>
        <td style="vertical-align:middle">
          <p style="margin:0;font-size:28px;font-weight:700;color:#fbbf24;letter-spacing:-0.02em;line-height:1">$${currentPrice.toFixed(2)}</p>
          <p style="margin:4px 0 0 0;font-size:12px;color:#fbbf24;opacity:0.85">was $${normalPrice.toFixed(2)} — save $${savings} (${pctOff}% off)</p>
        </td>
        <td style="vertical-align:middle;text-align:right">
          <a href="${esc(productUrl)}" style="background:#fbbf24;color:#080520;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none;display:inline-block">View on ${esc(storeName)}</a>
        </td>
      </tr></table>
    </div>
    <p style="margin:0 0 16px 0;font-size:13px;color:#9ca3af;line-height:1.5">${cycleBlurb}</p>
  </div>
  <hr style="border:0;border-top:1px solid rgba(255,255,255,0.08);margin:0">
  <div style="padding:16px 24px">
    <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.5">You're getting this because you signed up for PriceMate sale alerts. <a href="${esc(unsubscribeUrl)}" style="color:#a78bfa;text-decoration:underline">Unsubscribe with one click</a>.</p>
  </div>
</div></body></html>`
}

function renderAlertText({ productName, store, currentPrice, normalPrice, cycleDays, productUrl, unsubscribeUrl }) {
  const savings = (normalPrice - currentPrice).toFixed(2)
  const pctOff = Math.round(((normalPrice - currentPrice) / normalPrice) * 100)
  const storeName = STORE_NAME[store] || store
  return [
    `${productName}`,
    `On sale at ${storeName}`,
    ``,
    `$${currentPrice.toFixed(2)} (was $${normalPrice.toFixed(2)}, save $${savings}, ${pctOff}% off)`,
    `View: ${productUrl}`,
    ``,
    cycleDays
      ? `Half-price roughly every ${cycleDays} days for the last 6 months — historically the cheapest it gets.`
      : `Today's price is below 85% of the typical price for this product.`,
    ``,
    `--`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join('\n')
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
  // "On sale today" detection with three quality gates baked into SQL:
  //
  //   1. Use Coles's own `was_price` as the canonical normal price when
  //      present. Coles tells us "this is on sale, the regular price is X" —
  //      we should trust that over mode() of sparse history. mode() was
  //      giving wrong answers (e.g. picking $18.50 as "normal" for a Cream
  //      product whose real regular price is $11.50, because $18.50 happened
  //      to be in the table twice).
  //   2. Fall back to mode only when was_price is null/zero, AND require at
  //      least 7 records to consider the mode trustworthy.
  //   3. Reject "products" that look like garbage data:
  //        - name shorter than 10 chars (e.g. literal "Cream" / "Bananas")
  //        - savings > 60% (likely scraper noise, not a real half-price)
  //        - was_price disagrees with mode by >2× (volatile noise like the
  //          $39.50 cream / $5 bananas)
  //      These are conservative — better to under-alert than burn user trust.
  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT DISTINCT ON (store, product_id)
        store, product_id,
        price AS current_price,
        was_price,
        scraped_at
      FROM price_history
      WHERE scraped_at >= NOW() - INTERVAL '2 days'
      ORDER BY store, product_id, scraped_at DESC
    ),
    history AS (
      SELECT store, product_id,
             mode() WITHIN GROUP (ORDER BY price) AS mode_price,
             COUNT(*) AS records,
             MIN(price) AS hist_min,
             MAX(price) AS hist_max
      FROM price_history
      WHERE scraped_at >= NOW() - INTERVAL '180 days'
      GROUP BY store, product_id
    )
    SELECT r.store, r.product_id, r.current_price,
           -- Trust Coles's was_price first; fall back to mode if missing.
           COALESCE(NULLIF(r.was_price, 0), h.mode_price) AS normal_price,
           r.was_price,
           h.mode_price,
           p.name, p.brand, p.size, p.category, h.records,
           h.hist_min, h.hist_max,
           -- Percent savings for ordering — pick the deepest discounts first
           -- since the cap is 5 per user per email.
           (1 - r.current_price / COALESCE(NULLIF(r.was_price, 0), h.mode_price)) AS savings_pct
    FROM recent r
    JOIN history h ON h.store = r.store AND h.product_id = r.product_id
    JOIN products p ON p.store = r.store AND p.product_id = r.product_id
    WHERE r.current_price > 0
      AND p.name IS NOT NULL
      AND LENGTH(p.name) >= 10
      AND (
        -- Path A: trust was_price if present and a genuine sale
        (r.was_price IS NOT NULL AND r.was_price > 0
         AND r.current_price <= r.was_price * $1)
        OR
        -- Path B: no was_price → require strong history signal
        ((r.was_price IS NULL OR r.was_price = 0)
         AND h.records >= 7
         AND r.current_price <= h.mode_price * $1
         -- volatility guard: drop products where history is wildly noisy
         AND h.hist_max <= h.hist_min * 2.5)
      )
      -- Reject implausible savings (>60% off) — almost always scraper noise
      AND r.current_price >= COALESCE(NULLIF(r.was_price, 0), h.mode_price) * 0.40
    ORDER BY savings_pct DESC, r.current_price ASC
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

  const html = renderAlertHtml(props)
  const text = renderAlertText(props)

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
