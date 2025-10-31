const express = require("express");
const router = express.Router();
const db = require("../db"); // PostgreSQL client

// ----------------------
// Utility: Normalize Input
// ----------------------
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

// ----------------------
// ----------------------
// GET /api/sitekharch
router.get("/sitekharch", async (req, res) => {
  const { category_id, from, to, min_amount, max_amount, q } = req.query;

  const whereParts = [];
  const values = [];

  // ---------- filters for site_kharch ----------
  if (category_id) {
    values.push(Number(category_id));
    whereParts.push(`s.category_id = $${values.length}`);
  }

  if (from) {
    values.push(from);
    whereParts.push(`s.kharch_date >= $${values.length}`);
  }

  if (to) {
    values.push(to);
    whereParts.push(`s.kharch_date <= $${values.length}`);
  }

  if (min_amount) {
    values.push(Number(min_amount));
    whereParts.push(`s.amount >= $${values.length}`);
  }

  if (max_amount) {
    values.push(Number(max_amount));
    whereParts.push(`s.amount <= $${values.length}`);
  }

  if (q && String(q).trim() !== "") {
    values.push(`%${q}%`);
    // search in details OR in extra_details (from legacy columns)
    whereParts.push(`(s.details ILIKE $${values.length} OR s.extra_details ILIKE $${values.length})`);
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  try {
    // 1️⃣ get EXPENSE rows (site_kharch) with category + JSON extras
    const expenseQuery = `
      SELECT
        s.id,
        s.seq_no,
        s.kharch_date,
        s.category_id,
        wc.category_name,
        s.amount,
        s.details,
        s.extra_amount,
        s.extra_details,
        s.extra_items
      FROM site_kharch s
      LEFT JOIN workcategory wc ON wc.id = s.category_id
      ${whereClause}
      ORDER BY s.kharch_date ASC, s.seq_no ASC, s.id ASC;
    `;

    const { rows: expenseRows } = await db.query(expenseQuery, values);

    // 2️⃣ calculate total_expense in Node (because of JSONB extras)
    let totalExpense = 0;
    const normalizedData = expenseRows.map((row) => {
      const base = Number(row.amount || 0);

      // legacy single extra
      const legacyExtra = Number(row.extra_amount || 0);

      // JSON extras
      const extras = Array.isArray(row.extra_items) ? row.extra_items : JSON.parse(row.extra_items || "[]");
      const extrasTotal = extras.reduce(
        (sum, e) => sum + Number(e.amount || 0),
        0
      );

      const rowTotal = base + legacyExtra + extrasTotal;
      totalExpense += rowTotal;

      return {
        ...row,
        extra_items: extras,
        row_total: rowTotal
      };
    });

    // 3️⃣ get RECEIVED amount from user_sitekharch_amount
    //    If user gave from/to → apply same filter
    const incomeWhere = [];
    const incomeValues = [];
    if (from) {
      incomeValues.push(from);
      incomeWhere.push(`payment_date >= $${incomeValues.length}`);
    }
    if (to) {
      incomeValues.push(to);
      incomeWhere.push(`payment_date <= $${incomeValues.length}`);
    }
    const incomeWhereClause = incomeWhere.length ? `WHERE ${incomeWhere.join(" AND ")}` : "";

    const incomeQuery = `
      SELECT COALESCE(SUM(amount_received), 0) AS total_received
      FROM user_sitekharch_amount
      ${incomeWhereClause};
    `;
    const { rows: incomeRows } = await db.query(incomeQuery, incomeValues);
    const totalReceived = Number(incomeRows[0].total_received || 0);

    // 4️⃣ final response
    res.json({
      filters: {
        category_id: category_id || null,
        from: from || null,
        to: to || null,
        min_amount: min_amount || null,
        max_amount: max_amount || null,
        q: q || null,
      },
      totals: {
        expense: totalExpense,
        received: totalReceived,
        balance: totalReceived - totalExpense,
      },
      count: normalizedData.length,
      data: normalizedData,
    });
  } catch (err) {
    console.error("Error in /api/sitekharch:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// ----------------------
// GET by ID
// ----------------------
router.get("/sitekharch/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `SELECT * FROM site_kharch WHERE id = $1`,
      [Number(id)]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ----------------------
// CREATE
// ----------------------
router.post("/sitekharch", async (req, res, next) => {
  try {
    let {
      category_id,
      kharch_date,
      amount,
      details,
      extra_amount,
      extra_details,
      extras_all,
    } = req.body;

    if (!category_id || !amount || !details) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const normalizedExtras = normalizeExtrasArray(extras_all);
    const { rows } = await db.query(
      `INSERT INTO site_kharch
       (category_id, kharch_date, amount, details, extra_amount, extra_details, extra_items)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        category_id,
        kharch_date || new Date(),
        amount,
        details,
        extra_amount || null,
        extra_details || null,
        JSON.stringify(normalizedExtras),
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ----------------------
// UPDATE
// ----------------------
router.put("/sitekharch/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    let {
      category_id,
      kharch_date,
      amount,
      details,
      extra_amount,
      extra_details,
      extras_all,
    } = req.body;

    const normalizedExtras = normalizeExtrasArray(extras_all);

    const { rows } = await db.query(
      `UPDATE site_kharch SET
         category_id = COALESCE($1, category_id),
         kharch_date = COALESCE($2, kharch_date),
         amount = COALESCE($3, amount),
         details = COALESCE($4, details),
         extra_amount = $5,
         extra_details = $6,
         extra_items = $7::jsonb
       WHERE id = $8
       RETURNING *`,
      [
        category_id || null,
        kharch_date || null,
        amount || null,
        details || null,
        extra_amount || null,
        extra_details || null,
        JSON.stringify(normalizedExtras),
        id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ----------------------
// DELETE
// ----------------------
router.delete("/sitekharch/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(`DELETE FROM site_kharch WHERE id = $1 RETURNING *`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Add received amount
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

// Monthly summary for site kharch
router.get("/monthly-summary-sitekharch", async (req, res) => { 
  try {
    const { month } = req.query; // Optional filter: 1-12
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

// ----------------------
// BULK INSERT
// ----------------------
router.post("/sitekharch/bulk", async (req, res, next) => {
  try {
    const { category_id, kharch_date, entries } = req.body;
    if (!category_id || !kharch_date || !Array.isArray(entries)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const results = [];
      for (const e of entries) {
        const normalizedExtras = normalizeExtrasArray(e.extras_all);
        const { rows } = await client.query(
          `INSERT INTO site_kharch
           (category_id, kharch_date, amount, details, extra_amount, extra_details, extra_items)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           RETURNING *`,
          [
            category_id,
            kharch_date,
            e.amount,
            e.details,
            e.extra_amount || null,
            e.extra_details || null,
            JSON.stringify(normalizedExtras),
          ]
        );
        results.push(rows[0]);
      }

      await client.query("COMMIT");
      res.json({ success: true, inserted: results });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
