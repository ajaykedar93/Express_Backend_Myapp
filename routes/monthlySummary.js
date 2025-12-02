const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");
require("dotenv").config();

// Mailer (Mailjet HTTPS API): sendOTP / sendEmail
const { sendOTP, sendEmail } = require("../utils/mailer");

// ---------------- Helpers ----------------
const format = (num) =>
  num !== null && num !== undefined ? Number(num).toFixed(2) : "0.00";

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
  const range = doc.bufferedPageRange(); // { start, count }
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    // Footer: page number + generated at
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

/**
 * Build a professional monthly PDF (streamed or buffered).
 * - If `streamTo` is provided, pipes directly (download route).
 * - If `collectBuffer` is true, resolves a Promise<Buffer> (email route).
 *
 * Layout:
 * - Date sections with band
 * - Real table: No | Amount | Type | Category | Subcategory | Qty | Purpose
 * - Dynamic widths for Category/Subcategory/Purpose (based on content)
 * - Multi-line wrapping per cell, auto row height => no text hidden/mixed
 */
function buildMonthlyPDF({
  title,
  monthName,
  year,
  transactions, // flat list, ordered by date + sequence_no
  streamTo = null,
  collectBuffer = false,
}) {
  // Palette
  const BRAND_GRAD_LEFT = "#5f4bb6";
  const BRAND_GRAD_RIGHT = "#1f5f78";
  const SURFACE = "#ffffff";
  const INK_900 = "#0f172a";
  const INK_700 = "#334155";
  const INK_600 = "#475569";
  const BORDER = "#e6e9ef";
  const GREEN = "#0f8a5f";
  const RED = "#b33a3a";
  const DATE_BAND = "#f3f5fb";
  const ZEBRA = "#fafcff";

  const CELL_PAD_X = 4;
  const CELL_PAD_Y = 2;
  const HEADER_H = 18;
  const DATE_BAND_H = 24;
  const MIN_ROW_H = 14;

  // IMPORTANT: no bufferPages here to avoid extra blank pages
  const doc = new PDFDocument({
    margin: 36,
    size: "A4",
    autoFirstPage: true,
  });

  let resolveBuf;
  const buffers = [];

  if (streamTo) {
    doc.pipe(streamTo);
  }
  if (collectBuffer) {
    doc.on("data", (c) => buffers.push(c));
    doc.on("end", () => resolveBuf(Buffer.concat(buffers)));
  }

  // ---- Header (brand bar + title)
  const headerY = 20;
  const gradHeight = 22;

  const usableW =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Fake gradient bar (draw two halves)
  doc.save();
  doc
    .rect(doc.page.margins.left, headerY, usableW / 2, gradHeight)
    .fill(BRAND_GRAD_LEFT);
  doc
    .rect(doc.page.margins.left + usableW / 2, headerY, usableW / 2, gradHeight)
    .fill(BRAND_GRAD_RIGHT);
  doc.restore();

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(INK_900)
    .text(title, doc.page.margins.left, headerY + gradHeight + 10, {
      align: "left",
    });

  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(INK_700)
    .text(`Period: ${monthName} ${year}`, {
      align: "left",
    });

  drawDivider(doc, doc.y + 8, BORDER);

  // ---- Compute totals & group by date
  let monthTotalDebit = 0;
  let monthTotalCredit = 0;
  let monthTotalTransactions = 0;

  const byDate = new Map(); // "DD Mon YYYY" -> rows[]
  transactions.forEach((t) => {
    monthTotalTransactions++;
    if (String(t.type).toLowerCase() === "debit")
      monthTotalDebit += Number(t.amount || 0);
    if (String(t.type).toLowerCase() === "credit")
      monthTotalCredit += Number(t.amount || 0);

    const key = t.transaction_date;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(t);
  });

  /**
   * Dynamic column widths
   * Fixed-ish: No, Amount, Type, Qty
   * Flexible: Category, Subcategory, Purpose (based on content width)
   */
  doc.font("Helvetica").fontSize(10);

  const fixed = {
    no: 32,
    amount: 80,
    type: 50,
    qty: 40,
  };

  const fixedSum = fixed.no + fixed.amount + fixed.type + fixed.qty;
  const flexAvailable = Math.max(usableW - fixedSum, 120); // at least some space

  // Measure max text widths for flex columns
  let maxCat = doc.widthOfString("Category");
  let maxSub = doc.widthOfString("Subcategory");
  let maxPur = doc.widthOfString("Purpose");

  transactions.forEach((t) => {
    maxCat = Math.max(maxCat, doc.widthOfString(t.category || "-"));
    maxSub = Math.max(maxSub, doc.widthOfString(t.subcategory || "-"));
    maxPur = Math.max(maxPur, doc.widthOfString(t.purpose || "-"));
  });

  const sumFlex = maxCat + maxSub + maxPur || 1;
  let wCat = (maxCat / sumFlex) * flexAvailable;
  let wSub = (maxSub / sumFlex) * flexAvailable;
  let wPur = (maxPur / sumFlex) * flexAvailable;

  const MIN_CAT = 70;
  const MIN_SUB = 70;
  const MIN_PUR = 90;

  wCat = Math.max(MIN_CAT, wCat);
  wSub = Math.max(MIN_SUB, wSub);
  wPur = Math.max(MIN_PUR, wPur);

  // Normalize if overshoot
  let flexSum = wCat + wSub + wPur;
  if (flexSum > flexAvailable) {
    const scale = flexAvailable / flexSum;
    wCat *= scale;
    wSub *= scale;
    wPur *= scale;
  }

  const columns = [
    { key: "no", label: "No", width: fixed.no, align: "left" },
    { key: "amount", label: "Amount", width: fixed.amount, align: "right" },
    { key: "type", label: "Type", width: fixed.type, align: "left" },
    { key: "category", label: "Category", width: wCat, align: "left" },
    { key: "subcategory", label: "Subcategory", width: wSub, align: "left" },
    { key: "qty", label: "Qty", width: fixed.qty, align: "right" },
    { key: "purpose", label: "Purpose", width: wPur, align: "left" },
  ];

  const startX = doc.page.margins.left;
  let cursorY = doc.y + 12;

  const bottomLimit = () =>
    doc.page.height - doc.page.margins.bottom;

  function ensureSpaceHeight(neededHeight) {
    if (cursorY + neededHeight > bottomLimit()) {
      doc.addPage();
      cursorY = doc.page.margins.top;
    }
  }

  function drawHeaderRow() {
    ensureSpaceHeight(HEADER_H);
    let x = startX;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK_600);
    columns.forEach((c) => {
      doc.text(c.label, x + CELL_PAD_X, cursorY + CELL_PAD_Y, {
        width: c.width - 2 * CELL_PAD_X,
        align: c.align,
      });
      x += c.width;
    });
    drawDivider(doc, cursorY + HEADER_H - 2, BORDER);
    cursorY += HEADER_H;
  }

  function drawDateBand(label) {
    ensureSpaceHeight(DATE_BAND_H + HEADER_H);
    doc
      .save()
      .rect(startX, cursorY, usableW, DATE_BAND_H)
      .fill(DATE_BAND)
      .restore();
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(INK_900)
      .text(label, startX + 8, cursorY + 6);
    cursorY += DATE_BAND_H;
    drawHeaderRow();
  }

  function measureRowHeight(row, seq) {
    let maxH = 0;

    // We'll measure using Helvetica size 10 for all cells
    doc.font("Helvetica").fontSize(10);

    columns.forEach((c) => {
      let text = "";
      switch (c.key) {
        case "no":
          text = String(seq);
          break;
        case "amount":
          text = INR(row.amount);
          break;
        case "type":
          text = row.type;
          break;
        case "category":
          text = row.category || "-";
          break;
        case "subcategory":
          text = row.subcategory || "-";
          break;
        case "qty":
          text = String(row.quantity ?? 0);
          break;
        case "purpose":
          text = row.purpose || "-";
          break;
        default:
          text = "";
      }
      const h = doc.heightOfString(text, {
        width: c.width - 2 * CELL_PAD_X,
      });
      if (h > maxH) maxH = h;
    });

    return Math.max(maxH + 2 * CELL_PAD_Y, MIN_ROW_H);
  }

  function drawRow(seq, row, zebra) {
    const rowH = measureRowHeight(row, seq);
    ensureSpaceHeight(rowH + 4);

    if (zebra) {
      doc
        .save()
        .rect(startX, cursorY - 2, usableW, rowH + 4)
        .fill(ZEBRA)
        .restore();
    }

    let x = startX;
    const amt = INR(row.amount);
    const isDebit = String(row.type).toLowerCase() === "debit";
    const amtColor = isDebit ? RED : GREEN;

    columns.forEach((c) => {
      let text = "";
      let color = INK_900;
      let font = "Helvetica";
      switch (c.key) {
        case "no":
          text = String(seq);
          color = INK_900;
          font = "Helvetica";
          break;
        case "amount":
          text = amt;
          color = amtColor;
          font = "Helvetica-Bold";
          break;
        case "type":
          text = row.type;
          color = INK_900;
          font = "Helvetica";
          break;
        case "category":
          text = row.category || "-";
          color = row.category_color || INK_900;
          font = "Helvetica";
          break;
        case "subcategory":
          text = row.subcategory || "-";
          color = INK_900;
          font = "Helvetica";
          break;
        case "qty":
          text = String(row.quantity ?? 0);
          color = INK_900;
          font = "Helvetica-Bold";
          break;
        case "purpose":
          text = row.purpose || "-";
          color = INK_700;
          font = "Helvetica";
          break;
      }

      doc
        .font(font)
        .fontSize(10)
        .fillColor(color)
        .text(text, x + CELL_PAD_X, cursorY + CELL_PAD_Y, {
          width: c.width - 2 * CELL_PAD_X,
          align: c.align,
        });

      x += c.width;
    });

    cursorY += rowH;
  }

  // Render each date group with professional table layout
  for (const [dateLabel, rows] of byDate.entries()) {
    let seq = 1;
    drawDateBand(dateLabel);
    rows.forEach((r, idx) => drawRow(seq++, r, idx % 2 === 0));
    cursorY += 6;
  }

  // ---- Monthly Summary Panel
  const panelH = 84;
  ensureSpaceHeight(panelH + 30);
  drawDivider(doc, cursorY, BORDER);
  cursorY += 10;

  // Panel background
  doc
    .save()
    .roundedRect(startX, cursorY, usableW, panelH, 10)
    .fillOpacity(1)
    .fill(SURFACE)
    .restore();

  // Panel border
  doc
    .save()
    .lineWidth(1)
    .strokeColor(BORDER)
    .roundedRect(startX, cursorY, usableW, panelH, 10)
    .stroke()
    .restore();

  const colW = (usableW - 32) / 3;
  const px = startX + 16;
  const py = cursorY + 14;

  // Headings
  doc.font("Helvetica").fontSize(10).fillColor(INK_600);
  doc.text(`Total ${monthName} Transactions`, px, py, { width: colW });
  doc.text("Total Debit", px + colW + 16, py, { width: colW });
  doc.text("Total Credit", px + colW * 2 + 32, py, { width: colW });

  // Values
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK_900);
  doc.text(String(monthTotalTransactions), px, py + 16, { width: colW });
  doc.fillColor(RED).text(INR(monthTotalDebit), px + colW + 16, py + 16, {
    width: colW,
  });
  doc.fillColor(GREEN).text(INR(monthTotalCredit), px + colW * 2 + 32, py + 16, {
    width: colW,
  });

  cursorY += panelH + 10;

  // NOTE: we intentionally DO NOT call pageFooter here any more
  // to avoid extra blank pages from buffered page handling.

  if (streamTo) {
    doc.end();
    return; // streamed
  }

  if (collectBuffer) {
    return new Promise((resolve) => {
      resolveBuf = resolve;
      doc.end();
    });
  }
}

// ----------------- Monthly Summary Download API -----------------
router.get("/monthly-summary/download", async (req, res) => {
  try {
    const { month, year, formatType } = req.query;
    if (!month || !year || !formatType) {
      return res
        .status(400)
        .json({ message: "Month, year, and formatType are required" });
    }

    const query = `
      SELECT
        dt.sequence_no,
        TO_CHAR(dt.transaction_date, 'DD Mon YYYY') AS transaction_date,
        dt.amount,
        dt.type,
        dt.quantity,
        c.category_name AS category,
        c.category_color AS category_color,
        sc.subcategory_name AS subcategory,
        dt.purpose
      FROM DailyTransaction dt
      JOIN Category c ON dt.category_id = c.category_id
      LEFT JOIN Subcategory sc ON dt.subcategory_id = sc.subcategory_id
      WHERE EXTRACT(MONTH FROM dt.transaction_date) = $1
        AND EXTRACT(YEAR FROM dt.transaction_date) = $2
      ORDER BY dt.transaction_date, dt.sequence_no;
    `;
    const result = await db.query(query, [month, year]);
    const transactions = result.rows;

    if (!transactions || transactions.length === 0) {
      return res.status(404).json({ message: "No transactions found." });
    }

    const monthName = new Date(year, month - 1).toLocaleString("default", {
      month: "long",
    });
    const title = `${monthName} ${year} Transactions`;

    if (formatType === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${title}.pdf"`
      );

      buildMonthlyPDF({
        title,
        monthName,
        year,
        transactions,
        streamTo: res, // stream directly to client
      });
    } else if (formatType === "text") {
      // Fallback plain text (with Qty column)
      let txt = `*** ${title} ***\n\n`;
      let currentDate = "";
      let seq = 1;
      let monthTotalDebit = 0;
      let monthTotalCredit = 0;
      let monthTotalTransactions = 0;

      transactions.forEach((t) => {
        if (currentDate !== t.transaction_date) {
          currentDate = t.transaction_date;
          seq = 1;
          txt += `\nDate: ${currentDate}\n`;
          txt += `No | Amount | Type | Category | Subcategory | Qty | Purpose\n`;
        }

        txt += `${seq}. ${format(t.amount)} | ${t.type} | ${t.category} | ${
          t.subcategory || "-"
        } | ${t.quantity ?? 0} | ${t.purpose || "-"}\n`;
        seq++;

        if (t.type === "debit") monthTotalDebit += parseFloat(t.amount);
        if (t.type === "credit") monthTotalCredit += parseFloat(t.amount);
        monthTotalTransactions++;
      });

      txt += `\nTotal Transactions (${monthName}): ${monthTotalTransactions}\n`;
      txt += `Total Debit (${monthName}): ${format(monthTotalDebit)}\n`;
      txt += `Total Credit (${monthName}): ${format(monthTotalCredit)}\n`;

      res.setHeader("Content-Type", "text/plain");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${title}.txt"`
      );
      res.send(txt);
    } else {
      return res
        .status(400)
        .json({ message: "Invalid formatType. Use 'pdf' or 'text' only." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
});

// ----------------- Monthly Summary Email API (Mailjet Version) -----------------
router.post("/monthly-summary/send", async (req, res) => {
  try {
    const { month, year, formatType, email } = req.body;

    // Validation
    if (!month || !year || !formatType || !email) {
      return res
        .status(400)
        .json({ message: "Month, year, formatType, and email are required." });
    }

    // Query database
    const query = `
      SELECT
        dt.sequence_no,
        TO_CHAR(dt.transaction_date, 'DD Mon YYYY') AS transaction_date,
        dt.amount,
        dt.type,
        dt.quantity,
        c.category_name AS category,
        c.category_color AS category_color,
        sc.subcategory_name AS subcategory,
        dt.purpose
      FROM DailyTransaction dt
      JOIN Category c ON dt.category_id = c.category_id
      LEFT JOIN Subcategory sc ON dt.subcategory_id = sc.subcategory_id
      WHERE EXTRACT(MONTH FROM dt.transaction_date) = $1
        AND EXTRACT(YEAR FROM dt.transaction_date) = $2
      ORDER BY dt.transaction_date, dt.sequence_no;
    `;

    const result = await db.query(query, [month, year]);
    const transactions = result.rows;

    // Handle no records
    if (!transactions.length) {
      return res.status(404).json({ message: "No transactions found." });
    }

    const monthName = new Date(year, month - 1).toLocaleString("default", {
      month: "long",
    });
    const title = `${monthName} ${year} Transactions`;

    // ---------------- PDF FORMAT ----------------
    if (formatType === "pdf") {
      const pdfBuffer = await buildMonthlyPDF({
        title,
        monthName,
        year,
        transactions,
        collectBuffer: true,
      });

      // Convert to Base64 for Mailjet attachment
      const base64Pdf = pdfBuffer.toString("base64");

      await sendEmail(
        email,
        `Monthly Transactions - ${monthName} ${year}`,
        `<p>Please find attached your transaction report for <b>${monthName} ${year}</b>.</p>`,
        `Please find attached your transaction report for ${monthName} ${year}.`,
        [
          {
            Filename: `${title}.pdf`,
            ContentType: "application/pdf",
            Base64Content: base64Pdf,
          },
        ]
      );

      return res.json({ message: `PDF sent successfully to ${email}` });
    }

    // ---------------- TEXT FORMAT ----------------
    else if (formatType === "text") {
      let txt = `*** ${title} ***\n\n`;
      let currentDate = "";
      let seq = 1;
      let monthTotalDebit = 0;
      let monthTotalCredit = 0;
      let monthTotalTransactions = 0;

      transactions.forEach((t) => {
        if (currentDate !== t.transaction_date) {
          currentDate = t.transaction_date;
          seq = 1;
          txt += `\nDate: ${currentDate}\n`;
          txt += `No | Amount | Type | Category | Subcategory | Qty | Purpose\n`;
        }

        txt += `${seq}. ${format(t.amount)} | ${t.type} | ${t.category} | ${
          t.subcategory || "-"
        } | ${t.quantity ?? 0} | ${t.purpose || "-"}\n`;
        seq++;

        if (t.type === "debit") monthTotalDebit += parseFloat(t.amount);
        if (t.type === "credit") monthTotalCredit += parseFloat(t.amount);
        monthTotalTransactions++;
      });

      txt += `\nTotal Transactions (${monthName}): ${monthTotalTransactions}\n`;
      txt += `Total Debit (${monthName}): ${format(monthTotalDebit)}\n`;
      txt += `Total Credit (${monthName}): ${format(monthTotalCredit)}\n`;

      await sendEmail(
        email,
        `Monthly Transactions - ${monthName} ${year}`,
        `<pre style="font-family: monospace; white-space: pre-wrap;">${txt}</pre>`,
        txt
      );

      return res.json({ message: `Text report sent successfully to ${email}` });
    }

    // ---------------- INVALID FORMAT ----------------
    else {
      return res
        .status(400)
        .json({ message: "Invalid formatType. Use 'pdf' or 'text' only." });
    }
  } catch (err) {
    console.error("[monthly-summary/send] error:", err?.response?.data || err);
    return res.status(500).json({
      message: "Internal server error.",
      detail: err?.response?.data || err?.message || String(err),
    });
  }
});

// ----------------- Monthly Summary API -----------------
router.get("/monthly-summary", async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year)
      return res.status(400).json({ message: "Month and year are required" });

    const query = `
      SELECT
        dt.sequence_no,
        TO_CHAR(dt.transaction_date, 'DD Mon YYYY') AS transaction_date,
        dt.amount,
        dt.type,
        dt.quantity,
        c.category_name AS category,
        c.category_color AS category_color,
        sc.subcategory_name AS subcategory,
        dt.purpose
      FROM DailyTransaction dt
      JOIN Category c ON dt.category_id = c.category_id
      LEFT JOIN Subcategory sc ON dt.subcategory_id = sc.subcategory_id
      WHERE EXTRACT(MONTH FROM dt.transaction_date) = $1
        AND EXTRACT(YEAR FROM dt.transaction_date) = $2
      ORDER BY dt.transaction_date, dt.sequence_no;
    `;
    const result = await db.query(query, [month, year]);
    const rows = result.rows;

    if (!rows.length)
      return res.status(404).json({ message: "No transactions found." });

    const groupedTransactions = [];
    let currentDate = "";
    let dailyTransactions = [];

    rows.forEach((row) => {
      if (currentDate !== row.transaction_date) {
        if (dailyTransactions.length)
          groupedTransactions.push({
            date: currentDate,
            transactions: dailyTransactions,
          });
        currentDate = row.transaction_date;
        dailyTransactions = [];
      }
      dailyTransactions.push({
        ...row,
        amount: format(row.amount),
        quantity: row.quantity ?? 0,
      });
    });

    if (dailyTransactions.length)
      groupedTransactions.push({
        date: currentDate,
        transactions: dailyTransactions,
      });

    res.json(groupedTransactions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
});

// ----------------- Monthly Bulk Delete API (safety confirm) -----------------
router.delete("/monthly-summary", async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    const { confirm } = req.query;

    if (!month || !year || month < 1 || month > 12) {
      return res
        .status(400)
        .json({ message: "Valid month (1-12) and year are required." });
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
        WHERE EXTRACT(MONTH FROM transaction_date) = $1
          AND EXTRACT(YEAR  FROM transaction_date) = $2
        RETURNING amount, type
      )
      SELECT
        COUNT(*)::int AS deleted_count,
        COALESCE(SUM(CASE WHEN LOWER(type)='debit'  THEN amount END), 0)::numeric AS debit_sum,
        COALESCE(SUM(CASE WHEN LOWER(type)='credit' THEN amount END), 0)::numeric AS credit_sum
      FROM del;
    `;
    const { rows } = await db.query(sql, [month, year]);
    const stats = rows[0] || { deleted_count: 0, debit_sum: 0, credit_sum: 0 };

    if (stats.deleted_count === 0) {
      return res.status(404).json({
        message: "No transactions found for the specified month/year.",
      });
    }

    const monthName = new Date(year, month - 1).toLocaleString("default", {
      month: "long",
    });

    return res.status(200).json({
      message: `Deleted ${stats.deleted_count} transaction(s) for ${monthName} ${year}.`,
      removed: {
        debit_sum: Number(stats.debit_sum),
        credit_sum: Number(stats.credit_sum),
      },
    });
  } catch (err) {
    console.error("Error deleting monthly transactions:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
});

module.exports = router;
