const express = require("express");
const router = express.Router();
const pool = require("../../db");
const PDFDocument = require("pdfkit");

// ==============================
// FORMAT DATE
// ==============================
const formatDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;

  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
};

// ==============================
// FORMAT MONTH LABEL
// ==============================
const formatMonthLabel = (monthValue) => {
  if (!monthValue) return "All Transactions";

  const [year, month] = String(monthValue).split("-");
  if (!year || !month) return monthValue;

  const d = new Date(Number(year), Number(month) - 1, 1);

  if (isNaN(d.getTime())) return monthValue;

  return d.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
};

// ==============================
// FORMAT MONEY
// ==============================
const formatMoney = (amount) => {
  const num = Number(amount || 0);

  if (Number.isInteger(num)) {
    return `Rs. ${num}`;
  }

  return `Rs. ${parseFloat(num.toFixed(2)).toString()}`;
};

// ==============================
// GET FULL TRANSACTION BY ID
// ==============================
const getTransactionWithNames = async (id) => {
  const result = await pool.query(
    `
    SELECT 
      t.id,
      t.amount,
      t.quantity,
      t.type,
      t.category_id,
      c.name AS category_name,
      t.subcategory_id,
      s.name AS subcategory_name,
      t.purpose,
      t.t_date,
      t.created_at
    FROM tog_transaction t
    LEFT JOIN tog_categories c ON t.category_id = c.id
    LEFT JOIN tog_subcategories s ON t.subcategory_id = s.id
    WHERE t.id = $1
    `,
    [Number(id)]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    ...row,
    formatted_date: formatDate(row.t_date),
  };
};

// ==============================
// VALIDATE CATEGORY & SUBCATEGORY
// ==============================
const validateCategorySubcategory = async (category_id, subcategory_id) => {
  if (category_id) {
    const categoryCheck = await pool.query(
      `SELECT id, name FROM tog_categories WHERE id = $1`,
      [category_id]
    );

    if (categoryCheck.rows.length === 0) {
      return { ok: false, error: "Selected category does not exist" };
    }
  }

  if (subcategory_id) {
    const subCheck = await pool.query(
      `SELECT id, name, category_id FROM tog_subcategories WHERE id = $1`,
      [subcategory_id]
    );

    if (subCheck.rows.length === 0) {
      return { ok: false, error: "Selected subcategory does not exist" };
    }

    if (
      category_id &&
      Number(subCheck.rows[0].category_id) !== Number(category_id)
    ) {
      return {
        ok: false,
        error: "Selected subcategory does not belong to selected category",
      };
    }
  }

  return { ok: true };
};

// ==============================
// COMMON QUERY FOR TRANSACTIONS
// ==============================
const getAllTransactionsWithNames = async (month = null) => {
  let query = `
    SELECT 
      t.id,
      t.amount,
      t.quantity,
      t.type,
      t.category_id,
      c.name AS category_name,
      t.subcategory_id,
      s.name AS subcategory_name,
      t.purpose,
      t.t_date,
      t.created_at
    FROM tog_transaction t
    LEFT JOIN tog_categories c ON t.category_id = c.id
    LEFT JOIN tog_subcategories s ON t.subcategory_id = s.id
  `;

  const values = [];

  if (month) {
    query += ` WHERE TO_CHAR(t.t_date, 'YYYY-MM') = $1 `;
    values.push(month);
  }

  query += ` ORDER BY t.t_date DESC, t.id DESC `;

  const result = await pool.query(query, values);

  return result.rows.map((r) => ({
    ...r,
    formatted_date: formatDate(r.t_date),
  }));
};

// ==============================
// PREPARE PDF ROWS (DATE SHOW ONCE)
// ==============================
const preparePdfRows = (data) => {
  let lastDate = "";

  return data.map((row) => {
    const currentDate = row.formatted_date || "-";
    const showDate = currentDate !== lastDate;

    lastDate = currentDate;

    return {
      ...row,
      pdf_date: showDate ? currentDate : "",
    };
  });
};

// ==============================
// PDF HELPERS
// ==============================
const drawTableHeader = (doc, startX, y, colWidths) => {
  const headers = [
    "Date",
    "Type",
    "Amount",
    "Qty",
    "Category",
    "Subcategory",
    "Purpose",
  ];

  let x = startX;

  doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8.5);

  headers.forEach((header, index) => {
    doc
      .rect(x, y, colWidths[index], 24)
      .strokeColor("#000000")
      .lineWidth(0.8)
      .stroke();

    doc.text(header, x + 4, y + 7, {
      width: colWidths[index] - 8,
      align: "left",
    });

    x += colWidths[index];
  });
};

const drawTableRow = (doc, row, startX, y, colWidths) => {
  const values = [
    row.pdf_date || "",
    row.type ? row.type.charAt(0).toUpperCase() + row.type.slice(1) : "-",
    formatMoney(row.amount),
    row.quantity ?? 0,
    row.category_name || "-",
    row.subcategory_name || "-",
    row.purpose || "-",
  ];

  const fonts = [
    "Helvetica",
    "Helvetica",
    "Helvetica-Bold",
    "Helvetica",
    "Helvetica",
    "Helvetica",
    "Helvetica",
  ];

  const colors = [
    "#000000",
    "#000000",
    row.type === "credit"
      ? "#15803d"
      : row.type === "debit"
      ? "#dc2626"
      : "#000000",
    "#000000",
    "#000000",
    "#000000",
    "#000000",
  ];

  const cellHeights = values.map((val, index) => {
    doc.font(fonts[index]).fontSize(8);
    return doc.heightOfString(String(val), {
      width: colWidths[index] - 8,
      align: "left",
    });
  });

  const rowHeight = Math.max(...cellHeights, 16) + 10;

  let x = startX;

  values.forEach((val, index) => {
    doc
      .rect(x, y, colWidths[index], rowHeight)
      .strokeColor("#000000")
      .lineWidth(0.5)
      .stroke();

    doc
      .font(fonts[index])
      .fontSize(8)
      .fillColor(colors[index])
      .text(String(val), x + 4, y + 5, {
        width: colWidths[index] - 8,
        align: "left",
      });

    x += colWidths[index];
  });

  return rowHeight;
};

// ==============================
// CREATE TRANSACTION
// POST /api/tag_transaction
// ==============================
router.post("/", async (req, res) => {
  try {
    let {
      amount,
      quantity,
      type,
      category_id,
      subcategory_id,
      purpose,
      t_date,
    } = req.body;

    amount = Number(amount);
    quantity =
      quantity === "" || quantity === undefined || quantity === null
        ? null
        : Number(quantity);

    type = type ? String(type).trim().toLowerCase() : "debit";

    category_id =
      category_id === "" || category_id === undefined || category_id === null
        ? null
        : Number(category_id);

    subcategory_id =
      subcategory_id === "" || subcategory_id === undefined || subcategory_id === null
        ? null
        : Number(subcategory_id);

    purpose = purpose?.trim() || null;
    t_date = t_date || new Date().toISOString().split("T")[0];

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    if (quantity !== null && (isNaN(quantity) || quantity < 0)) {
      return res.status(400).json({ error: "Quantity must be 0 or more" });
    }

    if (!["debit", "credit"].includes(type)) {
      return res.status(400).json({
        error: "Type must be either debit or credit",
      });
    }

    if (t_date && isNaN(new Date(t_date).getTime())) {
      return res.status(400).json({ error: "Invalid transaction date" });
    }

    const validate = await validateCategorySubcategory(
      category_id,
      subcategory_id
    );

    if (!validate.ok) {
      return res.status(400).json({ error: validate.error });
    }

    const result = await pool.query(
      `
      INSERT INTO tog_transaction
      (amount, quantity, type, category_id, subcategory_id, purpose, t_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [amount, quantity, type, category_id, subcategory_id, purpose, t_date]
    );

    const savedData = await getTransactionWithNames(result.rows[0].id);

    res.status(201).json({
      message: "Transaction created successfully",
      data: savedData,
    });
  } catch (err) {
    console.error("CREATE ERROR:", err.message);
    res.status(500).json({ error: "Server error while creating transaction" });
  }
});

// ==============================
// EXPORT PDF
// GET /api/tag_transaction/export-pdf?month=YYYY-MM
// ==============================
router.get("/export-pdf", async (req, res) => {
  try {
    const { month } = req.query;

    const rawData = await getAllTransactionsWithNames(month);
    const data = preparePdfRows(rawData);
    const monthLabel = formatMonthLabel(month);

    const doc = new PDFDocument({
      size: "A4",
      margin: 35,
      layout: "portrait",
    });

    const fileName = month
      ? `transactions-${month}.pdf`
      : `transactions-all.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    doc.pipe(res);

    let totalDebit = 0;
    let totalCredit = 0;

    rawData.forEach((item) => {
      const amt = Number(item.amount || 0);
      if (item.type === "credit") totalCredit += amt;
      else totalDebit += amt;
    });

    const totalBalance = totalCredit - totalDebit;

    // ==============================
    // PDF HEADER
    // ==============================
    doc
      .fillColor("#000000")
      .font("Helvetica-Bold")
      .fontSize(19)
      .text("Transaction Report", 35, 28, { align: "center" });

    doc
      .moveDown(0.45)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(monthLabel, { align: "center" });

    doc
      .moveDown(0.35)
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#000000")
      .text(`Total Transactions: ${rawData.length}`, { align: "center" });

    doc
      .moveDown(0.15)
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#000000")
      .text(`Total Balance: ${formatMoney(totalBalance)}`, { align: "center" });

    doc
      .moveDown(0.15)
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#dc2626")
      .text(`Debit: ${formatMoney(totalDebit)}`, { align: "center" });

    doc
      .moveDown(0.15)
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#15803d")
      .text(`Credit: ${formatMoney(totalCredit)}`, { align: "center" });

    let y = 165;
    const startX = 35;
    const colWidths = [52, 45, 70, 34, 75, 82, 132];

    drawTableHeader(doc, startX, y, colWidths);
    y += 24;

    if (data.length === 0) {
      doc
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#000000")
        .text("No transaction records found.", startX, y + 20, {
          width: 520,
          align: "center",
        });
    } else {
      for (const row of data) {
        const testHeights = [
          row.pdf_date || "",
          row.type ? row.type.charAt(0).toUpperCase() + row.type.slice(1) : "-",
          formatMoney(row.amount),
          row.quantity ?? 0,
          row.category_name || "-",
          row.subcategory_name || "-",
          row.purpose || "-",
        ].map((val, index) => {
          doc.font(index === 2 ? "Helvetica-Bold" : "Helvetica").fontSize(8);
          return doc.heightOfString(String(val), {
            width: colWidths[index] - 8,
            align: "left",
          });
        });

        const expectedRowHeight = Math.max(...testHeights, 16) + 10;

        if (y + expectedRowHeight > doc.page.height - 40) {
          doc.addPage({
            size: "A4",
            margin: 35,
            layout: "portrait",
          });

          doc
            .fillColor("#000000")
            .font("Helvetica-Bold")
            .fontSize(14)
            .text("Transaction Report", 35, 20, { align: "center" });

          doc
            .moveDown(0.25)
            .font("Helvetica")
            .fontSize(9)
            .text(monthLabel, { align: "center" });

          y = 65;
          drawTableHeader(doc, startX, y, colWidths);
          y += 24;
        }

        const usedHeight = drawTableRow(doc, row, startX, y, colWidths);
        y += usedHeight;
      }
    }

    doc.end();
  } catch (err) {
    console.error("EXPORT PDF ERROR:", err.message);
    res.status(500).json({ error: "Server error while exporting PDF" });
  }
});

// ==============================
// GET ALL TRANSACTIONS
// GET /api/tag_transaction?month=YYYY-MM
// ==============================
router.get("/", async (req, res) => {
  try {
    const { month } = req.query;
    const data = await getAllTransactionsWithNames(month);

    res.json({
      count: data.length,
      data,
    });
  } catch (err) {
    console.error("GET ALL ERROR:", err.message);
    res.status(500).json({ error: "Server error while fetching transactions" });
  }
});

// ==============================
// GET SINGLE TRANSACTION
// GET /api/tag_transaction/:id
// ==============================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid transaction id" });
    }

    const data = await getTransactionWithNames(id);

    if (!data) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.json(data);
  } catch (err) {
    console.error("GET ONE ERROR:", err.message);
    res.status(500).json({ error: "Server error while fetching transaction" });
  }
});

// ==============================
// UPDATE TRANSACTION
// PUT /api/tag_transaction/:id
// ==============================
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid transaction id" });
    }

    let {
      amount,
      quantity,
      type,
      category_id,
      subcategory_id,
      purpose,
      t_date,
    } = req.body;

    const existing = await pool.query(
      `SELECT * FROM tog_transaction WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    const old = existing.rows[0];

    const updated = {
      amount:
        amount !== undefined && amount !== null && amount !== ""
          ? Number(amount)
          : Number(old.amount),

      quantity:
        quantity === ""
          ? null
          : quantity !== undefined && quantity !== null
          ? Number(quantity)
          : old.quantity,

      type:
        type !== undefined && type !== null && type !== ""
          ? String(type).trim().toLowerCase()
          : old.type,

      category_id:
        category_id === ""
          ? null
          : category_id !== undefined && category_id !== null
          ? Number(category_id)
          : old.category_id,

      subcategory_id:
        subcategory_id === ""
          ? null
          : subcategory_id !== undefined && subcategory_id !== null
          ? Number(subcategory_id)
          : old.subcategory_id,

      purpose:
        purpose !== undefined ? purpose?.trim() || null : old.purpose,

      t_date: t_date || old.t_date,
    };

    if (isNaN(updated.amount) || updated.amount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    if (
      updated.quantity !== null &&
      (isNaN(updated.quantity) || updated.quantity < 0)
    ) {
      return res.status(400).json({ error: "Quantity must be 0 or more" });
    }

    if (!["debit", "credit"].includes(updated.type)) {
      return res.status(400).json({
        error: "Type must be either debit or credit",
      });
    }

    if (updated.t_date && isNaN(new Date(updated.t_date).getTime())) {
      return res.status(400).json({ error: "Invalid transaction date" });
    }

    const validate = await validateCategorySubcategory(
      updated.category_id,
      updated.subcategory_id
    );

    if (!validate.ok) {
      return res.status(400).json({ error: validate.error });
    }

    await pool.query(
      `
      UPDATE tog_transaction SET
        amount = $1,
        quantity = $2,
        type = $3,
        category_id = $4,
        subcategory_id = $5,
        purpose = $6,
        t_date = $7
      WHERE id = $8
      `,
      [
        updated.amount,
        updated.quantity,
        updated.type,
        updated.category_id,
        updated.subcategory_id,
        updated.purpose,
        updated.t_date,
        id,
      ]
    );

    const updatedData = await getTransactionWithNames(id);

    res.json({
      message: "Transaction updated successfully",
      data: updatedData,
    });
  } catch (err) {
    console.error("UPDATE ERROR:", err.message);
    res.status(500).json({ error: "Server error while updating transaction" });
  }
});

// ==============================
// DELETE TRANSACTION
// DELETE /api/tag_transaction/:id
// ==============================
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid transaction id" });
    }

    const existing = await pool.query(
      `SELECT * FROM tog_transaction WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    await pool.query(`DELETE FROM tog_transaction WHERE id = $1`, [id]);

    res.json({
      message: "Transaction deleted successfully",
      deleted_id: Number(id),
    });
  } catch (err) {
    console.error("DELETE ERROR:", err.message);
    res.status(500).json({ error: "Server error while deleting transaction" });
  }
});

module.exports = router;