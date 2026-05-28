// extract-aldi.js — adaptive product extraction
// Tries multiple strategies in order. If the primary regex fails,
// falls back to heuristics that are more resilient to HTML changes.

// Aldi serves HTML with un-decoded entities (e.g. "Goat&#39;s" instead of "Goat's").
// Decoded names match Coles/Woolies which arrive from JSON pre-decoded.
function decodeEntities(s) {
  if (!s) return s
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
}

// Parse "200g" / "1L" / "12 Pack" out of a product name. Matches the convention
// Coles and Woolies store sizes in, so the cross-store matcher can bucket them.
function parseSizeFromName(name) {
  if (!name) return null
  const m = name.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|litre|liter|pack|pk|each|ea)\b/i)
  return m ? (m[1] + m[2]).toLowerCase() : null
}

const STRATEGIES = [
  // Strategy 1: Current structure (May 2026)
  {
    name: 'data-test attributes',
    extract(html) {
      const ids = [...html.matchAll(/product-tile-(\d+)/g)].map(m => m[1])
      const names = [...html.matchAll(/data-test="product-tile__name"[^>]*><p[^>]*>([^<]+)/g)].map(m => m[1])
      const prices = [...html.matchAll(/base-price__regular"><span>\$([\d.]+)/g)].map(m => parseFloat(m[1]))
      // Aldi Special Buys: was-price appears in a separate span when on sale.
      // Tiles WITHOUT a was-price get null aligned to product index — null means
      // "not on sale" downstream.
      const wasPrices = [...html.matchAll(/data-test="product-tile__was-price"[^>]*><[^>]*>\$([\d.]+)/g)].map(m => parseFloat(m[1]))
      const images = [...html.matchAll(/product-tile__picture"><img[^>]*src="([^"]+)"/g)].map(m => m[1])
      const brands = [...html.matchAll(/data-test="product-tile__brandname"[^>]*><p[^>]*>([^<]+)/g)].map(m => m[1].trim())
      const units  = [...html.matchAll(/data-test="product-tile__unit-of-measurement"[^>]*>(?:<[^>]*>)*([^<]+)/g)].map(m => m[1].trim())
      const sizes = names.map((n, i) => parseSizeFromName(n) || (units[i] ? units[i].toLowerCase().replace(/\s+/g, '') : null))
      return { ids, names, prices, wasPrices, images, brands, sizes }
    }
  },
  // Strategy 2: Generic product tile with aria-labels (resilient to class renames)
  {
    name: 'aria-label fallback',
    extract(html) {
      const ids = [...html.matchAll(/product-tile[- _](\d{6,})/g)].map(m => m[1])
      const names = [...html.matchAll(/aria-label="([^"]{3,80}),"/g)].map(m => m[1]).filter(n => !n.includes('page') && !n.includes('Add'))
      const prices = [...html.matchAll(/\$([\d]+\.[\d]{2})<\/span>/g)].map(m => parseFloat(m[1]))
      const images = [...html.matchAll(/src="(https:\/\/dm\.apac\.cms\.aldi\.cx\/is\/image\/[^"]+)"/g)].map(m => m[1])
      // Dedupe names (aria-labels appear twice per product — name + brand)
      const seen = new Set()
      const uniqueNames = names.filter(n => { if (seen.has(n)) return false; seen.add(n); return true })
      return { ids, names: uniqueNames, prices, images, brands: [] }
    }
  },
  // Strategy 3: JSON-LD structured data (if Aldi adds it for SEO)
  {
    name: 'JSON-LD',
    extract(html) {
      const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []
      const ids = [], names = [], prices = [], images = [], brands = []
      for (const block of ldMatch) {
        try {
          const json = JSON.parse(block.replace(/<\/?script[^>]*>/g, ''))
          const items = json['@type'] === 'ItemList' ? json.itemListElement : json['@type'] === 'Product' ? [json] : []
          for (const item of items) {
            const p = item.item || item
            if (p.name && p.offers) {
              ids.push(p.sku || p.productID || `aldi_${names.length}`)
              names.push(p.name)
              prices.push(parseFloat(p.offers.price || p.offers.lowPrice || 0))
              images.push(p.image || '')
              brands.push(p.brand?.name || '')
            }
          }
        } catch {}
      }
      return { ids, names, prices, images, brands }
    }
  },
  // Strategy 4: Last resort — find any price near any text that looks like a product name
  {
    name: 'generic price+text heuristic',
    extract(html) {
      // Find blocks that have a dollar price and nearby text
      const blocks = html.split(/product-tile|product-card|product-item/i).slice(1)
      const ids = [], names = [], prices = [], images = [], brands = []
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i].slice(0, 2000) // limit search area
        const priceMatch = block.match(/\$([\d]+\.[\d]{2})/)
        const nameMatch = block.match(/>([A-Z][^<]{4,60})</)?.[1] || block.match(/alt="([^"]{4,60})"/)?.[1]
        const imgMatch = block.match(/src="(https:\/\/[^"]*aldi[^"]*\.(jpg|png|webp)[^"]*)"/)?.[1]
        if (priceMatch && nameMatch) {
          ids.push(`aldi_generic_${i}`)
          names.push(nameMatch)
          prices.push(parseFloat(priceMatch[1]))
          images.push(imgMatch || '')
          brands.push('')
        }
      }
      return { ids, names, prices, images, brands }
    }
  },
]

/**
 * Try each strategy in order. Return the first one that produces results.
 * Logs which strategy worked so you know when the primary breaks.
 */
function extractProducts(html) {
  for (const strategy of STRATEGIES) {
    const { ids, names, prices, wasPrices, images, brands, sizes } = strategy.extract(html)
    const count = Math.min(ids.length, names.length, prices.length)
    if (count > 0) {
      if (strategy !== STRATEGIES[0]) {
        console.warn(`  [FALLBACK] Primary extraction failed, using: "${strategy.name}"`)
      }
      const products = []
      for (let i = 0; i < count; i++) {
        const cleanName = decodeEntities(names[i])
        const wasPrice = wasPrices && wasPrices[i] && wasPrices[i] > prices[i] ? wasPrices[i] : null
        products.push({
          productId: `aldi_${ids[i]}`,
          name: cleanName,
          price: prices[i],
          wasPrice,
          isOnSpecial: wasPrice !== null,
          brand: brands[i] ? decodeEntities(brands[i]) : null,
          image: images[i] || null,
          size: (sizes && sizes[i]) || parseSizeFromName(cleanName) || null,
        })
      }
      return products
    }
  }
  return []
}

module.exports = { extractProducts, STRATEGIES }
