// routes/financeTotals.js
const express = require("express");
const router = express.Router();
const db = require("../db"); // your pg client/pool

// tiny helpers (scoped to this single API)
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const fmt = (n) =>
  n !== null && n !== undefined && !Number.isNaN(Number(n))
    ? Number(n).toFixed(2)
    : "0.00";

// GET /api/monthly-summary/total?month=9&year=2025
router.get("/monthly-summary/total", async (req, res) => {
  try {
    const month = toInt(req.query.month);
    const year = toInt(req.query.year);

    if (!month || !year || month < 1 || month > 12) {
      return res
        .status(400)
        .json({ message: "Valid month (1-12) and year are required." });
    }

    const sql = `
      SELECT
        COALESCE(SUM(CASE WHEN LOWER(dt.type)='credit' THEN dt.amount ELSE 0 END), 0) AS total_credit,
        COALESCE(SUM(CASE WHEN LOWER(dt.type)='debit'  THEN dt.amount ELSE 0 END), 0) AS total_debit,
        COUNT(*) AS total_transactions
      FROM DailyTransaction dt
      WHERE EXTRACT(MONTH FROM dt.transaction_date) = $1
        AND EXTRACT(YEAR  FROM dt.transaction_date) = $2
    `;

    const { rows } = await db.query(sql, [month, year]);
    const r = rows[0] || { total_credit: 0, total_debit: 0, total_transactions: 0 };

    if (Number(r.total_transactions) === 0) {
      return res.status(404).json({ message: "No transactions found." });
    }

    const monthName = new Date(year, month - 1).toLocaleString("default", { month: "long" });

    return res.json({
      month: monthName,
      year,
      credit: fmt(r.total_credit),
      debit: fmt(r.total_debit),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Internal server error." });
  }
});

module.exports = router;
