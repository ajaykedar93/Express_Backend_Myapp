// src/routes/investment/investment_getview_tradingjournal.js
const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const pool = require("../../db");
const auth = require("../../middleware/auth");

// ==============================
// Helpers
// ==============================
function validateProfitLossBrokerage({ profit, loss, brokerage }) {
  const p = Number(profit);
  const l = Number(loss);
  const b = Number(brokerage);

  if (!Number.isFinite(p) || p < 0) return "profit invalid";
  if (!Number.isFinite(l) || l < 0) return "loss invalid";
  if (!Number.isFinite(b) || b < 0) return "brokerage invalid";

  const ok = (p === 0 && l > 0) || (l === 0 && p > 0) || (p === 0 && l === 0);
  if (!ok) return "Either Profit OR Loss should be > 0 (both cannot be > 0 together)";
  if (p === 0 && l === 0 && b > 0) return "brokerage not allowed when profit=loss=0";

  return "";
}

function formatDateOnly(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

function safeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function numberText(value) {
  return safeNumber(value).toFixed(2).replace(/\.00$/, "");
}

function cleanText(value) {
  if (value === null || value === undefined) return "-";
  const text = String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return text || "-";
}

function cleanOptionalText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return text;
}

function hasMeaningfulText(value) {
  return cleanOptionalText(value).length > 0;
}

function getFilterParams(req) {
  return {
    platformId: req.query.platform_id ? Number(req.query.platform_id) : null,
    segmentId: req.query.segment_id ? Number(req.query.segment_id) : null,
    planId: req.query.plan_id ? Number(req.query.plan_id) : null,
    month: req.query.month ? String(req.query.month) : null,
  };
}

function calcTotals(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.totalProfit += safeNumber(row.profit);
      acc.totalLoss += safeNumber(row.loss);
      acc.totalBrokerage += safeNumber(row.brokerage);
      acc.totalNet += safeNumber(row.net_total);
      return acc;
    },
    {
      totalProfit: 0,
      totalLoss: 0,
      totalBrokerage: 0,
      totalNet: 0,
    }
  );
}

function getMonthLabel(monthValue) {
  const source = monthValue
    ? String(monthValue).slice(0, 10)
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;

  const d = new Date(source);
  if (Number.isNaN(d.getTime())) return "Current Month";
  return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}

async function getTradingJournalRows({ userId, platformId, segmentId, planId, month }) {
  const { rows } = await pool.query(
    `
    WITH chosen AS (
      SELECT date_trunc(
               'month',
               COALESCE($5::date, date_trunc('month', now())::date)
             )::date AS month_start
    )
    SELECT
      j.journal_id,
      j.user_id,
      j.platform_id,
      p.platform_name,
      j.segment_id,
      s.segment_name,
      j.plan_id,
      j.trade_date,
      j.trade_name,
      j.profit,
      j.loss,
      j.brokerage,
      CASE
        WHEN j.profit > 0 THEN j.profit - j.brokerage
        WHEN j.loss > 0 THEN -(j.loss + j.brokerage)
        ELSE 0
      END AS net_total,
      j.trade_logic,
      j.mistakes,
      j.created_at
    FROM investment_tradingjournal j
    JOIN chosen c
      ON date_trunc('month', j.trade_date)::date = c.month_start
    JOIN investment_platform p
      ON p.user_id = j.user_id
     AND p.platform_id = j.platform_id
    JOIN investment_segment s
      ON s.user_id = j.user_id
     AND s.segment_id = j.segment_id
    WHERE j.user_id = $1
      AND ($2::bigint IS NULL OR j.platform_id = $2)
      AND ($3::bigint IS NULL OR j.segment_id = $3)
      AND ($4::bigint IS NULL OR j.plan_id = $4)
    ORDER BY j.trade_date DESC, j.journal_id DESC
    `,
    [userId, platformId, segmentId, planId, month]
  );

  return rows;
}

function getDownloadFileName(prefix, ext) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${prefix}_${yyyy}${mm}${dd}_${hh}${mi}${ss}.${ext}`;
}

function withLeftPadding(text, padSize = 0) {
  const leftPad = " ".repeat(padSize);
  return String(text)
    .split("\n")
    .map((line) => leftPad + line)
    .join("\n");
}

function buildTxtContent({ rows, totals, platformId, segmentId, planId, selectedMonth }) {
  const lines = [];

  lines.push("TRADING JOURNAL REPORT");
  lines.push(`${getMonthLabel(selectedMonth)}`);
  lines.push("=".repeat(90));
  lines.push(`Platform      : ${platformId ?? "All"}`);
  lines.push(`Segment       : ${segmentId ?? "All"}`);
  lines.push(`Plan          : ${planId ?? "All"}`);
  lines.push(`Total Rows    : ${rows.length}`);
  lines.push("-".repeat(90));
  lines.push(`Total Profit  : ${numberText(totals.totalProfit)}`);
  lines.push(`Total Loss    : ${numberText(totals.totalLoss)}`);
  lines.push(`Brokerage     : ${numberText(totals.totalBrokerage)}`);
  lines.push(`Overall Net   : ${numberText(totals.totalNet)}`);
  lines.push("=".repeat(90));
  lines.push("");

  rows.forEach((row, index) => {
    lines.push(`ENTRY #${index + 1}`);
    lines.push("-".repeat(90));
    lines.push(`Journal ID    : ${row.journal_id}`);
    lines.push(`Date          : ${formatDateOnly(row.trade_date)}`);
    lines.push(`Trade Name    : ${cleanText(row.trade_name)}`);
    lines.push(`Platform      : ${cleanText(row.platform_name)}`);
    lines.push(`Segment       : ${cleanText(row.segment_name)}`);
    lines.push(`Profit        : ${numberText(row.profit)}`);
    lines.push(`Loss          : ${numberText(row.loss)}`);
    lines.push(`Brokerage     : ${numberText(row.brokerage)}`);
    lines.push(`Net Total     : ${numberText(row.net_total)}`);

    const logicText = cleanOptionalText(row.trade_logic);
    const mistakesText = cleanOptionalText(row.mistakes);

    if (logicText) {
      lines.push("");
      lines.push("Trade Logic:");
      lines.push(logicText);
    }

    if (mistakesText) {
      lines.push("");
      lines.push("Mistakes:");
      lines.push(mistakesText);
    }

    lines.push("");
    lines.push("=".repeat(90));
    lines.push("");
  });

  return "\uFEFF" + withLeftPadding(lines.join("\n"), 0);
}

async function buildTradingJournalPdfBuffer({
  rows,
  totals,
  monthLabel,
  platformId,
  segmentId,
  planId,
}) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 30, bottom: 28, left: 28, right: 28 },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: "Trading Journal Report",
        Author: "Trading Journal System",
        Subject: "Trading Journal Monthly Export",
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const marginLeft = doc.page.margins.left;
    const marginRight = doc.page.margins.right;
    const marginTop = doc.page.margins.top;
    const marginBottom = doc.page.margins.bottom;
    const contentWidth = pageWidth - marginLeft - marginRight;
    const usableBottom = pageHeight - marginBottom;

    const table = {
      sr: 32,
      date: 70,
      trade: 150,
      platform: 92,
      segment: 88,
      profit: 72,
      loss: 72,
      brokerage: 82,
      net: 82,
    };

    const tableWidth =
      table.sr +
      table.date +
      table.trade +
      table.platform +
      table.segment +
      table.profit +
      table.loss +
      table.brokerage +
      table.net;

    let y = marginTop;

    function pageRemaining() {
      return usableBottom - y;
    }

    function newPage() {
      doc.addPage();
      y = marginTop;
    }

    function ensureSpace(heightNeeded, options = {}) {
      const reserve = options.reserve || 0;
      if (pageRemaining() < heightNeeded + reserve) {
        newPage();
        if (options.drawTableHeader) {
          drawTableHeader();
        }
      }
    }

    function drawHeader() {
      const boxH = 62;
      doc
        .roundedRect(marginLeft, y, contentWidth, boxH, 10)
        .fill("#ffffff")
        .stroke("#d1d5db");

      doc
        .font("Helvetica-Bold")
        .fontSize(20)
        .fillColor("#111827")
        .text("TRADING JOURNAL REPORT", marginLeft + 16, y + 12, {
          width: contentWidth - 32,
          align: "left",
        });

      doc
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#4b5563")
        .text(monthLabel, marginLeft + 16, y + 38, {
          width: contentWidth - 32,
          align: "left",
        });

      y += boxH + 14;
    }

    function drawStats() {
      const gap = 10;
      const boxW = (contentWidth - gap * 3) / 4;
      const boxH = 50;

      const items = [
        { label: "TOTAL PROFIT", value: numberText(totals.totalProfit) },
        { label: "TOTAL LOSS", value: numberText(totals.totalLoss) },
        { label: "BROKERAGE", value: numberText(totals.totalBrokerage) },
        { label: "OVERALL NET", value: numberText(totals.totalNet) },
      ];

      items.forEach((item, i) => {
        const x = marginLeft + i * (boxW + gap);

        doc
          .roundedRect(x, y, boxW, boxH, 8)
          .fill("#ffffff")
          .stroke("#d1d5db");

        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#6b7280")
          .text(item.label, x + 10, y + 9, {
            width: boxW - 20,
            align: "left",
          });

        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .fillColor("#111827")
          .text(item.value, x + 10, y + 24, {
            width: boxW - 20,
            align: "left",
          });
      });

      y += boxH + 14;
    }

    function drawMeta() {
      const boxH = 32;
      doc
        .roundedRect(marginLeft, y, contentWidth, boxH, 6)
        .fill("#ffffff")
        .stroke("#d1d5db");

      doc.font("Helvetica").fontSize(9).fillColor("#374151");
      doc.text(`Platform: ${platformId ?? "All"}`, marginLeft + 12, y + 11);
      doc.text(`Segment: ${segmentId ?? "All"}`, marginLeft + 180, y + 11);
      doc.text(`Plan: ${planId ?? "All"}`, marginLeft + 350, y + 11);
      doc.text(`Rows: ${rows.length}`, marginLeft + 500, y + 11);

      y += boxH + 14;
    }

    function drawTableHeader() {
      const h = 26;
      let x = marginLeft;

      doc
        .roundedRect(marginLeft, y, tableWidth, h, 4)
        .fill("#f3f4f6")
        .stroke("#cfd4dc");

      const headers = [
        ["No", table.sr],
        ["Date", table.date],
        ["Trade Name", table.trade],
        ["Platform", table.platform],
        ["Segment", table.segment],
        ["Profit", table.profit],
        ["Loss", table.loss],
        ["Brokerage", table.brokerage],
        ["Net Total", table.net],
      ];

      headers.forEach(([label, width]) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#111827")
          .text(label, x + 5, y + 9, {
            width: width - 10,
            align: "left",
          });
        x += width;
      });

      y += h;
    }

    function drawVerticalLines(rowTop, rowHeight) {
      let x = marginLeft;
      const widths = [
        table.sr,
        table.date,
        table.trade,
        table.platform,
        table.segment,
        table.profit,
        table.loss,
        table.brokerage,
        table.net,
      ];

      for (let i = 0; i < widths.length - 1; i++) {
        x += widths[i];
        doc
          .moveTo(x, rowTop)
          .lineTo(x, rowTop + rowHeight)
          .lineWidth(0.6)
          .strokeColor("#d1d5db")
          .stroke();
      }
    }

    function mainRowHeight(row, index) {
      const values = [
        String(index + 1),
        formatDateOnly(row.trade_date),
        cleanText(row.trade_name),
        cleanText(row.platform_name),
        cleanText(row.segment_name),
        numberText(row.profit),
        numberText(row.loss),
        numberText(row.brokerage),
        numberText(row.net_total),
      ];

      const widths = [
        table.sr - 10,
        table.date - 10,
        table.trade - 10,
        table.platform - 10,
        table.segment - 10,
        table.profit - 10,
        table.loss - 10,
        table.brokerage - 10,
        table.net - 10,
      ];

      let maxHeight = 0;
      for (let i = 0; i < values.length; i++) {
        const h = doc.heightOfString(values[i], {
          width: widths[i],
          lineGap: 1,
        });
        if (h > maxHeight) maxHeight = h;
      }

      return Math.max(24, maxHeight + 12);
    }

    function detailBlockHeight(row) {
      let total = 0;
      const innerWidth = contentWidth - 24;

      const logic = cleanOptionalText(row.trade_logic);
      const mistakes = cleanOptionalText(row.mistakes);

      if (logic) {
        total += 24;
        total += doc.heightOfString(logic, { width: innerWidth, lineGap: 2 }) + 12;
      }

      if (mistakes) {
        total += 24;
        total += doc.heightOfString(mistakes, { width: innerWidth, lineGap: 2 }) + 12;
      }

      return total > 0 ? total + 8 : 0;
    }

    function drawMainRow(row, index) {
      const rowTop = y;
      const h = mainRowHeight(row, index);

      doc
        .rect(marginLeft, y, tableWidth, h)
        .fill(index % 2 === 0 ? "#ffffff" : "#fafafa")
        .stroke("#d1d5db");

      let x = marginLeft;
      const topY = y + 6;

      function cell(text, width, font = "Helvetica", size = 8, color = "#111827") {
        doc
          .font(font)
          .fontSize(size)
          .fillColor(color)
          .text(String(text ?? "-"), x + 5, topY, {
            width: width - 10,
            align: "left",
            lineGap: 1,
          });
        x += width;
      }

      cell(index + 1, table.sr, "Helvetica-Bold", 8, "#111827");
      cell(formatDateOnly(row.trade_date), table.date, "Helvetica", 8, "#111827");
      cell(cleanText(row.trade_name), table.trade, "Helvetica-Bold", 8, "#111827");
      cell(cleanText(row.platform_name), table.platform, "Helvetica", 8, "#111827");
      cell(cleanText(row.segment_name), table.segment, "Helvetica", 8, "#111827");
      cell(numberText(row.profit), table.profit, "Helvetica-Bold", 8, "#111827");
      cell(numberText(row.loss), table.loss, "Helvetica-Bold", 8, "#111827");
      cell(numberText(row.brokerage), table.brokerage, "Helvetica-Bold", 8, "#111827");
      cell(numberText(row.net_total), table.net, "Helvetica-Bold", 8, "#111827");

      drawVerticalLines(rowTop, h);
      y += h;
    }

    function drawDetailSection(title, value) {
      if (!hasMeaningfulText(value)) return;

      const text = cleanOptionalText(value);
      const sectionTitleH = 18;
      const textH = doc.heightOfString(text, {
        width: contentWidth - 24,
        lineGap: 2,
      });
      const blockH = sectionTitleH + textH + 16;

      ensureSpace(blockH + 8, { drawTableHeader: false });

      doc
        .roundedRect(marginLeft, y + 6, contentWidth, blockH, 6)
        .fill("#ffffff")
        .stroke("#d1d5db");

      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#111827")
        .text(title, marginLeft + 12, y + 16, {
          width: contentWidth - 24,
          align: "left",
        });

      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor("#374151")
        .text(text, marginLeft + 12, y + 34, {
          width: contentWidth - 24,
          align: "left",
          lineGap: 2,
        });

      y += blockH + 12;
    }

    function drawRecord(row, index) {
      const hMain = mainRowHeight(row, index);
      const hDetail = detailBlockHeight(row);
      const required = hMain + hDetail + 8;

      ensureSpace(required, { drawTableHeader: true });

      drawMainRow(row, index);

      if (hasMeaningfulText(row.trade_logic)) {
        drawDetailSection("Trade Logic", row.trade_logic);
      }

      if (hasMeaningfulText(row.mistakes)) {
        drawDetailSection("Mistakes", row.mistakes);
      }
    }

    function drawFooter() {
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);

        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#6b7280")
          .text(`Page ${i + 1} of ${range.count}`, marginLeft, pageHeight - 18, {
            width: contentWidth,
            align: "center",
          });
      }
    }

    drawHeader();
    drawStats();
    drawMeta();
    drawTableHeader();

    rows.forEach((row, index) => {
      drawRecord(row, index);
    });

    drawFooter();
    doc.end();
  });
}

// ==============================
// GET /daily-summary
// ==============================
router.get("/daily-summary", auth, async (req, res) => {
  const userId = req.user.user_id;
  const { platformId, segmentId, planId, month } = getFilterParams(req);

  try {
    const rows = await getTradingJournalRows({
      userId,
      platformId,
      segmentId,
      planId,
      month,
    });

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Daily summary failed", error: e.message });
  }
});

// ==============================
// GET /export/txt
// ==============================
router.get("/export/txt", auth, async (req, res) => {
  const userId = req.user.user_id;
  const { platformId, segmentId, planId, month } = getFilterParams(req);

  try {
    const rows = await getTradingJournalRows({
      userId,
      platformId,
      segmentId,
      planId,
      month,
    });

    if (!rows.length) {
      return res.status(404).json({
        message: "No trading journal data found for selected filters. TXT file was not generated.",
      });
    }

    const totals = calcTotals(rows);
    const selectedMonth = month || new Date().toISOString().slice(0, 7) + "-01";
    const fileName = getDownloadFileName("trading_journal", "txt");
    const txtContent = buildTxtContent({
      rows,
      totals,
      platformId,
      segmentId,
      planId,
      selectedMonth,
    });

    res.status(200);
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(txtContent, "utf8"),
    });

    return res.end(txtContent, "utf8");
  } catch (e) {
    return res.status(500).json({ message: "TXT export failed", error: e.message });
  }
});

// ==============================
// GET /export/pdf
// ==============================
router.get("/export/pdf", auth, async (req, res) => {
  const userId = req.user.user_id;
  const { platformId, segmentId, planId, month } = getFilterParams(req);

  try {
    const rows = await getTradingJournalRows({
      userId,
      platformId,
      segmentId,
      planId,
      month,
    });

    if (!rows.length) {
      return res.status(404).json({
        message: "No trading journal data found for selected filters. PDF file was not generated.",
      });
    }

    const totals = calcTotals(rows);
    const fileName = getDownloadFileName("trading_journal", "pdf");
    const monthLabel = getMonthLabel(month);
    const pdfBuffer = await buildTradingJournalPdfBuffer({
      rows,
      totals,
      monthLabel,
      platformId,
      segmentId,
      planId,
    });

    if (!pdfBuffer || !pdfBuffer.length) {
      return res.status(500).json({
        message: "PDF export failed. Empty PDF buffer generated.",
      });
    }

    res.status(200);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": pdfBuffer.length,
    });

    return res.end(pdfBuffer);
  } catch (e) {
    return res.status(500).json({ message: "PDF export failed", error: e.message });
  }
});

// ==============================
// PUT /:id
// ==============================
router.put("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const journalId = Number(req.params.id);

  if (!journalId) {
    return res.status(400).json({ message: "Invalid journal_id" });
  }

  const {
    platform_id,
    segment_id,
    plan_id,
    trade_date,
    trade_name,
    profit,
    loss,
    brokerage,
    trade_logic,
    mistakes,
  } = req.body;

  const pid = Number(platform_id);
  const sid = Number(segment_id);
  const planId =
    plan_id === null || plan_id === "" || plan_id === undefined ? null : Number(plan_id);

  if (!pid) return res.status(400).json({ message: "platform_id required" });
  if (!sid) return res.status(400).json({ message: "segment_id required" });
  if (!trade_date) return res.status(400).json({ message: "trade_date required" });

  if (!String(trade_name || "").trim()) {
    return res.status(400).json({ message: "trade_name required (Index/Company/Symbol)" });
  }

  if (!String(trade_logic || "").trim()) {
    return res.status(400).json({ message: "trade_logic required" });
  }

  const v = validateProfitLossBrokerage({ profit, loss, brokerage });
  if (v) return res.status(400).json({ message: v });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const chk = await client.query(
      `SELECT 1 FROM investment_tradingjournal WHERE user_id=$1 AND journal_id=$2`,
      [userId, journalId]
    );

    if (!chk.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Journal not found" });
    }

    const seg = await client.query(
      `
      SELECT 1
      FROM investment_segment
      WHERE user_id=$1 AND segment_id=$2 AND platform_id=$3
      `,
      [userId, sid, pid]
    );

    if (!seg.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid platform/segment for user" });
    }

    if (planId) {
      const pl = await client.query(
        `
        SELECT 1
        FROM investment_plan
        WHERE user_id=$1 AND plan_id=$2 AND platform_id=$3 AND segment_id=$4
        `,
        [userId, planId, pid, sid]
      );

      if (!pl.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid plan for user/platform/segment" });
      }
    }

    const upd = await client.query(
      `
      UPDATE investment_tradingjournal
      SET
        platform_id = $1,
        segment_id = $2,
        plan_id = $3,
        trade_date = $4,
        trade_name = $5,
        profit = $6,
        loss = $7,
        brokerage = $8,
        trade_logic = $9,
        mistakes = $10
      WHERE user_id = $11 AND journal_id = $12
      RETURNING
        journal_id,
        user_id,
        platform_id,
        segment_id,
        plan_id,
        trade_date,
        trade_name,
        profit,
        loss,
        brokerage,
        CASE
          WHEN profit > 0 THEN profit - brokerage
          WHEN loss > 0 THEN -(loss + brokerage)
          ELSE 0
        END AS net_total,
        trade_logic,
        mistakes,
        created_at
      `,
      [
        pid,
        sid,
        planId,
        trade_date,
        String(trade_name).trim(),
        Math.trunc(Number(profit)),
        Math.trunc(Number(loss)),
        Math.trunc(Number(brokerage)),
        String(trade_logic).trim(),
        String(mistakes || "").trim() ? String(mistakes).trim() : null,
        userId,
        journalId,
      ]
    );

    await client.query("COMMIT");
    res.json({ data: upd.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ message: "Journal update failed", error: e.message });
  } finally {
    client.release();
  }
});

// ==============================
// DELETE /:id
// ==============================
router.delete("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const id = Number(req.params.id);

  if (!id) return res.status(400).json({ message: "Invalid journal_id" });

  try {
    const result = await pool.query(
      `
      DELETE FROM investment_tradingjournal
      WHERE user_id = $1 AND journal_id = $2
      `,
      [userId, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Journal not found" });
    }

    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Journal delete failed", error: e.message });
  }
});

module.exports = router;