// src/routes/investment/investment_getview_trandingjouranal.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

/**
 * ✅ IMPORTANT:
 * - filters now by platform_id / segment_id (IDs) (NOT names)
 * - response includes platform_name + segment_name for display
 */

// GET daily-summary (month required optional; default current)
router.get("/daily-summary", auth, async (req, res) => {
  const userId = req.user.user_id;
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const planId = req.query.plan_id ? Number(req.query.plan_id) : null;

  const month = req.query.month ? String(req.query.month) : null; // "YYYY-MM-01"

  try {
    const { rows } = await pool.query(
      `SELECT
         j.journal_id,
         j.user_id,
         j.platform_id, p.platform_name,
         j.segment_id,  s.segment_name,
         j.plan_id,
         j.trade_date,
         j.profit, j.loss, j.brokerage,
         CASE
           WHEN j.profit > 0 THEN j.profit - j.brokerage
           WHEN j.loss   > 0 THEN -(j.loss + j.brokerage)
           ELSE 0
         END AS net_total,
         j.trade_logic,
         j.mistakes,
         j.created_at
       FROM investment_tradingjournal j
       JOIN investment_platform p ON p.user_id=j.user_id AND p.platform_id=j.platform_id
       JOIN investment_segment  s ON s.user_id=j.user_id AND s.segment_id=j.segment_id
       WHERE j.user_id=$1
         AND ($2::bigint IS NULL OR j.platform_id=$2)
         AND ($3::bigint IS NULL OR j.segment_id=$3)
         AND ($4::bigint IS NULL OR j.plan_id=$4)
         AND (
              $5::date IS NULL
              OR date_trunc('month', j.trade_date)::date = date_trunc('month', $5::date)::date
         )
       ORDER BY j.trade_date DESC, j.journal_id DESC`,
      [userId, platformId, segmentId, planId, month]
    );

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Daily summary failed", error: e.message });
  }
});

// GET entry-details (by journal_id OR month)
router.get("/entry-details", auth, async (req, res) => {
  const userId = req.user.user_id;
  const journalId = req.query.journal_id ? Number(req.query.journal_id) : null;
  const month = req.query.month ? String(req.query.month) : null;

  try {
    // validate journal belongs to user if journal_id provided
    if (journalId) {
      const chk = await pool.query(
        `SELECT 1 FROM investment_tradingjournal WHERE user_id=$1 AND journal_id=$2`,
        [userId, journalId]
      );
      if (!chk.rowCount) return res.status(404).json({ message: "Journal not found" });
    }

    const { rows } = await pool.query(
      `
      -- OPTIONS
      SELECT
        j.journal_id,
        j.trade_date,
        'OPTIONS' AS trade_type,
        o.strike_price::text AS symbol,
        o.option_type,
        o.entry_price,
        o.exit_price,
        o.quantity,
        NULL::text AS stock_name
      FROM investment_tradingjournal j
      JOIN investment_tradingjournal_options o ON o.journal_id=j.journal_id
      WHERE j.user_id=$1
        AND ($2::bigint IS NULL OR j.journal_id=$2)
        AND (
             $3::date IS NULL
             OR date_trunc('month', j.trade_date)::date = date_trunc('month', $3::date)::date
        )

      UNION ALL

      -- STOCKS / GOLD / CURRENCY
      SELECT
        j.journal_id,
        j.trade_date,
        'STOCK' AS trade_type,
        NULL::text AS symbol,
        NULL::text AS option_type,
        s.entry_price,
        s.exit_price,
        s.quantity,
        s.stock_name
      FROM investment_tradingjournal j
      JOIN investment_tradingjournal_stocks s ON s.journal_id=j.journal_id
      WHERE j.user_id=$1
        AND ($2::bigint IS NULL OR j.journal_id=$2)
        AND (
             $3::date IS NULL
             OR date_trunc('month', j.trade_date)::date = date_trunc('month', $3::date)::date
        )

      ORDER BY trade_date DESC, journal_id DESC
      `,
      [userId, journalId, month]
    );

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Entry details failed", error: e.message });
  }
});

module.exports = router;
