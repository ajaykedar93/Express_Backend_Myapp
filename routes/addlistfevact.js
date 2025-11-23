// routes/addlistfevact.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const PDFDocument = require("pdfkit");

/* ---------- helpers ---------- */

// normalize actress name (extra safety; DB trigger also does INITCAP)
function normalizeName(name) {
  if (!name) return "";
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// try to parse various date formats; store as JS Date or null
function parseDob(dob) {
  if (!dob) return null;
  // accept "YYYY-MM-DD" or "2 Oct 2025" etc
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// decode base64 image (optional)
function parseImageBase64(str) {
  if (!str) return null;
  try {
    // allow "data:image/png;base64,AAAA" or pure base64
    const base64 = str.includes("base64,")
      ? str.split("base64,").pop()
      : str;
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

/* ==================== CRUD API ==================== */

/**
 * GET /api/add-list-actress
 * List all actresses with continuous sequence numbers (seq: 1..N)
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        ROW_NUMBER() OVER (ORDER BY id) AS seq,
        id,
        actress_name,
        TO_CHAR(dob, 'FMDD Mon YYYY') AS dob,  -- e.g. 2 Oct 2025
        best_movie,
        best_thing,
        country_name,
        created_at,
        updated_at
      FROM add_list_actress
      ORDER BY id;
    `
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET /add-list-actress error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch actress list",
    });
  }
});

/**
 * POST /api/add-list-actress
 * Body JSON:
 * {
 *   "actress_name": "sydney sweeney",          (required)
 *   "dob": "1997-09-12" OR "12 Sep 1997",     (optional)
 *   "best_movie": "...",                      (optional)
 *   "best_thing": "...",                      (optional)
 *   "country_name": "...",                    (optional)
 *   "profile_image_base64": "...."            (optional, base64 string)
 * }
 */
router.post("/", async (req, res) => {
  try {
    const {
      actress_name,
      dob,
      best_movie,
      best_thing,
      country_name,
      profile_image_base64,
    } = req.body || {};

    if (!actress_name || String(actress_name).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "actress_name is required",
      });
    }

    const nameNormalized = normalizeName(actress_name);
    const dobParsed = parseDob(dob);
    const imageBuffer = parseImageBase64(profile_image_base64);

    const result = await pool.query(
      `
      INSERT INTO add_list_actress
        (actress_name, dob, best_movie, best_thing, country_name, profile_image)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        actress_name,
        TO_CHAR(dob, 'FMDD Mon YYYY') AS dob,
        best_movie,
        best_thing,
        country_name,
        created_at,
        updated_at;
    `,
      [nameNormalized, dobParsed, best_movie || null, best_thing || null, country_name || null, imageBuffer]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error("POST /add-list-actress error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create actress",
    });
  }
});

/**
 * PUT /api/add-list-actress/:id
 * Update any fields (same body as POST, all optional)
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;

  if (!id || Number.isNaN(Number(id))) {
    return res.status(400).json({
      success: false,
      message: "Invalid id",
    });
  }

  try {
    const {
      actress_name,
      dob,
      best_movie,
      best_thing,
      country_name,
      profile_image_base64,
    } = req.body || {};

    // build dynamic update set list
    const fields = [];
    const values = [];
    let idx = 1;

    if (actress_name !== undefined) {
      fields.push(`actress_name = $${idx++}`);
      values.push(normalizeName(actress_name));
    }
    if (dob !== undefined) {
      fields.push(`dob = $${idx++}`);
      values.push(parseDob(dob));
    }
    if (best_movie !== undefined) {
      fields.push(`best_movie = $${idx++}`);
      values.push(best_movie || null);
    }
    if (best_thing !== undefined) {
      fields.push(`best_thing = $${idx++}`);
      values.push(best_thing || null);
    }
    if (country_name !== undefined) {
      fields.push(`country_name = $${idx++}`);
      values.push(country_name || null);
    }
    if (profile_image_base64 !== undefined) {
      fields.push(`profile_image = $${idx++}`);
      values.push(parseImageBase64(profile_image_base64));
    }

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    values.push(id);

    const result = await pool.query(
      `
      UPDATE add_list_actress
      SET ${fields.join(", ")}
      WHERE id = $${idx}
      RETURNING
        id,
        actress_name,
        TO_CHAR(dob, 'FMDD Mon YYYY') AS dob,
        best_movie,
        best_thing,
        country_name,
        created_at,
        updated_at;
    `,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Actress not found",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error("PUT /add-list-actress/:id error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update actress",
    });
  }
});

/**
 * DELETE /api/add-list-actress/:id
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  if (!id || Number.isNaN(Number(id))) {
    return res.status(400).json({
      success: false,
      message: "Invalid id",
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM add_list_actress WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Actress not found",
      });
    }

    res.json({
      success: true,
      message: "Actress deleted successfully",
    });
  } catch (err) {
    console.error("DELETE /add-list-actress/:id error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete actress",
    });
  }
});

/* ==================== EXPORT: TEXT & PDF ==================== */

// Helper to fetch list with seq
async function fetchActressList() {
  const result = await pool.query(
    `
    SELECT
      ROW_NUMBER() OVER (ORDER BY id) AS seq,
      id,
      actress_name,
      TO_CHAR(dob, 'FMDD Mon YYYY') AS dob,
      best_movie,
      best_thing,
      country_name
    FROM add_list_actress
    ORDER BY id;
  `
  );
  return result.rows;
}

/**
 * GET /api/add-list-actress/export/txt
 * Download a professional plain-text list
 */
router.get("/export/txt", async (req, res) => {
  try {
    const rows = await fetchActressList();

    let lines = [];
    lines.push("=== Actress Favourite List ===");
    lines.push(`Total: ${rows.length}`);
    lines.push("================================");
    lines.push("");

    rows.forEach((r) => {
      lines.push(
        `${r.seq}. ${r.actress_name || "N/A"}${
          r.country_name ? "  |  Country: " + r.country_name : ""
        }`
      );
      if (r.dob) lines.push(`   DOB: ${r.dob}`);
      if (r.best_movie) lines.push(`   Best Movie/Series: ${r.best_movie}`);
      if (r.best_thing) lines.push(`   Best Thing: ${r.best_thing}`);
      lines.push("--------------------------------");
    });

    const content = lines.join("\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="actress_list.txt"'
    );
    res.send(content);
  } catch (err) {
    console.error("GET /add-list-actress/export/txt error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to export text list",
    });
  }
});

/**
 * GET /api/add-list-actress/export/pdf
 * Download a professional PDF list
 */
router.get("/export/pdf", async (req, res) => {
  try {
    const rows = await fetchActressList();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="actress_list.pdf"'
    );

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    // Title
    doc
      .fontSize(18)
      .text("Actress Favourite List", { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(10)
      .text(`Total: ${rows.length}`, { align: "center" })
      .moveDown(1);

    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke().moveDown(0.8);

    doc.fontSize(11);

    rows.forEach((r) => {
      doc
        .font("Helvetica-Bold")
        .text(`${r.seq}. ${r.actress_name || "N/A"}`, { continued: true });

      if (r.country_name) {
        doc.font("Helvetica").text(`  (${r.country_name})`);
      } else {
        doc.font("Helvetica").text("");
      }

      if (r.dob) doc.text(`DOB: ${r.dob}`);
      if (r.best_movie) doc.text(`Best Movie/Series: ${r.best_movie}`);
      if (r.best_thing) doc.text(`Best Thing: ${r.best_thing}`);

      doc.moveDown(0.3);
      doc
        .moveTo(40, doc.y)
        .lineTo(555, doc.y)
        .stroke()
        .moveDown(0.6);
    });

    doc.end();
  } catch (err) {
    console.error("GET /add-list-actress/export/pdf error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to export PDF list",
    });
  }
});

module.exports = router;
