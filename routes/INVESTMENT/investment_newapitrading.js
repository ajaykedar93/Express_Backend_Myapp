// routes/INVESTMENT/investment_newapitrading.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

/**
 * ✅ Month Trading + Deposit Stats API
 * - user can pass ?month=YYYY-MM-01
 * - if month not provided => current month auto
 *
 * ✅ Returns (separate):
 *  - total_trades
 *  - total_profit
 *  - total_loss
 *  - total_brokerage
 *  - overall_month_pnl = total_profit - (total_loss + total_brokerage)
 *  - profit_net_total  = SUM(profit - brokerage) for profit trades
 *  - loss_net_total    = SUM(-(loss + brokerage)) for loss trades
 *  - total_deposit     = SUM(deposit amount) from investment_dipwid (month filtered)
 */

router.get("/month-stats", auth, async (req, res) => {
  const userId = req.user.user_id;

  // month optional (YYYY-MM-01). If null -> current month
  const month = req.query.month ? String(req.query.month) : null;

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
        GROUP BY d.user_id, date_trunc('month', d.txn_at)::date
      )
      SELECT
        $1::int AS user_id,
        c.month_start,

        -- trades
        COALESCE(COUNT(j.*), 0)::int AS total_trades,

        -- totals separate
        COALESCE(SUM(j.profit), 0)::numeric(14,0)    AS total_profit,
        COALESCE(SUM(j.loss), 0)::numeric(14,0)      AS total_loss,
        COALESCE(SUM(j.brokerage), 0)::numeric(14,0) AS total_brokerage,

        -- ✅ profit net: profit - brokerage (only profit trades)
        COALESCE(
          SUM(CASE WHEN j.profit > 0 THEN (j.profit - j.brokerage) ELSE 0 END),
          0
        )::numeric(14,0) AS profit_net_total,

        -- ✅ loss net: -(loss + brokerage) (only loss trades)
        COALESCE(
          SUM(CASE WHEN j.loss > 0 THEN -(j.loss + j.brokerage) ELSE 0 END),
          0
        )::numeric(14,0) AS loss_net_total,

        -- ✅ overall = total_profit - (total_loss + total_brokerage)
        (
          COALESCE(SUM(j.profit), 0)
          -
          (COALESCE(SUM(j.loss), 0) + COALESCE(SUM(j.brokerage), 0))
        )::numeric(14,0) AS overall_month_pnl,

        -- deposits
        COALESCE(d.total_deposit, 0)::numeric(14,0) AS total_deposit

      FROM chosen c
      LEFT JOIN j ON j.month_start = c.month_start
      LEFT JOIN d ON d.month_start = c.month_start AND d.user_id = $1
      GROUP BY c.month_start, d.total_deposit
      `,
      [userId, month]
    );

    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Month stats failed", error: e.message });
  }
});

module.exports = router;