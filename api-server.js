const express = require('express')
const { Pool } = require('pg')
const alerts = require('./alerts')
const app = express()
app.use(express.json())

// Password sourced from systemd EnvironmentFile on the VM (DB_PASSWORD).
// Never hard-code — git history before 2026-05-29 contains a leaked literal;
// it has been rotated server-side, so the old value in history is now inert.
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

app.get('/api/products', async (req, res) => {
  const { store, name, product_id, limit = 100, offset = 0 } = req.query
  let q = 'SELECT * FROM products WHERE 1=1'
  const params = []
  if (store) { params.push(store); q += ` AND store=$${params.length}` }
  if (name) { params.push(`%${name}%`); q += ` AND name ILIKE $${params.length}` }
  if (product_id) { params.push(product_id); q += ` AND product_id=$${params.length}` }
  params.push(limit, offset)
  // LOWER(name) so lowercase-leading product names (e.g. "a2 Milk Full Cream
  // Milk") sort alongside uppercase counterparts. Default ASCII ordering put
  // them after every A-Z row, so name search at limit=30 missed them entirely.
  q += ` ORDER BY LOWER(name) LIMIT $${params.length-1} OFFSET $${params.length}`
  const { rows } = await pool.query(q, params)
  res.json(rows)
})

app.get('/api/prices', async (req, res) => {
  const { store, product_id, limit = 1 } = req.query
  const { rows } = await pool.query(
    'SELECT * FROM price_history WHERE store=$1 AND product_id=$2 ORDER BY scraped_at DESC LIMIT $3',
    [store, product_id, limit]
  )
  res.json(rows)
})

app.get('/api/price-history', async (req, res) => {
  const { store, product_id, days = 180 } = req.query
  if (!store || !product_id) return res.status(400).json({ error: 'store and product_id required' })
  const { rows } = await pool.query(
    `SELECT price, was_price, is_on_special, scraped_at FROM price_history WHERE store=$1 AND product_id=$2 AND scraped_at > NOW() - ($3 || ' days')::interval ORDER BY scraped_at ASC`,
    [store, product_id, String(days)]
  )
  res.json(rows)
})


app.get('/api/price-history-v2', async (req, res) => {
  const { store, product_id, days = 180 } = req.query
  if (!store || !product_id) return res.status(400).json({ error: 'store and product_id required' })
  const { rows } = await pool.query(
    `WITH passport AS (
       SELECT internal_id FROM product_aliases
        WHERE store = $1 AND vendor_id = $2 LIMIT 1
     )
     SELECT ph.price::float AS price,
            ph.was_price::float AS was_price,
            ph.is_on_special,
            ph.scraped_at
       FROM price_history_v2 ph
       JOIN passport p ON ph.internal_id = p.internal_id
      WHERE ph.store = $1
        AND ph.scraped_at >= NOW() - ($3 || ' days')::interval
      ORDER BY ph.scraped_at ASC`,
    [store, product_id, String(days)]
  )
  res.json(rows)
})

// Parameterized — was string-interpolating user input straight into SQL,
// classic injection vector (e.g. `?coles_id=' OR '1'='1` would exfiltrate
// arbitrary rows). Fixed via $1 binding.
app.get('/api/groups', async (req, res) => {
  const { coles_id, woolworths_id, aldi_id } = req.query
  let q, val
  if (coles_id) { q = 'SELECT * FROM product_groups WHERE coles_id = $1 LIMIT 1'; val = coles_id }
  else if (woolworths_id) { q = 'SELECT * FROM product_groups WHERE woolworths_id = $1 LIMIT 1'; val = woolworths_id }
  else if (aldi_id) { q = 'SELECT * FROM product_groups WHERE aldi_id = $1 LIMIT 1'; val = aldi_id }
  else return res.json([])
  try {
    const { rows } = await pool.query(q, [val])
    res.json(rows)
  } catch (e) {
    console.error('[groups]', e.message)
    res.status(500).json({ error: 'query failed' })
  }
})

// Food-grade product categories — anything edible or drinkable. Excludes
// health-beauty, pet, baby, household, home-garden, cleaning, the "lower
// prices" promotional bucket (mixed contents), and miscategorised non-food.
// Sourced from the empirical category distribution in the `products` table
// 2026-05-28: top categories with >30 products. Variants like
// "dairy-eggs-fridge" and "dairy eggs fridge" (different separators) both
// included since the retailer scrape data isn't normalised.
const FOOD_CATEGORIES = [
  'pantry', 'dietary-world-foods', 'drinks', 'dairy-eggs-fridge',
  'frozen', 'chips-chocolates-snacks', 'bakery', 'meat-seafood-deli',
  'fruit-veg', 'meat-seafood', 'fruit-vegetables', 'deli',
  'dairy eggs fridge', 'fruits vegetables', 'freezer', 'meat seafood',
  'deli chilled meats', 'snacks confectionery',
]

// Returns product (store, product_id) pairs that have ≥ min_history rows in
// price_history_v2 over the last 180 days — i.e. the ~7k prediction-eligible
// pool. Used by the Vercel /api/hero-examples picker so it samples from
// products that have enough signal to produce a verdict, rather than random
// catalog products where ~96% return null. Read-only; safe.
//
// food_only=1 narrows to grocery categories — keeps the hero away from
// surfacing things like Pigeon teats as the "fake discount" example.
app.get('/api/eligible-products', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500)
  const minHistory = Math.max(parseInt(req.query.min_history, 10) || 7, 1)
  const store = req.query.store
  const foodOnly = req.query.food_only === '1'
  const params = [minHistory, limit]
  let storeFilter = ''
  if (store && ['coles', 'woolworths', 'aldi'].includes(store)) {
    params.push(store)
    storeFilter = ` AND pa.store = $${params.length}`
  }
  let foodFilter = ''
  if (foodOnly) {
    params.push(FOOD_CATEGORIES)
    foodFilter = ` AND p.category = ANY($${params.length})`
  }
  try {
    const { rows } = await pool.query(
      `WITH eligible AS (
         SELECT pa.store, pa.vendor_id, COUNT(*) AS history_count
           FROM price_history_v2 ph
           JOIN product_aliases pa
             ON ph.internal_id = pa.internal_id AND ph.store = pa.store
          WHERE ph.scraped_at >= NOW() - INTERVAL '180 days'
            ${storeFilter}
          GROUP BY pa.store, pa.vendor_id
         HAVING COUNT(*) >= $1
       )
       SELECT e.store, e.vendor_id AS product_id, e.history_count,
              p.name, p.brand, p.size, p.image, p.category
         FROM eligible e
         JOIN products p ON p.store = e.store AND p.product_id = e.vendor_id
        WHERE 1=1${foodFilter}
        ORDER BY RANDOM()
        LIMIT $2`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('[eligible-products]', e.message)
    res.status(500).json({ error: 'query failed' })
  }
})

// Unified product search across all three stores — replaces the per-store
// proxy scrape path for Vercel's /api/search. Returns products + their latest
// price in a single LATERAL-join query. Daily-scrape data is ≤24h stale
// (acceptable per the PriceMate brand promise — Hagglers does the same), and
// the proxy path can keep failing without breaking search.
//
// Filters supported:
//   ?q=<keyword>        — name ILIKE '%q%', required
//   ?limit=<N>          — total cap, default 300, max 1000
//   ?store=coles|...    — single-store filter (optional)
//   ?food_only=1        — limit to grocery categories (same set as
//                         /api/eligible-products)
app.get('/api/search-products', async (req, res) => {
  const q = (req.query.q || '').trim()
  const specialType = req.query.special_type  // 'half' | 'weekly' | 'clearance'
  const VALID_SPECIAL = new Set(['half', 'weekly', 'clearance'])
  const isSpecialQuery = specialType && VALID_SPECIAL.has(specialType)
  // Either a name query OR a special_type filter is required.
  if (!q && !isSpecialQuery) return res.status(400).json({ error: 'q or special_type required' })
  const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000)
  const requestedStore = req.query.store
  const foodOnly = req.query.food_only === '1'

  // Plural-stem handling: if the query is plural ("prawns"), also accept
  // the singular form ("prawn") via SQL ORs. Coles names products "Garlic
  // Prawns" (plural), Woolies often uses "Cooked Prawn Cutlets" (singular).
  // Without this, the substring-only ILIKE missed the singular variants.
  // Conservative: only strip a final lowercase 's' from words of length ≥4
  // to avoid mangling short words like "cos" (lettuce) or "gas".
  const qPatterns = q ? [`%${q}%`] : []
  if (q && q.length >= 4 && q.endsWith('s')) qPatterns.push(`%${q.slice(0, -1)}%`)
  if (q && q.length >= 3 && !q.endsWith('s')) qPatterns.push(`%${q}s%`)

  // Per-store balance: rather than one global LIMIT (which lets alphabet-
  // dense stores like Coles crowd out Aldi), query each store separately
  // with its own cap and UNION ALL the results. perStoreLimit ≈ limit / 3
  // gives each store an equal slice; food_only and explicit store filters
  // are passed through.
  const perStoreLimit = Math.max(50, Math.ceil(limit / 3))
  const stores = requestedStore && ['coles', 'woolworths', 'aldi'].includes(requestedStore)
    ? [requestedStore]
    : ['coles', 'woolworths', 'aldi']

  // For special_type queries, the price ratio defines the filter band.
  // 'half'      : RANGE 35-65% off (price is 35-65% of was_price). Centred on
  //               true half-price ± 15% tolerance. Anything deeper than 65%
  //               off is Clearance, NOT half-price.
  //               Fix 2026-05-28: was a single-sided ≥45% off threshold,
  //               which mis-tagged 78%-off Schwarzkopf as "Half Price".
  // 'clearance' : 65%+ off (price ≤ 35% of was_price). The "blow it out"
  //               clearance tier.
  // 'weekly'    : any current special (any positive discount where
  //               is_on_special=true).
  const SPECIAL_BAND = {
    half:      { min: 0.35, max: 0.65 },
    weekly:    { min: 0.0,  max: 1.0  },
    clearance: { min: 0.0,  max: 0.35 },
  }

  try {
    const allRows = []
    for (const store of stores) {
      let rows
      if (isSpecialQuery) {
        // Path A: filter price_history first (small result set), then join
        // products. Avoids the LIMIT-before-filter problem the q-path would
        // hit when most products aren't on special.
        const band = SPECIAL_BAND[specialType]
        const params = [store, band.min, band.max]
        let foodClause = ''
        if (foodOnly) {
          params.push(FOOD_CATEGORIES)
          foodClause = ` AND p.category = ANY($${params.length})`
        }
        // Optional name filter ON TOP of the special_type filter — supports
        // future "special offers in coffee" style searches.
        let nameClause = ''
        if (qPatterns.length > 0) {
          for (const pat of qPatterns) params.push(pat)
          const startIdx = params.length - qPatterns.length + 1
          nameClause = ' AND (' + qPatterns.map((_, i) => `p.name ILIKE $${startIdx + i}`).join(' OR ') + ')'
        }
        params.push(perStoreLimit)
        const limitParam = `$${params.length}`
        const result = await pool.query(
          `WITH recent_specials AS (
             SELECT DISTINCT ON (store, product_id) store, product_id,
                    price::float AS price,
                    was_price::float AS was_price,
                    is_on_special, cup_price, scraped_at
               FROM price_history
              WHERE store = $1
                AND scraped_at >= NOW() - INTERVAL '7 days'
                AND is_on_special = true
                AND price > 0
                AND was_price > price
                AND price >  was_price * $2
                AND price <= was_price * $3
              ORDER BY store, product_id, scraped_at DESC
           )
           SELECT p.store, p.product_id, p.name, p.brand, p.size, p.image, p.category,
                  r.price, r.was_price, r.is_on_special, r.cup_price, r.scraped_at
             FROM recent_specials r
             JOIN products p ON p.store = r.store AND p.product_id = r.product_id
            WHERE 1=1${foodClause}${nameClause}
            ORDER BY (r.was_price - r.price) DESC NULLS LAST, LOWER(p.name)
            LIMIT ${limitParam}`,
          params
        )
        rows = result.rows
      } else {
        // Path B (default): name search via the matched CTE + LATERAL.
        const params = [store, ...qPatterns]
        const nameClause = qPatterns.map((_, i) => `name ILIKE $${i + 2}`).join(' OR ')
        let foodClause = ''
        if (foodOnly) {
          params.push(FOOD_CATEGORIES)
          foodClause = ` AND category = ANY($${params.length})`
        }
        params.push(perStoreLimit)
        const limitParam = `$${params.length}`
        const result = await pool.query(
          `WITH matched AS (
             SELECT store, product_id, name, brand, size, image, category, image_phash
               FROM products
              WHERE store = $1
                AND (${nameClause})
                ${foodClause}
              ORDER BY LOWER(name)
              LIMIT ${limitParam}
           )
           SELECT m.store, m.product_id, m.name, m.brand, m.size, m.image, m.category,
                  ph.price::float AS price,
                  ph.was_price::float AS was_price,
                  ph.is_on_special,
                  ph.cup_price,
                  ph.scraped_at
             FROM matched m
             LEFT JOIN LATERAL (
               SELECT price, was_price, is_on_special, cup_price, scraped_at
                 FROM price_history
                WHERE store = m.store AND product_id = m.product_id
                ORDER BY scraped_at DESC
                LIMIT 1
             ) ph ON true
            WHERE ph.price IS NOT NULL`,
          params
        )
        rows = result.rows
      }
      allRows.push(...rows)
    }
    res.json(allRows)
  } catch (e) {
    console.error('[search-products]', e.message)
    res.status(500).json({ error: 'query failed' })
  }
})

// Batched price history fetch — replaces the N+1 fan-out that
// `lib/predictions.ts:getPredictions()` was doing on Vercel (one HTTP call
// per product → 481 round-trips for a milk search). This endpoint returns
// price history for ALL requested products in a single SQL query keyed on
// (store, vendor_id) tuples. Vercel still runs the computePrediction()
// pipeline in JS over the returned rows — no logic duplicated server-side.
//
// POST body: { items: [{ store: 'coles', productId: '12345' }, ...] }
// Response : { 'coles_12345': [{ price, was_price, is_on_special, scraped_at }, ...], ... }
//
// Cap at 600 items per call to stop a hostile/oversized basket from
// generating an unbounded query — same envelope as the existing search cap.
app.post('/api/predictions-batch', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null
  if (!items || items.length === 0) return res.status(400).json({ error: 'items array required' })
  if (items.length > 600) return res.status(400).json({ error: 'too many items (max 600)' })

  // Validate every (store, productId) before building the WHERE clause —
  // pg parameterised queries handle the SQL-injection side, but we still
  // want clean shape errors before round-tripping the DB.
  const VALID = new Set(['coles', 'woolworths', 'aldi'])
  const pidRe = /^[A-Za-z0-9_-]{1,64}$/
  for (const it of items) {
    if (!it || typeof it !== 'object'
        || !VALID.has(it.store)
        || typeof it.productId !== 'string' || !pidRe.test(it.productId)) {
      return res.status(400).json({ error: 'invalid item shape' })
    }
  }

  // Build the (store, vendor_id) IN-list. pg supports tuple-in-tuple via
  // array params — but it's simpler to flatten and reference each pair with
  // ($n, $n+1) placeholders, generating one row per (store, vendor) pair.
  const params = []
  const pairs = items.map(it => {
    params.push(it.store, it.productId)
    const a = params.length - 1, b = params.length
    return `($${a}, $${b})`
  }).join(',')

  try {
    const { rows } = await pool.query(
      `SELECT pa.store, pa.vendor_id AS product_id,
              ph.price::float AS price,
              ph.was_price::float AS was_price,
              ph.is_on_special,
              ph.scraped_at
         FROM product_aliases pa
         JOIN price_history_v2 ph
           ON ph.internal_id = pa.internal_id AND ph.store = pa.store
        WHERE (pa.store, pa.vendor_id) IN (${pairs})
          AND ph.scraped_at >= NOW() - INTERVAL '180 days'
        ORDER BY pa.store, pa.vendor_id, ph.scraped_at ASC`,
      params
    )
    // Group rows by `${store}_${product_id}` for cheap key lookup in JS.
    const grouped = {}
    for (const r of rows) {
      const k = `${r.store}_${r.product_id}`
      if (!grouped[k]) grouped[k] = []
      grouped[k].push({
        price: r.price,
        was_price: r.was_price,
        is_on_special: r.is_on_special,
        scraped_at: r.scraped_at,
      })
    }
    res.json(grouped)
  } catch (e) {
    console.error('[predictions-batch]', e.message)
    res.status(500).json({ error: 'query failed' })
  }
})

// Random sample of currently-on-special products across all 3 stores.
// Used by /api/hero-examples pickRealSale to skip the slow 6-proxy-query
// path (which was ~16s on Render cold start). This is ~100ms reading from
// the DB. Returns the same shape as /api/search-products.
app.get('/api/random-specials', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 80, 200)
  const foodOnly = req.query.food_only === '1'

  const params = []
  let foodClause = ''
  if (foodOnly) {
    params.push(FOOD_CATEGORIES)
    foodClause = ` AND p.category = ANY($${params.length})`
  }
  params.push(limit)
  const limitParam = `$${params.length}`

  try {
    // Optimised: instead of DISTINCT ON across all price_history (slow), pull
    // ONLY recent on-special rows via the scraped_at + is_on_special filter,
    // which use idx_ph_scraped + the scraper writes ~1 row per product per
    // scrape day. The DISTINCT ON then narrows to the truly-latest row
    // per (store, product_id) inside the much smaller set.
    const { rows } = await pool.query(
      `WITH recent_specials AS (
         SELECT DISTINCT ON (store, product_id) store, product_id,
                price::float AS price,
                was_price::float AS was_price,
                is_on_special, cup_price, scraped_at
           FROM price_history
          WHERE scraped_at >= NOW() - INTERVAL '7 days'
            AND is_on_special = true
            AND price > 0
            AND was_price > price
          ORDER BY store, product_id, scraped_at DESC
       )
       SELECT p.store, p.product_id, p.name, p.brand, p.size, p.image, p.category,
              l.price, l.was_price, l.is_on_special, l.cup_price, l.scraped_at
         FROM recent_specials l
         JOIN products p ON p.store = l.store AND p.product_id = l.product_id
        WHERE 1=1 ${foodClause}
        ORDER BY RANDOM()
        LIMIT ${limitParam}`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('[random-specials]', e.message)
    res.status(500).json({ error: 'query failed' })
  }
})

app.get('/health', (req, res) => res.json({ status: 'ok', db: 'postgresql' }))

alerts.register(app, pool)
app.listen(5000, () => console.log('API running on port 5000'))
