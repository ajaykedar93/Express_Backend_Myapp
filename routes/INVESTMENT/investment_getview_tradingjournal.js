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

function withLeftPadding(text, padSize = 6) {
  const leftPad = " ".repeat(padSize);
  return String(text)
    .split("\n")
    .map((line) => leftPad + line)
    .join("\n");
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

    const totals = calcTotals(rows);
    const selectedMonth = month || new Date().toISOString().slice(0, 7) + "-01";
    const fileName = getDownloadFileName("trading_journal", "txt");

    const lines = [];
    lines.push("TRADING JOURNAL REPORT");
    lines.push("======================================================================");
    lines.push(`Month            : ${getMonthLabel(selectedMonth)}`);
    lines.push(`Platform Id      : ${platformId ?? "All"}`);
    lines.push(`Segment Id       : ${segmentId ?? "All"}`);
    lines.push(`Plan Id          : ${planId ?? "All"}`);
    lines.push(`Total Rows       : ${rows.length}`);
    lines.push("----------------------------------------------------------------------");
    lines.push(`Total Profit     : ${numberText(totals.totalProfit)}`);
    lines.push(`Total Loss       : ${numberText(totals.totalLoss)}`);
    lines.push(`Total Brokerage  : ${numberText(totals.totalBrokerage)}`);
    lines.push(`Overall Net      : ${numberText(totals.totalNet)}`);
    lines.push("======================================================================");
    lines.push("");

    rows.forEach((row, index) => {
      lines.push(`ENTRY #${index + 1}`);
      lines.push("----------------------------------------------------------------------");
      lines.push(`Journal ID       : ${row.journal_id}`);
      lines.push(`Date             : ${formatDateOnly(row.trade_date)}`);
      lines.push(`Trade Name       : ${cleanText(row.trade_name)}`);
      lines.push(`Platform         : ${cleanText(row.platform_name)}`);
      lines.push(`Segment          : ${cleanText(row.segment_name)}`);
      lines.push(`Profit           : ${numberText(row.profit)}`);
      lines.push(`Loss             : ${numberText(row.loss)}`);
      lines.push(`Brokerage        : ${numberText(row.brokerage)}`);
      lines.push(`Net Total        : ${numberText(row.net_total)}`);
      lines.push("");
      lines.push("Trade Logic:");
      lines.push(cleanText(row.trade_logic));
      lines.push("");
      lines.push("Mistakes:");
      lines.push(cleanText(row.mistakes));
      lines.push("");
      lines.push("======================================================================");
      lines.push("");
    });

    const txtContent = "\uFEFF" + withLeftPadding(lines.join("\n"), 6);

    res.status(200);
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Transfer-Encoding": "binary",
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

    const totals = calcTotals(rows);
    const fileName = getDownloadFileName("trading_journal", "pdf");
    const monthLabel = getMonthLabel(month);

    res.status(200);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Transfer-Encoding": "binary",
      "Cache-Control": "private, no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
    });

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 24, bottom: 24, left: 20, right: 20 },
      bufferPages: true,
      autoFirstPage: false,
      info: {
        Title: "Trading Journal",
        Author: "Trading Journal System",
        Subject: "Trading Journal Monthly Export",
      },
    });

    doc.pipe(res);

    doc.addPage();

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const marginLeft = 20;
    const marginRight = 20;
    const marginTop = 24;
    const marginBottom = 24;
    const contentWidth = pageWidth - marginLeft - marginRight;

    const col = {
      sr: 26,
      date: 68,
      trade: 108,
      platform: 70,
      segment: 68,
      profit: 52,
      loss: 52,
      brokerage: 64,
      net: 56,
    };

    const tableWidth =
      col.sr +
      col.date +
      col.trade +
      col.platform +
      col.segment +
      col.profit +
      col.loss +
      col.brokerage +
      col.net;

    let y = marginTop;

    function startNewContentPage() {
      doc.addPage();
      y = marginTop;
      drawTableHeader();
    }

    function remainingHeight() {
      return pageHeight - marginBottom - y;
    }

    function drawReportHeader() {
      doc.roundedRect(marginLeft, y, contentWidth, 58, 12).fill("#0f172a");

      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(20)
        .text("TRADING JOURNAL", marginLeft + 14, y + 12, {
          width: contentWidth - 28,
          align: "left",
        });

      doc
        .fillColor("#dbeafe")
        .font("Helvetica")
        .fontSize(11)
        .text(monthLabel, marginLeft + 14, y + 35, {
          width: contentWidth - 28,
          align: "left",
        });

      y += 72;
    }

    function drawStats() {
      const gap = 8;
      const statW = (contentWidth - gap * 3) / 4;
      const statH = 46;

      const stats = [
        {
          x: marginLeft,
          label: "TOTAL PROFIT",
          value: numberText(totals.totalProfit),
          fill: "#ecfdf5",
          stroke: "#86efac",
          valueColor: "#166534",
        },
        {
          x: marginLeft + (statW + gap),
          label: "TOTAL LOSS",
          value: numberText(totals.totalLoss),
          fill: "#fef2f2",
          stroke: "#fca5a5",
          valueColor: "#b91c1c",
        },
        {
          x: marginLeft + (statW + gap) * 2,
          label: "BROKERAGE",
          value: numberText(totals.totalBrokerage),
          fill: "#eff6ff",
          stroke: "#93c5fd",
          valueColor: "#1d4ed8",
        },
        {
          x: marginLeft + (statW + gap) * 3,
          label: "OVERALL NET",
          value: numberText(totals.totalNet),
          fill: "#f8fafc",
          stroke: "#cbd5e1",
          valueColor: totals.totalNet >= 0 ? "#166534" : "#b91c1c",
        },
      ];

      stats.forEach((item) => {
        doc.roundedRect(item.x, y, statW, statH, 8).fill(item.fill).stroke(item.stroke);
        doc
          .fillColor("#64748b")
          .font("Helvetica-Bold")
          .fontSize(7.5)
          .text(item.label, item.x + 8, y + 8, { width: statW - 16 });
        doc
          .fillColor(item.valueColor)
          .font("Helvetica-Bold")
          .fontSize(12)
          .text(item.value, item.x + 8, y + 22, { width: statW - 16 });
      });

      y += statH + 14;
    }

    function drawMetaRow() {
      doc.roundedRect(marginLeft, y, contentWidth, 26, 6).fill("#f8fafc").stroke("#e2e8f0");

      doc.fillColor("#334155").font("Helvetica").fontSize(9);
      doc.text(`Platform: ${platformId ?? "All"}`, marginLeft + 10, y + 8);
      doc.text(`Segment: ${segmentId ?? "All"}`, marginLeft + 160, y + 8);
      doc.text(`Plan: ${planId ?? "All"}`, marginLeft + 290, y + 8);
      doc.text(`Rows: ${rows.length}`, marginLeft + 420, y + 8);

      y += 36;
    }

    function drawTableHeader() {
      doc.roundedRect(marginLeft, y, tableWidth, 24, 4).fill("#0f172a");

      let x = marginLeft;
      const headers = [
        ["No", col.sr],
        ["Date", col.date],
        ["Trade", col.trade],
        ["Platform", col.platform],
        ["Segment", col.segment],
        ["Profit", col.profit],
        ["Loss", col.loss],
        ["Brokerage", col.brokerage],
        ["Net", col.net],
      ];

      headers.forEach(([label, width]) => {
        doc
          .fillColor("#ffffff")
          .font("Helvetica-Bold")
          .fontSize(7.5)
          .text(label, x + 4, y + 8, {
            width: width - 8,
            align: "left",
          });
        x += width;
      });

      y += 24;
    }

    function drawVerticalLines(rowTop, rowHeight) {
      let x = marginLeft;
      const widths = [
        col.sr,
        col.date,
        col.trade,
        col.platform,
        col.segment,
        col.profit,
        col.loss,
        col.brokerage,
        col.net,
      ];

      for (let i = 0; i < widths.length - 1; i++) {
        x += widths[i];
        doc
          .moveTo(x, rowTop)
          .lineTo(x, rowTop + rowHeight)
          .strokeColor("#e5e7eb")
          .lineWidth(0.5)
          .stroke();
      }
    }

    function getMainRowHeight(row, index) {
      return (
        Math.max(
          doc.heightOfString(String(index + 1), { width: col.sr - 8 }),
          doc.heightOfString(formatDateOnly(row.trade_date), { width: col.date - 8 }),
          doc.heightOfString(cleanText(row.trade_name), { width: col.trade - 8 }),
          doc.heightOfString(cleanText(row.platform_name), { width: col.platform - 8 }),
          doc.heightOfString(cleanText(row.segment_name), { width: col.segment - 8 }),
          doc.heightOfString(numberText(row.profit), { width: col.profit - 8 }),
          doc.heightOfString(numberText(row.loss), { width: col.loss - 8 }),
          doc.heightOfString(numberText(row.brokerage), { width: col.brokerage - 8 }),
          doc.heightOfString(numberText(row.net_total), { width: col.net - 8 }),
          14
        ) + 12
      );
    }

    function getDetailBlockHeight(row) {
      const innerWidth = contentWidth - 20;

      const logicTitleH = doc.heightOfString("Trade Logic", { width: innerWidth });
      const logicTextH = doc.heightOfString(cleanText(row.trade_logic), {
        width: innerWidth,
        lineGap: 2,
      });

      const mistakesTitleH = doc.heightOfString("Mistakes", { width: innerWidth });
      const mistakesTextH = doc.heightOfString(cleanText(row.mistakes), {
        width: innerWidth,
        lineGap: 2,
      });

      return logicTitleH + logicTextH + mistakesTitleH + mistakesTextH + 34;
    }

    function drawMainRow(row, index) {
      const h = getMainRowHeight(row, index);
      const rowTop = y;

      doc
        .rect(marginLeft, y, tableWidth, h)
        .fill(index % 2 === 0 ? "#ffffff" : "#f8fafc")
        .stroke("#e5e7eb");

      let x = marginLeft;
      const topY = y + 6;

      function drawCell(text, width, color = "#111111", font = "Helvetica", size = 8) {
        doc
          .fillColor(color)
          .font(font)
          .fontSize(size)
          .text(String(text ?? "-"), x + 4, topY, {
            width: width - 8,
            align: "left",
          });
        x += width;
      }

      drawCell(index + 1, col.sr, "#111111", "Helvetica-Bold", 8);
      drawCell(formatDateOnly(row.trade_date), col.date, "#111111", "Helvetica", 8);
      drawCell(cleanText(row.trade_name), col.trade, "#111111", "Helvetica-Bold", 8);
      drawCell(cleanText(row.platform_name), col.platform, "#111111", "Helvetica", 8);
      drawCell(cleanText(row.segment_name), col.segment, "#111111", "Helvetica", 8);
      drawCell(numberText(row.profit), col.profit, "#166534", "Helvetica-Bold", 8);
      drawCell(numberText(row.loss), col.loss, "#dc2626", "Helvetica-Bold", 8);
      drawCell(numberText(row.brokerage), col.brokerage, "#1d4ed8", "Helvetica-Bold", 8);
      drawCell(
        numberText(row.net_total),
        col.net,
        safeNumber(row.net_total) >= 0 ? "#166534" : "#b91c1c",
        "Helvetica-Bold",
        8
      );

      drawVerticalLines(rowTop, h);
      y += h;
    }

    function drawDetailBlock(row) {
      const h = getDetailBlockHeight(row);
      const boxX = marginLeft;
      const boxY = y + 4;
      const boxW = contentWidth;

      doc.roundedRect(boxX, boxY, boxW, h, 8).fill("#ffffff").stroke("#dbeafe");

      const innerX = boxX + 10;
      let innerY = boxY + 10;
      const innerW = boxW - 20;

      doc
        .fillColor("#0f172a")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("Trade Logic", innerX, innerY, {
          width: innerW,
          align: "left",
        });

      innerY += doc.heightOfString("Trade Logic", { width: innerW }) + 4;

      doc
        .fillColor("#334155")
        .font("Helvetica")
        .fontSize(8.5)
        .text(cleanText(row.trade_logic), innerX, innerY, {
          width: innerW,
          align: "left",
          lineGap: 2,
        });

      innerY +=
        doc.heightOfString(cleanText(row.trade_logic), {
          width: innerW,
          lineGap: 2,
        }) + 8;

      doc
        .fillColor("#991b1b")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("Mistakes", innerX, innerY, {
          width: innerW,
          align: "left",
        });

      innerY += doc.heightOfString("Mistakes", { width: innerW }) + 4;

      doc
        .fillColor("#b91c1c")
        .font("Helvetica")
        .fontSize(8.5)
        .text(cleanText(row.mistakes), innerX, innerY, {
          width: innerW,
          align: "left",
          lineGap: 2,
        });

      y = boxY + h + 8;
    }

    function drawFooter() {
      const range = doc.bufferedPageRange();

      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#64748b")
          .text(`Page ${i + 1} of ${range.count}`, marginLeft, pageHeight - 16, {
            align: "center",
            width: contentWidth,
          });
      }
    }

    // First page content
    drawReportHeader();
    drawStats();
    drawMetaRow();

    if (!rows.length) {
      const noDataHeight = 52;
      if (remainingHeight() < noDataHeight + 8) {
        doc.addPage();
        y = marginTop;
      }

      doc.roundedRect(marginLeft, y, contentWidth, 52, 8).fill("#ffffff").stroke("#e5e7eb");

      doc
        .fillColor("#111827")
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("No trading journal data found for selected filters.", marginLeft, y + 18, {
          width: contentWidth,
          align: "center",
        });

      y += 60;
    } else {
      if (remainingHeight() < 24) {
        startNewContentPage();
      } else {
        drawTableHeader();
      }

      rows.forEach((row, index) => {
        const mainH = getMainRowHeight(row, index);
        const detailH = getDetailBlockHeight(row);
        const neededHeight = mainH + detailH + 12;

        if (remainingHeight() < neededHeight) {
          startNewContentPage();
        }

        drawMainRow(row, index);
        drawDetailBlock(row);
      });
    }

    drawFooter();
    doc.end();
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