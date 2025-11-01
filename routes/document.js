const express = require("express");
const router = express.Router();
const multer = require("multer");
const db = require("../db");

// ------------------
// Multer setup for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ------------------
// UPLOAD DOCUMENT
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { label, purpose, category_id, user_id } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: "No file uploaded." });
    if (!label) return res.status(400).json({ error: "Label is required." });
    if (!user_id) return res.status(400).json({ error: "User ID is required." });

    const categoryIdNum = category_id ? parseInt(category_id) : null;
    const userIdNum = parseInt(user_id);

    const result = await db.query(
      `INSERT INTO documents 
        (user_id, file_name, file_type, label, purpose, category_id, file_data, file_path) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        userIdNum,
        file.originalname,
        file.mimetype,
        label,
        purpose || null,
        categoryIdNum,
        file.buffer,
        "DB_UPLOAD_ONLY"
      ]
    );

    res.json({ success: true, document: result.rows[0] });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------
// GET ALL DOCUMENTS
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT d.document_id, d.user_id, d.file_name, d.file_type, d.label, d.purpose, 
              d.upload_date, d.status,
              c.category_id, c.category_name, c.color
       FROM documents d 
       LEFT JOIN documents_categories c ON d.category_id = c.category_id
       ORDER BY d.upload_date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------
// VIEW / DOWNLOAD DOCUMENT BY ID
router.get("/:id/file", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "SELECT file_name, file_type, file_data FROM documents WHERE document_id=$1",
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Document not found" });

    const doc = result.rows[0];

    // Set headers to allow proper download or inline viewing
    res.setHeader("Content-Disposition", `attachment; filename="${doc.file_name}"`);
    res.setHeader("Content-Type", doc.file_type);
    res.send(doc.file_data);
  } catch (err) {
    console.error("File view/download error:", err);
    res.status(500).json({ error: "Server error" });
  }
});
// VIEW DOCUMENT BY ID — works on Web + Mobile App WebView
router.get("/view/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      "SELECT file_name, file_type, file_data FROM documents WHERE document_id=$1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = result.rows[0];
    const mime = doc.file_type || "application/octet-stream";
    const filename = doc.file_name || "document";

    // For safety, allow all major doc types to render or download in-app browsers
    const inlineTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/gif",
      "text/plain",
    ];

    // ✅ Always include correct Content-Type
    res.setHeader("Content-Type", mime);

    // ✅ For viewable types → render inline (works in web + in-app browsers)
    // ✅ For other types (Word, Excel, ZIP, etc.) → suggest download
    if (inlineTypes.includes(mime)) {
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
    } else {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    }

    // ✅ Cache headers for performance (optional)
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

    // ✅ Send file buffer directly (binary-safe)
    res.end(doc.file_data);
  } catch (err) {
    console.error("View document error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ------------------
// DELETE DOCUMENT
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query("DELETE FROM documents WHERE document_id=$1 RETURNING *", [id]);

    if (result.rows.length === 0) return res.status(404).json({ error: "Document not found" });

    res.json({ success: true, message: "Document deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------
// UPDATE DOCUMENT INFO
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { label, purpose, category_id } = req.body;
    const categoryIdNum = category_id ? parseInt(category_id) : null;

    const result = await db.query(
      `UPDATE documents
       SET label=$1, purpose=$2, category_id=$3
       WHERE document_id=$4 RETURNING *`,
      [label, purpose || null, categoryIdNum, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Document not found" });

    res.json({ success: true, document: result.rows[0] });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------
// CATEGORY ROUTES
// ------------------

// GET ALL CATEGORIES
router.get("/categories", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM documents_categories ORDER BY category_name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("Categories fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ADD NEW CATEGORY
router.post("/categories", async (req, res) => {
  try {
    const { category_name, subcategory, description, color } = req.body;

    if (!category_name) return res.status(400).json({ error: "Category name is required." });

    const result = await db.query(
      `INSERT INTO documents_categories (category_name, subcategory, description, color)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [category_name, subcategory || null, description || null, color || "#6B7280"]
    );

    res.json({ success: true, category: result.rows[0] });
  } catch (err) {
    console.error("Category add error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE CATEGORY
router.delete("/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cat = await db.query("SELECT category_id FROM documents_categories WHERE category_id=$1", [id]);
    if (cat.rows.length === 0) return res.status(404).json({ error: "Category not found" });

    await db.query("DELETE FROM documents_categories WHERE category_id=$1", [id]);
    res.json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    console.error("Category delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get documents by category
router.get("/category/:categoryId", async (req, res) => {
  try {
    const { categoryId } = req.params;

    const result = await db.query(
      `SELECT d.document_id, d.user_id, d.file_name, d.file_type, d.label, d.purpose, 
              d.upload_date, d.status,
              c.category_id, c.category_name, c.color
       FROM documents d 
       LEFT JOIN documents_categories c ON d.category_id = c.category_id
       WHERE d.category_id = $1
       ORDER BY d.upload_date DESC`,
      [categoryId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Category search error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


module.exports = router;
