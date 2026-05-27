#!/usr/bin/env node
// hagglers-scraper.js
//
// Live scrape of hagglers.org. Emits JSON in the SAME SHAPE as
// hagglers-data.json so the existing ingest-hagglers-history.js consumes it
// unchanged. Run periodically (weekly?) to keep refreshing our price-history
// coverage of products Hagglers also tracks.
//
// Pipeline:
//   1. Fetch hagglers.org homepage → discover /category/* URLs
//   2. For each category, paginate (?p=2,3,...) → discover /compare/{slug} URLs
//   3. For each product page, regex out `var stores = [...];` JS literal
//   4. Flatten into { store, name, brand, size, dates, prices, hagglersId }[]
//   5. Write hagglers-data-{ts}.json (matches existing format)
//
// Polite: 1 req/sec by default (override with --rate ms).
// Run (foreground):
//   node hagglers-scraper.js --max 50               # quick test, 50 products
//   node hagglers-scraper.js                        # full run, ~1.5-2h
// Output:
//   hagglers-data-2026-05-28T....json
// Then ingest:
//   DB_HOST=localhost DB_PASSWORD=... node ingest-hagglers-history.js hagglers-data-{ts}.json --apply

const fs = require('fs')
const path = require('path')

const BASE = 'https://www.hagglers.org'
const UA = 'PriceMate-Crawler/1.0 (cheapasmate.com)'
const args = process.argv.slice(2)
const MAX = parseInt(args[args.indexOf('--max') + 1], 10) || Infinity
const RATE_MS = parseInt(args[args.indexOf('--rate') + 1], 10) || 1000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } })
      if (!res.ok) {
        if (res.status === 404) return null
        throw new Error(`HTTP ${res.status}`)
      }
      return await res.text()
    } catch (e) {
      if (attempt < retries) await sleep(2000 * (attempt + 1))
      else throw e
    }
  }
}

// ─── Discover category slugs from homepage ──────────────────────────────────
async function discoverCategories() {
  const html = await fetchText(BASE)
  const slugs = new Set()
  for (const m of html.matchAll(/href="\/category\/([a-z0-9-]+)"/g)) slugs.add(m[1])
  return [...slugs]
}

// ─── Enumerate product slugs in a category, paginating until empty ──────────
async function enumerateCategory(catSlug) {
  const slugs = new Set()
  let page = 1
  while (true) {
    const url = page === 1
      ? `${BASE}/category/${catSlug}`
      : `${BASE}/category/${catSlug}?p=${page}`
    const html = await fetchText(url)
    if (!html) break
    // Product links look like /compare/{name slug with spaces} — Hagglers
    // uses literal-space slugs (not + or %20) in their <a href> attrs.
    const before = slugs.size
    for (const m of html.matchAll(/href="\/compare\/([^"]+)"/g)) {
      // Some slugs contain bare % characters (Hagglers's slugs aren't strictly
      // URL-encoded), so decodeURIComponent can throw URIError. Fall back to
      // raw on failure — we'll re-encode on fetch anyway.
      let slug
      try { slug = decodeURIComponent(m[1]) } catch { slug = m[1] }
      slugs.add(slug)
    }
    if (slugs.size === before) break  // no new slugs on this page → end of pagination
    page++
    if (page > 60) break  // safety cap (max category seen on homepage is 1166 products / ~12 pages)
    await sleep(RATE_MS)
  }
  return [...slugs]
}

// ─── Parse a /compare/{slug} page → extract embedded stores array ───────────
function extractStores(html) {
  const m = html.match(/var\s+stores\s*=\s*(\[[\s\S]+?\]);/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

async function fetchProduct(slug) {
  const url = `${BASE}/compare/${encodeURIComponent(slug)}`
  const html = await fetchText(url)
  if (!html) return null
  const stores = extractStores(html)
  if (!stores) return null
  // Flatten into one entry per store the product appears at
  return stores.map(s => ({
    store: (s.store || '').toLowerCase(),
    name: s.name || '',
    brand: s.brand || '',
    size: s.size || '',
    dates: s.labels || [],
    prices: s.prices || [],
    hagglersId: String(s.id || ''),
  }))
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== hagglers-scraper start ${new Date().toISOString()} ===`)
  console.log(`Rate: 1 req per ${RATE_MS}ms, max products: ${MAX === Infinity ? 'all' : MAX}`)

  console.log('Discovering categories...')
  const categories = await discoverCategories()
  console.log(`  ${categories.length} categories: ${categories.join(', ')}`)
  await sleep(RATE_MS)

  console.log('Enumerating product slugs per category...')
  const allSlugs = new Set()
  for (const cat of categories) {
    const slugs = await enumerateCategory(cat)
    console.log(`  ${cat}: ${slugs.length}`)
    for (const s of slugs) allSlugs.add(s)
    if (allSlugs.size >= MAX) break
  }
  const slugList = [...allSlugs].slice(0, MAX)
  console.log(`Total unique product slugs: ${slugList.length}`)

  console.log('Fetching products...')
  const out = []
  let ok = 0, fail = 0, lastLog = Date.now()
  for (let i = 0; i < slugList.length; i++) {
    try {
      const entries = await fetchProduct(slugList[i])
      if (entries) { out.push(...entries); ok++ }
      else fail++
    } catch (e) {
      fail++
    }
    if (Date.now() - lastLog > 30000) {
      console.log(`  ${i+1}/${slugList.length}  ok=${ok} fail=${fail} entries=${out.length}`)
      lastLog = Date.now()
    }
    await sleep(RATE_MS)
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = path.join(__dirname, `hagglers-data-${ts}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out))
  console.log(`\n✓ DONE. ${out.length} store-entries from ${slugList.length} products (ok=${ok} fail=${fail})`)
  console.log(`Wrote: ${outPath}`)
  console.log(`\nNext: DB_HOST=localhost DB_PASSWORD=... node ingest-hagglers-history.js ${path.basename(outPath)} --apply`)
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1) })
