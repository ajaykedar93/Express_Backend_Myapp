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

// 1) POST /api/dipwid
router.post("/dipwid", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const { txn_type, amount, txn_date, note, category_id, subcategory_id } = req.body;

    const TYPE = String(txn_type || "").toUpperCase();
    if (!["DEPOSIT", "WITHDRAW"].includes(TYPE)) {
      return res.status(400).json({ message: "txn_type must be DEPOSIT or WITHDRAW" });
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: "amount must be > 0" });

    const catId = category_id ? parseInt(category_id, 10) : null;
    const subId = subcategory_id ? parseInt(subcategory_id, 10) : null;

    if (catId !== null && !catId) return res.status(400).json({ message: "Invalid category_id" });
    if (subId !== null && !subId) return res.status(400).json({ message: "Invalid subcategory_id" });

    if (txn_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(txn_date))) {
      return res.status(400).json({ message: "txn_date must be YYYY-MM-DD" });
    }

    // ownership checks (only if provided)
    if (catId !== null) {
      const catCheck = await pool.query(
        `SELECT 1 FROM investment_category WHERE category_id=$1 AND user_id=$2`,
        [catId, user_id]
      );
      if (catCheck.rowCount === 0) return res.status(404).json({ message: "Category not found for this user" });
    }

    if (subId !== null) {
      const subCheck = await pool.query(
        `SELECT category_id FROM investment_subcategory WHERE subcategory_id=$1 AND user_id=$2`,
        [subId, user_id]
      );
      if (subCheck.rowCount === 0) return res.status(404).json({ message: "Subcategory not found for this user" });

      if (catId !== null && subCheck.rows[0].category_id !== catId) {
        return res.status(400).json({ message: "subcategory_id does not belong to category_id" });
      }
    }

    const q = `
      INSERT INTO investment_dipwid
        (user_id, category_id, subcategory_id, txn_type, amount, txn_date, note)
      VALUES
        ($1,$2,$3,$4,$5, COALESCE($6::date, CURRENT_DATE), $7)
      RETURNING dipwid_id, user_id, category_id, subcategory_id, txn_type, amount, txn_date, note, created_at;
    `;
    const result = await pool.query(q, [
      user_id,
      catId,
      subId,
      TYPE,
      amt,
      txn_date ?? null,
      note ?? null,
    ]);

    return res.status(201).json({ message: "Transaction saved", data: result.rows[0] });
  } catch (err) {
    console.error("POST /api/dipwid error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// 2) GET /api/dipwid
router.get("/dipwid", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const category_id = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
    const subcategory_id = req.query.subcategory_id ? parseInt(req.query.subcategory_id, 10) : null;

    let q = `
      SELECT
        d.*,
        c.category_name,
        s.subcategory_name
      FROM investment_dipwid d
      LEFT JOIN investment_category c ON c.category_id = d.category_id
      LEFT JOIN investment_subcategory s ON s.subcategory_id = d.subcategory_id
      WHERE d.user_id = $1
    `;
    const params = [user_id];

    if (category_id) {
      q += ` AND d.category_id = $2`;
      params.push(category_id);
    }
    if (subcategory_id) {
      q += ` AND d.subcategory_id = $${params.length + 1}`;
      params.push(subcategory_id);
    }

    q += ` ORDER BY d.txn_date DESC, d.dipwid_id DESC;`;

    const result = await pool.query(q, params);
    return res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /api/dipwid error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// 3) GET /api/dipwid/ledger
router.get("/dipwid/ledger", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const category_id = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
    const subcategory_id = req.query.subcategory_id ? parseInt(req.query.subcategory_id, 10) : null;

    let q = `
      SELECT
        l.*,
        c.category_name,
        s.subcategory_name
      FROM investment_dipwid_ledger l
      LEFT JOIN investment_category c ON c.category_id = l.category_id
      LEFT JOIN investment_subcategory s ON s.subcategory_id = l.subcategory_id
      WHERE l.user_id = $1
    `;
    const params = [user_id];

    if (category_id) {
      q += ` AND l.category_id = $2`;
      params.push(category_id);
    }
    if (subcategory_id) {
      q += ` AND l.subcategory_id = $${params.length + 1}`;
      params.push(subcategory_id);
    }

    q += ` ORDER BY l.txn_date ASC, l.dipwid_id ASC;`;

    const result = await pool.query(q, params);
    return res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /api/dipwid/ledger error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// 4) GET /api/dipwid/alert?month=YYYY-MM  (EXTRA - monthly alert messages)
router.get("/dipwid/alert", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const month = req.query.month ? String(req.query.month) : null;
    if (!month || !isValidMonthString(month)) {
      return res.status(400).json({ message: "month is required in YYYY-MM (e.g., 2026-02)" });
    }

    const monthStart = `${month}-01`;

    const q = `
      SELECT
        a.*,
        c.category_name,
        s.subcategory_name
      FROM investment_dipwid_month_alert a
      LEFT JOIN investment_category c ON c.category_id = a.category_id
      LEFT JOIN investment_subcategory s ON s.subcategory_id = a.subcategory_id
      WHERE a.user_id = $1
        AND a.month_start = $2::date
      ORDER BY c.category_name NULLS FIRST, s.subcategory_name NULLS FIRST;
    `;

    const result = await pool.query(q, [user_id, monthStart]);
    return res.json({ month, data: result.rows });
  } catch (err) {
    console.error("GET /api/dipwid/alert error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
