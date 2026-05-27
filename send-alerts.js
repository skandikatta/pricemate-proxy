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

// Each store gets a colored badge using their actual brand color so the
// email is instantly identifiable by source. Coles red, Woolies green,
// Aldi blue + yellow. The PriceMate "NO GREEN" rule applies to SAVINGS
// semantics (where competitors use green); store-brand greens are
// legitimate identity here, not rule violations.
// logoW computed from each official logo's aspect ratio at 28px height:
//   Coles 103×32 → 90×28 (red wordmark)
//   Woolies 108×96 PNG → 32×28 (apple-W mark, square-ish)
//   Aldi 135×150 SVG → 26×28 (shield, slightly taller than wide → trim to 26)
// logoExt: file extension actually served at /store-logos/.
const STORE_BRAND = {
  coles:      { bg: '#E01A22', fg: '#FFFFFF', letter: 'C', logoW: 90, logoExt: 'svg' },
  woolworths: { bg: '#178740', fg: '#FFFFFF', letter: 'W', logoW: 32, logoExt: 'png' },
  aldi:       { bg: '#00549A', fg: '#FFCB05', letter: 'A', logoW: 26, logoExt: 'svg' },
}

// HTML escape — every user-controlled value goes through this before
// landing in the template string. Same set as alerts.js on the VM.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Per-store branded logo — hosted official mark on a white cell so the
// brand colors inside each logo render correctly (Coles red wordmark
// would otherwise blend into a red cell background).
//
// Image-blocked fallback: the white cell shows with a thin brand-colored
// border + the store name as alt text. Less colorful than a filled badge
// but still identifies the source. Most users (Gmail confirmed sender,
// Apple Mail, Outlook.com) see the official logo directly.
function storeBadgeHtml(store) {
  const b = STORE_BRAND[store]
  const name = STORE_NAME[store] || store
  if (!b) return `<span style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em">${esc(name)}</span>`
  const logoUrl = `${APP_BASE_URL}/store-logos/${store}.${b.logoExt}`
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:middle"><tr>
    <td style="background:#FFFFFF;border:1px solid ${b.bg};border-radius:6px;line-height:0;font-size:0;padding:3px 6px;height:28px;text-align:center;vertical-align:middle">
      <img src="${esc(logoUrl)}" width="${b.logoW}" height="28" alt="${esc(name)}" style="display:inline-block;border:0;outline:none;text-decoration:none;height:28px;width:${b.logoW}px;color:${b.bg};font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:0.05em">
    </td>
  </tr></table>`
}

// Digest email — one email, N product cards inside, each with the store's
// brand-color badge so the user can tell at a glance whether a deal is at
// Coles, Woolworths, or Aldi.
function renderDigestHtml({ items, scope, unsubscribeUrl }) {
  const intro = digestIntro(items.length, scope)
  const sub = digestSubHeader(scope)
  const itemsHtml = items.map(it => {
    const savings = (it.normalPrice - it.currentPrice).toFixed(2)
    const pctOff = Math.round(((it.normalPrice - it.currentPrice) / it.normalPrice) * 100)
    const brand = STORE_BRAND[it.store] || { bg: '#9ca3af', fg: '#FFFFFF', letter: '?' }
    // Each card has a left-edge color stripe matching the store's brand.
    return `<div style="margin-bottom:12px;border-radius:12px;overflow:hidden;background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06)">
  <table style="width:100%;border-collapse:collapse" role="presentation">
    <tr>
      <td style="width:4px;background:${brand.bg};padding:0"></td>
      <td style="padding:14px 16px">
        <table style="width:100%" role="presentation"><tr>
          <td style="vertical-align:top">
            <div style="margin-bottom:8px">${storeBadgeHtml(it.store)}</div>
            <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#f1f0ff;line-height:1.3">${esc(it.productName)}</p>
            <p style="margin:0;font-size:18px;font-weight:700;letter-spacing:-0.01em;line-height:1">
              <span style="color:#fbbf24">$${it.currentPrice.toFixed(2)}</span>
              <span style="font-size:12px;color:#9ca3af;font-weight:500;text-decoration:line-through;margin-left:4px">$${it.normalPrice.toFixed(2)}</span>
              <span style="font-size:11px;color:#fbbf24;font-weight:700;margin-left:6px;letter-spacing:0.02em">${pctOff}% OFF</span>
            </p>
            <p style="margin:4px 0 0 0;font-size:11px;color:#9ca3af">save $${savings}</p>
          </td>
          <td style="vertical-align:middle;text-align:right;padding-left:12px;white-space:nowrap">
            <a href="${esc(it.productUrl)}" style="background:#fbbf24;color:#080520;padding:9px 14px;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;display:inline-block">View at ${esc(STORE_NAME[it.store])}</a>
          </td>
        </tr></table>
      </td>
    </tr>
  </table>
</div>`
  }).join('')
  // Count distinct stores represented so the sub-header can advertise.
  const storeCounts = items.reduce((acc, it) => { acc[it.store] = (acc[it.store] || 0) + 1; return acc }, {})
  const storeChips = Object.entries(storeCounts).map(([store, n]) => {
    const b = STORE_BRAND[store]
    return `<span style="display:inline-block;margin-right:6px;padding:3px 8px;border-radius:6px;background:${b.bg};color:${b.fg};font-size:10px;font-weight:700;letter-spacing:0.03em">${n} ${esc(STORE_NAME[store].toUpperCase())}</span>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#080520;font-family:Manrope,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:24px 12px;color:#f1f0ff">
<div style="max-width:560px;margin:0 auto;background:#0f0a2a;border-radius:16px;border:1px solid rgba(255,255,255,0.08);overflow:hidden">
  <div style="padding:20px 24px;border-bottom:1px solid rgba(255,255,255,0.08)">
    <table style="width:100%" role="presentation"><tr>
      <td style="vertical-align:middle;font-size:14px;font-weight:700;letter-spacing:-0.01em"><span style="color:#a78bfa">M</span> PriceMate</td>
      <td style="vertical-align:middle;text-align:right;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em">Sale alerts</td>
    </tr></table>
  </div>
  <div style="padding:24px">
    <h1 style="margin:0 0 6px 0;font-size:22px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;color:#f1f0ff">${esc(intro)}</h1>
    ${sub ? `<p style="margin:0 0 14px 0;font-size:13px;color:#9ca3af;line-height:1.4">${esc(sub)}</p>` : ''}
    <div style="margin-bottom:18px">${storeChips}</div>
    ${itemsHtml}
  </div>
  <hr style="border:0;border-top:1px solid rgba(255,255,255,0.08);margin:0">
  <div style="padding:16px 24px">
    <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.5">You're getting this because you signed up for PriceMate sale alerts. <a href="${esc(unsubscribeUrl)}" style="color:#a78bfa;text-decoration:underline">Unsubscribe with one click</a>.</p>
  </div>
</div></body></html>`
}

function digestSubHeader(scope) {
  if (scope === 'watchlist') return 'From your watchlist'
  if (scope === 'category') return 'In your selected category'
  return null
}

function renderDigestText({ items, scope, unsubscribeUrl }) {
  const intro = digestIntro(items.length, scope)
  const lines = [intro, '']
  for (const it of items) {
    const savings = (it.normalPrice - it.currentPrice).toFixed(2)
    const pctOff = Math.round(((it.normalPrice - it.currentPrice) / it.normalPrice) * 100)
    const storeName = (STORE_NAME[it.store] || it.store).toUpperCase()
    lines.push(`[${storeName}] ${it.productName}`)
    lines.push(`  $${it.currentPrice.toFixed(2)} (was $${it.normalPrice.toFixed(2)}, save $${savings}, ${pctOff}% off)`)
    lines.push(`  ${it.productUrl}`)
    lines.push('')
  }
  lines.push('--')
  lines.push(`Unsubscribe: ${unsubscribeUrl}`)
  return lines.join('\n')
}

function digestIntro(n, scope) {
  if (scope === 'watchlist') {
    return n === 1
      ? `1 product from your watchlist is on sale today`
      : `${n} products from your watchlist are on sale today`
  }
  if (scope === 'category') {
    return n === 1 ? `1 deal in your category today` : `${n} deals in your category today`
  }
  return n === 1 ? `Today's top deal` : `Today's top ${n} deals`
}

function digestSubject(items, scope) {
  if (items.length === 1) {
    const it = items[0]
    const pctOff = Math.round(((it.normalPrice - it.currentPrice) / it.normalPrice) * 100)
    return `${it.productName} is ${pctOff}% off at ${STORE_NAME[it.store] || it.store}`
  }
  const topSave = Math.max(...items.map(i => Math.round(((i.normalPrice - i.currentPrice) / i.normalPrice) * 100)))
  if (scope === 'watchlist') return `${items.length} from your watchlist on sale — up to ${topSave}% off`
  if (scope === 'category') return `${items.length} deals in your category — up to ${topSave}% off`
  return `${items.length} sale alerts — up to ${topSave}% off`
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
  // Server-side watchlist (migration 002_user_watchlist.sql). Returns the
  // user's full watched-products set. The cron then intersects this with
  // the day's on-sale products and sends a digest of the matches.
  const { rows } = await pool.query(
    `SELECT store, product_id FROM user_watchlist WHERE LOWER(email) = LOWER($1)`,
    [email]
  )
  return rows
}

async function sendDigest(sub, products) {
  // One digest email per subscription per cron run. All matched products go
  // in this email; dedup is recorded per (sub, product) so a product alerted
  // today won't re-appear in tomorrow's digest within DEDUP_DAYS.
  const unsubscribeUrl = `${APP_BASE_URL}/alerts/unsubscribe?token=${encodeURIComponent(sub.token)}`
  const items = products.map(p => ({
    productName: [p.name, p.size].filter(Boolean).join(' '),
    store: p.store,
    currentPrice: parseFloat(p.current_price),
    normalPrice: parseFloat(p.normal_price),
    productUrl: storeUrl[p.store]?.(p.product_id) || APP_BASE_URL,
  }))

  const subject = digestSubject(items, sub.scope)

  if (!resend) {
    console.log(`[DRY] would send digest "${subject}" to ${sub.email} with ${items.length} items`)
    items.forEach((it, i) => console.log(`       ${i+1}. ${it.productName} — $${it.currentPrice} (was $${it.normalPrice})`))
    return { dry: true, count: items.length }
  }

  const html = renderDigestHtml({ items, scope: sub.scope, unsubscribeUrl })
  const text = renderDigestText({ items, scope: sub.scope, unsubscribeUrl })

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

  // Record one email_sends row per product so dedup works at product
  // granularity. All N rows share the same provider_id (the digest's
  // Resend message id) — that linkage is useful for tracing bounces back
  // to which alert batch they belonged to.
  const providerId = result.data?.id || null
  const params = products.flatMap(p => [sub.id, 'alert', p.store, p.product_id, providerId])
  const valueSql = products.map((_, i) => {
    const b = i * 5
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`
  }).join(',')
  await pool.query(
    `INSERT INTO email_sends (subscription_id, kind, store, product_id, provider_id) VALUES ${valueSql}`,
    params
  )
  return { sent: true, id: providerId, count: items.length }
}

async function main() {
  const startedAt = Date.now()
  const subs = await findActiveSubscriptions()
  const onSale = await findProductsOnSale()
  console.log(`[send-alerts] ${subs.length} active 'instant' subs · ${onSale.length} products on sale today`)

  // Per-scope caps for how many products go in the digest. Watchlist users
  // explicitly chose those products — show them all (up to 20 for safety).
  // All-specials/category users get a curated top-N.
  const MAX_PER_DIGEST = { watchlist: 20, 'all-specials': 5, category: 8 }

  let emailsSent = 0, productsAlerted = 0, skipCount = 0, dryCount = 0, errCount = 0, subsWithNothing = 0

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
      candidates = onSale.filter(p => p.category === sub.scope_payload)
    }

    // Filter out already-alerted (dedup) before capping
    const fresh = []
    for (const p of candidates) {
      if (await alreadyAlerted(sub.id, p.store, p.product_id)) { skipCount++; continue }
      fresh.push(p)
    }

    const cap = MAX_PER_DIGEST[sub.scope] || 5
    const digestItems = fresh.slice(0, cap)

    if (digestItems.length === 0) {
      subsWithNothing++
      continue
    }

    try {
      const r = await sendDigest(sub, digestItems)
      if (r.dry) dryCount++
      else { emailsSent++; productsAlerted += r.count }
    } catch (e) {
      console.error(`[send-alerts] failed to send digest to ${sub.email}: ${e.message}`)
      errCount++
    }
  }

  const summary = {
    date: new Date().toISOString().slice(0, 10),
    subs_active: subs.length,
    products_on_sale: onSale.length,
    emails_sent: emailsSent,
    products_alerted: productsAlerted,
    dry_run: dryCount,
    subs_no_new_products: subsWithNothing,
    skipped_dedup: skipCount,
    errors: errCount,
    duration_s: Math.round((Date.now() - startedAt) / 1000),
  }
  console.log('SEND_ALERTS_SUMMARY ' + JSON.stringify(summary))
  await pool.end()
  if (errCount > 0) process.exitCode = 1
}

main().catch(e => { console.error('CRASH:', e); process.exit(1) })
