const express = require("express");
const router = express.Router();
const pool = require("../../db");

/*
====================================================
CATEGORY API
Base URL:
http://localhost:5000/api/tag_category
====================================================
*/

// CREATE CATEGORY
router.post("/tag_category", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const cleanName = name.trim();

    const existing = await pool.query(
      `SELECT id FROM tog_categories WHERE LOWER(name) = LOWER($1)`,
      [cleanName]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Category already exists" });
    }

    const result = await pool.query(
      `INSERT INTO tog_categories (name)
       VALUES ($1)
       RETURNING *`,
      [cleanName]
    );

    res.status(201).json({
      message: "Category created successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("CREATE CATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET ALL CATEGORY
router.get("/tag_category", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM tog_categories ORDER BY id ASC`
    );

    res.json({
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET CATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET SINGLE CATEGORY
router.get("/tag_category/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid category id" });
    }

    const result = await pool.query(
      `SELECT * FROM tog_categories WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    res.json({
      data: result.rows[0],
    });
  } catch (err) {
    console.error("GET SINGLE CATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// UPDATE CATEGORY
router.put("/tag_category/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid category id" });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const cleanName = name.trim();

    const duplicate = await pool.query(
      `SELECT id FROM tog_categories WHERE LOWER(name) = LOWER($1) AND id <> $2`,
      [cleanName, id]
    );

    if (duplicate.rows.length > 0) {
      return res.status(400).json({ error: "Category already exists" });
    }

    const result = await pool.query(
      `UPDATE tog_categories
       SET name = $1
       WHERE id = $2
       RETURNING *`,
      [cleanName, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    res.json({
      message: "Category updated successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("UPDATE CATEGORY ERROR:", err.message);

    if (err.code === "23503") {
      return res.status(400).json({ error: "Category is used somewhere else" });
    }

    res.status(500).json({ error: "Server error" });
  }
});

// DELETE CATEGORY
router.delete("/tag_category/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid category id" });
    }

    const result = await pool.query(
      `DELETE FROM tog_categories
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    res.json({
      message: "Category deleted successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("DELETE CATEGORY ERROR:", err.message);

    if (err.code === "23503") {
      return res.status(400).json({
        error: "Cannot delete category because it is used in subcategories or transactions",
      });
    }

    res.status(500).json({ error: "Server error" });
  }
});

/*
====================================================
SUBCATEGORY API
Base URL:
http://localhost:5000/api/tag_subcategory
====================================================
*/

// CREATE SUBCATEGORY
router.post("/tag_subcategory", async (req, res) => {
  try {
    const { category_id, name } = req.body;

    if (!category_id || isNaN(Number(category_id))) {
      return res.status(400).json({ error: "Valid category_id is required" });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Subcategory name is required" });
    }

    const cleanName = name.trim();

    const categoryCheck = await pool.query(
      `SELECT * FROM tog_categories WHERE id = $1`,
      [category_id]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    const duplicate = await pool.query(
      `SELECT id FROM tog_subcategories WHERE category_id = $1 AND LOWER(name) = LOWER($2)`,
      [category_id, cleanName]
    );

    if (duplicate.rows.length > 0) {
      return res.status(400).json({ error: "Subcategory already exists in this category" });
    }

    const result = await pool.query(
      `INSERT INTO tog_subcategories (category_id, name)
       VALUES ($1, $2)
       RETURNING *`,
      [category_id, cleanName]
    );

    res.status(201).json({
      message: "Subcategory created successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("CREATE SUBCATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET ALL SUBCATEGORY
router.get("/tag_subcategory", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id,
        s.category_id,
        c.name AS category_name,
        s.name
      FROM tog_subcategories s
      LEFT JOIN tog_categories c ON s.category_id = c.id
      ORDER BY s.id ASC
    `);

    res.json({
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET SUBCATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET SINGLE SUBCATEGORY
router.get("/tag_subcategory/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid subcategory id" });
    }

    const result = await pool.query(
      `
      SELECT 
        s.id,
        s.category_id,
        c.name AS category_name,
        s.name
      FROM tog_subcategories s
      LEFT JOIN tog_categories c ON s.category_id = c.id
      WHERE s.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Subcategory not found" });
    }

    res.json({
      data: result.rows[0],
    });
  } catch (err) {
    console.error("GET SINGLE SUBCATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// UPDATE SUBCATEGORY
router.put("/tag_subcategory/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, name } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid subcategory id" });
    }

    if (!category_id || isNaN(Number(category_id))) {
      return res.status(400).json({ error: "Valid category_id is required" });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Subcategory name is required" });
    }

    const cleanName = name.trim();

    const categoryCheck = await pool.query(
      `SELECT * FROM tog_categories WHERE id = $1`,
      [category_id]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }

    const duplicate = await pool.query(
      `SELECT id FROM tog_subcategories WHERE category_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3`,
      [category_id, cleanName, id]
    );

    if (duplicate.rows.length > 0) {
      return res.status(400).json({ error: "Subcategory already exists in this category" });
    }

    const result = await pool.query(
      `UPDATE tog_subcategories
       SET category_id = $1, name = $2
       WHERE id = $3
       RETURNING *`,
      [category_id, cleanName, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Subcategory not found" });
    }

    res.json({
      message: "Subcategory updated successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("UPDATE SUBCATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE SUBCATEGORY
router.delete("/tag_subcategory/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: "Invalid subcategory id" });
    }

    const result = await pool.query(
      `DELETE FROM tog_subcategories
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Subcategory not found" });
    }

    res.json({
      message: "Subcategory deleted successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("DELETE SUBCATEGORY ERROR:", err.message);

    if (err.code === "23503") {
      return res.status(400).json({
        error: "Cannot delete subcategory because it is used in transactions",
      });
    }

    res.status(500).json({ error: "Server error" });
  }
});

/*
====================================================
GET CATEGORY WITH SUBCATEGORY
====================================================
*/
router.get("/tag_catsub/all", async (req, res) => {
  try {
    const categories = await pool.query(
      `SELECT * FROM tog_categories ORDER BY id ASC`
    );

    const subcategories = await pool.query(
      `SELECT * FROM tog_subcategories ORDER BY id ASC`
    );

    const merged = categories.rows.map((cat) => ({
      ...cat,
      subcategories: subcategories.rows.filter(
        (sub) => Number(sub.category_id) === Number(cat.id)
      ),
    }));

    res.json({
      count: merged.length,
      data: merged,
    });
  } catch (err) {
    console.error("GET CATEGORY SUBCATEGORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;