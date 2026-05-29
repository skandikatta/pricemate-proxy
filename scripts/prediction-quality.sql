-- prediction-quality.sql
-- Snapshot of "how thin is the per-product history?" across all 3 stores.
-- Run manually any time:
--   sudo -u postgres psql -d pricemate -f scripts/prediction-quality.sql
-- Append result to OPTION_C_PROD_STATE.md to track trend over weeks.
--
-- Logic: counts distinct scrape DAYS per (store, vendor_id) over last 180d
-- in price_history_v2 (post-Option-C). Buckets the catalog by depth so we
-- can see the moat-shape: products with >= 7 days are cycle-detector
-- candidates; products with < 3 are essentially "we have no signal yet".

\echo === Prediction-quality snapshot (last 180 days, v2 path) ===
\echo

WITH depth AS (
  SELECT pa.store, pa.vendor_id,
         COUNT(DISTINCT ph.scraped_at::date) AS days
    FROM product_aliases pa
    JOIN price_history_v2 ph
      ON ph.internal_id = pa.internal_id AND ph.store = pa.store
   WHERE pa.active = TRUE
     AND ph.scraped_at >= NOW() - INTERVAL '180 days'
   GROUP BY pa.store, pa.vendor_id
)
SELECT store,
       COUNT(*)                                              AS total_products,
       COUNT(*) FILTER (WHERE days >= 30)                    AS deep_30plus,
       COUNT(*) FILTER (WHERE days >= 14 AND days < 30)      AS mid_14_29,
       COUNT(*) FILTER (WHERE days >=  7 AND days < 14)      AS thin_7_13,
       COUNT(*) FILTER (WHERE days >=  3 AND days <  7)      AS sparse_3_6,
       COUNT(*) FILTER (WHERE days <   3)                    AS bare_under3,
       ROUND(100.0 * COUNT(*) FILTER (WHERE days >= 7) / NULLIF(COUNT(*), 0), 1) AS pct_predictable
  FROM depth
 GROUP BY store
 ORDER BY store;

\echo
\echo === Median + p10/p90 history depth per store ===
\echo
WITH depth AS (
  SELECT pa.store,
         COUNT(DISTINCT ph.scraped_at::date) AS days
    FROM product_aliases pa
    JOIN price_history_v2 ph
      ON ph.internal_id = pa.internal_id AND ph.store = pa.store
   WHERE pa.active = TRUE
     AND ph.scraped_at >= NOW() - INTERVAL '180 days'
   GROUP BY pa.store, pa.vendor_id
)
SELECT store,
       PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY days)::int AS p10_days,
       PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY days)::int AS median_days,
       PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY days)::int AS p90_days,
       MAX(days) AS max_days
  FROM depth
 GROUP BY store
 ORDER BY store;
