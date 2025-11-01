// routes/workdetails.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");

/* =========================
   SMALL HELPERS
   ========================= */

// small helpers
function formatNiceDate(isoLike) {
  // input: "2025-10-01"
  if (!isoLike) return "";
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return isoLike;
  // 1 Oct 2025
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" }); // Oct
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function toTextArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  // in case it is stored as PG array text like {a,b}
  if (typeof val === "string") {
    try {
      // try JSON first
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // fallback: split by comma
      return val.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }
  return [];
}

/* =========================
   1. CATEGORY APIS
   ========================= */

// GET all categories
router.get("/dpr/categories", async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, category_name FROM workcategory ORDER BY category_name ASC"
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("Error fetching categories:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch categories" });
  }
});

// ADD a category
router.post("/dpr/categories", async (req, res) => {
  const { category_name } = req.body;
  if (!category_name || !category_name.trim()) {
    return res.status(400).json({ ok: false, error: "category_name is required" });
  }
  try {
    const { rows } = await db.query(
      "INSERT INTO workcategory (category_name) VALUES ($1) RETURNING id, category_name",
      [category_name.trim()]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error("Error adding category:", err);
    res.status(500).json({ ok: false, error: "Failed to add category" });
  }
});

/* =========================
   2. DPR CRUD
   ========================= */

/**
 * GET /api/dpr
 * optional:
 *   ?category_id=1
 *   ?from=2025-10-01
 *   ?to=2025-10-31
 */
router.get("/dpr", async (req, res) => {
  const { category_id, from, to } = req.query;

  let where = [];
  let params = [];
  let idx = 1;

  if (category_id) {
    where.push(`d.category_id = $${idx++}`);
    params.push(category_id);
  }
  if (from) {
    where.push(`d.work_date >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    where.push(`d.work_date <= $${idx++}`);
    params.push(to);
  }

  let sql = `
    SELECT d.id, d.seq_no, d.category_id,
           TO_CHAR(d.work_date, 'YYYY-MM-DD') AS work_date,
           d.details, d.work_time, d.extra_details, d.extra_times,
           d.month_name,
           c.category_name
    FROM dpr d
    LEFT JOIN workcategory c ON d.category_id = c.id
  `;

  if (where.length) sql += " WHERE " + where.join(" AND ");

  sql += " ORDER BY d.work_date DESC, d.seq_no ASC";

  try {
    const { rows } = await db.query(sql, params);
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("Error fetching DPR entries:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch DPR entries" });
  }
});

/**
 * GET /api/dpr/month/October
 * (month_name is filled by trigger)
 */
router.get("/dpr/month/:month", async (req, res) => {
  const { month } = req.params;
  try {
    const { rows } = await db.query(
      `
      SELECT d.id, d.seq_no, d.category_id,
             TO_CHAR(d.work_date, 'YYYY-MM-DD') AS work_date,
             d.details, d.work_time, d.extra_details, d.extra_times,
             d.month_name,
             c.category_name
      FROM dpr d
      LEFT JOIN workcategory c ON d.category_id = c.id
      WHERE d.month_name = $1
      ORDER BY d.work_date ASC, d.seq_no ASC
      `,
      [month]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("Error fetching DPR by month:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch month DPR" });
  }
});

/**
 * POST /api/dpr
 * body: { category_id, work_date, details, work_time, extra_entries: [{detail,time}, ...] }
 */
router.post("/dpr", async (req, res) => {
  try {
    let { category_id, work_date, details, work_time, extra_entries } = req.body;

    if (!work_date) return res.status(400).json({ ok: false, error: "work_date is required" });
    if (!details?.trim()) return res.status(400).json({ ok: false, error: "details is required" });
    if (!work_time?.trim()) return res.status(400).json({ ok: false, error: "work_time is required" });

    const dateObj = new Date(work_date);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({ ok: false, error: "Invalid work_date format" });
    }

    // build arrays from extra_entries
    let extraDetails = [];
    let extraTimes = [];
    if (Array.isArray(extra_entries)) {
      extra_entries.forEach((e) => {
        if (e?.detail?.trim() || e?.time?.trim()) {
          extraDetails.push(e.detail?.trim() || "");
          extraTimes.push(e.time?.trim() || "");
        }
      });
    }

    const { rows } = await db.query(
      `
      INSERT INTO dpr
        (category_id, work_date, details, work_time, extra_details, extra_times)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        category_id || null,
        dateObj,
        details.trim(),
        work_time.trim(),
        extraDetails,
        extraTimes,
      ]
    );

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error("Error adding DPR:", err);
    res.status(500).json({ ok: false, error: "Failed to add DPR entry" });
  }
});

/**
 * PUT /api/dpr/:id
 */
router.put("/dpr/:id", async (req, res) => {
  const { id } = req.params;
  let { category_id, work_date, details, work_time, extra_details, extra_times } = req.body;

  if (!details?.trim() || !work_time?.trim()) {
    return res.status(400).json({ ok: false, error: "details and work_time are required" });
  }

  try {
    // get existing
    const existing = await db.query("SELECT * FROM dpr WHERE id = $1", [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ ok: false, error: "DPR entry not found" });
    }

    // date
    let finalDate;
    if (work_date) {
      const dt = new Date(work_date);
      if (isNaN(dt.getTime())) {
        return res.status(400).json({ ok: false, error: "Invalid work_date format" });
      }
      finalDate = dt;
    } else {
      finalDate = existing.rows[0].work_date;
    }

    const { rows } = await db.query(
      `
      UPDATE dpr
      SET category_id = $1,
          work_date   = $2,
          details     = $3,
          work_time   = $4,
          extra_details = $5,
          extra_times   = $6
      WHERE id = $7
      RETURNING *
      `,
      [
        category_id || existing.rows[0].category_id,
        finalDate,
        details.trim(),
        work_time.trim(),
        Array.isArray(extra_details) ? extra_details : existing.rows[0].extra_details,
        Array.isArray(extra_times) ? extra_times : existing.rows[0].extra_times,
        id,
      ]
    );

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error("Error updating DPR:", err);
    res.status(500).json({ ok: false, error: "Failed to update DPR entry" });
  }
});

/**
 * DELETE /api/dpr/:id
 */
router.delete("/dpr/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM dpr WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting DPR:", err);
    res.status(500).json({ ok: false, error: "Failed to delete DPR entry" });
  }
});

/**
 * (optional) DELETE whole day
 * DELETE /api/dpr/delete/2025-10-03
 */
router.delete("/dpr/delete/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const dt = new Date(date);
    if (isNaN(dt.getTime())) {
      return res.status(400).json({ ok: false, error: "Invalid date" });
    }
    // use ISO date only (no time)
    const onlyDate = dt.toISOString().slice(0, 10);
    await db.query("DELETE FROM dpr WHERE work_date = $1", [onlyDate]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting DPR by date:", err);
    res.status(500).json({ ok: false, error: "Failed to delete DPR for this date" });
  }
});

/* =========================
   3. PROFESSIONAL PDF EXPORT
   ========================= */
/**
 * GET /api/dpr/export/October
 * -> returns a clean, black-text, table-style PDF
 */
router.get("/dpr/export/:month", async (req, res) => {
  const { month } = req.params; // e.g. "October"

  try {
    // 1) fetch rows for that month
    const { rows } = await db.query(
      `
      SELECT d.id,
             d.seq_no,
             d.details,
             d.work_time,
             d.extra_details,
             d.extra_times,
             TO_CHAR(d.work_date, 'YYYY-MM-DD') AS work_date,
             d.month_name,
             c.category_name
      FROM dpr d
      LEFT JOIN workcategory c ON d.category_id = c.id
      WHERE d.month_name = $1
      ORDER BY d.work_date ASC, d.seq_no ASC, d.id ASC
      `,
      [month]
    );

    // 2) setup PDF
    const doc = new PDFDocument({
      margin: 35,
      size: "A4",
    });

    const filename = encodeURIComponent(`DPR_${month}.pdf`);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/pdf");

    doc.pipe(res);

    // 3) main heading
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("black")
      .text("Daily Progress Report (DPR)", { align: "left" });

    doc.moveDown(0.35);
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("black")
      .text(`Month: ${month}`, { align: "left" });

    doc.moveDown(0.8);

    // 4) table config
    const startX = 35;
    let cursorY = doc.y;
    const pageHeight = doc.page.height - doc.page.margins.bottom;

    // columns (total ≈ 35 + 28 + 80 + 95 + 215 + 90 = fits A4)
    const COLS = [
      { key: "seq", label: "#", width: 28 },
      { key: "date", label: "Date", width: 80 },
      { key: "cat", label: "Category", width: 95 },
      { key: "details", label: "Details", width: 215 },
      { key: "time", label: "Time", width: 90 },
    ];

    // draw table header
    function drawHeader() {
      let x = startX;
      const h = 22;

      if (cursorY + h > pageHeight) {
        doc.addPage();
        cursorY = doc.y;
      }

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor("black");

      COLS.forEach((col) => {
        doc.rect(x, cursorY, col.width, h).stroke();
        doc.text(col.label, x + 3, cursorY + 6, {
          width: col.width - 6,
          align: col.key === "seq" ? "center" : "left",
        });
        x += col.width;
      });

      cursorY += h;
    }

    // draw single row with auto height
    function drawRow(rowObj) {
      doc.font("Helvetica").fontSize(9).fillColor("black");

      // compute height based on each column text
      const heights = COLS.map((col) => {
        const text = rowObj[col.key] || "";
        return (
          doc.heightOfString(text, {
            width: col.width - 6,
          }) + 6
        );
      });

      const rowHeight = Math.max(20, ...heights);

      // check page break
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
          align: col.key === "seq" ? "center" : "left",
        });
        x += col.width;
      });

      cursorY += rowHeight;
    }

    // 5) print table
    drawHeader();

    if (!rows.length) {
      // no data row
      drawRow({
        seq: "",
        date: "",
        cat: "",
        details: "No DPR entries found for this month.",
        time: "",
      });
    } else {
      let seq = 1;
      rows.forEach((item) => {
        // main row
        drawRow({
          seq: String(seq),
          date: formatNiceDate(item.work_date),
          cat: item.category_name || "-",
          details: item.details || "-",
          time: item.work_time || "-",
        });
        seq++;

        // extra rows (bullets)
        const extrasD = toTextArray(item.extra_details);
        const extrasT = toTextArray(item.extra_times);
        if (extrasD.length) {
          extrasD.forEach((ex, idx) => {
            drawRow({
              seq: "",
              date: "",
              cat: "",
              details: `• ${ex}`,
              time: extrasT[idx] || "",
            });
          });
        }
      });
    }

    // 6) footer (only once, at the very end)
    // if we're too close to bottom, move to new page
    if (cursorY + 40 > pageHeight) {
      doc.addPage();
      cursorY = doc.y;
    }

    doc.moveDown(1);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("gray")
      .text("Ajay Kedar — DPR Export", {
        align: "right",
      });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("gray")
      .text(`Generated on: ${new Date().toLocaleString()}`, {
        align: "right",
      });

    // 7) end
    doc.end();
  } catch (err) {
    console.error("Error exporting DPR:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to export DPR PDF" });
  }
});

module.exports = router;
