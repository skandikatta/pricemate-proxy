#!/usr/bin/env node
// compute-image-hashes.js
//
// One-shot tool: downloads each product image, computes a 64-bit average-hash
// (aHash), and stores it in products.image_phash so the matcher can do
// cross-store identity matching by image when names diverge.
//
// Resumable: skips products that already have a hash. Re-runnable any time.
// Polite: ~5 req/sec per store host so we don't get rate-limited by
// productimages.coles.com.au / cdn1.woolworths.media / aldi.com.au.
//
// Run on VM (in screen / tmux / nohup since this is long-running):
//   DB_HOST=localhost DB_PASSWORD=... \
//     nohup node compute-image-hashes.js > image-hash.log 2>&1 &
//
// Apply pricemate/migrations/006_products_image_phash.sql FIRST (adds the
// image_phash column).

const sharp = require('sharp')
const STORES = ['coles', 'woolworths', 'aldi']
const RATE_MS_PER_STORE = 200       // ~5 req/sec per host
const COMMIT_EVERY = 100             // flush DB updates every N products
const FETCH_TIMEOUT_MS = 15000       // 15s per image
const MAX_RETRIES_PER_IMAGE = 2
const { pool } = require('./db')
// ─────────────────────────────────────────────────────────────────────────────
// PG bigint round-trip: aHash is naturally 0..2^64-1 unsigned, but PG bigint
// is signed (-2^63 .. 2^63-1). Map high half to negative; reverse on read.
// ─────────────────────────────────────────────────────────────────────────────
const TWO_POW_63 = 1n << 63n
const TWO_POW_64 = 1n << 64n
function hashToSigned(u64) {
  return u64 >= TWO_POW_63 ? u64 - TWO_POW_64 : u64
}

async function downloadImage(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'PriceMate-Hasher/1.0 (cheapasmate.com)' },
    })
    if (!res.ok) return { ok: false, status: res.status }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 200) return { ok: false, status: 'tiny' }
    return { ok: true, buf }
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : e.message.slice(0, 40) }
  } finally { clearTimeout(timer) }
}

async function computeAHash(buf) {
  // 8×8 grayscale = 64 bytes. aHash bit = 1 if pixel >= mean, else 0.
  const { data } = await sharp(buf, { failOnError: false })
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (data.length !== 64) throw new Error(`expected 64 bytes, got ${data.length}`)
  let sum = 0
  for (let i = 0; i < 64; i++) sum += data[i]
  const mean = sum / 64
  let hash = 0n
  for (let i = 0; i < 64; i++) {
    if (data[i] >= mean) hash |= 1n << BigInt(i)
  }
  return hash
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function processStore(store) {
  // Load every product with image but no hash. Resumable across restarts.
  const { rows } = await pool.query(
    `SELECT product_id, image FROM products
      WHERE store = $1 AND image IS NOT NULL AND LENGTH(image) > 10 AND image_phash IS NULL
      ORDER BY product_id`,
    [store]
  )
  console.log(`[${store}] to hash: ${rows.length}`)
  if (rows.length === 0) return { store, ok: 0, fail: 0 }

  let ok = 0, fail = 0
  let pendingUpdates = []
  const flush = async () => {
    if (!pendingUpdates.length) return
    const values = pendingUpdates.map((_, i) => `($${i*2+1}::text, $${i*2+2}::bigint)`).join(',')
    const params = pendingUpdates.flatMap(u => [u.product_id, u.hash])
    await pool.query(
      `UPDATE products SET image_phash = u.h
         FROM (VALUES ${values}) AS u(pid, h)
        WHERE store = '${store}' AND product_id = u.pid`,
      params
    )
    pendingUpdates = []
  }

  let lastLog = Date.now()
  for (let i = 0; i < rows.length; i++) {
    const { product_id, image } = rows[i]
    let dl = null
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_IMAGE; attempt++) {
      dl = await downloadImage(image)
      if (dl.ok) break
      if (attempt < MAX_RETRIES_PER_IMAGE) await sleep(1000 * (attempt + 1))  // backoff
    }
    if (!dl.ok) {
      fail++
    } else {
      try {
        const u64 = await computeAHash(dl.buf)
        pendingUpdates.push({ product_id, hash: hashToSigned(u64).toString() })
        ok++
      } catch (e) {
        fail++
      }
    }
    if (pendingUpdates.length >= COMMIT_EVERY) await flush()
    // log every ~30s
    if (Date.now() - lastLog > 30000) {
      console.log(`[${store}] ${i+1}/${rows.length}  ok=${ok}  fail=${fail}`)
      lastLog = Date.now()
    }
    await sleep(RATE_MS_PER_STORE)
  }
  await flush()
  console.log(`[${store}] DONE: ok=${ok} fail=${fail}`)
  return { store, ok, fail }
}

async function main() {
  console.log(`=== compute-image-hashes start ${new Date().toISOString()} ===`)
  // Run all 3 stores in parallel (different hosts, independent rate limits)
  const results = await Promise.all(STORES.map(processStore))
  console.log(`=== DONE ${new Date().toISOString()} ===`)
  for (const r of results) console.log(`  ${r.store}: ok=${r.ok} fail=${r.fail}`)
}

main()
  .then(() => pool.end())
  .catch(e => { console.error('FATAL:', e); pool.end(); process.exit(1) })
