// src/routes/investment/investment_tradingjournal.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

// ✅ strict rules (server-side)
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

// ✅ POST create journal (ONLY ADD)
router.post("/", auth, async (req, res) => {
  const userId = req.user.user_id;

  const {
    platform_id,
    segment_id,
    plan_id, // optional
    trade_date,
    trade_name, // required
    profit,
    loss,
    brokerage,
    trade_logic,
    mistakes,
  } = req.body;

  const pid = Number(platform_id);
  const sid = Number(segment_id);
  const planId = plan_id ? Number(plan_id) : null;

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

    // ✅ segment must belong to platform for this user
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

    // ✅ plan validate (if provided)
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

    const j = await client.query(
      `INSERT INTO investment_tradingjournal
        (user_id, platform_id, segment_id, plan_id, trade_date, trade_name,
         profit, loss, brokerage, trade_logic, mistakes)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING
        journal_id, user_id, platform_id, segment_id, plan_id,
        trade_date, trade_name,
        profit, loss, brokerage, net_pnl,
        trade_logic, mistakes, created_at`,
      [
        userId,
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
      ]
    );

    await client.query("COMMIT");
    res.json({ data: j.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ message: "Journal create failed", error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;