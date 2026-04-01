// investmenttestjouranlpdf.js
const express = require("express");
const PDFDocument = require("pdfkit");
const pool = require("../../db");
const auth = require("../../middleware/auth");

const router = express.Router();

/*
  GET /api/investment/tradingjournal-view/export/pdf?month=2026-03-01&platform_id=1&segment_id=2

  Query params:
  - month       : YYYY-MM-DD (optional, default current month)
  - platform_id : optional
  - segment_id  : optional
*/

router.get("/export/pdf", auth, async (req, res) => {
  const userId = req.user.user_id;

  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;
  const segmentId = req.query.segment_id ? Number(req.query.segment_id) : null;
  const month = req.query.month ? String(req.query.month) : null;

  try {
    const sql = `
      WITH selected_month AS (
        SELECT date_trunc(
                 'month',
                 COALESCE($4::date, date_trunc('month', now())::date)
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
        COALESCE(j.profit, 0) AS profit,
        COALESCE(j.loss, 0) AS loss,
        COALESCE(j.brokerage, 0) AS brokerage,
        CASE
          WHEN COALESCE(j.profit, 0) > 0 THEN COALESCE(j.profit, 0) - COALESCE(j.brokerage, 0)
          WHEN COALESCE(j.loss, 0) > 0 THEN -(COALESCE(j.loss, 0) + COALESCE(j.brokerage, 0))
          ELSE 0
        END AS net_total,
        COALESCE(j.trade_logic, '') AS trade_logic,
        COALESCE(j.mistakes, '') AS mistakes,
        j.created_at
      FROM investment_tradingjournal j
      JOIN selected_month sm
        ON date_trunc('month', j.trade_date)::date = sm.month_start
      JOIN investment_platform p
        ON p.user_id = j.user_id
       AND p.platform_id = j.platform_id
      JOIN investment_segment s
        ON s.user_id = j.user_id
       AND s.segment_id = j.segment_id
      WHERE j.user_id = $1
        AND ($2::bigint IS NULL OR j.platform_id = $2)
        AND ($3::bigint IS NULL OR j.segment_id = $3)
      ORDER BY j.trade_date DESC, j.journal_id DESC
    `;

    const result = await pool.query(sql, [userId, platformId, segmentId, month]);
    const rows = Array.isArray(result.rows) ? result.rows : [];

    const totals = rows.reduce(
      (acc, row) => {
        acc.profit += toNumber(row.profit);
        acc.loss += toNumber(row.loss);
        acc.brokerage += toNumber(row.brokerage);
        acc.net += toNumber(row.net_total);
        return acc;
      },
      { profit: 0, loss: 0, brokerage: 0, net: 0 }
    );

    const monthLabel = getMonthLabel(month);
    const fileName = `Trading_Journal_${monthLabel.replace(/\s+/g, "_")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: 34,
        bottom: 34,
        left: 28,
        right: 28,
      },
      autoFirstPage: true,
      info: {
        Title: `Trading Journal - ${monthLabel}`,
        Author: "Investment Management",
        Subject: "Trading Journal Professional PDF Export",
        Keywords: "Trading Journal, PDF, Export, Investment",
      },
    });

    doc.pipe(res);

    const page = {
      width: doc.page.width,
      height: doc.page.height,
      left: 28,
      right: 28,
      top: 34,
      bottom: 34,
    };

    const contentWidth = page.width - page.left - page.right;
    const safeBottomY = page.height - page.bottom;
    let y = page.top;

    const colors = {
      text: "#111111",
      subText: "#5b6472",
      white: "#ffffff",
      border: "#d9e0e7",
      lightBorder: "#e9eef4",

      dark: "#111827",
      blackBlue: "#0f172a",

      accentBlue: "#2563eb",
      accentPurple: "#7c3aed",

      chipProfitBg: "#ecfdf3",
      chipProfitText: "#15803d",

      chipLossBg: "#fff1f2",
      chipLossText: "#be123c",

      chipBrokerageBg: "#eff6ff",
      chipBrokerageText: "#1d4ed8",

      chipNeutralBg: "#f1f5f9",
      chipNeutralText: "#334155",

      logicBg: "#f8fbff",

      mistakeBg: "#fff5f5",
      mistakeBorder: "#fecaca",
      mistakeText: "#b91c1c",

      pageBgSoft: "#f8fbff",
    };

    function ensureSpace(requiredHeight) {
      if (y + requiredHeight <= safeBottomY) return;

      doc.addPage();
      y = page.top;
      drawMiniTopBand();
    }

    function drawRoundedBox(x, boxY, w, h, r, fillColor, strokeColor = null, strokeWidth = 1) {
      if (fillColor) {
        doc.save();
        doc.roundedRect(x, boxY, w, h, r).fill(fillColor);
        doc.restore();
      }

      if (strokeColor) {
        doc.save();
        doc.lineWidth(strokeWidth);
        doc.strokeColor(strokeColor);
        doc.roundedRect(x, boxY, w, h, r).stroke();
        doc.restore();
      }
    }

    function writeText(text, x, textY, options = {}) {
      const {
        width = contentWidth,
        font = "Helvetica",
        size = 10,
        color = colors.text,
        align = "left",
        lineGap = 0,
        lineBreak = true,
      } = options;

      doc.font(font).fontSize(size).fillColor(color);
      doc.text(String(text ?? ""), x, textY, {
        width,
        align,
        lineGap,
        lineBreak,
      });
    }

    function measureTextHeight(text, width, options = {}) {
      const {
        font = "Helvetica",
        size = 10,
        lineGap = 0,
      } = options;

      doc.font(font).fontSize(size);
      return doc.heightOfString(String(text ?? ""), { width, lineGap });
    }

    function toFixedClean(value) {
      const n = toNumber(value);
      return n.toFixed(10).replace(/\.?0+$/, "");
    }

    function formatDate(value) {
      if (!value) return "-";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);

      return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(d);
    }

    function formatDayMonth(value) {
      if (!value) return { day: "--", month: "---" };
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return { day: "--", month: "---" };

      return {
        day: String(d.getDate()).padStart(2, "0"),
        month: d.toLocaleString("en-US", { month: "short" }).toUpperCase(),
      };
    }

    function getNetTone(value) {
      const n = toNumber(value);
      if (n > 0) return "profit";
      if (n < 0) return "loss";
      return "neutral";
    }

    function drawChip(x, chipY, text, tone = "neutral") {
      let bg = colors.chipNeutralBg;
      let fg = colors.chipNeutralText;

      if (tone === "profit") {
        bg = colors.chipProfitBg;
        fg = colors.chipProfitText;
      } else if (tone === "loss") {
        bg = colors.chipLossBg;
        fg = colors.chipLossText;
      } else if (tone === "brokerage") {
        bg = colors.chipBrokerageBg;
        fg = colors.chipBrokerageText;
      }

      doc.font("Helvetica-Bold").fontSize(9);
      const textWidth = doc.widthOfString(text);
      const chipW = textWidth + 18;
      const chipH = 22;

      drawRoundedBox(x, chipY, chipW, chipH, 11, bg, null);

      writeText(text, x, chipY + 6, {
        width: chipW,
        font: "Helvetica-Bold",
        size: 9,
        color: fg,
        align: "center",
        lineBreak: false,
      });

      return chipW;
    }

    function drawTopBand() {
      doc.save();
      doc.rect(0, 0, page.width, 92).fill(colors.pageBgSoft);
      doc.restore();

      doc.save();
      doc.circle(60, 20, 85).fillOpacity(0.10).fill(colors.accentPurple);
      doc.restore();

      doc.save();
      doc.circle(page.width - 50, 24, 75).fillOpacity(0.08).fill(colors.accentBlue);
      doc.restore();
    }

    function drawMainHeader() {
      drawTopBand();

      writeText("Trading Journal View", page.left, 24, {
        width: contentWidth * 0.5,
        font: "Helvetica-Bold",
        size: 22,
        color: colors.text,
        lineBreak: false,
      });

      writeText("Professional monthly export", page.left, 50, {
        width: contentWidth * 0.45,
        font: "Helvetica",
        size: 10,
        color: colors.subText,
        lineBreak: false,
      });

      const statY = 18;
      const statH = 46;
      const gap = 8;
      const statW = 96;
      const totalStatW = statW * 4 + gap * 3;
      let x = page.width - page.right - totalStatW;

      const statItems = [
        {
          label: "PROFIT",
          value: toFixedClean(totals.profit),
          color: colors.chipProfitText,
        },
        {
          label: "LOSS",
          value: toFixedClean(totals.loss),
          color: colors.chipLossText,
        },
        {
          label: "BROKERAGE",
          value: toFixedClean(totals.brokerage),
          color: colors.chipBrokerageText,
        },
        {
          label: "NET",
          value: toFixedClean(totals.net),
          color:
            getNetTone(totals.net) === "profit"
              ? colors.chipProfitText
              : getNetTone(totals.net) === "loss"
              ? colors.chipLossText
              : colors.chipBrokerageText,
        },
      ];

      statItems.forEach((item) => {
        drawRoundedBox(x, statY, statW, statH, 12, colors.white, colors.border);

        writeText(item.label, x + 8, statY + 7, {
          width: statW - 16,
          font: "Helvetica-Bold",
          size: 7,
          color: colors.subText,
          lineBreak: false,
        });

        writeText(item.value, x + 8, statY + 21, {
          width: statW - 16,
          font: "Helvetica-Bold",
          size: 10,
          color: item.color,
          lineBreak: false,
        });

        x += statW + gap;
      });

      y = 104;

      drawRoundedBox(page.left, y, contentWidth, 46, 16, colors.white, colors.border);

      let chipX = page.left + 14;
      chipX += drawChip(chipX, y + 12, `Month ${monthLabel}`, "brokerage") + 8;
      chipX += drawChip(chipX, y + 12, `Platform ${platformId ? platformId : "All"}`, "neutral") + 8;
      chipX += drawChip(chipX, y + 12, `Segment ${segmentId ? segmentId : "All"}`, "neutral") + 8;
      chipX += drawChip(chipX, y + 12, `Entries ${rows.length}`, "neutral");

      y += 62;
    }

    function drawMiniTopBand() {
      writeText("Trading Journal View", page.left, y, {
        width: contentWidth * 0.6,
        font: "Helvetica-Bold",
        size: 13,
        color: colors.text,
        lineBreak: false,
      });

      writeText(monthLabel, page.left, y + 16, {
        width: contentWidth * 0.5,
        font: "Helvetica",
        size: 9,
        color: colors.subText,
        lineBreak: false,
      });

      y += 34;
    }

    function getCardHeight(row) {
      const logicText = row.trade_logic || "-";
      const mistakesText = row.mistakes || "";

      const logicTextH = measureTextHeight(logicText, contentWidth - 44, {
        font: "Helvetica",
        size: 10,
        lineGap: 2,
      });

      const mistakeTextH = mistakesText
        ? measureTextHeight(mistakesText, contentWidth - 44, {
            font: "Helvetica",
            size: 10,
            lineGap: 2,
          })
        : 14;

      const topArea = 88;
      const logicArea = 34 + logicTextH + 18;
      const mistakeArea = 34 + mistakeTextH + 18;

      return topArea + logicArea + mistakeArea + 10;
    }

    function drawJournalCard(row) {
      const cardH = getCardHeight(row);
      ensureSpace(cardH + 12);

      drawRoundedBox(page.left, y, contentWidth, cardH, 18, colors.white, colors.border);

      doc.save();
      doc.roundedRect(page.left, y, 5, cardH, 18).fill(colors.accentBlue);
      doc.restore();

      const date = formatDayMonth(row.trade_date);

      drawRoundedBox(page.left + 14, y + 14, 56, 60, 14, colors.blackBlue);

      writeText(date.day, page.left + 14, y + 23, {
        width: 56,
        font: "Helvetica-Bold",
        size: 18,
        color: colors.white,
        align: "center",
        lineBreak: false,
      });

      writeText(date.month, page.left + 14, y + 48, {
        width: 56,
        font: "Helvetica-Bold",
        size: 8,
        color: "#e5e7eb",
        align: "center",
        lineBreak: false,
      });

      const mainX = page.left + 82;
      const mainW = contentWidth - 96;

      writeText(row.trade_name || "-", mainX, y + 14, {
        width: mainW - 72,
        font: "Helvetica-Bold",
        size: 14,
        color: colors.text,
      });

      writeText(
        `${formatDate(row.trade_date)} • ${row.platform_name || "-"} • ${row.segment_name || "-"}`,
        mainX,
        y + 34,
        {
          width: mainW - 72,
          font: "Helvetica",
          size: 9,
          color: colors.subText,
          lineBreak: false,
        }
      );

      drawRoundedBox(page.left + contentWidth - 74, y + 14, 60, 22, 11, colors.chipNeutralBg);
      writeText(`#${row.journal_id}`, page.left + contentWidth - 74, y + 21, {
        width: 60,
        font: "Helvetica-Bold",
        size: 8,
        color: colors.chipNeutralText,
        align: "center",
        lineBreak: false,
      });

      let chipX = mainX;
      const chipY = y + 54;

      chipX += drawChip(chipX, chipY, `Profit ${toFixedClean(row.profit)}`, "profit") + 6;
      chipX += drawChip(chipX, chipY, `Loss ${toFixedClean(row.loss)}`, "loss") + 6;
      chipX += drawChip(chipX, chipY, `Brokerage ${toFixedClean(row.brokerage)}`, "brokerage") + 6;
      drawChip(chipX, chipY, `Net ${toFixedClean(row.net_total)}`, getNetTone(row.net_total));

      doc
        .moveTo(page.left + 14, y + 86)
        .lineTo(page.left + contentWidth - 14, y + 86)
        .strokeColor(colors.lightBorder)
        .lineWidth(1)
        .stroke();

      let sectionY = y + 96;

      writeText("TRADE LOGIC", page.left + 16, sectionY, {
        width: contentWidth - 32,
        font: "Helvetica-Bold",
        size: 8,
        color: colors.subText,
        lineBreak: false,
      });

      sectionY += 14;

      const logicText = row.trade_logic || "-";
      const logicTextH = measureTextHeight(logicText, contentWidth - 44, {
        font: "Helvetica",
        size: 10,
        lineGap: 2,
      });

      drawRoundedBox(page.left + 14, sectionY, contentWidth - 28, logicTextH + 16, 12, colors.logicBg);
      writeText(logicText, page.left + 22, sectionY + 8, {
        width: contentWidth - 44,
        font: "Helvetica",
        size: 10,
        color: colors.text,
        lineGap: 2,
      });

      sectionY += logicTextH + 28;

      writeText("MISTAKES", page.left + 16, sectionY, {
        width: contentWidth - 32,
        font: "Helvetica-Bold",
        size: 8,
        color: colors.subText,
        lineBreak: false,
      });

      sectionY += 14;

      if (row.mistakes) {
        const mistakeTextH = measureTextHeight(row.mistakes, contentWidth - 44, {
          font: "Helvetica",
          size: 10,
          lineGap: 2,
        });

        drawRoundedBox(
          page.left + 14,
          sectionY,
          contentWidth - 28,
          mistakeTextH + 16,
          12,
          colors.mistakeBg,
          colors.mistakeBorder
        );

        writeText(row.mistakes, page.left + 22, sectionY + 8, {
          width: contentWidth - 44,
          font: "Helvetica",
          size: 10,
          color: colors.mistakeText,
          lineGap: 2,
        });
      } else {
        drawRoundedBox(
          page.left + 14,
          sectionY,
          contentWidth - 28,
          30,
          12,
          "#fafafa",
          colors.border
        );

        writeText("No mistakes added", page.left + 22, sectionY + 9, {
          width: contentWidth - 44,
          font: "Helvetica",
          size: 10,
          color: colors.subText,
          lineBreak: false,
        });
      }

      y += cardH + 12;
    }

    function drawEmptyState() {
      const h = 78;
      ensureSpace(h + 10);

      drawRoundedBox(page.left, y, contentWidth, h, 18, colors.white, colors.border);

      writeText("No trading journal data found.", page.left, y + 22, {
        width: contentWidth,
        font: "Helvetica-Bold",
        size: 14,
        color: colors.text,
        align: "center",
        lineBreak: false,
      });

      writeText("Try another month, platform, or segment filter.", page.left, y + 44, {
        width: contentWidth,
        font: "Helvetica",
        size: 10,
        color: colors.subText,
        align: "center",
        lineBreak: false,
      });

      y += h + 10;
    }

    drawMainHeader();

    if (!rows.length) {
      drawEmptyState();
    } else {
      rows.forEach((row) => drawJournalCard(row));
    }

    doc.end();
  } catch (error) {
    console.error("Trading journal PDF export failed:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        message: "Trading journal PDF export failed",
        error: error.message,
      });
    }
  }
});

function toNumber(v) {
  const n = Number(String(v ?? 0).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function getMonthLabel(value) {
  try {
    const base = value ? new Date(value) : new Date();

    if (Number.isNaN(base.getTime())) {
      const now = new Date();
      return new Intl.DateTimeFormat("en-GB", {
        month: "long",
        year: "numeric",
      }).format(now);
    }

    return new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
    }).format(base);
  } catch {
    const now = new Date();
    return new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
    }).format(now);
  }
}

module.exports = router;