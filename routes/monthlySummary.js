const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
require("dotenv").config();

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
 */
function buildMonthlyPDF({
  title,
  monthName,
  year,
  transactions, // flat list, ordered by date + sequence_no
  streamTo = null,
  collectBuffer = false,
}) {
  // Palette (no bootstrap blue)
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

  const doc = new PDFDocument({
    margin: 36,
    size: "A4",
    bufferPages: true,
    autoFirstPage: true,
  });

  let resolveBuf;
  let buffers = [];

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
  // Fake gradient bar (draw two halves)
  doc.save();
  const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.rect(doc.page.margins.left, headerY, contentW / 2, gradHeight).fill(BRAND_GRAD_LEFT);
  doc
    .rect(doc.page.margins.left + contentW / 2, headerY, contentW / 2, gradHeight)
    .fill(BRAND_GRAD_RIGHT);
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK_900).text(
    title,
    doc.page.margins.left,
    headerY + gradHeight + 10,
    { align: "left" }
  );

  doc.font("Helvetica").fontSize(11).fillColor(INK_700).text(`Period: ${monthName} ${year}`, {
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

  // ---- Table settings (added Qty column before Purpose)
  const col = [
    { key: "no", label: "No", width: 32, align: "left" },
    { key: "amount", label: "Amount", width: 80, align: "right" },
    { key: "type", label: "Type", width: 50, align: "left" },
    { key: "category", label: "Category", width: 92, align: "left" },
    { key: "subcategory", label: "Subcategory", width: 92, align: "left" },
    { key: "qty", label: "Qty", width: 44, align: "right" },
    { key: "purpose", label: "Purpose", width: 116, align: "left" },
  ];

  const startX = doc.page.margins.left;
  const startY = doc.y + 12;
  let cursorY = startY;

  function ensureSpace(linesNeeded = 1, bandExtra = 0) {
    const needed = linesNeeded * 16 + bandExtra + 10;
    if (cursorY + needed > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      cursorY = doc.page.margins.top;
    }
  }

  function drawDateBand(label) {
    ensureSpace(1, 10);
    doc
      .save()
      .rect(
        startX,
        cursorY,
        doc.page.width - doc.page.margins.left - doc.page.margins.right,
        22
      )
      .fill(DATE_BAND)
      .restore();
    doc.fillColor(INK_900).font("Helvetica-Bold").fontSize(12).text(label, startX + 8, cursorY + 6);
    cursorY += 28;

    // Table header
    let x = startX;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK_600);
    col.forEach((c) => {
      doc.text(c.label, x + 2, cursorY, {
        width: c.width - 4,
        align: c.align,
      });
      x += c.width;
    });
    drawDivider(doc, cursorY + 14, BORDER);
    cursorY += 18;
  }

  function drawRow(seq, row, zebra) {
    ensureSpace(1);
    const rowHeight = 16;
    if (zebra) {
      doc
        .save()
        .rect(
          startX,
          cursorY - 2,
          doc.page.width - doc.page.margins.left - doc.page.margins.right,
          rowHeight + 4
        )
        .fill(ZEBRA)
        .restore();
    }

    let x = startX;
    const amt = INR(row.amount);
    const isDebit = String(row.type).toLowerCase() === "debit";
    const amtColor = isDebit ? RED : GREEN;

    // No
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_900)
      .text(String(seq), x + 2, cursorY, {
        width: col[0].width - 4,
        align: col[0].align,
      });
    x += col[0].width;

    // Amount
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(amtColor)
      .text(amt, x + 2, cursorY, { width: col[1].width - 4, align: col[1].align });
    x += col[1].width;

    // Type
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_900)
      .text(row.type, x + 2, cursorY, { width: col[2].width - 4, align: col[2].align });
    x += col[2].width;

    // Category
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(row.category_color || INK_900)
      .text(row.category || "-", x + 2, cursorY, {
        width: col[3].width - 4,
        align: col[3].align,
      });
    x += col[3].width;

    // Subcategory
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_900)
      .text(row.subcategory || "-", x + 2, cursorY, {
        width: col[4].width - 4,
        align: col[4].align,
      });
    x += col[4].width;

    // Qty
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(INK_900)
      .text(String(row.quantity ?? 0), x + 2, cursorY, {
        width: col[5].width - 4,
        align: col[5].align,
      });
    x += col[5].width;

    // Purpose
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK_700)
      .text(row.purpose || "-", x + 2, cursorY, {
        width: col[6].width - 6,
        align: col[6].align,
      });

    cursorY += rowHeight;
  }

  // Render each date group
  for (const [dateLabel, rows] of byDate.entries()) {
    let seq = 1;
    drawDateBand(dateLabel);
    rows.forEach((r, idx) => drawRow(seq++, r, idx % 2 === 0));
    cursorY += 6;
  }

  // ---- Monthly Summary Panel
  ensureSpace(4, 20);
  drawDivider(doc, cursorY, BORDER);
  cursorY += 10;

  // Panel background
  const panelH = 84;
  doc
    .save()
    .roundedRect(
      startX,
      cursorY,
      doc.page.width - doc.page.margins.left - doc.page.margins.right,
      panelH,
      10
    )
    .fillOpacity(1)
    .fill(SURFACE)
    .restore();

  // Border
  doc
    .save()
    .lineWidth(1)
    .strokeColor(BORDER)
    .roundedRect(
      startX,
      cursorY,
      doc.page.width - doc.page.margins.left - doc.page.margins.right,
      panelH,
      10
    )
    .stroke()
    .restore();

  const colW =
    (doc.page.width - doc.page.margins.left - doc.page.margins.right - 32) / 3;
  let px = startX + 16;
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

  // Footer with page numbers
  pageFooter(doc, BRAND_GRAD_LEFT);

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
      // Fallback plain text (now with Qty column)
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

        txt += `${seq}. ${format(t.amount)} | ${t.type} | ${t.category} | ${t.subcategory || "-"} | ${t.quantity ?? 0} | ${t.purpose || "-"}\n`;
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

// ----------------- Monthly Summary Email API -----------------
router.post("/monthly-summary/send", async (req, res) => {
  try {
    const { month, year, formatType, email } = req.body;
    if (!month || !year || !formatType || !email) {
      return res
        .status(400)
        .json({ message: "Month, year, formatType, and email are required." });
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

    if (!transactions.length)
      return res.status(404).json({ message: "No transactions found." });

    const monthName = new Date(year, month - 1).toLocaleString("default", {
      month: "long",
    });
    const title = `${monthName} ${year} Transactions`;

    if (formatType === "pdf") {
      // Generate attractive PDF buffer
      const pdfBuffer = await buildMonthlyPDF({
        title,
        monthName,
        year,
        transactions,
        collectBuffer: true,
      });

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: `Monthly Transactions - ${monthName} ${year}`,
        text: `Please find attached your transaction report for ${monthName} ${year}.`,
        attachments: [{ filename: `${title}.pdf`, content: pdfBuffer }],
      });

      return res.json({ message: `PDF sent successfully to ${email}` });
    } else if (formatType === "text") {
      // Text version (with Qty column)
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
        txt += `${seq}. ${format(t.amount)} | ${t.type} | ${t.category} | ${t.subcategory || "-"} | ${t.quantity ?? 0} | ${t.purpose || "-"}\n`;
        seq++;

        if (t.type === "debit") monthTotalDebit += parseFloat(t.amount);
        if (t.type === "credit") monthTotalCredit += parseFloat(t.amount);
        monthTotalTransactions++;
      });

      txt += `\nTotal Transactions (${monthName}): ${monthTotalTransactions}\n`;
      txt += `Total Debit (${monthName}): ${format(monthTotalDebit)}\n`;
      txt += `Total Credit (${monthName}): ${format(monthTotalCredit)}\n`;

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: `Monthly Transactions - ${monthName} ${year}`,
        text: txt,
      });

      return res.json({ message: `Text report sent successfully to ${email}` });
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
      groupedTransactions.push({ date: currentDate, transactions: dailyTransactions });

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
      return res
        .status(404)
        .json({ message: "No transactions found for the specified month/year." });
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
