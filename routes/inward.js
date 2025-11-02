// routes/inward.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");
const moment = require("moment");

// ==========================
// Config
// ==========================
const TABLE = "inward";

const ALLOWED_COLUMNS = new Set([
  "work_date",
  "work_time",
  "details",
  "quantity",
  "quantity_type",
  "extra_details",
  "extra_quantity",
  "extra_quantity_type",
  "extra_items",
]);

// ==========================
// Helper functions
// ==========================
function normalizeExtrasArray(extrasAll) {
  if (!Array.isArray(extrasAll)) return [];
  return extrasAll
    .map((e) => ({
      details: e?.details ?? null,
      quantity:
        e?.quantity === "" || e?.quantity == null ? null : Number(e.quantity),
      quantity_type: e?.quantity_type ?? null,
    }))
    .filter(
      (e) =>
        (e.details && String(e.details).trim() !== "") ||
        e.quantity !== null ||
        (e.quantity_type && String(e.quantity_type).trim() !== "")
    );
}

function ensureLegacyFromExtras(data) {
  const legacyProvided =
    data.extra_details !== undefined ||
    data.extra_quantity !== undefined ||
    data.extra_quantity_type !== undefined;

  if (legacyProvided) return data;

  let arr = [];
  if (Array.isArray(data.extra_items)) arr = data.extra_items;
  else if (typeof data.extra_items === "string") {
    try {
      arr = JSON.parse(data.extra_items);
    } catch {
      arr = [];
    }
  }

  const first = arr[0];
  if (!first) return data;

  return {
    ...data,
    extra_details: data.extra_details ?? first.details ?? null,
    extra_quantity: data.extra_quantity ?? first.quantity ?? null,
    extra_quantity_type: data.extra_quantity_type ?? first.quantity_type ?? null,
  };
}

function prepareDataFromBody(body) {
  const out = { ...body };

  // 1) convert extras_all -> extra_items
  if (Object.prototype.hasOwnProperty.call(body, "extras_all")) {
    out.extra_items = normalizeExtrasArray(body.extras_all);
    delete out.extras_all;
  }

  // 2) make sure extra_items is an array
  if (typeof out.extra_items === "string") {
    try {
      out.extra_items = JSON.parse(out.extra_items);
    } catch {
      out.extra_items = [];
    }
  }
  if (!Array.isArray(out.extra_items)) out.extra_items = [];

  // 3) clean empty date
  if (out.work_date !== undefined && String(out.work_date).trim() === "") {
    delete out.work_date;
  }

  // 4) copy first extra to legacy
  return ensureLegacyFromExtras(out);
}

function buildInsertFromBody(data) {
  const cols = [];
  const vals = [];
  const placeholders = [];

  let idx = 1;
  for (const col of ALLOWED_COLUMNS) {
    if (data[col] !== undefined) {
      cols.push(col);
      if (col === "extra_items") {
        vals.push(JSON.stringify(data[col] ?? []));
      } else {
        vals.push(data[col]);
      }
      placeholders.push(`$${idx++}`);
    }
  }

  return {
    text: `INSERT INTO ${TABLE} (${cols.join(", ")}) VALUES (${placeholders.join(
      ", "
    )}) RETURNING *`,
    values: vals,
  };
}

function buildUpdateFromBody(id, data) {
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const col of ALLOWED_COLUMNS) {
    if (data[col] !== undefined) {
      if (col === "extra_items") {
        sets.push(`${col} = $${idx++}`);
        vals.push(JSON.stringify(data[col] ?? []));
      } else {
        sets.push(`${col} = $${idx++}`);
        vals.push(data[col]);
      }
    }
  }

  if (!sets.length) {
    return null;
  }

  vals.push(id);
  return {
    text: `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE id = $${
      vals.length
    } RETURNING *`,
    values: vals,
  };
}

// ==========================
// 1) GET all (with filters)
// ==========================
router.get("/inward", async (req, res) => {
  try {
    const { date, month, q, limit = 100, offset = 0 } = req.query;

    let query = `SELECT * FROM ${TABLE}`;
    const cond = [];
    const vals = [];
    let idx = 1;

    if (date) {
      cond.push(`work_date = $${idx++}`);
      vals.push(date);
    } else if (month) {
      cond.push(`TRIM(TO_CHAR(work_date, 'Month')) ILIKE TRIM($${idx++})`);
      vals.push(month);
    }

    if (q) {
      cond.push(`(details ILIKE $${idx++} OR extra_details ILIKE $${idx++})`);
      vals.push(`%${q}%`, `%${q}%`);
    }

    if (cond.length) {
      query += " WHERE " + cond.join(" AND ");
    }

    query += " ORDER BY work_date DESC, seq_no DESC";
    query += ` LIMIT $${idx++} OFFSET $${idx++}`;
    vals.push(Number(limit), Number(offset));

    const result = await db.query(query, vals);
    res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /inward error:", err);
    res.status(500).json({ error: "Failed to fetch inward records" });
  }
});

// ==========================
// 2) CREATE / ADD
// ==========================
router.post("/inward", async (req, res) => {
  try {
    const data = prepareDataFromBody(req.body);
    const insertQuery = buildInsertFromBody(data);

    const result = await db.query(insertQuery.text, insertQuery.values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /inward error:", err);
    res.status(500).json({ error: "Failed to create inward record" });
  }
});

// ==========================
// 3) EXPORT PDF  (KEEP THIS BEFORE /:id !!)
// ==========================
router.get("/inward/export", async (req, res) => {
  try {
    const { date, month } = req.query;

    let query = `
      SELECT seq_no, work_date, details, quantity, quantity_type
      FROM ${TABLE}
    `;
    const vals = [];
    const cond = [];

    if (date) {
      cond.push(`work_date = $1`);
      vals.push(date);
    } else if (month) {
      cond.push(`TRIM(TO_CHAR(work_date, 'Month')) ILIKE TRIM($1)`);
      vals.push(month);
    }

    if (cond.length) query += ` WHERE ${cond.join(" AND ")}`;
    query += ` ORDER BY work_date ASC, seq_no ASC`;

    const result = await db.query(query, vals);
    const records = result.rows;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=inward_export_${moment().format(
        "YYYYMMDD_HHmm"
      )}.pdf`
    );

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    // Title
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("black")
      .text("Inward Material Report", { align: "center" });

    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("gray")
      .text(
        `Month: ${month || "All"} | Generated on: ${moment().format(
          "DD MMM YYYY, h:mm A"
        )}`,
        {
          align: "right",
        }
      );
    doc.moveDown(0.7);

    const tableWidth = 445;
    const startX = (doc.page.width - tableWidth) / 2;
    let cursorY = doc.y;
    const pageHeight = doc.page.height - doc.page.margins.bottom;

    const COLS = [
      { key: "seq", label: "#", width: 35 },
      { key: "date", label: "Date", width: 90 },
      { key: "details", label: "Details", width: 215 },
      { key: "qty", label: "Qty", width: 55 },
      { key: "type", label: "Type", width: 50 },
    ];

    function drawHeader() {
      let x = startX;
      const h = 22;

      if (cursorY + h > pageHeight) {
        doc.addPage();
        cursorY = doc.y;
      }

      doc.font("Helvetica-Bold").fontSize(10).fillColor("black");
      COLS.forEach((col) => {
        doc.rect(x, cursorY, col.width, h).stroke();
        doc.text(col.label, x + 3, cursorY + 6, {
          width: col.width - 6,
          align: "center",
        });
        x += col.width;
      });
      cursorY += h;
    }

    function drawRow(rowObj) {
      doc.font("Helvetica").fontSize(9).fillColor("black");

      const heights = COLS.map((col) => {
        const text = rowObj[col.key] || "";
        return doc.heightOfString(text, { width: col.width - 6 }) + 6;
      });

      const rowHeight = Math.max(20, ...heights);
      if (cursorY + rowHeight > pageHeight) {
        doc.addPage();
        cursorY = doc.y;
        drawHeader();
      }

      let x = startX;
      COLS.forEach((col) => {
        const text = rowObj[col.key] || "";
        doc.rect(x, cursorY, col.width, rowHeight).stroke();
        doc.text(text, x + 3, cursorY + 3, {
          width: col.width - 6,
          align: "center",
        });
        x += col.width;
      });
      cursorY += rowHeight;
    }

    drawHeader();

    if (!records.length) {
      drawRow({
        seq: "",
        date: "",
        details: "No inward records found.",
        qty: "",
        type: "",
      });
    } else {
      records.forEach((rec, i) => {
        drawRow({
          seq: String(i + 1),
          date: rec.work_date
            ? moment(rec.work_date).format("DD MMM YYYY")
            : "-",
          details: rec.details || "-",
          qty: rec.quantity ?? "-",
          type: rec.quantity_type ?? "-",
        });
      });
    }

    doc.moveDown(1.5);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("gray")
      .text("Authorized By:", { align: "right" });
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("black")
      .text("Ajay Kedar", { align: "right" });

    doc.end();
  } catch (err) {
    console.error("PDF export error:", err);
    res.status(500).json({ error: "Failed to export PDF" });
  }
});

// ==========================
// 4) GET by ID  (keep AFTER export)
// ==========================
router.get("/inward/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    // guard so /inward/export, /inward/abc don't break DB
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid inward id" });
    }

    const result = await db.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: "Inward record not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /inward/:id error:", err);
    res.status(500).json({ error: "Failed to fetch inward record" });
  }
});

// ==========================
// 5) UPDATE
// ==========================
router.put("/inward/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid inward id" });
    }

    const data = prepareDataFromBody(req.body);
    const updateQuery = buildUpdateFromBody(id, data);
    if (!updateQuery) {
      return res
        .status(400)
        .json({ error: "No valid columns supplied for update" });
    }

    const result = await db.query(updateQuery.text, updateQuery.values);
    if (!result.rows.length) {
      return res.status(404).json({ error: "Inward record not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /inward/:id error:", err);
    res.status(500).json({ error: "Failed to update inward record" });
  }
});

// ==========================
// 6) DELETE
// ==========================
router.delete("/inward/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid inward id" });
    }

    const result = await db.query(
      `DELETE FROM ${TABLE} WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Inward record not found" });
    }
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error("DELETE /inward/:id error:", err);
    res.status(500).json({ error: "Failed to delete inward record" });
  }
});

// ==========================
// Export router
// ==========================
module.exports = router;
