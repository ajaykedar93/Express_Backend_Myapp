// routes/monthlySummary.js
// ✅ Uses: const db = require("../db")
// ✅ Single API endpoint:
// GET /api/monthly-summary?category_id=1&subcategory_id=2&month=2026-01
//
// Returns:
// - month_start, month_end_exclusive
// - rule (deposit logic)
// - monthly totals (profit/loss/brokerage/net, trades count, trade days count)
// - trade-level follow counts (reward_followed/risk_followed/rr_respected from trading_journal)
// - day-level follow counts (based on day totals vs rule)
// - deposits/withdrawals in month
// - capital snapshot (base start, net deposit after withdrawal, end)
// - daily array (all days 1..last day)

const express = require("express");
const router = express.Router();
const db = require("../db"); // ✅ your existing db file

function monthToRange(monthStr) {
  // monthStr = "YYYY-MM"
  if (!/^\d{4}-\d{2}$/.test(monthStr)) return null;
  const [y, m] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1)); // exclusive
  return {
    startDate: start.toISOString().slice(0, 10), // YYYY-MM-DD
    endDate: end.toISOString().slice(0, 10), // YYYY-MM-DD (exclusive)
    startTs: start.toISOString(),
    endTs: end.toISOString(),
  };
}

router.get("/monthly-summary", async (req, res) => {
  const category_id = Number(req.query.category_id);
  const subcategory_id = Number(req.query.subcategory_id);
  const month = String(req.query.month || "").trim(); // "YYYY-MM"

  if (!category_id || !subcategory_id) {
    return res.status(400).json({ error: "category_id and subcategory_id are required" });
  }

  const range = monthToRange(month);
  if (!range) {
    return res.status(400).json({ error: 'month is required in format "YYYY-MM" (example: 2026-01)' });
  }

  const { startDate, endDate, startTs, endTs } = range;

  try {
    // 1) Rule / deposit base
    const ruleQ = `
      SELECT
        deposit_id,
        deposit_amount,
        withdrawal_amount,
        risk,
        reward,
        trading_days,
        traded_days,
        ratio
      FROM investment_deposit_logic
      WHERE category_id = $1 AND subcategory_id = $2
      LIMIT 1;
    `;
    const ruleR = await db.query(ruleQ, [category_id, subcategory_id]);
    const rule = ruleR.rows?.[0] || null;

    const base_deposit_start = rule
      ? Number(rule.deposit_amount || 0) - Number(rule.withdrawal_amount || 0)
      : 0;

    const rule_risk = rule ? Number(rule.risk || 0) : 0;
    const rule_reward = rule ? Number(rule.reward || 0) : 0;

    // 2) Monthly trading aggregates
    const monthlyAggQ = `
      SELECT
        COUNT(*)::int AS trades_count,
        COUNT(DISTINCT trade_date)::int AS trade_days_count,

        COALESCE(SUM(profit_amount),0)::numeric(15,2) AS total_profit,
        COALESCE(SUM(loss_amount),0)::numeric(15,2) AS total_loss,
        COALESCE(SUM(brokerage),0)::numeric(15,2) AS total_brokerage,
        COALESCE(SUM(net_pnl),0)::numeric(15,2) AS net_pnl,

        COALESCE(SUM(CASE WHEN reward_followed THEN 1 ELSE 0 END),0)::int AS reward_follow_count,
        COALESCE(SUM(CASE WHEN risk_followed   THEN 1 ELSE 0 END),0)::int AS risk_follow_count,
        COALESCE(SUM(CASE WHEN rr_respected    THEN 1 ELSE 0 END),0)::int AS rr_respected_count,

        MAX(profit_amount) FILTER (WHERE profit_amount > 0) AS max_profit,
        MAX(loss_amount)   FILTER (WHERE loss_amount  > 0) AS max_loss,
        MIN(profit_amount) FILTER (WHERE profit_amount > 0) AS min_profit,
        MIN(loss_amount)   FILTER (WHERE loss_amount  > 0) AS min_loss
      FROM trading_journal
      WHERE category_id = $1
        AND subcategory_id = $2
        AND trade_date >= $3::date
        AND trade_date <  $4::date;
    `;
    const monthlyAggR = await db.query(monthlyAggQ, [category_id, subcategory_id, startDate, endDate]);
    const monthlyAgg = monthlyAggR.rows?.[0] || {};

    // 3) Monthly deposit/withdraw events
    const depQ = `
      SELECT
        COALESCE(SUM(CASE WHEN txn_type='DEPOSIT'    THEN 1 ELSE 0 END),0)::int AS deposit_events_count,
        COALESCE(SUM(CASE WHEN txn_type='WITHDRAWAL' THEN 1 ELSE 0 END),0)::int AS withdrawal_events_count,
        COALESCE(SUM(CASE WHEN txn_type='DEPOSIT'    THEN amount ELSE 0 END),0)::numeric(15,2) AS total_deposit_added,
        COALESCE(SUM(CASE WHEN txn_type='WITHDRAWAL' THEN amount ELSE 0 END),0)::numeric(15,2) AS total_withdrawn
      FROM investment_deposit_txn
      WHERE category_id = $1
        AND subcategory_id = $2
        AND txn_at >= $3::timestamp
        AND txn_at <  $4::timestamp;
    `;
    const depR = await db.query(depQ, [category_id, subcategory_id, startTs, endTs]);
    const depAgg = depR.rows?.[0] || {};

    // 4) Daily breakdown for ALL days
    const dailyQ = `
      WITH days AS (
        SELECT generate_series($3::date, ($4::date - interval '1 day')::date, interval '1 day')::date AS day
      ),
      tj AS (
        SELECT
          trade_date::date AS day,
          COUNT(*)::int AS trades,
          COALESCE(SUM(profit_amount),0)::numeric(15,2) AS profit,
          COALESCE(SUM(loss_amount),0)::numeric(15,2) AS loss,
          COALESCE(SUM(brokerage),0)::numeric(15,2) AS brokerage,
          COALESCE(SUM(net_pnl),0)::numeric(15,2) AS net
        FROM trading_journal
        WHERE category_id = $1
          AND subcategory_id = $2
          AND trade_date >= $3::date
          AND trade_date <  $4::date
        GROUP BY trade_date
      )
      SELECT
        d.day,
        COALESCE(tj.trades,0)::int AS trades_count,
        COALESCE(tj.profit,0)::numeric(15,2) AS total_profit,
        COALESCE(tj.loss,0)::numeric(15,2) AS total_loss,
        COALESCE(tj.brokerage,0)::numeric(15,2) AS total_brokerage,
        COALESCE(tj.net,0)::numeric(15,2) AS net_pnl,

        (COALESCE(tj.profit,0) >= $5::numeric) AS reward_followed,
        (COALESCE(tj.loss,0)   <= $6::numeric) AS risk_followed,
        ((COALESCE(tj.profit,0) >= $5::numeric) AND (COALESCE(tj.loss,0) <= $6::numeric)) AS rr_respected
      FROM days d
      LEFT JOIN tj ON tj.day = d.day
      ORDER BY d.day;
    `;
    const dailyR = await db.query(dailyQ, [category_id, subcategory_id, startDate, endDate, rule_reward, rule_risk]);
    const dailyRows = Array.isArray(dailyR.rows) ? dailyR.rows : [];

    // 5) Day-level counts
    const days_with_trades = dailyRows.reduce((acc, r) => acc + (Number(r.trades_count) > 0 ? 1 : 0), 0);
    const day_reward_follow_count = dailyRows.reduce((acc, r) => acc + (r.reward_followed ? 1 : 0), 0);
    const day_risk_follow_count = dailyRows.reduce((acc, r) => acc + (r.risk_followed ? 1 : 0), 0);
    const day_rr_respected_count = dailyRows.reduce((acc, r) => acc + (r.rr_respected ? 1 : 0), 0);

    // 6) Capital snapshot
    const total_deposit_added = Number(depAgg.total_deposit_added || 0);
    const total_withdrawn = Number(depAgg.total_withdrawn || 0);
    const month_net_pnl = Number(monthlyAgg.net_pnl || 0);

    const net_deposit_after_withdrawal = base_deposit_start + total_deposit_added - total_withdrawn;
    const base_deposit_end = net_deposit_after_withdrawal + month_net_pnl;

    return res.json({
      month,
      month_start: startDate,
      month_end_exclusive: endDate,

      selection: { category_id, subcategory_id },

      rule: rule
        ? {
            deposit_id: rule.deposit_id,
            deposit_amount: Number(rule.deposit_amount || 0),
            withdrawal_amount: Number(rule.withdrawal_amount || 0),
            risk: rule_risk,
            reward: rule_reward,
            trading_days: Number(rule.trading_days || 0),
            traded_days: Number(rule.traded_days || 0),
            ratio: rule.ratio || null,
          }
        : null,

      monthly: {
        trades_count: Number(monthlyAgg.trades_count || 0),
        trade_days_count: Number(monthlyAgg.trade_days_count || 0),

        total_profit: Number(monthlyAgg.total_profit || 0),
        total_loss: Number(monthlyAgg.total_loss || 0),
        total_brokerage: Number(monthlyAgg.total_brokerage || 0),
        net_pnl: Number(monthlyAgg.net_pnl || 0),

        // trade-level follow counts (already stored by trigger)
        reward_follow_count: Number(monthlyAgg.reward_follow_count || 0),
        risk_follow_count: Number(monthlyAgg.risk_follow_count || 0),
        rr_respected_count: Number(monthlyAgg.rr_respected_count || 0),

        // extremes
        max_profit: monthlyAgg.max_profit == null ? null : Number(monthlyAgg.max_profit),
        max_loss: monthlyAgg.max_loss == null ? null : Number(monthlyAgg.max_loss),
        min_profit: monthlyAgg.min_profit == null ? null : Number(monthlyAgg.min_profit),
        min_loss: monthlyAgg.min_loss == null ? null : Number(monthlyAgg.min_loss),

        // day-level follow counts (based on day totals vs rule)
        days_with_trades,
        day_reward_follow_count,
        day_risk_follow_count,
        day_rr_respected_count,
      },

      deposits_withdrawals: {
        deposit_events_count: Number(depAgg.deposit_events_count || 0),
        withdrawal_events_count: Number(depAgg.withdrawal_events_count || 0),
        total_deposit_added,
        total_withdrawn,
      },

      capital: {
        base_deposit_start,
        net_deposit_after_withdrawal,
        base_deposit_end,
      },

      daily: dailyRows.map((r) => ({
        day: String(r.day),
        trades_count: Number(r.trades_count || 0),
        total_profit: Number(r.total_profit || 0),
        total_loss: Number(r.total_loss || 0),
        total_brokerage: Number(r.total_brokerage || 0),
        net_pnl: Number(r.net_pnl || 0),
        reward_followed: !!r.reward_followed,
        risk_followed: !!r.risk_followed,
        rr_respected: !!r.rr_respected,
      })),
    });
  } catch (err) {
    console.error("monthly-summary error:", err);
    return res.status(500).json({ error: "Server error", detail: err?.message || String(err) });
  }
});

module.exports = router;

/*
✅ How to use in your main server file (example):

const monthlySummary = require("./routes/investmentmonthlySummary");
app.use("/api", monthlySummary);

✅ Example call:
GET /api/monthly-summary?category_id=1&subcategory_id=2&month=2026-01
*/
