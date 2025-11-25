// routes/addlistfevact.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const PDFDocument = require("pdfkit");

/* ---------- helpers ---------- */

// normalize actress name (extra safety; DB trigger may also INITCAP)
function normalizeName(name) {
  if (!name) return "";
  return String(name)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// parse DOB into JS Date or null
function parseDob(dob) {
  if (!dob) return null;
  const d = new Date(dob); // supports "YYYY-MM-DD", "12 Sep 1997", etc.
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// decode base64 image (optional)
function parseImageBase64(str) {
  if (!str) return null;
  try {
    const base64 = str.includes("base64,") ? str.split("base64,").pop() : str;
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

/* ==================== EXPORT ENDPOINTS FIRST (avoid /:id conflict) ==================== */

// Helper to fetch list with seq for exports
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
 */
router.get("/export/txt", async (req, res) => {
  try {
    const rows = await fetchActressList();

    const lines = [];
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
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke().moveDown(0.6);
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

/* ==================== MAIN CRUD API ==================== */

/**
 * GET /api/add-list-actress
 * List all actresses with continuous sequence numbers (seq: 1..N)
 * Also expose a profile_image_path for the React page.
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        ROW_NUMBER() OVER (ORDER BY id) AS seq,
        id,
        actress_name,
        TO_CHAR(dob, 'FMDD Mon YYYY') AS dob,
        best_movie,
        best_thing,
        country_name,
        created_at,
        updated_at,
        '/api/add-list-actress/' || id || '/profile-image' AS profile_image_path
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
 * GET /api/add-list-actress/:id/profile-image
 * Raw binary image – used for small + full image in React.
 */
router.get("/:id/profile-image", async (req, res) => {
  const { id } = req.params;

  if (!id || Number.isNaN(Number(id))) {
    return res.status(400).json({
      success: false,
      message: "Invalid id",
    });
  }

  try {
    const result = await pool.query(
      `SELECT profile_image FROM add_list_actress WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!result.rows.length || !result.rows[0].profile_image) {
      return res.status(404).json({
        success: false,
        message: "No profile image",
      });
    }

    const buf = result.rows[0].profile_image; // Buffer
    // Simple default; you can detect type if you store mime_type.
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.end(buf);
  } catch (err) {
    console.error("GET /add-list-actress/:id/profile-image error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load profile image",
    });
  }
});

/**
 * GET /api/add-list-actress/:id
 * Optional detail endpoint.
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!id || Number.isNaN(Number(id))) {
    return res.status(400).json({
      success: false,
      message: "Invalid id",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        actress_name,
        TO_CHAR(dob, 'FMDD Mon YYYY') AS dob,
        best_movie,
        best_thing,
        country_name,
        created_at,
        updated_at
      FROM add_list_actress
      WHERE id = $1
      LIMIT 1;
    `,
      [id]
    );

    if (!result.rows.length) {
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
    console.error("GET /add-list-actress/:id error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch actress",
    });
  }
});

/**
 * POST /api/add-list-actress
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
      [
        nameNormalized,
        dobParsed,
        best_movie || null,
        best_thing || null,
        country_name || null,
        imageBuffer,
      ]
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
 * shared handler for updating by id (PUT / PATCH)
 */
async function updateActressHandler(req, res) {
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
    console.error("UPDATE /add-list-actress/:id error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update actress",
    });
  }
}

router.put("/:id", updateActressHandler);
router.patch("/:id", updateActressHandler);

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

module.exports = router;
