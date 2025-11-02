// routes/inward.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");
const moment = require("moment");

const TABLE = "inward";
const PK = "id";

// columns that actually exist in your inward table
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
    // very important: remove extras_all so we don't try to insert that column
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

// ==========================
// EXPORT PDF
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
          date: moment(rec.work_date).format("DD MMM YYYY"),
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
// REST APIs
// ==========================

// LIST
router.get("/inward", async (req, res) => {
  try {
    const { date, month } = req.query;
    const cond = [];
    const vals = [];
    let i = 1;

    if (date) {
      cond.push(`work_date = $${i++}`);
      vals.push(date);
    } else if (month) {
      const months = moment.months();
      const monthIndex = months.indexOf(month);
      if (monthIndex >= 0) {
        const year = new Date().getFullYear();
        const firstDay = moment([year, monthIndex, 1]).format("YYYY-MM-DD");
        const lastDay = moment(firstDay).endOf("month").format("YYYY-MM-DD");
        cond.push(`work_date BETWEEN $${i++} AND $${i++}`);
        vals.push(firstDay, lastDay);
      } else {
        cond.push(`TRIM(TO_CHAR(work_date, 'Month')) ILIKE TRIM($${i++})`);
        vals.push(month);
      }
    }

    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const sql = `
      SELECT ${PK}, seq_no, work_date, work_time, details, quantity, quantity_type,
             extra_details, extra_quantity, extra_quantity_type, extra_items
      FROM ${TABLE}
      ${where}
      ORDER BY work_date ASC, seq_no ASC, ${PK} ASC
    `;

    const result = await db.query(sql, vals);
    res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /inward", err);
    res.status(500).json({ error: "Failed to fetch inward records" });
  }
});

// GET BY ID
router.get("/inward/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const result = await db.query(
      `SELECT * FROM ${TABLE} WHERE ${PK}=$1`,
      [id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /inward/:id", err);
    res.status(500).json({ error: "Failed to fetch inward record" });
  }
});

// CREATE
router.post("/inward", async (req, res) => {
  try {
    const raw = req.body || {};

    // only check what is real
    if (!raw.details?.trim()) {
      return res.status(400).json({ error: "details is required" });
    }

    // convert extras_all -> extra_items, drop extras_all
    let data = prepareDataFromBody(raw);

    // keep only columns that exist in the table
    data = Object.fromEntries(
      Object.entries(data).filter(([key]) => ALLOWED_COLUMNS.has(key))
    );

    const cols = Object.keys(data);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const vals = cols.map((k) =>
      k === "extra_items" ? JSON.stringify(data[k]) : data[k]
    );

    const result = await db.query(
      `INSERT INTO ${TABLE} (${cols.join(",")}) VALUES (${placeholders.join(
        ","
      )}) RETURNING *`,
      vals
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /inward", err);
    res.status(500).json({ error: "Failed to create inward record" });
  }
});

// UPDATE
router.put("/inward/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    let data = prepareDataFromBody(req.body || {});
    // strip extras_all here also
    data = Object.fromEntries(
      Object.entries(data).filter(([key]) => ALLOWED_COLUMNS.has(key))
    );

    const keys = Object.keys(data);
    if (!keys.length)
      return res.status(400).json({ error: "No updatable fields provided" });

    const sets = keys.map((k, i) => `${k}=$${i + 1}`);
    const vals = keys.map((k) =>
      k === "extra_items" ? JSON.stringify(data[k]) : data[k]
    );
    vals.push(id);

    const result = await db.query(
      `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE ${PK}=$${
        sets.length + 1
      } RETURNING *`,
      vals
    );

    if (!result.rows.length)
      return res.status(404).json({ error: "Record not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /inward/:id", err);
    res.status(500).json({ error: "Failed to update inward record" });
  }
});

// DELETE
router.delete("/inward/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const result = await db.query(
      `DELETE FROM ${TABLE} WHERE ${PK}=$1 RETURNING *`,
      [id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Record not found" });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error("DELETE /inward/:id", err);
    res.status(500).json({ error: "Failed to delete inward record" });
  }
});

// RESEQUENCE (no category_id now)
router.post("/inward/resequence", async (req, res) => {
  try {
    const orderBy = String(req.body?.orderBy || "").toLowerCase();
    let orderExpr = `work_date ASC, ${PK} ASC`;

    if (orderBy === "id") {
      orderExpr = `${PK} ASC`;
    } else if (orderBy === "seq") {
      orderExpr = `seq_no ASC, ${PK} ASC`;
    }

    const sql = `
      WITH ordered AS (
        SELECT ${PK}, ROW_NUMBER() OVER (ORDER BY ${orderExpr}) AS rn
        FROM ${TABLE}
      )
      UPDATE ${TABLE} t
      SET seq_no = o.rn
      FROM ordered o
      WHERE t.${PK} = o.${PK}
      RETURNING t.${PK};
    `;

    const result = await db.query(sql);
    res.json({ ok: true, resequenced: result.rows.length });
  } catch (err) {
    console.error("POST /inward/resequence", err);
    res.status(500).json({ error: "Failed to resequence" });
  }
});

module.exports = router;
