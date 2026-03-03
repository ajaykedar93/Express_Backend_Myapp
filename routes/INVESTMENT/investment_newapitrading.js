// routes/INVESTMENT/investment_newapitrading.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

/**
 * ✅ Month Trading + Deposit Stats API (NEW)
 *
 * Query (all optional):
 *  - month=YYYY-MM-01   (if not given -> current month)
 *  - platform_id
 *  - segment_id
 *  - plan_id
 *
 * ✅ Returns:
 *  - total_trades
 *  - total_profit
 *  - total_loss
 *  - total_brokerage
 *  - profit_net_total  = SUM(profit - brokerage) only profit trades
 *  - loss_net_total    = SUM(-(loss + brokerage)) only loss trades
 *  - overall_month_pnl = total_profit - (total_loss + total_brokerage)
 *  - total_deposit     = SUM(deposit amount) from investment_dipwid (month filtered)
 */

router.get("/month-stats", auth, async (req, res) => {
  const userId = req.user.user_id;

  const month = req.query.month ? String(req.query.month) : null; // YYYY-MM-01
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const planId = req.query.plan_id ? Number(req.query.plan_id) : null;

  try {
    const { rows } = await pool.query(
      `
      WITH chosen AS (
        SELECT date_trunc(
                 'month',
                 COALESCE($2::date, date_trunc('month', now())::date)
               )::date AS month_start
      ),
      j AS (
        SELECT
          j.user_id,
          date_trunc('month', j.trade_date)::date AS month_start,
          j.profit,
          j.loss,
          j.brokerage
        FROM investment_tradingjournal j
        JOIN chosen c
          ON date_trunc('month', j.trade_date)::date = c.month_start
        WHERE j.user_id = $1
          AND ($3::bigint IS NULL OR j.platform_id = $3)
          AND ($4::bigint IS NULL OR j.segment_id  = $4)
          AND ($5::bigint IS NULL OR j.plan_id     = $5)
      ),
      d AS (
        SELECT
          d.user_id,
          date_trunc('month', d.txn_at)::date AS month_start,
          COALESCE(SUM(d.amount) FILTER (WHERE d.txn_type = 'DEPOSIT'), 0) AS total_deposit
        FROM investment_dipwid d
        JOIN chosen c
          ON date_trunc('month', d.txn_at)::date = c.month_start
        WHERE d.user_id = $1
          AND ($3::bigint IS NULL OR d.platform_id = $3)
          AND ($4::bigint IS NULL OR d.segment_id  = $4)
          AND ($5::bigint IS NULL OR d.plan_id     = $5)
        GROUP BY d.user_id, date_trunc('month', d.txn_at)::date
      )
      SELECT
        $1::int AS user_id,
        c.month_start,

        -- ✅ trades count
        COALESCE((SELECT COUNT(*) FROM j), 0)::int AS total_trades,

        -- ✅ totals separate
        COALESCE((SELECT SUM(profit)    FROM j), 0)::numeric(14,0) AS total_profit,
        COALESCE((SELECT SUM(loss)      FROM j), 0)::numeric(14,0) AS total_loss,
        COALESCE((SELECT SUM(brokerage) FROM j), 0)::numeric(14,0) AS total_brokerage,

        -- ✅ profit net total
        COALESCE(
          (SELECT SUM(CASE WHEN profit > 0 THEN (profit - brokerage) ELSE 0 END) FROM j),
          0
        )::numeric(14,0) AS profit_net_total,

        -- ✅ loss net total
        COALESCE(
          (SELECT SUM(CASE WHEN loss > 0 THEN -(loss + brokerage) ELSE 0 END) FROM j),
          0
        )::numeric(14,0) AS loss_net_total,

        -- ✅ overall pnl
        (
          COALESCE((SELECT SUM(profit) FROM j), 0)
          -
          (
            COALESCE((SELECT SUM(loss) FROM j), 0)
            +
            COALESCE((SELECT SUM(brokerage) FROM j), 0)
          )
        )::numeric(14,0) AS overall_month_pnl,

        -- ✅ deposits
        COALESCE((SELECT total_deposit FROM d LIMIT 1), 0)::numeric(14,0) AS total_deposit

      FROM chosen c
      `,
      [userId, month, platformId, segmentId, planId]
    );

    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Month stats failed", error: e.message });
  }
});

module.exports = router;