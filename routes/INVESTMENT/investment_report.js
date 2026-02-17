// src/routes/investment/investment_report.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

/**
 * ✅ report:
 * - filters by platform_id/segment_id/plan_id/month
 * - rr_followed = target_rr <= achieved_rr <= 3.0  (gambline limit)
 */

// GET month report
router.get("/month", auth, async (req, res) => {
  const userId = req.user.user_id;
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const planId = req.query.plan_id ? Number(req.query.plan_id) : null;
  const month = req.query.month ? String(req.query.month) : null; // YYYY-MM-01

  try {
    const { rows } = await pool.query(
      `
      WITH j AS (
        SELECT
          user_id, platform_id, segment_id, plan_id,
          date_trunc('month', trade_date)::date AS month_start,
          SUM(profit)    AS total_profit,
          SUM(loss)      AS total_loss,
          SUM(brokerage) AS total_brokerage,
          SUM(profit - loss - brokerage) AS overall_month_pnl,
          COUNT(*) FILTER (WHERE mistakes IS NOT NULL AND btrim(mistakes) <> '') AS mistakes_entries
        FROM investment_tradingjournal
        WHERE user_id=$1
          AND ($2::bigint IS NULL OR platform_id=$2)
          AND ($3::bigint IS NULL OR segment_id=$3)
          AND ($4::bigint IS NULL OR plan_id=$4)
          AND ($5::date IS NULL OR date_trunc('month', trade_date)::date = date_trunc('month', $5::date)::date)
        GROUP BY user_id, platform_id, segment_id, plan_id, date_trunc('month', trade_date)
      ),
      p AS (
        SELECT
          plan_id, user_id, platform_id, segment_id,
          total_fund_deposit,
          rr_ratio,
          split_part(rr_ratio, ':', 2)::numeric AS target_rr
        FROM investment_plan
        WHERE user_id=$1
      )
      SELECT
        j.user_id,
        j.platform_id,
        j.segment_id,
        j.plan_id,
        j.month_start,
        j.total_profit      AS total_month_profit,
        j.total_loss        AS total_month_loss,
        j.total_brokerage   AS total_month_brokerage,
        j.mistakes_entries  AS total_mistakes_entries,
        j.overall_month_pnl,

        CASE
          WHEN j.overall_month_pnl > 0 THEN 'PROFIT'
          WHEN j.overall_month_pnl < 0 THEN 'LOSS'
          ELSE 'BREAKEVEN'
        END AS month_status,

        p.rr_ratio AS target_rr_ratio,

        CASE WHEN j.total_loss > 0 THEN round(j.total_profit / j.total_loss, 6) ELSE NULL END AS achieved_rr,

        CASE
          WHEN p.target_rr IS NULL OR j.total_loss = 0 THEN NULL
          WHEN (j.total_profit / j.total_loss) >= p.target_rr
           AND (j.total_profit / j.total_loss) <= 3.0
          THEN true
          ELSE false
        END AS rr_followed,

        p.total_fund_deposit AS plan_fund,
        (p.total_fund_deposit + j.overall_month_pnl) AS fund_remaining,

        CASE
          WHEN p.total_fund_deposit IS NULL THEN NULL
          WHEN (p.total_fund_deposit + j.overall_month_pnl) <= (p.total_fund_deposit * 0.45)
          THEN 'WARNING: Capital खूप कमी झाला आहे. Stop trading / risk कमी कर / logic improve कर.'
          ELSE NULL
        END AS fund_warning

      FROM j
      LEFT JOIN p
        ON p.plan_id=j.plan_id
       AND p.user_id=j.user_id
       AND p.platform_id=j.platform_id
       AND p.segment_id=j.segment_id

      ORDER BY j.month_start DESC
      `,
      [userId, platformId, segmentId, planId, month]
    );

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Month report failed", error: e.message });
  }
});

// GET mistakes repeat (normalized)
router.get("/mistakes-repeat", auth, async (req, res) => {
  const userId = req.user.user_id;
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const planId = req.query.plan_id ? Number(req.query.plan_id) : null;
  const month = req.query.month ? String(req.query.month) : null;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        user_id,
        platform_id,
        segment_id,
        plan_id,
        date_trunc('month', trade_date)::date AS month_start,
        lower(btrim(mistakes)) AS mistake_text,
        COUNT(*) AS repeat_count
      FROM investment_tradingjournal
      WHERE user_id=$1
        AND mistakes IS NOT NULL AND btrim(mistakes) <> ''
        AND ($2::bigint IS NULL OR platform_id=$2)
        AND ($3::bigint IS NULL OR segment_id=$3)
        AND ($4::bigint IS NULL OR plan_id=$4)
        AND ($5::date IS NULL OR date_trunc('month', trade_date)::date = date_trunc('month', $5::date)::date)
      GROUP BY user_id, platform_id, segment_id, plan_id, date_trunc('month', trade_date), lower(btrim(mistakes))
      ORDER BY repeat_count DESC
      `,
      [userId, platformId, segmentId, planId, month]
    );

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Mistakes repeat failed", error: e.message });
  }
});

module.exports = router;
