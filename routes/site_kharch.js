const express = require("express");
const router = express.Router();
const db = require("../db"); // PostgreSQL client
const jsPDF = require("jspdf");
const html2canvas = require("html2canvas");

// Utility: Normalize Input for extras
function normalizeExtrasArray(extras) {
  if (!extras || !Array.isArray(extras)) return [];
  return extras
    .map((x) => {
      if (typeof x !== "object" || x === null) return null;
      let amount = Number(x.amount);
      if (isNaN(amount)) amount = null;
      let details = x.details ? String(x.details).trim() : null;
      if (amount === null && !details) return null;
      return { amount, details };
    })
    .filter(Boolean);
}

// ----------------------
// GET all with optional filters (transactions API)
// ----------------------
router.get("/sitekharch", async (req, res, next) => {
  try {
    let { category_id, from, to, min_amount, max_amount, q } = req.query;
    let conditions = [];
    let values = [];

    if (category_id) {
      values.push(Number(category_id));
      conditions.push(`category_id = $${values.length}`);
    }
    if (from) {
      values.push(from);
      conditions.push(`kharch_date >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`kharch_date <= $${values.length}`);
    }
    if (min_amount) {
      values.push(Number(min_amount));
      conditions.push(`amount >= $${values.length}`);
    }
    if (max_amount) {
      values.push(Number(max_amount));
      conditions.push(`amount <= $${values.length}`);
    }
    if (q && String(q).trim() !== "") {
      values.push(`%${q}%`);
      conditions.push(`details ILIKE $${values.length}`);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const query = `SELECT * FROM site_kharch ${where} ORDER BY kharch_date ASC, seq_no ASC, id ASC`;
    const { rows } = await db.query(query, values);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ----------------------
// GET all sitekharch data (to export to PDF)
// ----------------------
router.get("/download-sitekharch-pdf", async (req, res, next) => {
  try {
    const { category_id, from, to, min_amount, max_amount, q } = req.query;
    let conditions = [];
    let values = [];

    if (category_id) {
      values.push(Number(category_id));
      conditions.push(`category_id = $${values.length}`);
    }
    if (from) {
      values.push(from);
      conditions.push(`kharch_date >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`kharch_date <= $${values.length}`);
    }
    if (min_amount) {
      values.push(Number(min_amount));
      conditions.push(`amount >= $${values.length}`);
    }
    if (max_amount) {
      values.push(Number(max_amount));
      conditions.push(`amount <= $${values.length}`);
    }
    if (q && String(q).trim() !== "") {
      values.push(`%${q}%`);
      conditions.push(`details ILIKE $${values.length}`);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const query = `SELECT * FROM site_kharch ${where} ORDER BY kharch_date ASC, seq_no ASC, id ASC`;
    const { rows } = await db.query(query, values);

    if (!rows.length) {
      return res.status(404).json({ error: "No records found" });
    }

    // Calculate total amount for all transactions
    const totalAmount = rows.reduce((total, item) => {
      const itemAmount = Number(item.amount || 0);
      const extraAmount = item.extra_items
        ? item.extra_items.reduce((sum, e) => sum + Number(e.amount || 0), 0)
        : 0;
      return total + itemAmount + extraAmount;
    }, 0);

    // Generate PDF
    const doc = new jsPDF();

    // Header
    doc.setFontSize(16);
    doc.text("Site Kharch Transactions", 10, 10);

    // Table
    let y = 20;
    doc.setFontSize(12);
    rows.forEach((item, idx) => {
      doc.text(`${idx + 1}. ${item.kharch_date} - ${item.category_name}: ₹${item.amount}`, 10, y);
      y += 10;
      if (item.extra_items) {
        item.extra_items.forEach((extra) => {
          doc.text(`   Extra: ₹${extra.amount} - ${extra.details}`, 15, y);
          y += 10;
        });
      }
    });

    // Footer (Total)
    y += 10;
    doc.setFontSize(14);
    doc.text(`Total Amount: ₹${totalAmount}`, 10, y);

    // Download PDF
    doc.save("sitekharch_transactions.pdf");

  } catch (err) {
    next(err);
  }
});

// ----------------------
// ADD received amount (previous implementation)
// ----------------------
router.post("/add-received-amount", async (req, res) => {
  try {
    const { amount_received, payment_date } = req.body;

    // Validation
    if (!amount_received || isNaN(amount_received) || Number(amount_received) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Use today if no date provided
    const date = payment_date || new Date().toISOString().split("T")[0];

    const query = `
      INSERT INTO user_sitekharch_amount (amount_received, payment_date, payment_mode)
      VALUES ($1, $2, 'cash')
      RETURNING id, amount_received, payment_date, payment_mode
    `;
    const values = [amount_received, date];

    const { rows } = await db.query(query, values);

    res.status(201).json({
      message: "Amount added successfully",
      data: rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// Monthly summary for sitekharch
// ----------------------
router.get("/monthly-summary-sitekharch", async (req, res) => { 
  try {
    const { month } = req.query;
    const values = [];
    let monthFilter = "";

    if (month && Number(month) >= 1 && Number(month) <= 12) {
      monthFilter = "WHERE EXTRACT(MONTH FROM COALESCE(mk.month_start, mr.month_start)) = $1";
      values.push(month);
    }

    const query = `
      WITH monthly_kharch AS (
          SELECT DATE_TRUNC('month', kharch_date) AS month_start,
                 SUM(amount + COALESCE(extra_amount,0) +
                     COALESCE(
                       (SELECT SUM((extra_item->>'amount')::numeric)
                        FROM jsonb_array_elements(extra_items) AS extra_item),0)
                 ) AS total_kharch
          FROM site_kharch
          GROUP BY DATE_TRUNC('month', kharch_date)
      ),
      monthly_received AS (
          SELECT DATE_TRUNC('month', payment_date) AS month_start,
                 SUM(amount_received) AS total_received
          FROM user_sitekharch_amount
          WHERE payment_mode = 'cash'
          GROUP BY DATE_TRUNC('month', payment_date)
      )
      SELECT 
         TO_CHAR(COALESCE(mk.month_start, mr.month_start),'Mon YYYY') AS month_name,
         COALESCE(mr.total_received,0) AS total_received_rs,
         COALESCE(mk.total_kharch,0) AS total_kharch_rs,
         COALESCE(mr.total_received,0) - COALESCE(mk.total_kharch,0) AS remaining_amount_rs
      FROM monthly_kharch mk
      FULL OUTER JOIN monthly_received mr
        ON mk.month_start = mr.month_start
      ${monthFilter}
      ORDER BY COALESCE(mk.month_start, mr.month_start) DESC;
    `;

    const { rows } = await db.query(query, values);
    res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// RESEQUENCE (per kharch_date)
// ----------------------
router.post("/sitekharch/resequence", async (req, res, next) => {
  try {
    await db.query(`
      WITH ordered AS (
        SELECT 
          id,
          ROW_NUMBER() OVER (
            PARTITION BY kharch_date 
            ORDER BY id ASC, category_id ASC
          ) AS new_seq
        FROM site_kharch
      )
      UPDATE site_kharch t
      SET seq_no = o.new_seq
      FROM ordered o
      WHERE t.id = o.id
    `);

    res.json({ success: true, message: "Resequenced seq_no per kharch_date" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
