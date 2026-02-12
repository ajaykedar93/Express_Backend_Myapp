const express = require("express");
const router = express.Router();
const pool = require("../../db");

function getUserId(req) {
  const uid = req.user?.user_id || req.headers["x-user-id"];
  if (!uid) return null;
  const n = parseInt(uid, 10);
  return Number.isNaN(n) ? null : n;
}

function isValidMonthString(m) {
  return typeof m === "string" && /^\d{4}-\d{2}$/.test(m);
}

function getDefaultMonth() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

// 1) GET /api/report/monthly?month=YYYY-MM
router.get("/report/monthly", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const month = req.query.month ? String(req.query.month) : getDefaultMonth();
    if (!isValidMonthString(month)) return res.status(400).json({ message: "month must be YYYY-MM (e.g., 2026-02)" });

    const monthStart = `${month}-01`;

    const q = `
      SELECT
        r.user_id,
        r.category_id, c.category_name,
        r.subcategory_id, s.subcategory_name,
        r.month_start,
        r.total_profit, r.total_loss, r.total_brokerage, r.overall_total,
        r.month_status,
        r.rr_followed_count, r.rr_not_followed_count,
        r.overtrade_entries,
        r.mistakes_count
      FROM investment_month_report r
      JOIN investment_category c ON c.category_id = r.category_id
      JOIN investment_subcategory s ON s.subcategory_id = r.subcategory_id
      WHERE r.user_id = $1
        AND r.month_start = $2::date
      ORDER BY c.category_name, s.subcategory_name;
    `;
    const result = await pool.query(q, [user_id, monthStart]);
    return res.json({ month, data: result.rows });
  } catch (err) {
    console.error("GET /api/report/monthly error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// 2) GET /api/report/mistakes?month=YYYY-MM
router.get("/report/mistakes", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const month = req.query.month ? String(req.query.month) : getDefaultMonth();
    if (!isValidMonthString(month)) return res.status(400).json({ message: "month must be YYYY-MM (e.g., 2026-02)" });

    const monthStart = `${month}-01`;

    const q = `
      SELECT
        m.user_id,
        m.category_id, c.category_name,
        m.subcategory_id, s.subcategory_name,
        m.month_start,
        m.mistake_text,
        m.repeat_count
      FROM investment_month_top_mistakes m
      JOIN investment_category c ON c.category_id = m.category_id
      JOIN investment_subcategory s ON s.subcategory_id = m.subcategory_id
      WHERE m.user_id = $1
        AND m.month_start = $2::date
      ORDER BY m.repeat_count DESC, m.mistake_text ASC;
    `;
    const result = await pool.query(q, [user_id, monthStart]);
    return res.json({ month, data: result.rows });
  } catch (err) {
    console.error("GET /api/report/mistakes error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// 3) GET /api/report/fund?month=YYYY-MM  (FIXED)
router.get("/report/fund", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const month = req.query.month ? String(req.query.month) : getDefaultMonth();
    if (!isValidMonthString(month)) return res.status(400).json({ message: "month must be YYYY-MM (e.g., 2026-02)" });

    const monthStart = `${month}-01`;

    const q = `
      WITH month_range AS (
        SELECT
          ($2::date) AS start_date,
          (date_trunc('month', $2::date) + interval '1 month')::date AS end_date
      )
      SELECT
        p.user_id,
        p.plan_id,
        p.plan_name,
        p.subcategory_id,
        s.subcategory_name,
        c.category_id,
        c.category_name,
        $2::date AS month_start,
        p.total_fund_deposit AS total_fund,
        COALESCE(SUM(j.net_pnl), 0) AS month_pnl,
        (p.total_fund_deposit + COALESCE(SUM(j.net_pnl), 0)) AS fund_remaining
      FROM investment_plan p
      JOIN investment_subcategory s ON s.subcategory_id = p.subcategory_id
      JOIN investment_category c ON c.category_id = s.category_id
      CROSS JOIN month_range mr
      LEFT JOIN investment_tradingjournal j
        ON j.plan_id = p.plan_id
       AND j.user_id = p.user_id
       AND j.trade_date >= mr.start_date
       AND j.trade_date <  mr.end_date
      WHERE p.user_id = $1
      GROUP BY
        p.user_id, p.plan_id, p.plan_name, p.subcategory_id,
        s.subcategory_name, c.category_id, c.category_name,
        p.total_fund_deposit
      ORDER BY c.category_name, s.subcategory_name, p.plan_name;
    `;

    const result = await pool.query(q, [user_id, monthStart]);
    return res.json({ month, data: result.rows });
  } catch (err) {
    console.error("GET /api/report/fund error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
