// routes/investment_month_summary.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/* ================= helpers ================= */
const badReq = (res, msg) => res.status(400).json({ error: msg });
const toNum = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const isYYYYMM = (s) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);

/** monthStr "YYYY-MM" -> { start: 'YYYY-MM-01', end: first day next month } */
function monthBounds(monthStr) {
  if (!isYYYYMM(monthStr)) return null;
  const [y, m] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));     // UTC to avoid TZ drift
  const end = new Date(Date.UTC(y, m, 1));           // next month
  // format as YYYY-MM-DD
  const f = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { start: f(start), end: f(end) };
}

/* ================= core aggregation ================= */
async function buildMonthlySummary({ month, category_id, subcategory_id }) {
  const bounds = monthBounds(month);
  if (!bounds) throw new Error("month must be in YYYY-MM format");
  const catId = Number(category_id);
  const subId = Number(subcategory_id);
  if (!Number.isInteger(catId) || !Number.isInteger(subId))
    throw new Error("category_id and subcategory_id are required numbers");

  // 1) Base deposit from current logic
  const baseQ = `
    SELECT (deposit_amount - withdrawal_amount)::float8 AS base_deposit
    FROM investment_deposit_logic
    WHERE category_id = $1 AND subcategory_id = $2
    LIMIT 1;
  `;
  const baseRes = await db.query(baseQ, [catId, subId]);
  const base_deposit = baseRes.rows.length ? Number(baseRes.rows[0].base_deposit) : 0;

  // 2) Trades aggregate for month
  const tradesAggQ = `
    SELECT
      COUNT(*)::int                                                   AS trades_count,
      COUNT(DISTINCT trade_date)::int                                  AS trade_days_count,
      COALESCE(SUM(profit_amount),0)::float8                           AS total_profit,
      COALESCE(SUM(loss_amount),0)::float8                             AS total_loss,
      COALESCE(SUM(brokerage),0)::float8                               AS total_brokerage,
      COALESCE(SUM(profit_amount - loss_amount - brokerage),0)::float8 AS net_pnl,
      COALESCE(SUM(CASE WHEN reward_followed THEN 1 ELSE 0 END),0)::int AS reward_follow_count,
      COALESCE(SUM(CASE WHEN risk_followed   THEN 1 ELSE 0 END),0)::int AS risk_follow_count,
      COALESCE(SUM(CASE WHEN rr_respected    THEN 1 ELSE 0 END),0)::int AS rr_respected_count,
      /* extremes */
      NULLIF(MAX(profit_amount), 0)::float8                            AS max_profit,
      NULLIF(MAX(loss_amount), 0)::float8                              AS max_loss,
      NULLIF(MIN(NULLIF(profit_amount,0)),0)::float8                   AS min_profit,
      NULLIF(MIN(NULLIF(loss_amount,0)),0)::float8                     AS min_loss
    FROM trading_journal
    WHERE trade_date >= $1 AND trade_date < $2
      AND category_id = $3 AND subcategory_id = $4;
  `;
  const tradesAggRes = await db.query(tradesAggQ, [bounds.start, bounds.end, catId, subId]);
  const TA = tradesAggRes.rows[0] || {};

  // Top segment (and the full ranking list)
  const topSegQ = `
    SELECT segment, COUNT(*)::int AS trades
    FROM trading_journal
    WHERE trade_date >= $1 AND trade_date < $2
      AND category_id = $3 AND subcategory_id = $4
      AND segment IS NOT NULL AND segment <> ''
    GROUP BY segment
    ORDER BY trades DESC, segment ASC
    LIMIT 1;
  `;
  const topSegRes = await db.query(topSegQ, [bounds.start, bounds.end, catId, subId]);
  const topSeg = topSegRes.rows[0] || null;

  const segListQ = `
    SELECT segment, COUNT(*)::int AS trades
    FROM trading_journal
    WHERE trade_date >= $1 AND trade_date < $2
      AND category_id = $3 AND subcategory_id = $4
      AND segment IS NOT NULL AND segment <> ''
    GROUP BY segment
    ORDER BY trades DESC, segment ASC;
  `;
  const segListRes = await db.query(segListQ, [bounds.start, bounds.end, catId, subId]);
  const segments = segListRes.rows || [];

  // 3) Deposit/Withdrawal activity for month
  const depAggQ = `
    SELECT
      COALESCE(SUM(CASE WHEN txn_type='DEPOSIT'    THEN 1 ELSE 0 END),0)::int    AS deposit_events_count,
      COALESCE(SUM(CASE WHEN txn_type='WITHDRAWAL' THEN 1 ELSE 0 END),0)::int    AS withdrawal_events_count,
      COALESCE(SUM(CASE WHEN txn_type='DEPOSIT'    THEN amount ELSE 0 END),0)::float8    AS total_deposit_added,
      COALESCE(SUM(CASE WHEN txn_type='WITHDRAWAL' THEN amount ELSE 0 END),0)::float8    AS total_withdrawn
    FROM investment_deposit_txn
    WHERE category_id=$1 AND subcategory_id=$2
      AND txn_at >= $3 AND txn_at < $4;
  `;
  const depAggRes = await db.query(depAggQ, [catId, subId, bounds.start, bounds.end]);
  const DA = depAggRes.rows[0] || {};

  const depListQ = `
    SELECT txn_id, txn_type, amount::float8 AS amount, note, txn_at
    FROM investment_deposit_txn
    WHERE category_id=$1 AND subcategory_id=$2
      AND txn_at >= $3 AND txn_at < $4
    ORDER BY txn_at ASC, txn_id ASC;
  `;
  const depListRes = await db.query(depListQ, [catId, subId, bounds.start, bounds.end]);
  const transactions = depListRes.rows || [];

  // 4) Ending capital stance
  const month_net_deposit_change = Number(DA.total_deposit_added || 0) - Number(DA.total_withdrawn || 0);
  const month_net_pnl            = Number(TA.net_pnl || 0);
  const ending_capital           = Number(base_deposit) + month_net_deposit_change + month_net_pnl;

  return {
    month,
    month_start: bounds.start,
    month_end_exclusive: bounds.end,

    category_id: catId,
    subcategory_id: subId,

    base_deposit: Number(base_deposit),

    // trading aggregates
    trades_count: Number(TA.trades_count || 0),
    trade_days_count: Number(TA.trade_days_count || 0),
    total_profit: Number(TA.total_profit || 0),
    total_loss: Number(TA.total_loss || 0),
    total_brokerage: Number(TA.total_brokerage || 0),
    net_pnl: month_net_pnl,

    reward_follow_count: Number(TA.reward_follow_count || 0),
    risk_follow_count: Number(TA.risk_follow_count || 0),
    rr_respected_count: Number(TA.rr_respected_count || 0),

    max_profit: TA.max_profit === null ? null : Number(TA.max_profit),
    max_loss:   TA.max_loss   === null ? null : Number(TA.max_loss),
    min_profit: TA.min_profit === null ? null : Number(TA.min_profit),
    min_loss:   TA.min_loss   === null ? null : Number(TA.min_loss),

    // deposit/withdraw
    deposit_events_count: Number(DA.deposit_events_count || 0),
    withdrawal_events_count: Number(DA.withdrawal_events_count || 0),
    total_deposit_added: Number(DA.total_deposit_added || 0),
    total_withdrawn: Number(DA.total_withdrawn || 0),
    month_net_deposit_change,

    // capital
    ending_capital,
    status_capital: ending_capital >= base_deposit ? "grew" : "decreased",
    status_pnl: month_net_pnl >= 0 ? "profit" : "loss",

    // segments
    top_segment: topSeg ? topSeg.segment : null,
    top_segment_trades: topSeg ? Number(topSeg.trades) : 0,
    segments_ranking: segments,

    // per-event list (for UI)
    deposit_withdrawal_events: transactions,
  };
}

/* ================= routes ================= */

/** GET /api/monthly_summary?month=YYYY-MM&category_id=..&subcategory_id=.. */
router.get("/", async (req, res) => {
  try {
    const { month, category_id, subcategory_id } = req.query;
    if (!isYYYYMM(month)) return badReq(res, "month must be YYYY-MM");
    if (!category_id || !subcategory_id) return badReq(res, "category_id and subcategory_id are required");

    const data = await buildMonthlySummary({ month, category_id, subcategory_id });
    return res.json(data);
  } catch (e) {
    console.error("Monthly summary error:", e);
    return res.status(500).json({ error: e.message || "Server Error" });
  }
});

/** GET /api/monthly_summary/months?category_id=..&subcategory_id=.. (optional filters)
 *  Returns a list of months (YYYY-MM) where there is either journal or deposit activity.
 */
router.get("/months", async (req, res) => {
  try {
    const params = [];
    let i = 1;

    const conds = [];
    const conds2 = []; // for txn table

    if (req.query.category_id) {
      conds.push(`category_id = $${i}`);
      conds2.push(`category_id = $${i}`);
      params.push(Number(req.query.category_id));
      i++;
    }
    if (req.query.subcategory_id) {
      conds.push(`subcategory_id = $${i}`);
      conds2.push(`subcategory_id = $${i}`);
      params.push(Number(req.query.subcategory_id));
      i++;
    }

    const q1 = `
      SELECT TO_CHAR(date_trunc('month', trade_date), 'YYYY-MM') AS ym
      FROM trading_journal
      ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
      GROUP BY 1
    `;
    const q2 = `
      SELECT TO_CHAR(date_trunc('month', txn_at), 'YYYY-MM') AS ym
      FROM investment_deposit_txn
      ${conds2.length ? `WHERE ${conds2.join(" AND ")}` : ""}
      GROUP BY 1
    `;
    const [r1, r2] = await Promise.all([db.query(q1, params), db.query(q2, params)]);
    const set = new Set([...(r1.rows || []).map((r) => r.ym), ...(r2.rows || []).map((r) => r.ym)]);
    const months = Array.from(set).sort().reverse();
    return res.json(months);
  } catch (e) {
    console.error("Months list error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

/** POST /api/monthly_summary/txn
 * Body: { category_id, subcategory_id, txn_type: 'DEPOSIT'|'WITHDRAWAL', amount, note?, txn_at? }
 */
router.post("/txn", async (req, res) => {
  try {
    const { category_id, subcategory_id, txn_type, amount, note, txn_at } = req.body;
    const catId = toNum(category_id);
    const subId = toNum(subcategory_id);
    const amt = toNum(amount);
    if (!catId || !subId) return badReq(res, "category_id and subcategory_id are required");
    if (!txn_type || !["DEPOSIT", "WITHDRAWAL"].includes(txn_type)) return badReq(res, "txn_type must be DEPOSIT or WITHDRAWAL");
    if (!(amt >= 0)) return badReq(res, "amount must be >= 0");

    const q = `
      INSERT INTO investment_deposit_txn
        (category_id, subcategory_id, txn_type, amount, note, txn_at)
      VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamp, NOW()))
      RETURNING txn_id, category_id, subcategory_id, txn_type, amount::float8 AS amount, note, txn_at;
    `;
    const { rows } = await db.query(q, [catId, subId, txn_type, amt, note ?? null, txn_at ?? null]);
    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error("Create deposit txn error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

/** GET /api/monthly_summary/txn?month=YYYY-MM&category_id=..&subcategory_id=.. */
router.get("/txn", async (req, res) => {
  try {
    const { month, category_id, subcategory_id } = req.query;
    if (!isYYYYMM(month)) return badReq(res, "month must be YYYY-MM");
    const bounds = monthBounds(month);
    const catId = Number(category_id);
    const subId = Number(subcategory_id);
    if (!Number.isInteger(catId) || !Number.isInteger(subId))
      return badReq(res, "category_id and subcategory_id are required");

    const q = `
      SELECT txn_id, txn_type, amount::float8 AS amount, note, txn_at
      FROM investment_deposit_txn
      WHERE category_id=$1 AND subcategory_id=$2
        AND txn_at >= $3 AND txn_at < $4
      ORDER BY txn_at ASC, txn_id ASC;
    `;
    const { rows } = await db.query(q, [catId, subId, bounds.start, bounds.end]);
    return res.json(rows);
  } catch (e) {
    console.error("List deposit txn error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

/** DELETE /api/monthly_summary/txn/:txn_id */
router.delete("/txn/:txn_id", async (req, res) => {
  try {
    const { txn_id } = req.params;
    const { rows } = await db.query(
      `DELETE FROM investment_deposit_txn WHERE txn_id=$1 RETURNING txn_id;`,
      [txn_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ message: "Deleted" });
  } catch (e) {
    console.error("Delete deposit txn error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

/** POST /api/monthly_summary/snapshot
 * Body: { month: 'YYYY-MM', category_id, subcategory_id }
 * Computes and UPSERTS into trading_monthly_summary.
 */
router.post("/snapshot", async (req, res) => {
  const client = await db.connect();
  try {
    const { month, category_id, subcategory_id } = req.body;
    if (!isYYYYMM(month)) return badReq(res, "month must be YYYY-MM");
    const data = await buildMonthlySummary({ month, category_id, subcategory_id });
    const monthStart = monthBounds(month).start;

    await client.query("BEGIN");
    const upsertQ = `
      INSERT INTO trading_monthly_summary (
        month_start, category_id, subcategory_id,
        trades_count, trade_days_count,
        total_profit, total_loss, total_brokerage, net_pnl,
        reward_follow_count, risk_follow_count, rr_respected_count,
        max_profit, max_loss, min_profit, min_loss,
        deposit_events_count, withdrawal_events_count,
        total_deposit_added, total_withdrawn,
        base_deposit_start, base_deposit_end, net_deposit_after_withdrawal,
        top_segment, top_segment_trades, computed_at
      )
      VALUES (
        $1,$2,$3,
        $4,$5,
        $6,$7,$8,$9,
        $10,$11,$12,
        $13,$14,$15,$16,
        $17,$18,
        $19,$20,
        $21,$22,$23,
        $24,$25, NOW()
      )
      ON CONFLICT (month_start, category_id, subcategory_id)
      DO UPDATE SET
        trades_count = EXCLUDED.trades_count,
        trade_days_count = EXCLUDED.trade_days_count,
        total_profit = EXCLUDED.total_profit,
        total_loss = EXCLUDED.total_loss,
        total_brokerage = EXCLUDED.total_brokerage,
        net_pnl = EXCLUDED.net_pnl,
        reward_follow_count = EXCLUDED.reward_follow_count,
        risk_follow_count   = EXCLUDED.risk_follow_count,
        rr_respected_count  = EXCLUDED.rr_respected_count,
        max_profit = EXCLUDED.max_profit,
        max_loss   = EXCLUDED.max_loss,
        min_profit = EXCLUDED.min_profit,
        min_loss   = EXCLUDED.min_loss,
        deposit_events_count    = EXCLUDED.deposit_events_count,
        withdrawal_events_count = EXCLUDED.withdrawal_events_count,
        total_deposit_added = EXCLUDED.total_deposit_added,
        total_withdrawn     = EXCLUDED.total_withdrawn,
        base_deposit_start = EXCLUDED.base_deposit_start,
        base_deposit_end   = EXCLUDED.base_deposit_end,
        net_deposit_after_withdrawal = EXCLUDED.net_deposit_after_withdrawal,
        top_segment = EXCLUDED.top_segment,
        top_segment_trades = EXCLUDED.top_segment_trades,
        computed_at = NOW()
      RETURNING *;
    `;
    const vals = [
      monthStart, Number(category_id), Number(subcategory_id),

      data.trades_count, data.trade_days_count,
      data.total_profit, data.total_loss, data.total_brokerage, data.net_pnl,

      data.reward_follow_count, data.risk_follow_count, data.rr_respected_count,

      data.max_profit, data.max_loss, data.min_profit, data.min_loss,

      data.deposit_events_count, data.withdrawal_events_count,
      data.total_deposit_added, data.total_withdrawn,

      data.base_deposit,                  // base_deposit_start (snapshot uses current base as start)
      data.ending_capital,                // base_deposit_end   (use computed ending_capital)
      data.base_deposit +                 // net_deposit_after_withdrawal (end-of-month capital)
        data.month_net_deposit_change +
        data.net_pnl,

      data.top_segment, data.top_segment_trades,
    ];

    const { rows } = await client.query(upsertQ, vals);
    await client.query("COMMIT");
    return res.json(rows[0]);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Monthly snapshot error:", e);
    return res.status(500).json({ error: e.message || "Server Error" });
  } finally {
    try { client.release(); } catch {}
  }
});

/** GET /api/monthly_summary/snapshot?month=YYYY-MM&category_id=..&subcategory_id=.. */
router.get("/snapshot", async (req, res) => {
  try {
    const { month, category_id, subcategory_id } = req.query;
    if (!isYYYYMM(month)) return badReq(res, "month must be YYYY-MM");
    const monthStart = monthBounds(month).start;
    const q = `
      SELECT *
      FROM trading_monthly_summary
      WHERE month_start=$1 AND category_id=$2 AND subcategory_id=$3
      LIMIT 1;
    `;
    const { rows } = await db.query(q, [monthStart, Number(category_id), Number(subcategory_id)]);
    if (!rows.length) return res.status(404).json({ error: "Snapshot not found" });
    return res.json(rows[0]);
  } catch (e) {
    console.error("Get snapshot error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
