const express = require("express");
const router = express.Router();
const db = require("../db");

// =============================
// 1. Create Category
// =============================
router.post("/", async (req, res) => {
  try {
    const { category_name } = req.body;
    const result = await db.query(
      "INSERT INTO investment_category (category_name) VALUES ($1) RETURNING *",
      [category_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 2. Get All Categories
// =============================
router.get("/", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM investment_category ORDER BY category_id");
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 3. Get Single Category by ID
// =============================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query("SELECT * FROM investment_category WHERE category_id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).send("Category not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 4. Update Category
// =============================
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { category_name } = req.body;
    const result = await db.query(
      "UPDATE investment_category SET category_name = $1 WHERE category_id = $2 RETURNING *",
      [category_name, id]
    );
    if (result.rows.length === 0) return res.status(404).send("Category not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 5. Delete Category
// =============================
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "DELETE FROM investment_category WHERE category_id = $1 RETURNING *",
      [id]
    );
    if (result.rows.length === 0) return res.status(404).send("Category not found");
    res.json({ message: "Category deleted successfully" });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
