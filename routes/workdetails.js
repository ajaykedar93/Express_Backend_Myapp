const express = require("express");
const router = express.Router();
const db = require("../db");
const PDFDocument = require("pdfkit");



// ===== GET DPR entries (optionally by category_id) =====
router.get("/dpr", async (req, res) => {
  const { category_id } = req.query;
  try {
    let query = "SELECT * FROM dpr ORDER BY work_date DESC, seq_no ASC";
    const params = [];
    if (category_id) {
      query = "SELECT * FROM dpr WHERE category_id=$1 ORDER BY work_date DESC, seq_no ASC";
      params.push(category_id);
    }
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch DPR entries" });
  }
});// DELETE /api/dpr/delete/:date
router.delete("/dpr/delete/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const dateObj = new Date(date);
    if (isNaN(dateObj.getTime())) return res.status(400).json({ error: "Invalid date" });

    await db.query("DELETE FROM dpr WHERE work_date = $1", [dateObj]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete DPR entries" });
  }
});

// ===== ADD new DPR entry =====
router.post("/dpr", async (req, res) => {
  try {
    let { category_id, work_date, extra_entries, details, work_time } = req.body;

    // Validate required fields
    if (!work_date) return res.status(400).json({ error: "work_date is required" });
    if (!details || !details.trim()) return res.status(400).json({ error: "details is required" });
    if (!work_time || !work_time.trim()) return res.status(400).json({ error: "work_time is required" });

    let dateObj = new Date(work_date);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({ error: "Invalid work_date format" });
    }

    // Process extra_entries if provided
    let extraDetails = [];
    let extraTimes = [];

    if (Array.isArray(extra_entries)) {
      extra_entries.forEach((e) => {
        if (e.detail?.trim() || e.time?.trim()) {
          extraDetails.push(e.detail?.trim() || "");
          extraTimes.push(e.time?.trim() || "");
        }
      });
    }

    // Insert into DB
    const result = await db.query(
      `INSERT INTO dpr
       (category_id, work_date, details, work_time, extra_details, extra_times)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [category_id || null, dateObj, details.trim(), work_time.trim(), extraDetails, extraTimes]
    );

    res.json({ success: true, dpr: result.rows[0] });
  } catch (err) {
    console.error("Error adding DPR entry:", err);
    res.status(500).json({ error: "Failed to add DPR entry" });
  }
});


// ===== UPDATE DPR entry =====
router.put("/dpr/:id", async (req, res) => {
  const { id } = req.params;
  let { category_id, work_date, details, work_time, extra_details, extra_times } = req.body;

  if (!details || !work_time) {
    return res.status(400).json({ error: "Details and work_time are required" });
  }

  try {
    const existing = await db.query("SELECT * FROM dpr WHERE id=$1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "DPR entry not found" });
    }

    // Validate date if provided
    if (work_date) {
      work_date = new Date(work_date);
      if (isNaN(work_date.getTime())) {
        return res.status(400).json({ error: "Invalid work_date format" });
      }
    } else {
      work_date = existing.rows[0].work_date;
    }

    const result = await db.query(
      `UPDATE dpr
       SET category_id=$1,
           work_date=$2,
           details=$3,
           work_time=$4,
           extra_details=$5,
           extra_times=$6
       WHERE id=$7
       RETURNING *`,
      [
        category_id || existing.rows[0].category_id,
        work_date,
        details,
        work_time,
        Array.isArray(extra_details) ? extra_details : existing.rows[0].extra_details,
        Array.isArray(extra_times) ? extra_times : existing.rows[0].extra_times,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating DPR entry:", err);
    res.status(500).json({ error: "Failed to update DPR entry" });
  }
});

// ✅ 1. GET DPR entries by month (arranged by date + sequence)
router.get("/dpr/month/:month", async (req, res) => {
  const { month } = req.params; // Example: January, February, etc.

  try {
    const result = await db.query(
      `SELECT id, seq_no, category_id, details, work_time, extra_details, extra_times,
              TO_CHAR(work_date, 'YYYY-MM-DD') AS work_date, month_name
       FROM dpr
       WHERE month_name = $1
       ORDER BY work_date ASC, seq_no ASC`,
      [month]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching DPR by month:", err);
    res.status(500).json({ error: "Failed to fetch DPR entries" });
  }
});


// ✅ 2. EXPORT DPR entries by month (same but for export use)

// ===== EXPORT DPR entries by month as professional PDF =====
router.get("/dpr/export/:month", async (req, res) => {
  const { month } = req.params;

  try {
    // Fetch DPR data with category names
    const result = await db.query(
      `SELECT d.seq_no, d.details, d.work_time, d.extra_details, d.extra_times,
              TO_CHAR(d.work_date, 'YYYY-MM-DD') AS work_date,
              c.category_name
       FROM dpr d
       LEFT JOIN workcategory c ON d.category_id = c.id
       WHERE d.month_name = $1
       ORDER BY d.work_date ASC, d.seq_no ASC`,
      [month]
    );

    const dprData = result.rows;

    // Create PDF
    const doc = new PDFDocument({ margin: 30, size: "A4" });
    const filename = encodeURIComponent(`DPR_${month}.pdf`);

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/pdf");

    doc.pipe(res);

    // Title
    doc.fontSize(20).font("Helvetica-Bold").text(`DPR Records - ${month}`, { align: "center" });
    doc.moveDown(1);

    // Table settings
    const table = {
      x: 40,
      y: doc.y,
      rowHeight: 25,
      colWidths: {
        seq: 40,
        date: 80,
        category: 100,
        details: 220,
        time: 90,
      },
      pageHeight: doc.page.height - doc.page.margins.bottom,
    };

    // Draw table header
    const drawTableHeader = () => {
      if (table.y + table.rowHeight > table.pageHeight) doc.addPage();
      doc.fontSize(12).font("Helvetica-Bold");
      let x = table.x;
      let y = table.y;

      doc.rect(x, y, table.colWidths.seq, table.rowHeight).stroke();
      doc.text("Seq", x + 5, y + 7, { width: table.colWidths.seq - 10 });

      x += table.colWidths.seq;
      doc.rect(x, y, table.colWidths.date, table.rowHeight).stroke();
      doc.text("Date", x + 5, y + 7, { width: table.colWidths.date - 10 });

      x += table.colWidths.date;
      doc.rect(x, y, table.colWidths.category, table.rowHeight).stroke();
      doc.text("Category", x + 5, y + 7, { width: table.colWidths.category - 10 });

      x += table.colWidths.category;
      doc.rect(x, y, table.colWidths.details, table.rowHeight).stroke();
      doc.text("Details", x + 5, y + 7, { width: table.colWidths.details - 10 });

      x += table.colWidths.details;
      doc.rect(x, y, table.colWidths.time, table.rowHeight).stroke();
      doc.text("Time", x + 5, y + 7, { width: table.colWidths.time - 10 });

      table.y += table.rowHeight;
    };

    // Draw table row
    const drawRow = (seq, date, category, details, time) => {
      if (table.y + table.rowHeight > table.pageHeight) {
        doc.addPage();
        table.y = 30;
        drawTableHeader();
      }

      let x = table.x;
      let y = table.y;
      const rowHeight = table.rowHeight;
      const colWidths = table.colWidths;

      doc.rect(x, y, colWidths.seq, rowHeight).stroke();
      doc.font("Helvetica").text(seq, x + 5, y + 7, { width: colWidths.seq - 10 });

      x += colWidths.seq;
      doc.rect(x, y, colWidths.date, rowHeight).stroke();
      doc.text(date, x + 5, y + 7, { width: colWidths.date - 10 });

      x += colWidths.date;
      doc.rect(x, y, colWidths.category, rowHeight).stroke();
      doc.text(category || "-", x + 5, y + 7, { width: colWidths.category - 10 });

      x += colWidths.category;
      doc.rect(x, y, colWidths.details, rowHeight).stroke();
      doc.text(details || "-", x + 5, y + 7, { width: colWidths.details - 10 });

      x += colWidths.details;
      doc.rect(x, y, colWidths.time, rowHeight).stroke();
      doc.text(time || "-", x + 5, y + 7, { width: colWidths.time - 10 });

      table.y += rowHeight;
    };

    drawTableHeader();

    if (dprData.length === 0) {
      doc.moveDown(1);
      doc.fontSize(12).text("No DPR entries found for this month.", { align: "center" });
    } else {
      let seqCounter = 1;
      dprData.forEach((item) => {
        drawRow(seqCounter++, item.work_date, item.category_name, item.details, item.work_time);

        if (Array.isArray(item.extra_details)) {
          item.extra_details.forEach((extra, eIdx) => {
            drawRow("", "", "", extra, item.extra_times[eIdx] || "");
          });
        }
      });
    }

    // Footer
    doc.moveDown(2);
    doc.fontSize(10).fillColor("gray").text(
      `Generated on: ${new Date().toLocaleString()}`,
      { align: "right" }
    );

    doc.end();
  } catch (err) {
    console.error("Error exporting DPR:", err);
    res.status(500).json({ error: "Failed to export DPR entries" });
  }
});

module.exports = router;
