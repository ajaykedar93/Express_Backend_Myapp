const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");

/*
Table:
CREATE TABLE month_dpr (
    sr_no SERIAL PRIMARY KEY,
    dpr_date DATE NOT NULL,
    work_details TEXT NOT NULL,
    work_time VARCHAR(50)
);
*/

/* =========================================
   Helper: month name list
========================================= */
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/* =========================================
   Helper: validate month/year
========================================= */
function isValidMonthYear(month, year) {
  const m = Number(month);
  const y = Number(year);
  return m >= 1 && m <= 12 && y >= 1900 && y <= 3000;
}

/* =========================================
   Helper: PDF Header
========================================= */
function addPdfHeader(doc, title, monthLabel) {
  const pageWidth = doc.page.width;

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor("#000000")
    .text(title, 40, 30, {
      width: pageWidth - 80,
      align: "center",
      lineBreak: false,
    });

  doc
    .font("Helvetica")
    .fontSize(10)
    .text("Monthly Daily Progress Report", 40, 52, {
      width: pageWidth - 80,
      align: "center",
      lineBreak: false,
    });

  doc
    .font("Helvetica")
    .fontSize(9)
    .text(`Month: ${monthLabel}`, 40, 66, {
      width: pageWidth - 80,
      align: "center",
      lineBreak: false,
    });

  doc.moveTo(40, 88).lineTo(pageWidth - 40, 88).stroke("#000000");
}

/* =========================================
   Helper: calculate row height
========================================= */
function getRowHeight(doc, row, colWidths, fontSize = 9, minHeight = 24) {
  doc.font("Helvetica").fontSize(fontSize);

  let maxHeight = minHeight;

  for (let i = 0; i < row.length; i++) {
    const text = row[i] !== null && row[i] !== undefined ? String(row[i]) : "";

    const textHeight = doc.heightOfString(text, {
      width: colWidths[i] - 10,
      align: "left",
      lineBreak: true,
    });

    const cellHeight = Math.max(minHeight, textHeight + 12);
    if (cellHeight > maxHeight) {
      maxHeight = cellHeight;
    }
  }

  return maxHeight;
}

/* =========================================
   Helper: draw table row
========================================= */
function drawTableRow(doc, row, colWidths, rowHeight, options = {}) {
  const { x, y, fontSize = 9, header = false, aligns = [] } = options;

  let currentX = x;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  if (header) {
    doc.rect(x, y, totalWidth, rowHeight).fillAndStroke("#EDEDED", "#000000");
    doc.font("Helvetica-Bold").fontSize(fontSize).fillColor("#000000");
  } else {
    doc.rect(x, y, totalWidth, rowHeight).stroke("#000000");
    doc.font("Helvetica").fontSize(fontSize).fillColor("#000000");
  }

  for (let i = 0; i < colWidths.length; i++) {
    const cellWidth = colWidths[i];
    const text = row[i] !== null && row[i] !== undefined ? String(row[i]) : "";
    const align = aligns[i] || "left";

    doc.rect(currentX, y, cellWidth, rowHeight).stroke("#000000");

    doc.text(text, currentX + 5, y + 6, {
      width: cellWidth - 10,
      align,
      lineBreak: true,
    });

    currentX += cellWidth;
  }
}

/* =========================================
   1. ADD NEW DPR
   POST /api/monthdpr
========================================= */
router.post("/", async (req, res) => {
  try {
    const { dpr_date, work_details, work_time } = req.body;

    if (!dpr_date || !work_details) {
      return res.status(400).json({
        success: false,
        message: "dpr_date and work_details are required",
      });
    }

    const query = `
      INSERT INTO month_dpr (dpr_date, work_details, work_time)
      VALUES ($1, $2, $3)
      RETURNING 
        sr_no,
        TO_CHAR(dpr_date, 'FMDD Mon YYYY') AS dpr_date,
        work_details,
        work_time
    `;

    const result = await db.query(query, [
      dpr_date,
      work_details,
      work_time || null,
    ]);

    res.status(201).json({
      success: true,
      message: "DPR added successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("ADD DPR ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Server error while adding DPR",
    });
  }
});

/* =========================================
   2. GET ALL DPR
   GET /api/monthdpr
========================================= */
router.get("/", async (req, res) => {
  try {
    const query = `
      SELECT
        ROW_NUMBER() OVER (ORDER BY dpr_date ASC, sr_no ASC) AS sequence_no,
        sr_no,
        dpr_date,
        TO_CHAR(dpr_date, 'FMDD Mon YYYY') AS display_date,
        work_details,
        work_time
      FROM month_dpr
      ORDER BY dpr_date ASC, sr_no ASC
    `;

    const result = await db.query(query);

    res.status(200).json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET ALL DPR ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching DPR data",
    });
  }
});

/* =========================================
   3. EXPORT MONTH DPR PDF
   GET /api/monthdpr/export-pdf?month=4&year=2026
========================================= */
router.get("/export-pdf", async (req, res) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: "month and year are required. Example: ?month=4&year=2026",
      });
    }

    if (!isValidMonthYear(month, year)) {
      return res.status(400).json({
        success: false,
        message: "Invalid month or year",
      });
    }

    const monthNumber = Number(month);
    const yearNumber = Number(year);
    const monthLabel = `${monthNames[monthNumber - 1]} ${yearNumber}`;
    const title = `${monthLabel} DPR`;
    const fileName = `${monthNames[monthNumber - 1]}${yearNumber}DPR.pdf`;

    const query = `
      SELECT
        ROW_NUMBER() OVER (ORDER BY dpr_date ASC, sr_no ASC) AS sequence_no,
        sr_no,
        dpr_date,
        TO_CHAR(dpr_date, 'FMDD Mon YYYY') AS display_date,
        work_details,
        work_time
      FROM month_dpr
      WHERE EXTRACT(MONTH FROM dpr_date) = $1
        AND EXTRACT(YEAR FROM dpr_date) = $2
      ORDER BY dpr_date ASC, sr_no ASC
    `;

    const result = await db.query(query, [monthNumber, yearNumber]);
    const rows = result.rows;

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No DPR records found for ${monthLabel}`,
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: 30,
        bottom: 30,
        left: 40,
        right: 40,
      },
      autoFirstPage: true,
    });

    doc.pipe(res);

    const startX = 40;
    const colWidths = [45, 90, 290, 95];
    const headerRow = ["Sr No", "Date", "Work Details", "Time"];
    const aligns = ["center", "center", "left", "center"];

    const tableStartY = 105;
    const safeBottomY = doc.page.height - 40;

    let currentY = tableStartY;
    let lastDate = null;

    addPdfHeader(doc, title, monthLabel);

    drawTableRow(doc, headerRow, colWidths, 24, {
      x: startX,
      y: currentY,
      fontSize: 9,
      header: true,
      aligns,
    });

    currentY += 24;

    for (const item of rows) {
      const dateToShow = lastDate === item.display_date ? "" : item.display_date;
      lastDate = item.display_date;

      const rowData = [
        item.sequence_no,
        dateToShow,
        item.work_details || "",
        item.work_time || "",
      ];

      const rowHeight = getRowHeight(doc, rowData, colWidths, 9, 24);

      if (currentY + rowHeight > safeBottomY) {
        doc.addPage();

        addPdfHeader(doc, title, monthLabel);

        currentY = tableStartY;

        drawTableRow(doc, headerRow, colWidths, 24, {
          x: startX,
          y: currentY,
          fontSize: 9,
          header: true,
          aligns,
        });

        currentY += 24;
      }

      drawTableRow(doc, rowData, colWidths, rowHeight, {
        x: startX,
        y: currentY,
        fontSize: 9,
        header: false,
        aligns,
      });

      currentY += rowHeight;
    }

    doc.end();
  } catch (error) {
    console.error("EXPORT PDF ERROR:", error);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Server error while generating PDF",
      });
    }
  }
});

/* =========================================
   4. GET SINGLE DPR
   GET /api/monthdpr/:sr_no
========================================= */
router.get("/:sr_no", async (req, res) => {
  try {
    const { sr_no } = req.params;

    const query = `
      SELECT 
        sr_no,
        TO_CHAR(dpr_date, 'YYYY-MM-DD') AS dpr_date,
        TO_CHAR(dpr_date, 'FMDD Mon YYYY') AS display_date,
        work_details,
        work_time
      FROM month_dpr
      WHERE sr_no = $1
    `;

    const result = await db.query(query, [sr_no]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "DPR record not found",
      });
    }

    res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("GET SINGLE DPR ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching DPR record",
    });
  }
});

/* =========================================
   5. UPDATE DPR
   PUT /api/monthdpr/:sr_no
========================================= */
router.put("/:sr_no", async (req, res) => {
  try {
    const { sr_no } = req.params;
    const { dpr_date, work_details, work_time } = req.body;

    if (!dpr_date || !work_details) {
      return res.status(400).json({
        success: false,
        message: "dpr_date and work_details are required",
      });
    }

    const checkQuery = `SELECT sr_no FROM month_dpr WHERE sr_no = $1`;
    const checkResult = await db.query(checkQuery, [sr_no]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "DPR record not found",
      });
    }

    const updateQuery = `
      UPDATE month_dpr
      SET
        dpr_date = $1,
        work_details = $2,
        work_time = $3
      WHERE sr_no = $4
      RETURNING
        sr_no,
        TO_CHAR(dpr_date, 'FMDD Mon YYYY') AS dpr_date,
        work_details,
        work_time
    `;

    const result = await db.query(updateQuery, [
      dpr_date,
      work_details,
      work_time || null,
      sr_no,
    ]);

    res.status(200).json({
      success: true,
      message: "DPR updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("UPDATE DPR ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating DPR",
    });
  }
});

/* =========================================
   6. DELETE DPR
   DELETE /api/monthdpr/:sr_no
========================================= */
router.delete("/:sr_no", async (req, res) => {
  try {
    const { sr_no } = req.params;

    const checkQuery = `SELECT sr_no FROM month_dpr WHERE sr_no = $1`;
    const checkResult = await db.query(checkQuery, [sr_no]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "DPR record not found",
      });
    }

    await db.query(`DELETE FROM month_dpr WHERE sr_no = $1`, [sr_no]);

    res.status(200).json({
      success: true,
      message: "DPR deleted successfully",
    });
  } catch (error) {
    console.error("DELETE DPR ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting DPR",
    });
  }
});

module.exports = router;