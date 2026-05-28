// review-matches.js — Manual product match review tool
// Shows matches one by one, you approve/reject
// Run: node review-matches.js [--start N] [--category dairy]
//
// Controls:
//   y = correct match ✅
//   n = wrong match ❌ (removes from product_groups)
//   s = skip (unsure, review later)
//   q = quit (saves progress)
const readline = require('readline')
const { pool } = require('./db')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(r => rl.question(q, r))

async function main() {
  const startArg = process.argv.find(a => a.startsWith('--start='))
  const start = startArg ? parseInt(startArg.split('=')[1]) : 0

  // Load all groups with product names
  const { rows: groups } = await pool.query(`
    SELECT g.id, g.display_name, g.size,
      g.coles_id, g.woolworths_id, g.aldi_id,
      c.name as coles_name, c.brand as coles_brand,
      w.name as ww_name, w.brand as ww_brand,
      a.name as aldi_name, a.brand as aldi_brand
    FROM product_groups g
    LEFT JOIN products c ON c.store='coles' AND c.product_id = g.coles_id
    LEFT JOIN products w ON w.store='woolworths' AND w.product_id = g.woolworths_id
    LEFT JOIN products a ON a.store='aldi' AND a.product_id = g.aldi_id
    ORDER BY g.id
    OFFSET $1
  `, [start])

  console.log(`\n=== Product Match Review ===`)
  console.log(`${groups.length} groups to review (starting from #${start})`)
  console.log(`Controls: y=correct  n=wrong  s=skip  q=quit\n`)

  let approved = 0, rejected = 0, skipped = 0

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    console.log(`--- #${start + i + 1} / ${start + groups.length} ---`)
    console.log(`  Size: ${g.size || '?'}`)
    if (g.coles_name) console.log(`  🔴 Coles:       ${g.coles_name} [${g.coles_brand || ''}]\n     https://www.coles.com.au/product/${g.coles_id}`)
    if (g.ww_name)    console.log(`  🟢 Woolworths:  ${g.ww_name} [${g.ww_brand || ''}]\n     https://www.woolworths.com.au/shop/productdetails/${g.woolworths_id}`)
    if (g.aldi_name)  console.log(`  🔵 Aldi:        ${g.aldi_name} [${g.aldi_brand || ''}]`)

    const answer = await ask('  Match? (y/n/s/q): ')

    if (answer === 'q') {
      console.log(`\nStopped at #${start + i + 1}. Resume with: node review-matches.js --start=${start + i}`)
      break
    } else if (answer === 'n') {
      await pool.query('DELETE FROM product_groups WHERE id = $1', [g.id])
      rejected++
      console.log('  ❌ Removed\n')
    } else if (answer === 'y') {
      approved++
      console.log('  ✅ Approved\n')
    } else {
      skipped++
      console.log('  ⏭️  Skipped\n')
    }
  }

  console.log(`\nDone! Approved: ${approved} | Rejected: ${rejected} | Skipped: ${skipped}`)
  rl.close()
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
