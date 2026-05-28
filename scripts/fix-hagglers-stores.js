// fix-hagglers-stores.js — Re-fetch store badge for products tagged 'unknown'
const fs = require('fs')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const DELAY = 300
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const data = JSON.parse(fs.readFileSync('hagglers-data.json'))
  const ids = JSON.parse(fs.readFileSync('hagglers-fix-ids.json'))
  const idToIndex = new Map()
  for (let i = 0; i < data.length; i++) {
    if (data[i].store === 'unknown') idToIndex.set(data[i].hagglersId, i)
  }

  console.log(`Fixing store for ${ids.length} products...`)
  let fixed = 0, failed = 0
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    try {
      const res = await fetch(`https://www.hagglers.org/product/${id}`, { headers: { 'User-Agent': UA } })
      if (!res.ok) { failed++; continue }
      const html = await res.text()
      const m = html.match(/store-badge store-([a-z]+)/)
      if (m) {
        const idx = idToIndex.get(id)
        if (idx !== undefined) { data[idx].store = m[1]; fixed++ }
      } else { failed++ }
    } catch { failed++ }
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${ids.length} (fixed: ${fixed}, failed: ${failed})`)
    await sleep(DELAY)
  }

  fs.writeFileSync('hagglers-data.json', JSON.stringify(data, null, 2))
  const stores = data.reduce((a, d) => { a[d.store] = (a[d.store] || 0) + 1; return a }, {})
  console.log(`\nDone. Fixed ${fixed}, failed ${failed}`)
  console.log('Final store breakdown:', stores)
}

main().catch(e => { console.error(e); process.exit(1) })
