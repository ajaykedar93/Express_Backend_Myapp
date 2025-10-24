// routes/dailyTransactions.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/** Utility → today (local) as YYYY-MM-DD */
const getToday = () => {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  return new Date(now - tzOffset).toISOString().split("T")[0];
};

/** Helpers */
const toPosFloat = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const parseQtyOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null; // let DB default or keep old on UPDATE
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
};

/* ================================
   GET daily transactions (today only)
   ================================ */
router.get("/", async (_req, res) => {
  try {
    const today = getToday();
    const { rows } = await db.query(
      "SELECT * FROM DailyTransaction WHERE transaction_date=$1 ORDER BY sequence_no",
      [today]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching transactions:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================================
   ADD daily transaction
   ================================ */
router.post("/", async (req, res) => {
  try {
    let {
      amount,
      type = "debit",
      category_id,
      subcategory_id,
      purpose,
      transaction_date,
      quantity, // optional
    } = req.body;

    // Validate
    amount = toPosFloat(amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "Amount must be a positive number" });
    }
    if (!category_id) {
      return res.status(400).json({ message: "Category is required" });
    }

    const dateToUse =
      (transaction_date && isISODate(transaction_date) && transaction_date) || getToday();

    type = String(type || "debit").toLowerCase();
    category_id = parseInt(category_id, 10);
    subcategory_id = subcategory_id ? parseInt(subcategory_id, 10) : null;

    const qty = parseQtyOrNull(quantity);
    if (Number.isNaN(qty)) {
      return res.status(400).json({ message: "quantity must be a non-negative integer" });
    }

    await db.query(
      `INSERT INTO DailyTransaction (amount, type, category_id, subcategory_id, purpose, transaction_date, quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [amount, type, category_id, subcategory_id, purpose || null, dateToUse, qty] // qty=null → DB default 0
    );

    // Return only today’s transactions (keeps UI logic consistent)
    const { rows } = await db.query(
      "SELECT * FROM DailyTransaction WHERE transaction_date=$1 ORDER BY sequence_no",
      [getToday()]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error adding transaction:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================================
   UPDATE daily transaction
   ================================ */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let {
      amount,
      type = "debit",
      category_id,
      subcategory_id,
      purpose,
      quantity, // optional; if omitted → keep existing
    } = req.body;

    amount = toPosFloat(amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "Amount must be a positive number" });
    }
    if (!category_id) {
      return res.status(400).json({ message: "Category is required" });
    }

    type = String(type || "debit").toLowerCase();
    category_id = parseInt(category_id, 10);
    subcategory_id = subcategory_id ? parseInt(subcategory_id, 10) : null;

    const qty = parseQtyOrNull(quantity);
    if (Number.isNaN(qty)) {
      return res.status(400).json({ message: "quantity must be a non-negative integer" });
    }

    const result = await db.query(
      `UPDATE DailyTransaction
         SET amount=$1,
             type=$2,
             category_id=$3,
             subcategory_id=$4,
             purpose=$5,
             quantity = COALESCE($6, quantity)   -- only update if provided; else keep old
       WHERE daily_transaction_id=$7
       RETURNING transaction_date`,
      [amount, type, category_id, subcategory_id, purpose || null, qty, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    // Return only today’s transactions
    const { rows } = await db.query(
      "SELECT * FROM DailyTransaction WHERE transaction_date=$1 ORDER BY sequence_no",
      [getToday()]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error updating transaction:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================================
   DELETE daily transaction
   ================================ */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { rowCount } = await db.query(
      "DELETE FROM DailyTransaction WHERE daily_transaction_id=$1",
      [id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    // Return only today’s transactions
    const { rows } = await db.query(
      "SELECT * FROM DailyTransaction WHERE transaction_date=$1 ORDER BY sequence_no",
      [getToday()]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error deleting transaction:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================================
   GET daily summary (today only)
   ================================ */
router.get("/daily-summary", async (_req, res) => {
  try {
    const today = getToday();

    const { rows } = await db.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN LOWER(type)='debit'  THEN amount END), 0) AS total_debit,
         COALESCE(SUM(CASE WHEN LOWER(type)='credit' THEN amount END), 0) AS total_credit,
         COUNT(*) AS total_transactions
       FROM DailyTransaction
       WHERE transaction_date = $1`,
      [today]
    );

    const r = rows[0] || {
      total_debit: 0,
      total_credit: 0,
      total_transactions: 0,
    };

    res.json({
      summary_date: today,
      total_debit: Number(r.total_debit),
      total_credit: Number(r.total_credit),
      total_transactions: Number(r.total_transactions),
    });
  } catch (err) {
    console.error("Error fetching daily summary:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================================
   DELETE all transactions for a date
   DELETE /api/daily-transactions?date=YYYY-MM-DD&confirm=YES
   ================================ */
router.delete("/", async (req, res) => {
  try {
    const { date, confirm } = req.query; // YYYY-MM-DD

    if (!date) {
      return res
        .status(400)
        .json({ message: "Query param 'date' (YYYY-MM-DD) is required." });
    }
    if (!isISODate(date)) {
      return res.status(400).json({ message: "Invalid date format (YYYY-MM-DD)" });
    }
    if (confirm !== "YES") {
      return res.status(400).json({
        message:
          "Dangerous operation blocked. Add confirm=YES to proceed with deletion.",
      });
    }

    const sql = `
      WITH del AS (
        DELETE FROM DailyTransaction
        WHERE transaction_date::date = $1::date
        RETURNING amount, type
      )
      SELECT
        COUNT(*)::int AS deleted_count,
        COALESCE(SUM(CASE WHEN LOWER(type)='debit'  THEN amount END), 0)::numeric AS debit_sum,
        COALESCE(SUM(CASE WHEN LOWER(type)='credit' THEN amount END), 0)::numeric AS credit_sum
      FROM del;
    `;
    const { rows } = await db.query(sql, [date]);
    const stats = rows[0] || { deleted_count: 0, debit_sum: 0, credit_sum: 0 };

    if (stats.deleted_count === 0) {
      return res.status(404).json({ message: "No transactions found for that date." });
    }

    res.status(200).json({
      message: `Deleted ${stats.deleted_count} transaction(s) for ${date}.`,
      removed: {
        debit_sum: Number(stats.debit_sum),
        credit_sum: Number(stats.credit_sum),
      },
    });
  } catch (err) {
    console.error("Error deleting daily transactions:", err);
    res.status(500).json({ message: "Internal server error." });
  }
});

module.exports = router;
