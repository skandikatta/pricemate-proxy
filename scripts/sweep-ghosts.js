// Nightly sweep — flips product_aliases.active = FALSE for any alias whose
// last_seen is more than GHOST_DAYS old.
//
// Rationale: shadow-write bumps last_seen = CURRENT_DATE on every scrape for
// products that come back from the retailer API. If a vendor_id stops being
// returned (discontinued, renamed/repacked, category drift), its last_seen
// freezes. After 14 days of no returns we treat it as a ghost and exclude it
// from search, eligible-products, and predictions-batch read paths.
//
// Comes back? The next shadow-write on that alias sets active = TRUE again.
// See db.js:shadowUpsertProductsV2 (`SET last_seen = CURRENT_DATE, active = TRUE`).
//
// Bounded write: AND active = TRUE clause means we only touch rows that are
// actually changing — UPDATE count == number of new ghosts today.

const { pool } = require('../db')

const GHOST_DAYS = parseInt(process.env.GHOST_DAYS, 10) || 14

async function main() {
  const started = Date.now()

  const before = await pool.query(
    `SELECT store, COUNT(*)::int AS n
       FROM product_aliases
      WHERE active = TRUE AND last_seen < CURRENT_DATE - $1::int
      GROUP BY store ORDER BY store`,
    [GHOST_DAYS]
  )
  console.log(`[sweep] ghost-aliases >${GHOST_DAYS}d (about to flip):`)
  for (const r of before.rows) console.log(`  ${r.store}: ${r.n}`)
  if (before.rows.length === 0) console.log('  (none)')

  const result = await pool.query(
    `UPDATE product_aliases
        SET active = FALSE
      WHERE active = TRUE
        AND last_seen < CURRENT_DATE - $1::int`,
    [GHOST_DAYS]
  )

  const after = await pool.query(
    `SELECT store,
            COUNT(*) FILTER (WHERE active = TRUE)  AS active_n,
            COUNT(*) FILTER (WHERE active = FALSE) AS inactive_n
       FROM product_aliases
      GROUP BY store ORDER BY store`
  )
  console.log(`[sweep] flipped ${result.rowCount} aliases in ${Date.now() - started}ms`)
  console.log('[sweep] post-sweep totals:')
  for (const r of after.rows) {
    console.log(`  ${r.store}: ${r.active_n} active, ${r.inactive_n} inactive`)
  }

  // SCRAPE_SUMMARY-style one-liner for GH Actions log grep
  // (matches the pattern used by scrape-coles.js → commit b3b794c).
  console.log(`SWEEP_SUMMARY ${JSON.stringify({
    ghost_days: GHOST_DAYS,
    flipped: result.rowCount,
    duration_ms: Date.now() - started,
    per_store: Object.fromEntries(after.rows.map(r => [r.store, { active: r.active_n, inactive: r.inactive_n }])),
  })}`)

  await pool.end()
}

main().catch(e => {
  console.error('[sweep] failed:', e.message)
  process.exit(1)
})
