// src/routes/investment/investment_plan.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

// GET plans (platform_id / segment_id optional) - returns names also
router.get("/", auth, async (req, res) => {
  const userId = req.user.user_id;
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;

  try {
    const { rows } = await pool.query(
      `SELECT
         pl.plan_id, pl.platform_id, pl.segment_id,
         p.platform_name,
         s.segment_name, s.is_options,
         pl.plan_name, pl.total_fund_deposit, pl.risk_loss, pl.profit_reward,
         pl.rr_ratio, pl.day_trade_limit, pl.trading_days, pl.created_at
       FROM investment_plan pl
       JOIN investment_platform p ON p.user_id=pl.user_id AND p.platform_id=pl.platform_id
       JOIN investment_segment  s ON s.user_id=pl.user_id AND s.segment_id=pl.segment_id
       WHERE pl.user_id=$1
         AND ($2::bigint IS NULL OR pl.platform_id=$2)
         AND ($3::bigint IS NULL OR pl.segment_id=$3)
       ORDER BY pl.created_at DESC`,
      [userId, platformId, segmentId]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Plan fetch failed", error: e.message });
  }
});

// CREATE plan
router.post("/", auth, async (req, res) => {
  const userId = req.user.user_id;
  const {
    platform_id,
    segment_id,
    plan_name,
    total_fund_deposit,
    risk_loss,
    profit_reward,
    rr_ratio,
    day_trade_limit,
    trading_days,
  } = req.body;

  const pid = Number(platform_id);
  const sid = Number(segment_id);

  if (!pid) return res.status(400).json({ message: "platform_id required" });
  if (!sid) return res.status(400).json({ message: "segment_id required" });

  // numeric ints
  const fund = Number(total_fund_deposit);
  const risk = Number(risk_loss);
  const reward = Number(profit_reward);
  const dayLimit = Number(day_trade_limit);

  const allowedRR = new Set(["1:1", "1:1.5", "1:2", "1:3"]);
  if (!allowedRR.has(rr_ratio)) return res.status(400).json({ message: "rr_ratio invalid" });

  if (!Number.isFinite(fund) || fund < 0) return res.status(400).json({ message: "total_fund_deposit invalid" });
  if (!Number.isFinite(risk) || risk <= 0) return res.status(400).json({ message: "risk_loss invalid" });
  if (!Number.isFinite(reward) || reward <= 0) return res.status(400).json({ message: "profit_reward invalid" });
  if (!Number.isFinite(dayLimit) || dayLimit < 0) return res.status(400).json({ message: "day_trade_limit invalid" });

  const td = trading_days === null || trading_days === "" || trading_days === undefined ? null : Number(trading_days);
  if (td !== null && (!Number.isFinite(td) || td <= 0)) return res.status(400).json({ message: "trading_days invalid" });

  try {
    // ✅ ownership validate platform + segment same user and segment belongs to platform
    const chk = await pool.query(
      `SELECT s.segment_id
       FROM investment_segment s
       JOIN investment_platform p ON p.user_id=s.user_id AND p.platform_id=s.platform_id
       WHERE s.user_id=$1 AND s.segment_id=$2 AND s.platform_id=$3`,
      [userId, sid, pid]
    );
    if (!chk.rowCount) return res.status(400).json({ message: "Invalid platform/segment for user" });

    const { rows } = await pool.query(
      `INSERT INTO investment_plan
        (user_id, platform_id, segment_id, plan_name, total_fund_deposit, risk_loss, profit_reward, rr_ratio, day_trade_limit, trading_days)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING plan_id, platform_id, segment_id, plan_name, total_fund_deposit, risk_loss, profit_reward, rr_ratio, day_trade_limit, trading_days, created_at`,
      [userId, pid, sid, plan_name?.trim() ? plan_name.trim() : null, fund, risk, reward, rr_ratio, dayLimit, td]
    );

    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Plan create failed", error: e.message });
  }
});

// UPDATE plan
router.put("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const planId = Number(req.params.id);

  const {
    platform_id,
    segment_id,
    plan_name,
    total_fund_deposit,
    risk_loss,
    profit_reward,
    rr_ratio,
    day_trade_limit,
    trading_days,
  } = req.body;

  if (!planId) return res.status(400).json({ message: "Invalid plan_id" });

  const pid = Number(platform_id);
  const sid = Number(segment_id);
  if (!pid) return res.status(400).json({ message: "platform_id required" });
  if (!sid) return res.status(400).json({ message: "segment_id required" });

  const fund = Number(total_fund_deposit);
  const risk = Number(risk_loss);
  const reward = Number(profit_reward);
  const dayLimit = Number(day_trade_limit);

  const allowedRR = new Set(["1:1", "1:1.5", "1:2", "1:3"]);
  if (!allowedRR.has(rr_ratio)) return res.status(400).json({ message: "rr_ratio invalid" });

  const td = trading_days === null || trading_days === "" || trading_days === undefined ? null : Number(trading_days);
  if (td !== null && (!Number.isFinite(td) || td <= 0)) return res.status(400).json({ message: "trading_days invalid" });

  try {
    const chk = await pool.query(
      `SELECT 1
       FROM investment_segment s
       WHERE s.user_id=$1 AND s.segment_id=$2 AND s.platform_id=$3`,
      [userId, sid, pid]
    );
    if (!chk.rowCount) return res.status(400).json({ message: "Invalid platform/segment for user" });

    const { rows } = await pool.query(
      `UPDATE investment_plan
       SET platform_id=$1, segment_id=$2, plan_name=$3,
           total_fund_deposit=$4, risk_loss=$5, profit_reward=$6,
           rr_ratio=$7, day_trade_limit=$8, trading_days=$9
       WHERE user_id=$10 AND plan_id=$11
       RETURNING plan_id, platform_id, segment_id, plan_name, total_fund_deposit, risk_loss, profit_reward, rr_ratio, day_trade_limit, trading_days, created_at`,
      [
        pid,
        sid,
        plan_name?.trim() ? plan_name.trim() : null,
        fund,
        risk,
        reward,
        rr_ratio,
        dayLimit,
        td,
        userId,
        planId,
      ]
    );

    if (!rows.length) return res.status(404).json({ message: "Plan not found" });
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Plan update failed", error: e.message });
  }
});

// DELETE plan
router.delete("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const planId = Number(req.params.id);
  if (!planId) return res.status(400).json({ message: "Invalid plan_id" });

  try {
    const result = await pool.query(
      `DELETE FROM investment_plan WHERE user_id=$1 AND plan_id=$2`,
      [userId, planId]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Plan not found" });
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Plan delete failed", error: e.message });
  }
});

module.exports = router;
