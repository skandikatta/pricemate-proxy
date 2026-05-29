// scrape-utils.js — Scrapy-inspired utilities for all scrapers
// Provides: concurrent fetching, adaptive throttle, retry, progress persistence, rate stats.

const fs = require('fs')
const path = require('path')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

// --- Adaptive Throttle ---
// Like Scrapy's AutoThrottle: adjusts delay based on server response time.
class AdaptiveThrottle {
  constructor({ minDelay = 200, maxDelay = 3000, targetConcurrency = 4 } = {}) {
    this.minDelay = minDelay
    this.maxDelay = maxDelay
    this.targetConcurrency = targetConcurrency
    this.delay = 500 // start conservative
    this.responseTimes = []
  }

  record(responseTimeMs) {
    this.responseTimes.push(responseTimeMs)
    if (this.responseTimes.length > 20) this.responseTimes.shift()
    const avg = this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
    // Target: delay = avg response time / target concurrency
    this.delay = Math.max(this.minDelay, Math.min(this.maxDelay, Math.round(avg / this.targetConcurrency)))
  }

  async wait() {
    await sleep(this.delay)
  }

  stats() {
    const avg = this.responseTimes.length
      ? Math.round(this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length)
      : 0
    return { currentDelay: this.delay, avgResponseTime: avg, samples: this.responseTimes.length }
  }
}

// --- Retry with backoff ---
// Like Scrapy's RetryMiddleware: retries on 5xx/network errors, fails fast on 4xx.
async function fetchWithRetry(url, { retries = 3, timeoutMs = 15000, headers = {}, ...fetchOpts } = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    const start = Date.now()
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        ...fetchOpts,
      })
      const elapsed = Date.now() - start
      if (r.ok) return { ok: true, response: r, elapsed }
      if (r.status >= 500 && attempt < retries) {
        lastErr = `HTTP ${r.status}`
        await sleep(1000 * Math.pow(2, attempt - 1))
        continue
      }
      return { ok: false, status: r.status, error: `HTTP ${r.status}`, elapsed }
    } catch (e) {
      lastErr = e.message
      if (attempt < retries) {
        await sleep(1000 * Math.pow(2, attempt - 1))
        continue
      }
    }
  }
  return { ok: false, error: lastErr || 'unknown', elapsed: 0 }
}

// --- Concurrent fetcher ---
// Like Scrapy's concurrent requests setting: processes N pages in parallel.
async function fetchConcurrent(tasks, { concurrency = 4, throttle = null } = {}) {
  const results = []
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(async (task) => {
      const result = await task()
      if (throttle && result?.elapsed) throttle.record(result.elapsed)
      return result
    }))
    results.push(...batchResults)
    if (throttle) await throttle.wait()
  }
  return results
}

// --- Progress persistence ---
// Like Scrapy's job persistence: resume from where you left off after a crash.
class Progress {
  constructor(store) {
    this.file = path.join(__dirname, `.scrape-progress-${store}.json`)
    this.state = this._load()
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        // Only resume if less than 2 hours old (stale progress = start fresh)
        if (Date.now() - data.updatedAt < 7200000) return data
      }
    } catch {}
    return { completedCategories: [], updatedAt: Date.now() }
  }

  isCompleted(category) {
    return this.state.completedCategories.includes(category)
  }

  markCompleted(category) {
    this.state.completedCategories.push(category)
    this.state.updatedAt = Date.now()
    fs.writeFileSync(this.file, JSON.stringify(this.state))
  }

  clear() {
    this.state = { completedCategories: [], updatedAt: Date.now() }
    try { fs.unlinkSync(this.file) } catch {}
  }
}

// --- Rate stats ---
// Like Scrapy's stats collector: tracks requests, items, errors.
class Stats {
  constructor(store) {
    this.store = store
    this.startTime = Date.now()
    this.requests = 0
    this.items = 0
    this.errors = 0
    this.retries = 0
    this.bytesDownloaded = 0
  }

  tick(items = 0, bytes = 0) { this.requests++; this.items += items; this.bytesDownloaded += bytes }
  error() { this.errors++ }
  retry() { this.retries++ }

  summary() {
    const elapsed = Math.round((Date.now() - this.startTime) / 1000)
    const rps = elapsed > 0 ? (this.requests / elapsed).toFixed(1) : 0
    return {
      store: this.store,
      elapsed_s: elapsed,
      requests: this.requests,
      items: this.items,
      errors: this.errors,
      retries: this.retries,
      requests_per_sec: parseFloat(rps),
      bytes_downloaded: this.bytesDownloaded,
    }
  }

  print() {
    const s = this.summary()
    console.log(`\nSTATS: ${s.requests} requests in ${s.elapsed_s}s (${s.requests_per_sec} req/s), ${s.items} items, ${s.errors} errors, ${s.retries} retries`)
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { AdaptiveThrottle, fetchWithRetry, fetchConcurrent, Progress, Stats, sleep, UA }
