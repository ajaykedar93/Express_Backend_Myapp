// src/routes/investment/investment_getview_tradingjournal.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

// ✅ strict rules
function validateProfitLossBrokerage({ profit, loss, brokerage }) {
  const p = Number(profit);
  const l = Number(loss);
  const b = Number(brokerage);

  if (!Number.isFinite(p) || p < 0) return "profit invalid";
  if (!Number.isFinite(l) || l < 0) return "loss invalid";
  if (!Number.isFinite(b) || b < 0) return "brokerage invalid";

  const ok = (p === 0 && l > 0) || (l === 0 && p > 0) || (p === 0 && l === 0);
  if (!ok) return "Either Profit OR Loss should be > 0 (both cannot be > 0 together)";
  if (p === 0 && l === 0 && b > 0) return "brokerage not allowed when profit=loss=0";

  return "";
}

/**
 * ✅ GET /daily-summary
 * Query (optional):
 *  - platform_id
 *  - segment_id
 *  - plan_id
 *  - month=YYYY-MM-01 (default current month)
 */
router.get("/daily-summary", auth, async (req, res) => {
  const userId = req.user.user_id;

  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const planId = req.query.plan_id ? Number(req.query.plan_id) : null;
  const month = req.query.month ? String(req.query.month) : null;

  try {
    const { rows } = await pool.query(
      `
      WITH chosen AS (
        SELECT date_trunc(
                 'month',
                 COALESCE($5::date, date_trunc('month', now())::date)
               )::date AS month_start
      )
      SELECT
        j.journal_id,
        j.user_id,

        j.platform_id, p.platform_name,
        j.segment_id,  s.segment_name,

        j.plan_id,
        j.trade_date,
        j.trade_name,

        j.profit,
        j.loss,
        j.brokerage,

        CASE
          WHEN j.profit > 0 THEN j.profit - j.brokerage
          WHEN j.loss   > 0 THEN -(j.loss + j.brokerage)
          ELSE 0
        END AS net_total,

        j.trade_logic,
        j.mistakes,
        j.created_at

      FROM investment_tradingjournal j
      JOIN chosen c
        ON date_trunc('month', j.trade_date)::date = c.month_start

      JOIN investment_platform p
        ON p.user_id=j.user_id AND p.platform_id=j.platform_id

      JOIN investment_segment s
        ON s.user_id=j.user_id AND s.segment_id=j.segment_id

      WHERE j.user_id=$1
        AND ($2::bigint IS NULL OR j.platform_id=$2)
        AND ($3::bigint IS NULL OR j.segment_id=$3)
        AND ($4::bigint IS NULL OR j.plan_id=$4)

      ORDER BY j.trade_date DESC, j.journal_id DESC
      `,
      [userId, platformId, segmentId, planId, month]
    );

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Daily summary failed", error: e.message });
  }
});

/**
 * ✅ PUT /:id  (update row)
 * Body required:
 *  - platform_id, segment_id
 *  - trade_date, trade_name
 *  - profit, loss, brokerage
 *  - trade_logic
 * optional:
 *  - plan_id (null allowed)
 *  - mistakes
 */
router.put("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const journalId = Number(req.params.id);
  if (!journalId) return res.status(400).json({ message: "Invalid journal_id" });

  const {
    platform_id,
    segment_id,
    plan_id,
    trade_date,
    trade_name,
    profit,
    loss,
    brokerage,
    trade_logic,
    mistakes,
  } = req.body;

  const pid = Number(platform_id);
  const sid = Number(segment_id);

  // plan_id: allow null
  const planId = plan_id === null || plan_id === "" || plan_id === undefined ? null : Number(plan_id);

  if (!pid) return res.status(400).json({ message: "platform_id required" });
  if (!sid) return res.status(400).json({ message: "segment_id required" });
  if (!trade_date) return res.status(400).json({ message: "trade_date required" });

  if (!String(trade_name || "").trim())
    return res.status(400).json({ message: "trade_name required (Index/Company/Symbol)" });

  if (!trade_logic?.trim()) return res.status(400).json({ message: "trade_logic required" });

  const v = validateProfitLossBrokerage({ profit, loss, brokerage });
  if (v) return res.status(400).json({ message: v });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ✅ ensure journal belongs to user
    const chk = await client.query(
      `SELECT 1 FROM investment_tradingjournal WHERE user_id=$1 AND journal_id=$2`,
      [userId, journalId]
    );
    if (!chk.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Journal not found" });
    }

    // ✅ validate segment belongs to platform for this user
    const seg = await client.query(
      `SELECT 1
       FROM investment_segment
       WHERE user_id=$1 AND segment_id=$2 AND platform_id=$3`,
      [userId, sid, pid]
    );
    if (!seg.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid platform/segment for user" });
    }

    // ✅ plan validate (if not null)
    if (planId) {
      const pl = await client.query(
        `SELECT 1
         FROM investment_plan
         WHERE user_id=$1 AND plan_id=$2 AND platform_id=$3 AND segment_id=$4`,
        [userId, planId, pid, sid]
      );
      if (!pl.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid plan for user/platform/segment" });
      }
    }

    const upd = await client.query(
      `
      UPDATE investment_tradingjournal
      SET
        platform_id=$1,
        segment_id=$2,
        plan_id=$3,
        trade_date=$4,
        trade_name=$5,
        profit=$6,
        loss=$7,
        brokerage=$8,
        trade_logic=$9,
        mistakes=$10
      WHERE user_id=$11 AND journal_id=$12
      RETURNING
        journal_id, user_id, platform_id, segment_id, plan_id,
        trade_date, trade_name,
        profit, loss, brokerage, net_pnl,
        trade_logic, mistakes, created_at
      `,
      [
        pid,
        sid,
        planId,
        trade_date,
        String(trade_name).trim(),
        Math.trunc(Number(profit)),
        Math.trunc(Number(loss)),
        Math.trunc(Number(brokerage)),
        trade_logic.trim(),
        mistakes?.trim() ? mistakes.trim() : null,
        userId,
        journalId,
      ]
    );

    await client.query("COMMIT");
    res.json({ data: upd.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ message: "Journal update failed", error: e.message });
  } finally {
    client.release();
  }
});

/**
 * ✅ DELETE /:id
 */
router.delete("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid journal_id" });

  try {
    const result = await pool.query(
      `DELETE FROM investment_tradingjournal
       WHERE user_id=$1 AND journal_id=$2`,
      [userId, id]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Journal not found" });
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Journal delete failed", error: e.message });
  }
});

module.exports = router;