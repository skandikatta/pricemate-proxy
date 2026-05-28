// scrape-hagglers.js — Fetch price history from hagglers.org
// Flow: /category/{cat}?page=N → /compare/{name} → /product/{id} → extract history
// Output: hagglers-data.json
// Run: node scrape-hagglers.js

const fs = require('fs')
const HAGGLERS = 'https://www.hagglers.org'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const DELAY = 400

const CATEGORIES = [
  'milk', 'bread', 'eggs', 'cheese', 'butter', 'meat',
  'cereal', 'coffee', 'pasta', 'nappies', 'snacks',
  'drinks', 'formula', 'cleaning', 'petfood'
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return null
  return res.text()
}

async function getProductIdsFromCategory(cat) {
  const compareNames = []
  let page = 1
  while (true) {
    const html = await get(`${HAGGLERS}/category/${cat}?page=${page}`)
    if (!html) break
    const matches = [...html.matchAll(/href="\/compare\/([^"]+)"/g)]
    if (matches.length === 0) break
    for (const m of matches) {
      try { const name = decodeURIComponent(m[1]); if (!compareNames.includes(name)) compareNames.push(name) }
      catch { if (!compareNames.includes(m[1])) compareNames.push(m[1]) }
    }
    if (!html.includes(`page=${page + 1}`)) break
    page++
    await sleep(DELAY)
  }
  return compareNames
}

async function getProductLinks(compareName) {
  const html = await get(`${HAGGLERS}/compare/${encodeURIComponent(compareName)}`)
  if (!html) return []
  // Each store variant has its own /product/{id} link
  const ids = [...html.matchAll(/href="\/product\/(\d+)"/g)].map(m => m[1])
  return [...new Set(ids)]
}

function extractHistory(html) {
  const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/)
  const labelsMatch = html.match(/const mainLabels = \[([^\]]+)\]/)
  const pricesMatch = html.match(/const mainPrices = \[([^\]]+)\]/)
  if (!nameMatch || !labelsMatch || !pricesMatch) return null

  const fullName = nameMatch[1].trim()
  // Name format: "Aldi FARMDALE Full Cream Milk 1L" or "Woolworths Full Cream Milk 2L"
  const storeMatch = fullName.match(/^(Woolworths|Coles|Aldi)\s+/i)
  const store = storeMatch ? storeMatch[1].toLowerCase() : 'unknown'
  const name = storeMatch ? fullName.slice(storeMatch[0].length) : fullName

  // Extract brand (first word if uppercase/titlecase before product description)
  const brandMatch = name.match(/^([A-Z][A-Za-z'*]+(?:\s+[A-Z][A-Za-z'*]+)*)\s+/)
  const brand = brandMatch ? brandMatch[1] : ''
  const productName = brand ? name.slice(brand.length).trim() : name

  // Extract size
  const sizeMatch = name.match(/(\d+\.?\d*)\s*(kg|g|ml|l|L|mL|pk|pack)\b/i)
  const size = sizeMatch ? sizeMatch[0] : ''

  const dates = JSON.parse('[' + labelsMatch[1] + ']')
  const prices = JSON.parse('[' + pricesMatch[1] + ']')

  return { store, name: fullName.replace(/^(Woolworths|Coles|Aldi)\s+/i, ''), brand, size, dates, prices }
}

async function main() {
  console.log('[hagglers] Phase 1: Collecting product names from categories...')
  const allCompareNames = new Set()

  for (const cat of CATEGORIES) {
    const names = await getProductIdsFromCategory(cat)
    names.forEach(n => allCompareNames.add(n))
    console.log(`  [${cat}] ${names.length} products (total unique: ${allCompareNames.size})`)
    await sleep(DELAY)
  }

  console.log(`\n[hagglers] Phase 2: Resolving ${allCompareNames.size} compare pages → product IDs...`)
  const productIds = new Set()
  let resolved = 0
  for (const name of allCompareNames) {
    const ids = await getProductLinks(name)
    ids.forEach(id => productIds.add(id))
    resolved++
    if (resolved % 50 === 0) console.log(`  ${resolved}/${allCompareNames.size} resolved (${productIds.size} product pages)`)
    await sleep(DELAY)
  }

  console.log(`\n[hagglers] Phase 3: Fetching price history for ${productIds.size} products...`)
  const results = []
  let done = 0
  for (const id of productIds) {
    const html = await get(`${HAGGLERS}/product/${id}`)
    if (html) {
      const data = extractHistory(html)
      if (data && data.dates.length > 0) {
        data.hagglersId = id
        results.push(data)
      }
    }
    done++
    if (done % 100 === 0) console.log(`  ${done}/${productIds.size} (${results.length} with history)`)
    await sleep(DELAY)
  }

  fs.writeFileSync('hagglers-data.json', JSON.stringify(results, null, 2))
  console.log(`\n[hagglers] Done! ${results.length} products saved to hagglers-data.json`)
  
  // Summary
  const stores = {}
  for (const r of results) { stores[r.store] = (stores[r.store] || 0) + 1 }
  console.log('  By store:', stores)
  console.log(`  Sample: ${results[0]?.name} (${results[0]?.store}) — ${results[0]?.dates.length} days of history`)
}

main().catch(e => { console.error(e); process.exit(1) })
