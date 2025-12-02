// routes/transaction-category.js
const express = require("express");
const router = express.Router();
const db = require("../db"); // PostgreSQL client
const PDFDocument = require("pdfkit");
require("dotenv").config();
const { body, validationResult } = require("express-validator");

// Mailer (Mailjet HTTPS API): sendOTP / sendEmail
const { sendEmail } = require("../utils/mailer"); // Mailjet version

/* ---------------- Helpers ---------------- */
const formatDate = (dateStr) => {
  const [year, month, day] = String(dateStr).split("-");
  const monthName = new Date(`${year}-${month}-01`).toLocaleString("en-GB", {
    month: "long",
  });
  return `${parseInt(day, 10)} ${monthName} ${year}`;
};

// small helper to avoid timezone issues: build YYYY-MM-DD manually
function ymd(year, month1Based, day) {
  const y = String(year);
  const m = String(month1Based).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const getCurrentMonthRange = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month1 = now.getMonth() + 1; // 1..12

  // last day of this month
  const lastDay = new Date(year, month1, 0).getDate();

  const startISO = ymd(year, month1, 1);
  const endISO = ymd(year, month1, lastDay);

  const monthName = new Date(year, month1 - 1, 1).toLocaleString("en-GB", {
    month: "long",
  });
  const yyyy = year;

  return {
    startISO,
    endISO,
    monthName,
    year: yyyy,
    label: `${monthName} ${yyyy}`,
  };
};

// month param range helper: "YYYY-MM" -> avoid timezone fully
const getMonthRangeFromParam = (monthStr) => {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
    return getCurrentMonthRange();
  }
  const [yearStr, monthStr2] = monthStr.split("-");
  const year = Number(yearStr);
  const month1 = Number(monthStr2); // 1..12
  if (!Number.isFinite(year) || !Number.isFinite(month1) || month1 < 1 || month1 > 12) {
    return getCurrentMonthRange();
  }

  const lastDay = new Date(year, month1, 0).getDate(); // last day of that month

  const startISO = ymd(year, month1, 1);
  const endISO = ymd(year, month1, lastDay);

  const monthName = new Date(year, month1 - 1, 1).toLocaleString("en-GB", {
    month: "long",
  });
  const yyyy = year;
  return {
    startISO,
    endISO,
    monthName,
    year: yyyy,
    label: `${monthName} ${yyyy}`,
  };
};

const INR = (num) =>
  Number(num || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function drawDivider(doc, y, color = "#e6e9ef") {
  doc
    .save()
    .lineWidth(1)
    .strokeColor(color)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke()
    .restore();
}

function pageFooter(doc, brandHex = "#5f4bb6") {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footerY = doc.page.height - doc.page.margins.bottom + 10;
    const genAt = new Date().toLocaleString();
    doc
      .fontSize(9)
      .fillColor("#667085")
      .text(`Generated: ${genAt}`, doc.page.margins.left, footerY, {
        align: "left",
      });
    doc
      .fontSize(9)
      .fillColor(brandHex)
      .text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, footerY, {
        align: "right",
      });
  }
}

/* Single-line clamp with ellipsis */
function fitText(doc, text, width, fontName = "Helvetica", fontSize = 10) {
  if (!text) return "";
  doc.font(fontName).fontSize(fontSize);
  const ellipsis = "…";
  if (doc.widthOfString(text) <= width) return text;
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const s = text.slice(0, mid) + ellipsis;
    if (doc.widthOfString(s) <= width) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

/* N-line clamp by height */
function clampLines(
  doc,
  text,
  width,
  fontName,
  fontSize,
  lineHeight,
  maxLines
) {
  if (!text) return "";
  doc.font(fontName).fontSize(fontSize);
  const maxH = maxLines * lineHeight;
  if (doc.heightOfString(text, { width }) <= maxH) return text;
  const ellipsis = "…";
  let lo = 0,
    hi = text.length,
    best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const s = text.slice(0, mid) + ellipsis;
    const h = doc.heightOfString(s, { width });
    if (h <= maxH) {
      best = s;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best || ellipsis;
}

/**
 * Build a professional PDF for a month (current by default).
 * Perfect-fit columns, Qty included, daily & monthly totals.
 */
function buildCurrentMonthPDF({
  titleLine,
  selectedCategoryName,
  selectedSubcategoryName,
  grouped,
  monthTotals,
  streamTo = null,
  collectBuffer = false,
}) {
  // Palette
  const BRAND_LEFT = "#5f4bb6";
  const BRAND_RIGHT = "#1f5f78";
  const SURFACE = "#ffffff";
  const INK_900 = "#0f172a";
  const INK_700 = "#334155";
  const INK_600 = "#475569";
  const BORDER = "#e6e9ef";
  const GREEN = "#0f8a5f";
  const RED = "#b33a3a";
  const DATE_BAND = "#f3f5fb";
  const ZEBRA = "#fafcff";
  const PURPLE = BRAND_LEFT;

  // Typography / layout
  const ROW_FONT = 9;
  const ROW_LINE_H = 12;
  const ROW_BASE_H = 14;
  const ROW_MAX_LINES = 2;
  const HEADER_H = 18;

  // Spacing
  const GUTTER = 6;
  const CELL_PAD_X = 2;
  const CELL_PAD_Y = 0;

  // Page setup
  const doc = new PDFDocument({
    margin: 28,
    size: "A4",
    bufferPages: true,
    autoFirstPage: true,
  });
  if (streamTo) doc.pipe(streamTo);

  const render = () => {
    const headerY = 20;
    const gradH = 22;
    const usableW =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Fixed column widths
    const fixed = {
      seq: 40, // Seq No
      cat: 96, // Category
      sub: 108, // Subcategory
      qty: 44, // Qty
      amt: 74, // Amount
      typ: 42, // Type
    };

    const COLS_COUNT = 7;
    const totalFixed =
      fixed.seq + fixed.cat + fixed.sub + fixed.qty + fixed.amt + fixed.typ;
    const totalGutters = GUTTER * (COLS_COUNT - 1);
    let purposeWidth = usableW - totalFixed - totalGutters;

    const PURPOSE_MIN = 120;
    const PURPOSE_MAX = 260;
    if (purposeWidth < PURPOSE_MIN) purposeWidth = PURPOSE_MIN;
    if (purposeWidth > PURPOSE_MAX) purposeWidth = PURPOSE_MAX;

    const overshoot = totalFixed + totalGutters + purposeWidth - usableW;
    if (Math.abs(overshoot) > 0.01) {
      const adjustTargets = ["cat", "sub"];
      const per = overshoot / adjustTargets.length;
      fixed.cat -= per / 2;
      fixed.sub -= per / 2;
      purposeWidth =
        usableW -
        (fixed.seq +
          fixed.cat +
          fixed.sub +
          fixed.qty +
          fixed.amt +
          fixed.typ) -
        totalGutters;
    }

    const columns = [
      { key: "seq", label: "Seq No", width: fixed.seq, align: "left" },
      { key: "category", label: "Category", width: fixed.cat, align: "left" },
      {
        key: "subcategory",
        label: "Subcategory",
        width: fixed.sub,
        align: "left",
      },
      { key: "quantity", label: "Qty", width: fixed.qty, align: "right" },
      {
        key: "purpose",
        label: "Purpose",
        width: purposeWidth,
        align: "left",
      },
      { key: "amount", label: "Amount", width: fixed.amt, align: "right" },
      { key: "type", label: "Type", width: fixed.typ, align: "left" },
    ];

    // Header ribbon
    doc.save();
    doc
      .rect(doc.page.margins.left, headerY, usableW / 2, gradH)
      .fill(BRAND_LEFT);
    doc
      .rect(
        doc.page.margins.left + usableW / 2,
        headerY,
        usableW / 2,
        gradH
      )
      .fill(BRAND_RIGHT);
    doc.restore();

    // Title + month
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor(INK_900)
      .text(
        "Transaction Category-wise Report",
        doc.page.margins.left,
        headerY + gradH + 10
      );
    doc.font("Helvetica").fontSize(12).fillColor(INK_700).text(titleLine);

    // Filters
    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_600)
      .text(`Selected Category: ${selectedCategoryName || "-"}`);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_600)
      .text(`Selected Subcategory: ${selectedSubcategoryName || "All"}`);
    drawDivider(doc, doc.y + 8, BORDER);

    const startX = doc.page.margins.left;
    let cursorY = doc.y + 12;

    function ensureSpace(heightNeeded) {
      if (
        cursorY + heightNeeded >
        doc.page.height - doc.page.margins.bottom
      ) {
        doc.addPage();
        cursorY = doc.page.margins.top;
      }
    }

    function drawHeaderRow() {
      let x = startX;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(INK_600);
      columns.forEach((c, idx) => {
        doc.text(c.label, x + CELL_PAD_X, cursorY + CELL_PAD_Y, {
          width: c.width - 2 * CELL_PAD_X,
          align: c.align,
        });
        x += c.width + (idx < columns.length - 1 ? GUTTER : 0);
      });
      drawDivider(doc, cursorY + HEADER_H - 2, BORDER);
      cursorY += HEADER_H;
    }

    function drawDateBand(label) {
      ensureSpace(22 + HEADER_H + 6);
      doc
        .save()
        .rect(startX, cursorY, usableW, 22)
        .fill(DATE_BAND)
        .restore();
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor(INK_900)
        .text(label, startX + 8, cursorY + 5);
      cursorY += 26;
      drawHeaderRow();
    }

    function measureRowHeight(row) {
      doc.font("Helvetica-Bold").fontSize(ROW_FONT);
      const catH = doc.heightOfString(row.category || "-", {
        width: columns[1].width - 2 * CELL_PAD_X,
      });
      const subH = doc.heightOfString(row.subcategory || "-", {
        width: columns[2].width - 2 * CELL_PAD_X,
      });

      const purposeClamped = clampLines(
        doc,
        row.purpose || "-",
        columns[4].width - 2 * CELL_PAD_X,
        "Helvetica",
        ROW_FONT,
        ROW_LINE_H,
        ROW_MAX_LINES
      );
      doc.font("Helvetica").fontSize(ROW_FONT);
      const purH = doc.heightOfString(purposeClamped, {
        width: columns[4].width - 2 * CELL_PAD_X,
      });

      return Math.ceil(Math.max(catH, subH, purH, ROW_BASE_H));
    }

    function drawRow(row, zebra) {
      const purposeText = clampLines(
        doc,
        row.purpose || "-",
        columns[4].width - 2 * CELL_PAD_X,
        "Helvetica",
        ROW_FONT,
        ROW_LINE_H,
        ROW_MAX_LINES
      );
      const rowH = Math.max(
        measureRowHeight({ ...row, purpose: purposeText }),
        ROW_BASE_H
      );
      ensureSpace(rowH + 6);

      if (zebra) {
        doc
          .save()
          .rect(startX, cursorY - 2, usableW, rowH + 4)
          .fill(ZEBRA)
          .restore();
      }

      let x = startX;
      const y = cursorY;

      // Seq
      doc
        .font("Helvetica")
        .fontSize(ROW_FONT)
        .fillColor(INK_900)
        .text(String(row.seq_no), x + CELL_PAD_X, y + CELL_PAD_Y, {
          width: columns[0].width - 2 * CELL_PAD_X,
          align: columns[0].align,
        });
      x += columns[0].width + GUTTER;

      // Category
      doc
        .font("Helvetica-Bold")
        .fontSize(ROW_FONT)
        .fillColor(PURPLE)
        .text(
          fitText(
            doc,
            row.category || "-",
            columns[1].width - 2 * CELL_PAD_X,
            "Helvetica-Bold",
            ROW_FONT
          ),
          x + CELL_PAD_X,
          y + CELL_PAD_Y,
          {
            width: columns[1].width - 2 * CELL_PAD_X,
            align: columns[1].align,
          }
        );
      x += columns[1].width + GUTTER;

      // Subcategory
      doc
        .font("Helvetica-Bold")
        .fontSize(ROW_FONT)
        .fillColor(PURPLE)
        .text(
          fitText(
            doc,
            row.subcategory || "-",
            columns[2].width - 2 * CELL_PAD_X,
            "Helvetica-Bold",
            ROW_FONT
          ),
          x + CELL_PAD_X,
          y + CELL_PAD_Y,
          {
            width: columns[2].width - 2 * CELL_PAD_X,
            align: columns[2].align,
          }
        );
      x += columns[2].width + GUTTER;

      // Qty
      doc
        .font("Helvetica-Bold")
        .fontSize(ROW_FONT)
        .fillColor(INK_900)
        .text(String(row.quantity ?? 0), x + CELL_PAD_X, y + CELL_PAD_Y, {
          width: columns[3].width - 2 * CELL_PAD_X,
          align: "right",
        });
      x += columns[3].width + GUTTER;

      // Purpose
      doc
        .font("Helvetica")
        .fontSize(ROW_FONT)
        .fillColor(INK_700)
        .text(purposeText, x + CELL_PAD_X, y + CELL_PAD_Y, {
          width: columns[4].width - 2 * CELL_PAD_X,
          align: columns[4].align,
        });
      x += columns[4].width + GUTTER;

      // Amount
      const isDebit = String(row.type).toLowerCase() === "debit";
      doc
        .font("Helvetica-Bold")
        .fontSize(ROW_FONT)
        .fillColor(isDebit ? RED : GREEN)
        .text(INR(row.amount), x + CELL_PAD_X, y + CELL_PAD_Y, {
          width: columns[5].width - 2 * CELL_PAD_X,
          align: columns[5].align,
        });
      x += columns[5].width + GUTTER;

      // Type
      doc
        .font("Helvetica")
        .fontSize(ROW_FONT)
        .fillColor(INK_900)
        .text(row.type, x + CELL_PAD_X, y + CELL_PAD_Y, {
          width: columns[6].width - 2 * CELL_PAD_X,
          align: columns[6].align,
        });

      cursorY += rowH;
    }

    function dailyTotalsHeight() {
      return 14 + 6 + 52 + 10;
    }

    function drawDailyTotals(sum) {
      const boxH = 52;
      const afterTitle = 14;
      const spacing = 6;
      ensureSpace(afterTitle + spacing + boxH + 10);

      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(INK_900)
        .text("Daily Total", startX, cursorY);
      cursorY += afterTitle;

      drawDivider(doc, cursorY, BORDER);
      cursorY += spacing;

      const colW = (usableW - 16) / 3;

      doc
        .save()
        .roundedRect(startX, cursorY, usableW, boxH, 8)
        .fill(SURFACE)
        .restore();
      doc
        .save()
        .lineWidth(1)
        .strokeColor(BORDER)
        .roundedRect(startX, cursorY, usableW, boxH, 8)
        .stroke()
        .restore();

      const py = cursorY + 10;
      const px = startX + 10;

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(INK_600)
        .text("Total Transactions", px, py, { width: colW });
      doc.text("Total Debit", px + colW + 8, py, { width: colW });
      doc.text("Total Credit", px + 2 * colW + 16, py, { width: colW });

      doc
        .font("Helvetica-Bold")
        .fontSize(13)
        .fillColor(INK_900)
        .text(String(sum.total_transactions || 0), px, py + 16, {
          width: colW,
        });
      doc
        .fillColor(RED)
        .text(INR(sum.total_debit || 0), px + colW + 8, py + 16, {
          width: colW,
        });
      doc
        .fillColor(GREEN)
        .text(INR(sum.total_credit || 0), px + 2 * colW + 16, py + 16, {
          width: colW,
        });

      cursorY += boxH + 10;
    }

    function estimateSectionHeight(rows) {
      let h = 26 + HEADER_H;
      rows.forEach((r) => {
        h += Math.max(measureRowHeight(r), ROW_BASE_H);
      });
      h += dailyTotalsHeight();
      return h;
    }

    grouped.forEach((g) => {
      const need = estimateSectionHeight(g.transactions);
      ensureSpace(need);
      drawDateBand(g.date);
      g.transactions.forEach((row, idx) => drawRow(row, idx % 2 === 0));
      drawDailyTotals(g.summary);
    });

    // Month Totals
    const monthBoxH = 64;
    const monthBlockH = 16 + 8 + monthBoxH + 8;
    ensureSpace(monthBlockH);

    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(INK_900)
      .text("Month Total", doc.page.margins.left, cursorY);
    cursorY += 16;

    drawDivider(doc, cursorY, BORDER);
    cursorY += 8;

    doc
      .save()
      .roundedRect(doc.page.margins.left, cursorY, usableW, monthBoxH, 10)
      .fill(SURFACE)
      .restore();
    doc
      .save()
      .lineWidth(1)
      .strokeColor(BORDER)
      .roundedRect(doc.page.margins.left, cursorY, usableW, monthBoxH, 10)
      .stroke()
      .restore();

    const colW2 = (usableW - 16) / 3;
    const px2 = doc.page.margins.left + 12;
    const py2 = cursorY + 12;

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_600)
      .text("Monthly Total Transactions", px2, py2, { width: colW2 });
    doc.text("Monthly Total Debit", px2 + colW2 + 8, py2, { width: colW2 });
    doc.text("Monthly Total Credit", px2 + 2 * colW2 + 16, py2, {
      width: colW2,
    });

    doc
      .font("Helvetica-Bold")
      .fontSize(16)
      .fillColor(INK_900)
      .text(String(monthTotals.totalTransactions || 0), px2, py2 + 18, {
        width: colW2,
      });
    doc
      .fillColor(RED)
      .text(INR(monthTotals.totalDebit || 0), px2 + colW2 + 8, py2 + 18, {
        width: colW2,
      });
    doc
      .fillColor(GREEN)
      .text(INR(monthTotals.totalCredit || 0), px2 + 2 * colW2 + 16, py2 + 18, {
        width: colW2,
      });

    pageFooter(doc, BRAND_LEFT);
  };

  if (collectBuffer) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      render();
      doc.end();
    });
  }

  render();
  doc.end();
}

/* ============================ APIs ============================ */

// 1) Categories
router.get("/categories", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT category_id, category_name, category_color FROM Category ORDER BY category_name"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Categories error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2) Subcategories
router.get("/subcategories", async (req, res) => {
  try {
    const { category_id } = req.query;
    if (!category_id)
      return res.status(400).json({ error: "category_id is required" });

    const result = await db.query(
      "SELECT subcategory_id, subcategory_name FROM Subcategory WHERE category_id=$1 ORDER BY subcategory_name",
      [category_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Subcategories error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3) Daily Transactions (grouped with per-day totals)
//    Supports: start_date + end_date OR month=YYYY-MM (else current month)
router.get("/transactions", async (req, res) => {
  try {
    const { category_id, subcategory_id, start_date, end_date, month } =
      req.query;
    if (!category_id)
      return res.status(400).json({ error: "category_id is required" });

    // Validate subcategory belongs to category if provided
    if (subcategory_id) {
      const scCheck = await db.query(
        "SELECT 1 FROM Subcategory WHERE subcategory_id=$1 AND category_id=$2",
        [subcategory_id, category_id]
      );
      if (scCheck.rowCount === 0) {
        return res
          .status(400)
          .json({ error: "Invalid subcategory for the given category." });
      }
    }

    const params = [category_id];
    let paramIndex = 2;

    let query = `
      SELECT
        dt.daily_transaction_id,
        dt.amount,
        dt.type,
        COALESCE(dt.quantity, 0) AS quantity,
        dt.purpose,
        TO_CHAR(dt.transaction_date, 'YYYY-MM-DD') AS transaction_date,
        c.category_name, c.category_color,
        sc.subcategory_name
      FROM DailyTransaction dt
      JOIN Category c ON dt.category_id = c.category_id
      LEFT JOIN Subcategory sc ON dt.subcategory_id = sc.subcategory_id
      WHERE dt.category_id = $1
    `;

    if (subcategory_id) {
      query += ` AND dt.subcategory_id = $${paramIndex++}`;
      params.push(subcategory_id);
    }

    // Date range logic:
    // - If start_date & end_date provided → use them.
    // - Else if month=YYYY-MM → use that month.
    // - Else → current month.
    let startDate = start_date;
    let endDate = end_date;

    if (!start_date || !end_date) {
      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const { startISO, endISO } = getMonthRangeFromParam(month);
        startDate = startISO;
        endDate = endISO;
      } else {
        const { startISO, endISO } = getCurrentMonthRange();
        startDate = startISO;
        endDate = endISO;
      }
    }

    query += ` AND dt.transaction_date BETWEEN $${paramIndex++} AND $${paramIndex++}`;
    params.push(startDate, endDate);

    query +=
      " ORDER BY dt.transaction_date ASC, dt.daily_transaction_id ASC";

    const result = await db.query(query, params);

    const grouped = {};
    result.rows.forEach((t) => {
      const dateKey = t.transaction_date;
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(t);
    });

    const transactionsByDate = Object.keys(grouped)
      .sort()
      .map((date) => {
        const dailyTransactions = grouped[date].map((t, i) => ({
          seq_no: i + 1,
          amount: Number(t.amount),
          type: t.type,
          quantity: Number(t.quantity ?? 0),
          purpose: t.purpose,
          category: t.category_name,
          subcategory: t.subcategory_name || "-",
          category_color: t.category_color,
          transaction_date: formatDate(t.transaction_date),
        }));

        const totalDebit = dailyTransactions
          .filter((t) => t.type === "debit")
          .reduce((acc, t) => acc + t.amount, 0);
        const totalCredit = dailyTransactions
          .filter((t) => t.type === "credit")
          .reduce((acc, t) => acc + t.amount, 0);
        const totalQuantity = dailyTransactions.reduce(
          (acc, t) => acc + (Number(t.quantity) || 0),
          0
        );

        return {
          date: formatDate(date),
          transactions: dailyTransactions,
          summary: {
            total_transactions: dailyTransactions.length,
            total_debit: totalDebit,
            total_credit: totalCredit,
            total_quantity: totalQuantity,
          },
        };
      });

    res.json({
      category_id,
      subcategory_id: subcategory_id || null,
      data: transactionsByDate,
    });
  } catch (err) {
    console.error("Error fetching transactions:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4) Monthly Total Helper — now accepts optional month=YYYY-MM
const fetchMonthlyTotals = async (category_id, subcategory_id, month) => {
  const { startISO, endISO, label } = month
    ? getMonthRangeFromParam(month)
    : getCurrentMonthRange();

  const params = [category_id];
  let paramIndex = 2;
  let query = `
    SELECT dt.amount, dt.type, COALESCE(dt.quantity,0) AS quantity
    FROM DailyTransaction dt
    WHERE dt.category_id = $1
  `;
  if (subcategory_id) {
    query += ` AND dt.subcategory_id = $${paramIndex++}`;
    params.push(subcategory_id);
  }
  query += ` AND dt.transaction_date BETWEEN $${paramIndex++} AND $${paramIndex++}`;
  params.push(startISO, endISO);

  const result = await db.query(query, params);

  const totalTransactions = result.rows.length;
  const totalDebit = result.rows
    .filter((t) => t.type === "debit")
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const totalCredit = result.rows
    .filter((t) => t.type === "credit")
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const totalQuantity = result.rows.reduce(
    (sum, t) => sum + Number(t.quantity || 0),
    0
  );

  return {
    totalTransactions,
    totalDebit,
    totalCredit,
    totalQuantity,
    startDate: startISO,
    endDate: endISO,
    label,
  };
};

// 5) Monthly Total JSON — supports month=YYYY-MM, else current month
router.get("/transactions/monthly-total", async (req, res) => {
  try {
    const { category_id, subcategory_id, month } = req.query;
    if (!category_id)
      return res.status(400).json({ error: "category_id is required" });

    // Validate subcategory belongs to category if provided
    if (subcategory_id) {
      const scCheck = await db.query(
        "SELECT 1 FROM Subcategory WHERE subcategory_id=$1 AND category_id=$2",
        [subcategory_id, category_id]
      );
      if (scCheck.rowCount === 0) {
        return res
          .status(400)
          .json({ error: "Invalid subcategory for the given category." });
      }
    }
    const totals = await fetchMonthlyTotals(category_id, subcategory_id, month);
    res.json({
      category_id,
      subcategory_id: subcategory_id || null,
      ...totals,
      month: month || null,
    });
  } catch (err) {
    console.error("Monthly total error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 6) Shared fetch for month data (grouped + names)
//    Uses month=YYYY-MM if provided, otherwise current month.
async function fetchCurrentMonthData(category_id, subcategory_id, month) {
  const { startISO, endISO, monthName, year, label } = month
    ? getMonthRangeFromParam(month)
    : getCurrentMonthRange();

  const catRes = await db.query(
    "SELECT category_name FROM Category WHERE category_id=$1",
    [category_id]
  );
  if (catRes.rowCount === 0) throw new Error("Invalid category_id");
  const categoryName = catRes.rows[0].category_name;

  let subcategoryName = null;
  if (subcategory_id) {
    const scRes = await db.query(
      "SELECT subcategory_name FROM Subcategory WHERE subcategory_id=$1 AND category_id=$2",
      [subcategory_id, category_id]
    );
    if (scRes.rowCount === 0)
      throw new Error("Invalid subcategory for category");
    subcategoryName = scRes.rows[0].subcategory_name;
  }

  const params = [category_id];
  let paramIndex = 2;
  let sql = `
    SELECT
      dt.daily_transaction_id,
      dt.amount,
      dt.type,
      COALESCE(dt.quantity,0) AS quantity,
      dt.purpose,
      TO_CHAR(dt.transaction_date, 'YYYY-MM-DD') AS transaction_date,
      c.category_name AS category,
      c.category_color AS category_color,
      sc.subcategory_name AS subcategory
    FROM DailyTransaction dt
    JOIN Category c ON dt.category_id = c.category_id
    LEFT JOIN Subcategory sc ON dt.subcategory_id = sc.subcategory_id
    WHERE dt.category_id = $1
  `;
  if (subcategory_id) {
    sql += ` AND dt.subcategory_id = $${paramIndex++}`;
    params.push(subcategory_id);
  }
  sql += ` AND dt.transaction_date BETWEEN $${paramIndex++} AND $${paramIndex++}
           ORDER BY dt.transaction_date ASC, dt.daily_transaction_id ASC`;
  params.push(startISO, endISO);

  const listRes = await db.query(sql, params);

  const byDate = {};
  listRes.rows.forEach((r) => {
    if (!byDate[r.transaction_date]) byDate[r.transaction_date] = [];
    byDate[r.transaction_date].push(r);
  });

  const grouped = Object.keys(byDate)
    .sort()
    .map((date) => {
      const rows = byDate[date].map((r, i) => ({
        seq_no: i + 1,
        category: r.category,
        subcategory: r.subcategory || "-",
        purpose: r.purpose || "-",
        amount: Number(r.amount || 0),
        quantity: Number(r.quantity || 0),
        type: r.type,
        category_color: r.category_color,
      }));
      const total_debit = rows
        .filter((t) => t.type === "debit")
        .reduce((s, t) => s + Number(t.amount), 0);
      const total_credit = rows
        .filter((t) => t.type === "credit")
        .reduce((s, t) => s + Number(t.amount), 0);
      const total_quantity = rows.reduce(
        (s, t) => s + Number(t.quantity || 0),
        0
      );
      return {
        date: formatDate(date),
        transactions: rows,
        summary: {
          total_transactions: rows.length,
          total_debit,
          total_credit,
          total_quantity,
        },
      };
    });

  const totalTransactions = listRes.rowCount;
  const totalDebit = listRes.rows
    .filter((r) => r.type === "debit")
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalCredit = listRes.rows
    .filter((r) => r.type === "credit")
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalQuantity = listRes.rows.reduce(
    (s, r) => s + Number(r.quantity || 0),
    0
  );

  return {
    label,
    monthName,
    year,
    grouped,
    monthTotals: {
      totalTransactions,
      totalDebit,
      totalCredit,
      totalQuantity,
    },
    categoryName,
    subcategoryName,
  };
}

// 7) DOWNLOAD month PDF (uses ?month=YYYY-MM or current month)
router.get("/transactions/monthly-total/pdf", async (req, res) => {
  try {
    const { category_id, subcategory_id, month } = req.query;
    if (!category_id)
      return res.status(400).json({ error: "category_id is required" });

    // Validate subcategory belongs to category if provided
    if (subcategory_id) {
      const scCheck = await db.query(
        "SELECT 1 FROM Subcategory WHERE subcategory_id=$1 AND category_id=$2",
        [subcategory_id, category_id]
      );
      if (scCheck.rowCount === 0) {
        return res
          .status(400)
          .json({ error: "Invalid subcategory for the given category." });
      }
    }

    const data = await fetchCurrentMonthData(
      category_id,
      subcategory_id,
      month
    );

    const safeTitle = `Transactions_${data.label}_${data.categoryName}${
      data.subcategoryName ? "_" + data.subcategoryName : ""
    }`.replace(/[^\w\-]+/g, "_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeTitle}.pdf"`
    );

    buildCurrentMonthPDF({
      titleLine: data.label,
      selectedCategoryName: data.categoryName,
      selectedSubcategoryName: data.subcategoryName || "All",
      grouped: data.grouped,
      monthTotals: data.monthTotals,
      streamTo: res,
    });
  } catch (err) {
    console.error("PDF download error:", err);
    res.status(500).json({ error: "Failed to generate PDF." });
  }
});

// 8) SEND month PDF via email (supports month=YYYY-MM)
router.post(
  "/transactions/monthly-total/email",
  body("email").isString().trim().isEmail(),
  body("category_id").notEmpty(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res
          .status(400)
          .json({ error: "Invalid input", details: errors.array() });
      }

      const { email, category_id, subcategory_id, month } = req.body;

      // Validate subcategory belongs to category if provided
      if (subcategory_id) {
        const scCheck = await db.query(
          "SELECT 1 FROM Subcategory WHERE subcategory_id=$1 AND category_id=$2",
          [subcategory_id, category_id]
        );
        if (scCheck.rowCount === 0) {
          return res
            .status(400)
            .json({ error: "Invalid subcategory for the given category." });
        }
      }

      const data = await fetchCurrentMonthData(
        category_id,
        subcategory_id,
        month
      );

      const pdfBuffer = await buildCurrentMonthPDF({
        titleLine: data.label,
        selectedCategoryName: data.categoryName,
        selectedSubcategoryName: data.subcategoryName || "All",
        grouped: data.grouped,
        monthTotals: data.monthTotals,
        collectBuffer: true,
      });

      const subject =
        `Transaction Report — ${data.label} (${data.categoryName}` +
        `${data.subcategoryName ? " / " + data.subcategoryName : ""})`;

      const base64Pdf = pdfBuffer.toString("base64");
      const safeName =
        `Transactions_${data.label}_${data.categoryName}` +
        `${data.subcategoryName ? "_" + data.subcategoryName : ""}`.replace(
          /[^\w\-]+/g,
          "_"
        ) + ".pdf";

      await sendEmail(
        email,
        subject,
        `<p>Please find attached your transaction report for <b>${data.label}</b>.<br/>Category: <b>${data.categoryName}</b><br/>Subcategory: <b>${
          data.subcategoryName || "All"
        }</b></p>`,
        `Please find attached your transaction report for ${data.label}.
Category: ${data.categoryName}
Subcategory: ${data.subcategoryName || "All"}`,
        [
          {
            Filename: safeName,
            ContentType: "application/pdf",
            Base64Content: base64Pdf,
          },
        ]
      );

      res.json({ message: `PDF sent successfully to ${email}` });
    } catch (err) {
      console.error("Email send error:", err?.response?.data || err);
      res.status(502).json({ error: "Failed to send email." });
    }
  }
);

module.exports = router;
