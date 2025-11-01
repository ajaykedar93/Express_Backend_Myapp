// routes/sitekharch_new.js
const express = require("express");
const PDFDocument = require("pdfkit");
const db = require("../db");
const router = express.Router();

/* =========================================================
   COMMON HELPERS / RESPONSES
   ========================================================= */
function makeSuccess(data = null, msg = "OK", extra = {}) {
  return { ok: true, message: msg, data, ...extra };
}
function makeError(msg = "Something went wrong", code = 500, extra = {}) {
  return { ok: false, error: msg, code, ...extra };
}

/**
 * Strict safe integer for :id (for bigint / serial PKs)
 * If it's not a proper integer -> return null -> we 400
 */
function toIntId(v) {
  if (v === undefined || v === null) return null;
  // e.g. "/kharch/NaN" -> v = "NaN"
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

/**
 * For numeric columns in DB.
 * Returns: number OR null
 * Never returns NaN, never returns "NaN" string
 */
function toNumOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Ensure value is JSON array (for extra_items)
 */
function toJsonArrayOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
      return JSON.stringify([]);
    } catch (err) {
      return JSON.stringify([]);
    }
  }
  return JSON.stringify([]);
}

/* =========================
   DATE / MONTH HELPERS
========================= */

// validate "YYYY-MM"
function isValidMonthStr(ym) {
  if (!ym || typeof ym !== "string") return false;
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return year > 1970 && month >= 1 && month <= 12;
}

// parse yyyy-mm to month start & end
function getMonthRange(ym) {
  const [year, month] = ym.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1); // exclusive
  return { start, end };
}

/* =========================
   NORMALISERS
========================= */

// calculate total of one site_kharch row (amount + extra_amount + json extras)
function calcRowTotal(row) {
  let total = 0;
  total += Number(row.amount || 0);
  total += Number(row.extra_amount || 0);

  // ensure array
  let extras = row.extra_items;
  if (typeof extras === "string") {
    try {
      extras = JSON.parse(extras);
    } catch (_) {
      extras = [];
    }
  }
  if (Array.isArray(extras)) {
    for (const x of extras) {
      total += Number(x.amount || 0);
    }
  }
  return total;
}

// normalize row from PG (extra_items always array)
function normalizeKharchRow(row) {
  if (typeof row.extra_items === "string") {
    try {
      row.extra_items = JSON.parse(row.extra_items);
    } catch (_) {
      row.extra_items = [];
    }
  }
  if (!Array.isArray(row.extra_items)) {
    row.extra_items = [];
  }
  return row;
}

/**
 * Global DB-error guard. We know user was getting:
 *   invalid input syntax for type bigint: "NaN"
 * So let’s convert it to a 400 with proper message.
 */
function handleDbError(err, res, fallbackMsg = "DB error") {
  console.error("DB ERROR:", err);
  const msg = String(err.message || "");
  if (msg.includes("invalid input syntax for type bigint")
      || msg.includes("NaN")) {
    return res
      .status(400)
      .json(makeError("Invalid number (NaN) received. Check frontend payload.", 400));
  }
  return res.status(500).json(makeError(fallbackMsg));
}

/* =========================================================
   1. SITE_KHARCH CRUD
   ========================================================= */

/**
 * POST /api/sitekharch/kharch
 * body: { kharch_date?, amount, details?, extra_amount?, extra_details?, extra_items? }
 */
router.post("/kharch", async (req, res) => {
  try {
    const {
      kharch_date, // optional
      amount,
      details,
      extra_amount,
      extra_details,
      extra_items, // array or JSON string
    } = req.body;

    const amt = toNumOrNull(amount);
    if (amt === null) {
      return res
        .status(400)
        .json(makeError("amount is required and must be number", 400));
    }

    const extraAmt = toNumOrNull(extra_amount);
    const extraItemsJson = extra_items
      ? toJsonArrayOrNull(extra_items)
      : JSON.stringify([]);

    const q = `
      INSERT INTO site_kharch
        (kharch_date, amount, details, extra_amount, extra_details, extra_items)
      VALUES
        ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '[]'::jsonb))
      RETURNING *;
    `;

    const vals = [
      kharch_date || null,
      amt,
      details || null,
      extraAmt,
      extra_details || null,
      extraItemsJson,
    ];

    const { rows } = await db.query(q, vals);
    const out = normalizeKharchRow(rows[0]);
    return res.status(201).json(makeSuccess(out, "Site kharch added"));
  } catch (err) {
    return handleDbError(err, res, "Failed to add site kharch");
  }
});

/**
 * GET /api/sitekharch/kharch
 * GET /api/sitekharch/kharch?month=YYYY-MM
 */
router.get("/kharch", async (req, res) => {
  try {
    const { month } = req.query;
    let rows;
    if (month) {
      if (!isValidMonthStr(month)) {
        return res
          .status(400)
          .json(makeError("Invalid month format. Use YYYY-MM", 400));
      }

      const { start, end } = getMonthRange(month);
      const { rows: r } = await db.query(
        `
        SELECT *
        FROM site_kharch
        WHERE kharch_date >= $1 AND kharch_date < $2
        ORDER BY kharch_date, seq_no;
      `,
        [start, end]
      );
      rows = r;
    } else {
      const { rows: r } = await db.query(
        `SELECT * FROM site_kharch ORDER BY kharch_date DESC, seq_no;`
      );
      rows = r;
    }

    rows = rows.map(normalizeKharchRow);

    if (!rows.length) {
      return res.json(
        makeSuccess([], "No site kharch found for selected month", {
          noData: true,
        })
      );
    }

    return res.json(makeSuccess(rows, "Site kharch list"));
  } catch (err) {
    return handleDbError(err, res, "Failed to load site kharch records");
  }
});

/**
 * PUT /api/sitekharch/kharch/:id
 */
router.put("/kharch/:id", async (req, res) => {
  const id = toIntId(req.params.id);
  if (id === null) {
    return res
      .status(400)
      .json(makeError("Invalid id (must be integer)", 400));
  }

  try {
    const {
      kharch_date,
      amount,
      details,
      extra_amount,
      extra_details,
      extra_items,
    } = req.body;

    const amt = toNumOrNull(amount);
    const extraAmt = toNumOrNull(extra_amount);
    const extraItemsJson =
      extra_items !== undefined && extra_items !== null
        ? toJsonArrayOrNull(extra_items)
        : null;

    const q = `
      UPDATE site_kharch
      SET
        kharch_date   = COALESCE($1, kharch_date),
        amount        = COALESCE($2, amount),
        details       = COALESCE($3, details),
        extra_amount  = COALESCE($4, extra_amount),
        extra_details = COALESCE($5, extra_details),
        extra_items   = COALESCE($6::jsonb, extra_items)
      WHERE id = $7
      RETURNING *;
    `;

    const vals = [
      kharch_date || null,
      amt,
      details !== undefined ? details : null,
      extraAmt,
      extra_details !== undefined ? extra_details : null,
      extraItemsJson,
      id,
    ];

    const { rows } = await db.query(q, vals);
    if (!rows.length) {
      return res.status(404).json(makeError("Not found", 404));
    }

    return res.json(
      makeSuccess(normalizeKharchRow(rows[0]), "Site kharch updated")
    );
  } catch (err) {
    return handleDbError(err, res, "Failed to update site kharch");
  }
});

/**
 * DELETE /api/sitekharch/kharch/:id
 */
router.delete("/kharch/:id", async (req, res) => {
  const id = toIntId(req.params.id);
  if (id === null) {
    return res
      .status(400)
      .json(makeError("Invalid id (must be integer)", 400));
  }

  try {
    const { rowCount } = await db.query(
      `DELETE FROM site_kharch WHERE id = $1`,
      [id]
    );

    if (!rowCount) {
      return res.status(404).json(makeError("Not found", 404));
    }

    return res.json(makeSuccess(null, "Deleted"));
  } catch (err) {
    return handleDbError(err, res, "Failed to delete entry");
  }
});

/* =========================================================
   2. RECEIVED AMOUNT CRUD
   ========================================================= */

/**
 * POST /api/sitekharch/received
 */
router.post("/received", async (req, res) => {
  try {
    const { payment_date, amount_received, details, payment_mode } = req.body;

    const amtRec = toNumOrNull(amount_received);
    if (amtRec === null) {
      return res
        .status(400)
        .json(makeError("amount_received is required and must be number", 400));
    }

    const q = `
      INSERT INTO user_sitekharch_amount
        (payment_date, amount_received, details, payment_mode)
      VALUES
        ($1, $2, $3, $4)
      RETURNING *;
    `;

    const vals = [
      payment_date || null,
      amtRec,
      details || null,
      payment_mode || "cash",
    ];

    const { rows } = await db.query(q, vals);
    return res
      .status(201)
      .json(makeSuccess(rows[0], "Received amount added"));
  } catch (err) {
    return handleDbError(err, res, "Failed to add received amount");
  }
});

/**
 * GET /api/sitekharch/received
 * GET /api/sitekharch/received?month=YYYY-MM
 */
router.get("/received", async (req, res) => {
  try {
    const { month } = req.query;
    let rows;
    if (month) {
      if (!isValidMonthStr(month)) {
        return res
          .status(400)
          .json(makeError("Invalid month format. Use YYYY-MM", 400));
      }
      const { start, end } = getMonthRange(month);
      const { rows: r } = await db.query(
        `
        SELECT *
        FROM user_sitekharch_amount
        WHERE payment_date >= $1 AND payment_date < $2
        ORDER BY payment_date;
      `,
        [start, end]
      );
      rows = r;
    } else {
      const { rows: r } = await db.query(
        `SELECT * FROM user_sitekharch_amount ORDER BY payment_date DESC;`
      );
      rows = r;
    }

    if (!rows.length) {
      return res.json(
        makeSuccess([], "No received entries for selected month", {
          noData: true,
        })
      );
    }

    return res.json(makeSuccess(rows, "Received list"));
  } catch (err) {
    return handleDbError(err, res, "Failed to load received list");
  }
});

/**
 * PUT /api/sitekharch/received/:id
 */
router.put("/received/:id", async (req, res) => {
  const id = toIntId(req.params.id);
  if (id === null) {
    return res
      .status(400)
      .json(makeError("Invalid id (must be integer)", 400));
  }

  try {
    const { payment_date, amount_received, details, payment_mode } = req.body;
    const amtRec = toNumOrNull(amount_received);

    const q = `
      UPDATE user_sitekharch_amount
      SET
        payment_date    = COALESCE($1, payment_date),
        amount_received = COALESCE($2, amount_received),
        details         = COALESCE($3, details),
        payment_mode    = COALESCE($4, payment_mode)
      WHERE id = $5
      RETURNING *;
    `;

    const vals = [
      payment_date || null,
      amtRec,
      details !== undefined ? details : null,
      payment_mode !== undefined ? payment_mode : null,
      id,
    ];

    const { rows } = await db.query(q, vals);
    if (!rows.length) {
      return res.status(404).json(makeError("Not found", 404));
    }

    return res.json(makeSuccess(rows[0], "Received entry updated"));
  } catch (err) {
    return handleDbError(err, res, "Failed to update received entry");
  }
});

/**
 * DELETE /api/sitekharch/received/:id
 */
router.delete("/received/:id", async (req, res) => {
  const id = toIntId(req.params.id);
  if (id === null) {
    return res
      .status(400)
      .json(makeError("Invalid id (must be integer)", 400));
  }

  try {
    const { rowCount } = await db.query(
      `DELETE FROM user_sitekharch_amount WHERE id = $1`,
      [id]
    );
    if (!rowCount) {
      return res.status(404).json(makeError("Not found", 404));
    }

    return res.json(makeSuccess(null, "Received entry deleted"));
  } catch (err) {
    return handleDbError(err, res, "Failed to delete received entry");
  }
});

/* =========================================================
   3. AUTO CALCULATE (month)
   ========================================================= */

/**
 * GET /api/sitekharch/summary?month=YYYY-MM
 */
router.get("/summary", async (req, res) => {
  try {
    const { month } = req.query;
    if (!month)
      return res.status(400).json(makeError("month is required", 400));

    if (!isValidMonthStr(month)) {
      return res
        .status(400)
        .json(makeError("Invalid month format. Use YYYY-MM", 400));
    }

    const { start, end } = getMonthRange(month);

    const { rows: kharchRowsRaw } = await db.query(
      `
      SELECT *
      FROM site_kharch
      WHERE kharch_date >= $1 AND kharch_date < $2
      ORDER BY kharch_date, seq_no;
      `,
      [start, end]
    );
    const kharchRows = kharchRowsRaw.map(normalizeKharchRow);

    const { rows: recvRows } = await db.query(
      `
      SELECT *
      FROM user_sitekharch_amount
      WHERE payment_date >= $1 AND payment_date < $2
      ORDER BY payment_date;
      `,
      [start, end]
    );

    let totalKharch = 0;
    const kharchList = kharchRows.map((r) => {
      const rowTotal = calcRowTotal(r);
      totalKharch += rowTotal;
      return { ...r, row_total: rowTotal };
    });

    const totalReceived = recvRows.reduce(
      (sum, r) => sum + Number(r.amount_received || 0),
      0
    );

    if (!kharchRows.length && !recvRows.length) {
      return res.json(
        makeSuccess(
          {
            month,
            totalKharch: 0,
            totalReceived: 0,
            balance: 0,
            kharch: [],
            received: [],
          },
          "No data for selected month",
          { noData: true }
        )
      );
    }

    return res.json(
      makeSuccess(
        {
          month,
          totalKharch,
          totalReceived,
          balance: totalReceived - totalKharch,
          kharch: kharchList,
          received: recvRows,
        },
        "Monthly summary"
      )
    );
  } catch (err) {
    return handleDbError(err, res, "Failed to get summary");
  }
});

/* =========================================================
   4. DOWNLOAD PDF  (black, table-like)
   ========================================================= */
// DOWNLOAD MONTHLY REPORT (PDF, table style, black only)
// DOWNLOAD MONTHLY PDF (professional, black-only, received first, then kharch)
router.get("/download", async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) {
      return res.status(400).json(makeError("month is required", 400));
    }
    if (!isValidMonthStr(month)) {
      return res
        .status(400)
        .json(makeError("Invalid month format. Use YYYY-MM", 400));
    }

    // helper: 2025-10 -> "October 2025"
    const monthToLabel = (ym) => {
      const [y, m] = ym.split("-").map(Number);
      const d = new Date(y, m - 1, 1);
      return d.toLocaleString("en-IN", {
        month: "long",
        year: "numeric",
      });
    };

    const { start, end } = getMonthRange(month);

    // 1) KHARCH
    const { rows: kharchRowsRaw } = await db.query(
      `
      SELECT *
      FROM site_kharch
      WHERE kharch_date >= $1 AND kharch_date < $2
      ORDER BY kharch_date, seq_no;
      `,
      [start, end]
    );
    const kharchRows = kharchRowsRaw.map(normalizeKharchRow);

    // 2) RECEIVED
    const { rows: recvRows } = await db.query(
      `
      SELECT *
      FROM user_sitekharch_amount
      WHERE payment_date >= $1 AND payment_date < $2
      ORDER BY payment_date;
      `,
      [start, end]
    );

    // 3) TOTALS
    let totalKharch = 0;
    for (const r of kharchRows) {
      totalKharch += calcRowTotal(r);
    }
    const totalReceived = recvRows.reduce(
      (sum, r) => sum + Number(r.amount_received || 0),
      0
    );
    const balance = totalReceived - totalKharch;

    // 4) PDF start
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=sitekharch-${month}.pdf`
    );

    const doc = new PDFDocument({
      margin: 40,
      size: "A4",
    });
    doc.pipe(res);

    // common helpers
    const pageWidth = doc.page.width;
    const left = doc.page.margins.left;
    const right = pageWidth - doc.page.margins.right;

    // draw row with auto-height and borders
    const drawRow = (cells, widths, opts = {}) => {
      const {
        header = false,
        y = doc.y,
        fontSize = 10,
        padding = 4,
      } = opts;

      // measure height
      let maxH = 0;
      cells.forEach((cell, i) => {
        const w = widths[i] - padding * 2;
        const txt = cell == null ? "" : String(cell);
        const h = doc.heightOfString(txt, {
          width: w,
          align: "left",
        });
        if (h > maxH) maxH = h;
      });
      const rowH = Math.max(maxH + padding * 2, 20);

      // check page space
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (y + rowH > bottom) {
        doc.addPage();
        return drawRow(cells, widths, { header, y: doc.y, fontSize, padding });
      }

      // draw
      let x = left;
      cells.forEach((cell, i) => {
        const w = widths[i];
        doc
          .rect(x, y, w, rowH)
          .strokeColor("black")
          .stroke();
        doc
          .font(header ? "Helvetica-Bold" : "Helvetica")
          .fontSize(fontSize)
          .fillColor("black")
          .text(cell == null ? "" : String(cell), x + padding, y + padding, {
            width: w - padding * 2,
            align: "left",
          });
        x += w;
      });

      doc.y = y + rowH;
      return rowH;
    };

    const money = (n) => {
      const num = Number(n || 0);
      return num.toFixed(2);
    };

    /* ----------------------------------------------------
       TITLE
    ---------------------------------------------------- */
    doc.font("Helvetica-Bold").fontSize(18).fillColor("black");
    doc.text("Site Kharch Report", left, doc.y, { align: "left" });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(11);
    doc.text(`Month: ${monthToLabel(month)}`);
    doc.moveDown(1);

    /* ----------------------------------------------------
       SUMMARY (ONE ROW TABLE)
    ---------------------------------------------------- */
    const summaryWidths = [140, 120, 120, 120];
    drawRow(
      ["Month", "Total Kharch (Rs.)", "Total Received (Rs.)", "Balance (Rs.)"],
      summaryWidths,
      { header: true }
    );
    drawRow(
      [
        monthToLabel(month),
        money(totalKharch),
        money(totalReceived),
        money(balance),
      ],
      summaryWidths
    );
    doc.moveDown(1.5);

    /* ----------------------------------------------------
       RECEIVED FIRST
    ---------------------------------------------------- */
    doc.font("Helvetica-Bold").fontSize(13).text("Received Amounts", {
      align: "left",
    });
    doc.moveDown(0.5);

    if (!recvRows.length) {
      doc.font("Helvetica").fontSize(10).text("No received entries.");
      doc.moveDown(1.2);
    } else {
      const recWidths = [30, 70, 195, 80, 65]; // total ~440-450
      drawRow(["#", "Date", "Details", "Mode", "Amount (Rs.)"], recWidths, {
        header: true,
      });

      recvRows.forEach((r, idx) => {
        const det = r.details ? r.details : "—";
        drawRow(
          [
            idx + 1,
            r.payment_date || "",
            det,
            r.payment_mode || "cash",
            money(r.amount_received),
          ],
          recWidths
        );
      });

      doc.moveDown(1.5);
    }

    /* ----------------------------------------------------
       KHARCH BELOW
    ---------------------------------------------------- */
    doc.font("Helvetica-Bold").fontSize(13).text("Kharch Details", {
      align: "left",
    });
    doc.moveDown(0.5);

    if (!kharchRows.length) {
      doc.font("Helvetica").fontSize(10).text("No kharch entries.");
    } else {
      const kWidths = [25, 65, 210, 65, 65, 65]; // total ~495
      drawRow(["#", "Date", "Details", "Amount", "Extra", "Total"], kWidths, {
        header: true,
      });

      kharchRows.forEach((r, idx) => {
        const total = calcRowTotal(r);
        const details =
          r.details && r.details.trim().length
            ? r.details
            : "—";

        // main row
        drawRow(
          [
            idx + 1,
            r.kharch_date || "",
            details,
            money(r.amount),
            r.extra_amount ? money(r.extra_amount) : "",
            money(total),
          ],
          kWidths
        );

        // extra_items as subrows (only if present)
        if (Array.isArray(r.extra_items) && r.extra_items.length) {
          r.extra_items.forEach((x) => {
            const txt = `• Rs.${money(x.amount)} ${
              x.details ? `(${x.details})` : ""
            }`;
            drawRow(["", "", txt, "", "", ""], kWidths);
          });
        }
      });
    }

    // optional footer
    // doc.moveDown(1);
    // doc.fontSize(8).text("Generated by Site Kharch System", left, doc.y);

    doc.end();
  } catch (err) {
    console.error("GET /download error:", err);
    return res.status(500).json(makeError("Failed to download PDF"));
  }
});



module.exports = router;
