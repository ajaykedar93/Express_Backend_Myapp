// src/routes/investment/investment_dipwid.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

// Create dip/wid
router.post("/", auth, async (req, res) => {
  const userId = req.user.user_id;
  const { platform_id, segment_id, plan_id, txn_type, amount, note } = req.body;

  const pid = Number(platform_id);
  const sid = Number(segment_id);
  const planId = plan_id ? Number(plan_id) : null;
  const amt = Number(amount);

  if (!pid) return res.status(400).json({ message: "platform_id required" });
  if (!sid) return res.status(400).json({ message: "segment_id required" });
  if (!["DEPOSIT", "WITHDRAW"].includes(String(txn_type || "").toUpperCase()))
    return res.status(400).json({ message: "txn_type invalid" });
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: "amount invalid" });

  try {
    // ✅ ownership + relation check (segment belongs to platform)
    const seg = await pool.query(
      `SELECT 1 FROM investment_segment WHERE user_id=$1 AND segment_id=$2 AND platform_id=$3`,
      [userId, sid, pid]
    );
    if (!seg.rowCount) return res.status(400).json({ message: "Invalid platform/segment for user" });

    // plan (optional) should match
    if (planId) {
      const pl = await pool.query(
        `SELECT 1 FROM investment_plan WHERE user_id=$1 AND plan_id=$2 AND platform_id=$3 AND segment_id=$4`,
        [userId, planId, pid, sid]
      );
      if (!pl.rowCount) return res.status(400).json({ message: "Invalid plan for user/platform/segment" });
    }

    const { rows } = await pool.query(
      `INSERT INTO investment_dipwid
        (user_id, platform_id, segment_id, plan_id, txn_type, amount, note)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7)
       RETURNING dipwid_id, user_id, platform_id, segment_id, plan_id, txn_type, amount, txn_at, note`,
      [userId, pid, sid, planId, String(txn_type).toUpperCase(), Math.trunc(amt), note?.trim() ? note.trim() : null]
    );

    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Dip/Wid create failed", error: e.message });
  }
});

// DELETE dipwid (user safe)
router.delete("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid dipwid_id" });

  try {
    const result = await pool.query(
      `DELETE FROM investment_dipwid WHERE user_id=$1 AND dipwid_id=$2`,
      [userId, id]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Delete failed", error: e.message });
  }
});

// GET ledger (returns names too)
router.get("/ledger", auth, async (req, res) => {
  const userId = req.user.user_id;
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const planId = req.query.plan_id ? Number(req.query.plan_id) : null;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        d.dipwid_id, d.user_id,
        d.platform_id, p.platform_name,
        d.segment_id,  s.segment_name,
        d.plan_id,
        d.txn_type, d.amount, d.txn_at, d.note,

        pl.total_fund_deposit AS plan_fund,

        CASE WHEN d.txn_type='DEPOSIT' THEN d.amount ELSE -d.amount END AS signed_amount,

        SUM(CASE WHEN d.txn_type='DEPOSIT' THEN d.amount ELSE -d.amount END)
          OVER (PARTITION BY d.user_id, d.platform_id, d.segment_id
                ORDER BY d.txn_at, d.dipwid_id) AS running_balance

      FROM investment_dipwid d
      JOIN investment_platform p ON p.user_id=d.user_id AND p.platform_id=d.platform_id
      JOIN investment_segment  s ON s.user_id=d.user_id AND s.segment_id=d.segment_id
      LEFT JOIN investment_plan pl ON pl.user_id=d.user_id AND pl.plan_id=d.plan_id

      WHERE d.user_id=$1
        AND ($2::bigint IS NULL OR d.platform_id=$2)
        AND ($3::bigint IS NULL OR d.segment_id=$3)
        AND ($4::bigint IS NULL OR d.plan_id=$4)

      ORDER BY d.txn_at DESC, d.dipwid_id DESC
      `,
      [userId, platformId, segmentId, planId]
    );

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Ledger fetch failed", error: e.message });
  }
});

// GET month summary (deposit/withdraw counts + totals)
router.get("/month-summary", auth, async (req, res) => {
  const userId = req.user.user_id;
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const month = req.query.month ? String(req.query.month) : null; // YYYY-MM-01

  try {
    const { rows } = await pool.query(
      `
      SELECT
        user_id,
        platform_id,
        segment_id,
        date_trunc('month', txn_at)::date AS month_start,

        COUNT(*) FILTER (WHERE txn_type='DEPOSIT')  AS deposits_count,
        COUNT(*) FILTER (WHERE txn_type='WITHDRAW') AS withdrawals_count,

        COALESCE(SUM(amount) FILTER (WHERE txn_type='DEPOSIT'), 0)  AS total_deposit,
        COALESCE(SUM(amount) FILTER (WHERE txn_type='WITHDRAW'), 0) AS total_withdraw

      FROM investment_dipwid
      WHERE user_id=$1
        AND ($2::bigint IS NULL OR platform_id=$2)
        AND ($3::bigint IS NULL OR segment_id=$3)
        AND ($4::date IS NULL OR date_trunc('month', txn_at)::date = date_trunc('month', $4::date)::date)

      GROUP BY user_id, platform_id, segment_id, date_trunc('month', txn_at)
      ORDER BY month_start DESC
      `,
      [userId, platformId, segmentId, month]
    );

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Month summary failed", error: e.message });
  }
});

module.exports = router;
