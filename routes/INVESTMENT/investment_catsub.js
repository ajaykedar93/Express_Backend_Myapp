// routes/INVESTMENT/investment_catsub.js
const express = require("express");
const router = express.Router();
const pool = require("../../db"); // adjust if needed

// ----------------------------
// user id from header "x-user-id"
// ----------------------------
function getUserId(req) {
  const uid = req.user?.user_id || req.headers["x-user-id"] || req.body?.user_id;
  if (!uid) return null;
  const n = parseInt(uid, 10);
  return Number.isNaN(n) ? null : n;
}

/* =========================================================
   CATEGORY APIs
   Table: investment_category (user_id, category_name)
   Path: /api/investment/category
   ========================================================= */

// CREATE
router.post("/investment/category", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const name = String(req.body?.category_name || "").trim();
    if (!name) return res.status(400).json({ message: "category_name is required" });

    const q = `
      INSERT INTO investment_category (user_id, category_name)
      VALUES ($1, $2)
      RETURNING category_id, user_id, category_name, created_at;
    `;
    const result = await pool.query(q, [user_id, name]);
    return res.status(201).json({ message: "Category created", data: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ message: "Category already exists" });
    console.error("POST /api/investment/category error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// LIST
router.get("/investment/category", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const q = `
      SELECT category_id, user_id, category_name, created_at
      FROM investment_category
      WHERE user_id = $1
      ORDER BY created_at DESC, category_id DESC;
    `;
    const result = await pool.query(q, [user_id]);
    return res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /api/investment/category error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// UPDATE
router.put("/investment/category/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const category_id = parseInt(req.params.id, 10);
    if (!category_id) return res.status(400).json({ message: "Invalid category id" });

    const name = String(req.body?.category_name || "").trim();
    if (!name) return res.status(400).json({ message: "category_name is required" });

    const q = `
      UPDATE investment_category
      SET category_name = $1
      WHERE category_id = $2 AND user_id = $3
      RETURNING category_id, user_id, category_name, created_at;
    `;
    const result = await pool.query(q, [name, category_id, user_id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "Category not found" });

    return res.json({ message: "Category updated", data: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ message: "Category name already exists" });
    console.error("PUT /api/investment/category/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE
router.delete("/investment/category/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const category_id = parseInt(req.params.id, 10);
    if (!category_id) return res.status(400).json({ message: "Invalid category id" });

    const q = `
      DELETE FROM investment_category
      WHERE category_id = $1 AND user_id = $2
      RETURNING category_id;
    `;
    const result = await pool.query(q, [category_id, user_id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "Category not found" });

    return res.json({ message: "Category deleted", deleted_id: result.rows[0].category_id });
  } catch (err) {
    console.error("DELETE /api/investment/category/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   SUBCATEGORY APIs
   Table: investment_subcategory (user_id, category_id, subcategory_name, is_options)
   Path: /api/investment/subcategory
   ========================================================= */

// CREATE
router.post("/investment/subcategory", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const catId = parseInt(req.body?.category_id, 10);
    if (!catId) return res.status(400).json({ message: "category_id is required" });

    const name = String(req.body?.subcategory_name || "").trim();
    if (!name) return res.status(400).json({ message: "subcategory_name is required" });

    const is_options = Boolean(req.body?.is_options);

    // ensure category belongs to this user
    const catCheck = await pool.query(
      `SELECT 1 FROM investment_category WHERE user_id=$1 AND category_id=$2`,
      [user_id, catId]
    );
    if (catCheck.rowCount === 0) {
      return res.status(404).json({ message: "Category not found for this user" });
    }

    // IMPORTANT: user_id included (matches your table)
    const q = `
      INSERT INTO investment_subcategory (user_id, category_id, subcategory_name, is_options)
      VALUES ($1, $2, $3, $4)
      RETURNING subcategory_id, user_id, category_id, subcategory_name, is_options, created_at;
    `;
    const result = await pool.query(q, [user_id, catId, name, is_options]);

    return res.status(201).json({ message: "Subcategory created", data: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ message: "Subcategory already exists" });
    console.error("POST /api/investment/subcategory error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// LIST (by category)
router.get("/investment/subcategory", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const category_id = parseInt(req.query?.category_id, 10);
    if (!category_id) return res.status(400).json({ message: "category_id query param is required" });

    // simplest + fastest (no join needed because table has user_id)
    const q = `
      SELECT subcategory_id, user_id, category_id, subcategory_name, is_options, created_at
      FROM investment_subcategory
      WHERE user_id = $1 AND category_id = $2
      ORDER BY created_at DESC, subcategory_id DESC;
    `;
    const result = await pool.query(q, [user_id, category_id]);

    return res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /api/investment/subcategory error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// UPDATE
router.put("/investment/subcategory/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const subcategory_id = parseInt(req.params.id, 10);
    if (!subcategory_id) return res.status(400).json({ message: "Invalid subcategory id" });

    const name = String(req.body?.subcategory_name || "").trim();
    if (!name) return res.status(400).json({ message: "subcategory_name is required" });

    const catId = parseInt(req.body?.category_id, 10);
    if (!catId) return res.status(400).json({ message: "category_id is required" });

    const is_options = Boolean(req.body?.is_options);

    // ensure category belongs to user (avoid moving to other's category)
    const catCheck = await pool.query(
      `SELECT 1 FROM investment_category WHERE user_id=$1 AND category_id=$2`,
      [user_id, catId]
    );
    if (catCheck.rowCount === 0) {
      return res.status(404).json({ message: "Category not found for this user" });
    }

    // ✅ Fix of your earlier "$3 missing" issue:
    // parameters exactly match $1..$5
    const q = `
      UPDATE investment_subcategory
      SET subcategory_name = $1,
          category_id = $2,
          is_options = $3
      WHERE subcategory_id = $4
        AND user_id = $5
      RETURNING subcategory_id, user_id, category_id, subcategory_name, is_options, created_at;
    `;
    const result = await pool.query(q, [name, catId, is_options, subcategory_id, user_id]);

    if (result.rowCount === 0) return res.status(404).json({ message: "Subcategory not found" });
    return res.json({ message: "Subcategory updated", data: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ message: "Subcategory already exists" });
    console.error("PUT /api/investment/subcategory/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE
router.delete("/investment/subcategory/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const subcategory_id = parseInt(req.params.id, 10);
    if (!subcategory_id) return res.status(400).json({ message: "Invalid subcategory id" });

    const q = `
      DELETE FROM investment_subcategory
      WHERE subcategory_id = $1 AND user_id = $2
      RETURNING subcategory_id;
    `;
    const result = await pool.query(q, [subcategory_id, user_id]);

    if (result.rowCount === 0) return res.status(404).json({ message: "Subcategory not found" });
    return res.json({ message: "Subcategory deleted", deleted_id: result.rows[0].subcategory_id });
  } catch (err) {
    console.error("DELETE /api/investment/subcategory/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
