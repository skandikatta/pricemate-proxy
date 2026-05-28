// alerts.js — subscribe/confirm/unsubscribe + watchlist CRUD
// Registers routes on the Express app. Called from api-server.js.
//
// Reconstructed 2026-05-29 from frontend route contracts + migration schemas
// after the original was lost to git clean. Token auth: knowing the sub's
// token is sufficient for all operations (no separate user/password system).

const crypto = require('crypto')

function register(app, pool) {

  // --- Alerts: subscribe / confirm / unsubscribe ---

  app.post('/api/alerts/subscribe', async (req, res) => {
    const { email, frequency, scope } = req.body || {}
    if (!email || !frequency || !scope) return res.status(400).json({ error: 'email, frequency, scope required' })

    const token = crypto.randomBytes(32).toString('base64url')
    try {
      await pool.query(
        `INSERT INTO email_subscriptions (email, frequency, scope, token)
         VALUES (LOWER($1), $2, $3, $4)
         ON CONFLICT (LOWER(email), frequency, scope, COALESCE(scope_payload, ''))
         DO UPDATE SET status = CASE WHEN email_subscriptions.status = 'unsubscribed' THEN 'pending' ELSE email_subscriptions.status END,
                       token = CASE WHEN email_subscriptions.status = 'unsubscribed' THEN $4 ELSE email_subscriptions.token END`,
        [email, frequency, scope, token]
      )

      // Send confirmation email via Resend
      const RESEND_API_KEY = process.env.RESEND_API_KEY
      const APP_BASE_URL = process.env.APP_BASE_URL || 'https://cheapasmate.com'
      const FROM_ADDRESS = process.env.FROM_ADDRESS || 'cheapasmate <alerts@cheapasmate.com>'

      if (RESEND_API_KEY) {
        const confirmUrl = `${APP_BASE_URL}/alerts/confirm?token=${token}`
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [email],
            subject: 'Confirm your cheapasmate alert',
            html: `<p>Click to confirm your sale alerts:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p><p>If you didn't sign up, ignore this email.</p>`,
          }),
        })
        // Record the send
        const { rows } = await pool.query(`SELECT id FROM email_subscriptions WHERE token = $1`, [token])
        if (rows[0]) {
          await pool.query(`INSERT INTO email_sends (subscription_id, kind) VALUES ($1, 'confirm')`, [rows[0].id])
        }
      }

      res.json({ ok: true })
    } catch (e) {
      console.error('[alerts/subscribe]', e.message)
      res.status(500).json({ error: 'Could not save subscription.' })
    }
  })

  app.get('/api/alerts/confirm', async (req, res) => {
    const { token } = req.query
    if (!token) return res.status(400).json({ error: 'token required' })
    try {
      const { rows } = await pool.query(
        `UPDATE email_subscriptions SET status = 'active', confirmed_at = NOW()
         WHERE token = $1 AND status = 'pending'
         RETURNING email`,
        [token]
      )
      if (!rows.length) {
        // Maybe already confirmed
        const { rows: existing } = await pool.query(`SELECT email, status FROM email_subscriptions WHERE token = $1`, [token])
        if (existing.length && existing[0].status === 'active') return res.json({ ok: true, email: existing[0].email })
        return res.status(404).json({ error: 'Invalid or expired token.' })
      }
      res.json({ ok: true, email: rows[0].email })
    } catch (e) {
      console.error('[alerts/confirm]', e.message)
      res.status(500).json({ error: 'Confirmation failed.' })
    }
  })

  app.post('/api/alerts/unsubscribe', async (req, res) => {
    const token = req.query.token || req.body?.token
    if (!token) return res.status(400).json({ error: 'token required' })
    try {
      const { rows } = await pool.query(
        `UPDATE email_subscriptions SET status = 'unsubscribed', unsubscribed_at = NOW()
         WHERE token = $1 AND status != 'unsubscribed'
         RETURNING email`,
        [token]
      )
      if (!rows.length) return res.status(404).json({ error: 'Already unsubscribed or invalid token.' })
      res.json({ ok: true, email: rows[0].email })
    } catch (e) {
      console.error('[alerts/unsubscribe]', e.message)
      res.status(500).json({ error: 'Unsubscribe failed.' })
    }
  })

  // --- Watchlist CRUD (token-authenticated) ---

  // Helper: resolve token → email
  async function emailFromToken(token) {
    const { rows } = await pool.query(
      `SELECT email FROM email_subscriptions WHERE token = $1 AND status = 'active'`,
      [token]
    )
    return rows[0]?.email || null
  }

  app.get('/api/watchlist', async (req, res) => {
    const { token } = req.query
    if (!token) return res.status(400).json({ error: 'token required' })
    const email = await emailFromToken(token)
    if (!email) return res.status(401).json({ error: 'Invalid token' })
    try {
      const { rows } = await pool.query(
        `SELECT store, product_id, added_at FROM user_watchlist WHERE LOWER(email) = LOWER($1) ORDER BY added_at DESC`,
        [email]
      )
      res.json({ items: rows })
    } catch (e) {
      console.error('[watchlist/list]', e.message)
      res.status(500).json({ error: 'Failed to load watchlist' })
    }
  })

  app.post('/api/watchlist/add', async (req, res) => {
    const { token, store, product_id } = req.body || {}
    if (!token || !store || !product_id) return res.status(400).json({ error: 'token, store, product_id required' })
    const email = await emailFromToken(token)
    if (!email) return res.status(401).json({ error: 'Invalid token' })
    try {
      await pool.query(
        `INSERT INTO user_watchlist (email, store, product_id) VALUES (LOWER($1), $2, $3)
         ON CONFLICT (LOWER(email), store, product_id) DO NOTHING`,
        [email, store, product_id]
      )
      res.json({ ok: true })
    } catch (e) {
      console.error('[watchlist/add]', e.message)
      res.status(500).json({ error: 'Failed to add' })
    }
  })

  app.post('/api/watchlist/remove', async (req, res) => {
    const { token, store, product_id } = req.body || {}
    if (!token || !store || !product_id) return res.status(400).json({ error: 'token, store, product_id required' })
    const email = await emailFromToken(token)
    if (!email) return res.status(401).json({ error: 'Invalid token' })
    try {
      await pool.query(
        `DELETE FROM user_watchlist WHERE LOWER(email) = LOWER($1) AND store = $2 AND product_id = $3`,
        [email, store, product_id]
      )
      res.json({ ok: true })
    } catch (e) {
      console.error('[watchlist/remove]', e.message)
      res.status(500).json({ error: 'Failed to remove' })
    }
  })

  app.post('/api/watchlist/sync', async (req, res) => {
    const { token, items } = req.body || {}
    if (!token || !Array.isArray(items)) return res.status(400).json({ error: 'token + items[] required' })
    const email = await emailFromToken(token)
    if (!email) return res.status(401).json({ error: 'Invalid token' })
    try {
      let synced = 0
      for (const item of items) {
        if (!item.store || !item.product_id) continue
        await pool.query(
          `INSERT INTO user_watchlist (email, store, product_id) VALUES (LOWER($1), $2, $3)
           ON CONFLICT (LOWER(email), store, product_id) DO NOTHING`,
          [email, item.store, item.product_id]
        )
        synced++
      }
      res.json({ ok: true, synced })
    } catch (e) {
      console.error('[watchlist/sync]', e.message)
      res.status(500).json({ error: 'Sync failed' })
    }
  })
}

module.exports = { register }
