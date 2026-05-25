// extract-aldi.js — adaptive product extraction
// Tries multiple strategies in order. If the primary regex fails,
// falls back to heuristics that are more resilient to HTML changes.

const STRATEGIES = [
  // Strategy 1: Current structure (May 2026)
  {
    name: 'data-test attributes',
    extract(html) {
      const ids = [...html.matchAll(/product-tile-(\d+)/g)].map(m => m[1])
      const names = [...html.matchAll(/data-test="product-tile__name"[^>]*><p[^>]*>([^<]+)/g)].map(m => m[1])
      const prices = [...html.matchAll(/base-price__regular"><span>\$([\d.]+)/g)].map(m => parseFloat(m[1]))
      const images = [...html.matchAll(/product-tile__picture"><img[^>]*src="([^"]+)"/g)].map(m => m[1])
      const brands = [...html.matchAll(/data-test="product-tile__brandname"[^>]*><p[^>]*>([^<]+)/g)].map(m => m[1].trim())
      return { ids, names, prices, images, brands }
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
    const { ids, names, prices, images, brands } = strategy.extract(html)
    const count = Math.min(ids.length, names.length, prices.length)
    if (count > 0) {
      if (strategy !== STRATEGIES[0]) {
        console.warn(`  [FALLBACK] Primary extraction failed, using: "${strategy.name}"`)
      }
      const products = []
      for (let i = 0; i < count; i++) {
        products.push({
          productId: `aldi_${ids[i]}`,
          name: names[i],
          price: prices[i],
          brand: brands[i] || null,
          image: images[i] || null,
        })
      }
      return products
    }
  }
  return []
}

module.exports = { extractProducts, STRATEGIES }
