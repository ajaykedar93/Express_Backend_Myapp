// src/routes/investment/investment_getview_tradingjournal.js
const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const pool = require("../../db");
const auth = require("../../middleware/auth");

// ✅ strict rules
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

/**
 * ✅ GET /daily-summary
 */
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

/**
 * ✅ GET /export/txt
 * Download as text file
 */
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
    const lines = [];

    lines.push("TRADING JOURNAL REPORT");
    lines.push("============================================================");
    lines.push(`Month        : ${selectedMonth}`);
    lines.push(`Platform Id  : ${platformId ?? "All"}`);
    lines.push(`Segment Id   : ${segmentId ?? "All"}`);
    lines.push(`Plan Id      : ${planId ?? "All"}`);
    lines.push(`Total Rows   : ${rows.length}`);
    lines.push("============================================================");
    lines.push(`Total Profit    : ${numberText(totals.totalProfit)}`);
    lines.push(`Total Loss      : ${numberText(totals.totalLoss)}`);
    lines.push(`Total Brokerage : ${numberText(totals.totalBrokerage)}`);
    lines.push(`Overall Net     : ${numberText(totals.totalNet)}`);
    lines.push("============================================================");
    lines.push("");

    rows.forEach((row, index) => {
      lines.push(`Entry #${index + 1}`);
      lines.push("------------------------------------------------------------");
      lines.push(`Journal ID   : ${row.journal_id}`);
      lines.push(`Date         : ${formatDateOnly(row.trade_date)}`);
      lines.push(`Trade Name   : ${row.trade_name || "-"}`);
      lines.push(`Platform     : ${row.platform_name || "-"}`);
      lines.push(`Segment      : ${row.segment_name || "-"}`);
      lines.push(`Profit       : ${numberText(row.profit)}`);
      lines.push(`Loss         : ${numberText(row.loss)}`);
      lines.push(`Brokerage    : ${numberText(row.brokerage)}`);
      lines.push(`Net Total    : ${numberText(row.net_total)}`);
      lines.push(`Trade Logic  : ${row.trade_logic || "-"}`);
      lines.push(`Mistakes     : ${row.mistakes || "-"}`);
      lines.push("");
    });

    const content = lines.join("\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="trading_journal_${Date.now()}.txt"`
    );

    res.send(content);
  } catch (e) {
    res.status(500).json({ message: "TXT export failed", error: e.message });
  }
});

/**
 * ✅ GET /export/pdf
 * Download as professional PDF
 */
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

    const doc = new PDFDocument({
      size: "A4",
      margin: 35,
      bufferPages: true,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="trading_journal_${Date.now()}.pdf"`
    );

    doc.pipe(res);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 35;
    const contentWidth = pageWidth - margin * 2;

    const col = {
      sr: 35,
      date: 65,
      trade: 95,
      platform: 60,
      segment: 60,
      profit: 45,
      loss: 45,
      brokerage: 55,
      net: 50,
    };

    const detailBoxWidth = contentWidth - (
      col.sr +
      col.date +
      col.trade +
      col.platform +
      col.segment +
      col.profit +
      col.loss +
      col.brokerage +
      col.net
    ) - 20;

    const tradeLogicWidth = Math.floor(detailBoxWidth / 2) - 10;
    const mistakesWidth = detailBoxWidth - tradeLogicWidth - 10;

    const tableStartX = margin;
    let y = margin;

    function drawHeaderBlock() {
      doc
        .roundedRect(margin, y, contentWidth, 72, 10)
        .fillAndStroke("#111111", "#111111");

      doc
        .fillColor("#FFFFFF")
        .font("Helvetica-Bold")
        .fontSize(20)
        .text("TRADING JOURNAL REPORT", margin + 15, y + 14, {
          width: contentWidth - 30,
          align: "left",
        });

      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#E5E7EB")
        .text(`Generated: ${new Date().toLocaleString()}`, margin + 15, y + 43);

      y += 85;

      doc
        .roundedRect(margin, y, contentWidth, 62, 8)
        .fillAndStroke("#F8FAFC", "#D1D5DB");

      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11);
      doc.text(`Month: ${month || "Current Month"}`, margin + 12, y + 10);
      doc.text(`Platform: ${platformId ?? "All"}`, margin + 220, y + 10);
      doc.text(`Segment: ${segmentId ?? "All"}`, margin + 380, y + 10);

      doc.text(`Plan: ${planId ?? "All"}`, margin + 12, y + 32);
      doc.text(`Total Rows: ${rows.length}`, margin + 220, y + 32);

      y += 75;

      const boxGap = 10;
      const boxW = (contentWidth - boxGap * 3) / 4;
      const boxH = 52;

      const stats = [
        { label: "TOTAL PROFIT", value: numberText(totals.totalProfit), fill: "#ECFDF5", stroke: "#86EFAC", text: "#166534" },
        { label: "TOTAL LOSS", value: numberText(totals.totalLoss), fill: "#FEF2F2", stroke: "#FCA5A5", text: "#B91C1C" },
        { label: "BROKERAGE", value: numberText(totals.totalBrokerage), fill: "#EFF6FF", stroke: "#93C5FD", text: "#1D4ED8" },
        { label: "OVERALL NET", value: numberText(totals.totalNet), fill: "#F8FAFC", stroke: "#CBD5E1", text: "#111827" },
      ];

      stats.forEach((item, i) => {
        const x = margin + i * (boxW + boxGap);
        doc.roundedRect(x, y, boxW, boxH, 8).fillAndStroke(item.fill, item.stroke);
        doc.fillColor("#64748B").font("Helvetica-Bold").fontSize(8).text(item.label, x + 10, y + 10);
        doc.fillColor(item.text).font("Helvetica-Bold").fontSize(14).text(item.value, x + 10, y + 25);
      });

      y += boxH + 18;
    }

    function drawTableHeader() {
      const headerHeight = 26;

      doc.roundedRect(tableStartX, y, contentWidth, headerHeight, 4).fillAndStroke("#111827", "#111827");

      let x = tableStartX;
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
        ["Trade Logic / Mistakes", detailBoxWidth],
      ];

      headers.forEach(([label, width]) => {
        doc
          .fillColor("#FFFFFF")
          .font("Helvetica-Bold")
          .fontSize(8)
          .text(label, x + 4, y + 8, {
            width: width - 8,
            align: "left",
          });
        x += width;
      });

      y += headerHeight;
    }

    function pageBreakIfNeeded(requiredHeight) {
      if (y + requiredHeight > pageHeight - margin - 30) {
        doc.addPage();
        y = margin;
        drawTableHeader();
      }
    }

    function rowHeight(row, index) {
      const logicText = row.trade_logic || "-";
      const mistakesText = row.mistakes || "-";

      const basicHeight = Math.max(
        doc.heightOfString(String(index + 1), { width: col.sr - 8, align: "left" }),
        doc.heightOfString(formatDateOnly(row.trade_date), { width: col.date - 8, align: "left" }),
        doc.heightOfString(row.trade_name || "-", { width: col.trade - 8, align: "left" }),
        doc.heightOfString(row.platform_name || "-", { width: col.platform - 8, align: "left" }),
        doc.heightOfString(row.segment_name || "-", { width: col.segment - 8, align: "left" }),
        doc.heightOfString(numberText(row.profit), { width: col.profit - 8, align: "left" }),
        doc.heightOfString(numberText(row.loss), { width: col.loss - 8, align: "left" }),
        doc.heightOfString(numberText(row.brokerage), { width: col.brokerage - 8, align: "left" }),
        doc.heightOfString(numberText(row.net_total), { width: col.net - 8, align: "left" })
      );

      const logicLabelHeight = doc.heightOfString("Trade Logic:", {
        width: tradeLogicWidth - 8,
      });
      const logicHeight = doc.heightOfString(logicText, {
        width: tradeLogicWidth - 8,
        align: "left",
      });

      const mistakesLabelHeight = doc.heightOfString("Mistakes:", {
        width: mistakesWidth - 8,
      });
      const mistakesHeight = doc.heightOfString(mistakesText, {
        width: mistakesWidth - 8,
        align: "left",
      });

      const detailHeight = Math.max(
        logicLabelHeight + logicHeight + 8,
        mistakesLabelHeight + mistakesHeight + 8
      );

      return Math.max(basicHeight, detailHeight) + 16;
    }

    function drawRow(row, index) {
      const h = rowHeight(row, index);
      pageBreakIfNeeded(h);

      doc
        .rect(tableStartX, y, contentWidth, h)
        .fillAndStroke(index % 2 === 0 ? "#FFFFFF" : "#F8FAFC", "#E5E7EB");

      let x = tableStartX;

      const normalFont = "Helvetica";
      const boldFont = "Helvetica-Bold";
      const topY = y + 8;

      function cellText(text, width, color = "#111111", font = normalFont, size = 8) {
        doc.fillColor(color).font(font).fontSize(size).text(String(text ?? "-"), x + 4, topY, {
          width: width - 8,
          align: "left",
        });
        x += width;
      }

      cellText(index + 1, col.sr, "#111111", boldFont, 8);
      cellText(formatDateOnly(row.trade_date), col.date, "#111111", normalFont, 8);
      cellText(row.trade_name || "-", col.trade, "#111111", boldFont, 8);
      cellText(row.platform_name || "-", col.platform, "#111111", normalFont, 8);
      cellText(row.segment_name || "-", col.segment, "#111111", normalFont, 8);
      cellText(numberText(row.profit), col.profit, "#166534", boldFont, 8);
      cellText(numberText(row.loss), col.loss, "#B91C1C", boldFont, 8);
      cellText(numberText(row.brokerage), col.brokerage, "#1D4ED8", boldFont, 8);
      cellText(numberText(row.net_total), col.net, row.net_total >= 0 ? "#166534" : "#B91C1C", boldFont, 8);

      const detailX = x;

      const logicX = detailX + 4;
      const mistakesX = detailX + tradeLogicWidth + 6;

      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(8).text("Trade Logic:", logicX, topY, {
        width: tradeLogicWidth - 8,
      });

      const logicLabelH = doc.heightOfString("Trade Logic:", { width: tradeLogicWidth - 8 });

      doc.fillColor("#111111").font("Helvetica").fontSize(8).text(row.trade_logic || "-", logicX, topY + logicLabelH + 2, {
        width: tradeLogicWidth - 8,
        align: "left",
      });

      doc.fillColor("#B91C1C").font("Helvetica-Bold").fontSize(8).text("Mistakes:", mistakesX, topY, {
        width: mistakesWidth - 8,
      });

      const mistakesLabelH = doc.heightOfString("Mistakes:", { width: mistakesWidth - 8 });

      doc.fillColor("#B91C1C").font("Helvetica").fontSize(8).text(row.mistakes || "-", mistakesX, topY + mistakesLabelH + 2, {
        width: mistakesWidth - 8,
        align: "left",
      });

      let lineX = tableStartX;
      [
        col.sr,
        col.date,
        col.trade,
        col.platform,
        col.segment,
        col.profit,
        col.loss,
        col.brokerage,
        col.net,
        detailBoxWidth,
      ].forEach((w, idx, arr) => {
        if (idx < arr.length - 1) {
          lineX += w;
          doc.moveTo(lineX, y).lineTo(lineX, y + h).strokeColor("#E5E7EB").stroke();
        }
      });

      y += h;
    }

    function drawFooter() {
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#64748B")
          .text(
            `Page ${i + 1} of ${range.count}`,
            margin,
            pageHeight - 22,
            { align: "center", width: contentWidth }
          );
      }
    }

    drawHeaderBlock();
    drawTableHeader();

    if (!rows.length) {
      doc
        .fillColor("#111111")
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("No trading journal data found for selected filters.", margin, y + 20, {
          width: contentWidth,
          align: "center",
        });
    } else {
      rows.forEach((row, index) => drawRow(row, index));
    }

    drawFooter();
    doc.end();
  } catch (e) {
    res.status(500).json({ message: "PDF export failed", error: e.message });
  }
});

/**
 * ✅ PUT /:id  (update row)
 */
router.put("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const journalId = Number(req.params.id);
  if (!journalId) return res.status(400).json({ message: "Invalid journal_id" });

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

  if (!trade_logic?.trim()) {
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
        net_pnl,
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
        trade_logic.trim(),
        mistakes?.trim() ? mistakes.trim() : null,
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

/**
 * ✅ DELETE /:id
 */
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