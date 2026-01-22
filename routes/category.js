const express = require("express");
const router = express.Router();
const db = require("../db");

// --------------------
// Helpers
// --------------------
const isHexColor = (v) => typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v);

const handlePgError = (err, res) => {
  // Unique violation (duplicate)
  if (err && err.code === "23505") {
    return res.status(409).json({ message: "Already exists (duplicate)" });
  }
  // Foreign key violation
  if (err && err.code === "23503") {
    return res.status(409).json({ message: "Cannot delete/update due to existing references" });
  }
  console.error(err);
  return res.status(500).json({ message: "Server Error" });
};

// =====================================================
// CATEGORY ROUTES
// Base: /api/transaction-category/categories
// =====================================================

// GET all categories
router.get("/categories", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT category_id, category_name, category_color
       FROM Category
       ORDER BY category_name`
    );
    res.json(result.rows);
  } catch (err) {
    handlePgError(err, res);
  }
});

// GET single category by id
router.get("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid category id" });

  try {
    const result = await db.query(
      `SELECT category_id, category_name, category_color
       FROM Category
       WHERE category_id = $1`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ message: "Category not found" });
    res.json(result.rows[0]);
  } catch (err) {
    handlePgError(err, res);
  }
});

// ADD new category (name + color)
router.post("/categories", async (req, res) => {
  const { category_name, category_color } = req.body;

  if (!category_name || !String(category_name).trim()) {
    return res.status(400).json({ message: "category_name is required" });
  }

  // color optional, but if provided must be valid
  const colorToSave =
    category_color && String(category_color).trim()
      ? String(category_color).trim()
      : "#000000";

  if (!isHexColor(colorToSave)) {
    return res.status(400).json({ message: "category_color must be HEX like #0284C7" });
  }

  try {
    const result = await db.query(
      `INSERT INTO Category (category_name, category_color)
       VALUES ($1, $2)
       RETURNING category_id, category_name, category_color`,
      [String(category_name).trim(), colorToSave]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    handlePgError(err, res);
  }
});

// UPDATE category (name + color)
router.put("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { category_name, category_color } = req.body;

  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid category id" });
  if (!category_name || !String(category_name).trim()) {
    return res.status(400).json({ message: "category_name is required" });
  }

  const colorToSave =
    category_color && String(category_color).trim()
      ? String(category_color).trim()
      : "#000000";

  if (!isHexColor(colorToSave)) {
    return res.status(400).json({ message: "category_color must be HEX like #0284C7" });
  }

  try {
    const result = await db.query(
      `UPDATE Category
       SET category_name = $1,
           category_color = $2
       WHERE category_id = $3
       RETURNING category_id, category_name, category_color`,
      [String(category_name).trim(), colorToSave, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ message: "Category not found" });
    res.json(result.rows[0]);
  } catch (err) {
    handlePgError(err, res);
  }
});

// DELETE category (subcats auto delete because ON DELETE CASCADE)
router.delete("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid category id" });

  try {
    const result = await db.query(
      `DELETE FROM Category
       WHERE category_id = $1
       RETURNING category_id`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ message: "Category not found" });
    res.json({ message: "Category deleted", category_id: id });
  } catch (err) {
    handlePgError(err, res);
  }
});

// =====================================================
// SUBCATEGORY ROUTES
// Base: /api/transaction-category/subcategories
// =====================================================

// GET subcategories by category
router.get("/categories/:id/subcategories", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid category id" });

  try {
    const result = await db.query(
      `SELECT subcategory_id, subcategory_name, category_id
       FROM Subcategory
       WHERE category_id = $1
       ORDER BY subcategory_name`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    handlePgError(err, res);
  }
});

// ADD subcategory
router.post("/subcategories", async (req, res) => {
  const { subcategory_name, category_id } = req.body;

  const catId = Number(category_id);
  if (!subcategory_name || !String(subcategory_name).trim()) {
    return res.status(400).json({ message: "subcategory_name is required" });
  }
  if (!Number.isFinite(catId)) {
    return res.status(400).json({ message: "category_id is required and must be a number" });
  }

  try {
    // Optional: ensure category exists (gives clean error)
    const cat = await db.query(`SELECT category_id FROM Category WHERE category_id=$1`, [catId]);
    if (cat.rows.length === 0) return res.status(404).json({ message: "Category not found" });

    const result = await db.query(
      `INSERT INTO Subcategory (subcategory_name, category_id)
       VALUES ($1, $2)
       RETURNING subcategory_id, subcategory_name, category_id`,
      [String(subcategory_name).trim(), catId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    handlePgError(err, res);
  }
});

// UPDATE subcategory
router.put("/subcategories/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { subcategory_name } = req.body;

  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid subcategory id" });
  if (!subcategory_name || !String(subcategory_name).trim()) {
    return res.status(400).json({ message: "subcategory_name is required" });
  }

  try {
    const result = await db.query(
      `UPDATE Subcategory
       SET subcategory_name = $1
       WHERE subcategory_id = $2
       RETURNING subcategory_id, subcategory_name, category_id`,
      [String(subcategory_name).trim(), id]
    );

    if (result.rows.length === 0) return res.status(404).json({ message: "Subcategory not found" });
    res.json(result.rows[0]);
  } catch (err) {
    handlePgError(err, res);
  }
});

// DELETE subcategory
router.delete("/subcategories/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid subcategory id" });

  try {
    const result = await db.query(
      `DELETE FROM Subcategory
       WHERE subcategory_id = $1
       RETURNING subcategory_id`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ message: "Subcategory not found" });
    res.json({ message: "Subcategory deleted", subcategory_id: id });
  } catch (err) {
    handlePgError(err, res);
  }
});

module.exports = router;
