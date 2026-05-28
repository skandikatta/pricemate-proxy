// Aldi category health-check.
//
// Runs Mon + Thu via .github/workflows/aldi-health-check.yml.
//
// Compares live top-level categories at https://www.aldi.com.au/products against
// what scrape-aldi.js knows (TOP_LEVEL_CATEGORIES + SKIP). Auto-applies three
// kinds of drift:
//   - new category found  → add to TOP_LEVEL_CATEGORIES
//   - category id changed → update existing TOP_LEVEL_CATEGORIES entry
//   - category disappeared → add slug to SKIP
//
// If a live category produces 0 products via extractProducts(), surfaces an
// EXTRACTION_BROKEN signal so the workflow opens a GitHub issue — that's the
// one case that needs human attention (the per-tile regexes need updating).
//
// Outputs to $GITHUB_OUTPUT for the workflow:
//   changed=true|false
//   adds=slug1,slug2,...
//   id_changes=slug1,slug2,...
//   removes=slug1,slug2,...
//   extraction_broken=true|false
//   test_url=/products/.../k/...

const fs = require('fs')
const path = require('path')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const ALDI_BASE = 'https://www.aldi.com.au'
const SCRAPER_PATH = path.resolve(__dirname, '..', 'scrape-aldi.js')

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
  console.log(`::output ${key}=${value}`)
}

async function fetchLiveTopLevel() {
  const res = await fetch(`${ALDI_BASE}/products`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching /products`)
  const html = await res.text()
  // Same regex pattern as scrape-aldi.js discoverCategories().
  const matches = [...html.matchAll(/href="\/products\/([^"]+)\/k\/(\d+)"/g)]
  const live = new Map()
  for (const m of matches) {
    const slug = m[1]; const id = m[2]
    if (slug.includes('/')) continue // top-level only
    if (!live.has(slug)) live.set(slug, id)
  }
  return live
}

function readScraperState() {
  const src = fs.readFileSync(SCRAPER_PATH, 'utf8')
  const topMatch = src.match(/const TOP_LEVEL_CATEGORIES = \{([\s\S]*?)\n\}/)
  if (!topMatch) throw new Error('Cannot find TOP_LEVEL_CATEGORIES block in scrape-aldi.js')
  const current = new Map()
  for (const m of topMatch[1].matchAll(/'([^']+)':\s*'(\d+)'/g)) current.set(m[1], m[2])

  const skipMatch = src.match(/const SKIP = \[([^\]]+)\]/)
  if (!skipMatch) throw new Error('Cannot find SKIP array in scrape-aldi.js discoverCategories()')
  const skip = new Set()
  for (const m of skipMatch[1].matchAll(/'([^']+)'/g)) skip.add(m[1])

  return { current, skip, src }
}

function rewriteSrc(src, { adds, idChanges, removes }) {
  let out = src
  if (adds.length || idChanges.length) {
    const topMatch = out.match(/const TOP_LEVEL_CATEGORIES = \{([\s\S]*?)\n\}/)
    const entries = new Map()
    for (const m of topMatch[1].matchAll(/'([^']+)':\s*'(\d+)'/g)) entries.set(m[1], m[2])
    for (const c of idChanges) entries.set(c.slug, c.newId)
    for (const a of adds) entries.set(a.slug, a.id)
    const lines = [...entries.entries()].map(([s, i]) => `  '${s}': '${i}',`).join('\n')
    out = out.replace(/const TOP_LEVEL_CATEGORIES = \{[\s\S]*?\n\}/, `const TOP_LEVEL_CATEGORIES = {\n${lines}\n}`)
  }
  if (removes.length) {
    const skipMatch = out.match(/const SKIP = \[([^\]]+)\]/)
    const skipSet = new Set()
    for (const m of skipMatch[1].matchAll(/'([^']+)'/g)) skipSet.add(m[1])
    for (const r of removes) skipSet.add(r)
    const newSkip = `const SKIP = [${[...skipSet].map(s => `'${s}'`).join(', ')}]`
    out = out.replace(/const SKIP = \[[^\]]+\]/, newSkip)
  }
  return out
}

async function testExtraction(testUrl) {
  const { extractProducts } = require('../extract-aldi.js')
  const res = await fetch(`${ALDI_BASE}${testUrl}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return -1
  const html = await res.text()
  return extractProducts(html).length
}

async function main() {
  console.log('Fetching live Aldi top-level categories…')
  const live = await fetchLiveTopLevel()
  console.log(`  ${live.size} top-level categories live on site`)

  const { current, skip, src } = readScraperState()
  console.log(`  scraper knows ${current.size} categories; SKIP has ${skip.size}`)

  const adds = []
  const idChanges = []
  const removes = []

  for (const [slug, id] of live) {
    if (skip.has(slug)) continue
    if (!current.has(slug)) {
      adds.push({ slug, id })
    } else if (current.get(slug) !== id) {
      idChanges.push({ slug, oldId: current.get(slug), newId: id })
    }
  }
  for (const [slug] of current) {
    if (!live.has(slug)) removes.push(slug)
  }

  console.log(`  diff → adds=${adds.length}, id_changes=${idChanges.length}, removes=${removes.length}`)
  if (adds.length) console.log('    adds:', adds.map(a => `${a.slug}=${a.id}`).join(', '))
  if (idChanges.length) console.log('    id_changes:', idChanges.map(c => `${c.slug}: ${c.oldId}→${c.newId}`).join(', '))
  if (removes.length) console.log('    removes (→SKIP):', removes.join(', '))

  // Before any rewrite, validate extraction still works on a live category.
  // If extractProducts returns 0 from a real category, the per-tile regex
  // anchors are stale — human must update extract-aldi.js. Block the auto-fix
  // and surface a signal so the workflow opens an issue.
  const testSlug = [...live.keys()][0]
  const testUrl = `/products/${testSlug}/k/${live.get(testSlug)}`
  console.log(`Testing extractProducts() against ${testUrl}…`)
  const count = await testExtraction(testUrl)
  if (count === 0) {
    console.error(`EXTRACTION_BROKEN: 0 products returned from ${testUrl}`)
    setOutput('extraction_broken', 'true')
    setOutput('test_url', testUrl)
    setOutput('changed', 'false')
    return
  }
  console.log(`  ✓ extraction OK (${count} products)`)
  setOutput('extraction_broken', 'false')

  if (!adds.length && !idChanges.length && !removes.length) {
    console.log('No drift — silent exit')
    setOutput('changed', 'false')
    return
  }

  const updated = rewriteSrc(src, { adds, idChanges, removes })
  fs.writeFileSync(SCRAPER_PATH, updated)
  // Round-trip syntax-check the rewrite. Rolling back if invalid prevents
  // committing a broken file. (We don't require/load it because that would
  // run main() inside scrape-aldi.js.)
  const { execSync } = require('child_process')
  try { execSync(`node --check ${SCRAPER_PATH}`) }
  catch (e) {
    console.error('REWRITE PRODUCED INVALID JS — rolling back')
    fs.writeFileSync(SCRAPER_PATH, src)
    setOutput('changed', 'false')
    setOutput('extraction_broken', 'true')
    setOutput('test_url', 'rewrite-syntax-error')
    return
  }

  setOutput('changed', 'true')
  setOutput('adds', adds.map(a => a.slug).join(','))
  setOutput('id_changes', idChanges.map(c => c.slug).join(','))
  setOutput('removes', removes.join(','))
  console.log('Rewrite applied + syntax-checked OK.')
}

main().catch(e => {
  console.error('HEALTH_CHECK_FAILED:', e.message)
  console.error(e.stack)
  process.exit(1)
})
