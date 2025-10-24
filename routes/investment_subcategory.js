const express = require("express");
const router = express.Router();
const db = require("../db");

// =============================
// 1. Create Subcategory
// =============================
router.post("/", async (req, res) => {
  try {
    const { category_id, subcategory_name } = req.body;

    const result = await db.query(
      "INSERT INTO investment_subcategory (category_id, subcategory_name) VALUES ($1, $2) RETURNING *",
      [category_id, subcategory_name]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 2. Get All Subcategories (with category name)
// =============================
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.*, c.category_name
       FROM investment_subcategory s
       JOIN investment_category c ON s.category_id = c.category_id
       ORDER BY s.subcategory_id`
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 3. Get Single Subcategory by ID
// =============================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT s.*, c.category_name
       FROM investment_subcategory s
       JOIN investment_category c ON s.category_id = c.category_id
       WHERE s.subcategory_id = $1`,
      [id]
    );

    if (result.rows.length === 0) return res.status(404).send("Subcategory not found");

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 4. Update Subcategory
// =============================
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, subcategory_name } = req.body;

    const result = await db.query(
      `UPDATE investment_subcategory
       SET category_id = $1, subcategory_name = $2
       WHERE subcategory_id = $3 RETURNING *`,
      [category_id, subcategory_name, id]
    );

    if (result.rows.length === 0) return res.status(404).send("Subcategory not found");

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// =============================
// 5. Delete Subcategory
// =============================
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "DELETE FROM investment_subcategory WHERE subcategory_id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) return res.status(404).send("Subcategory not found");

    res.json({ message: "Subcategory deleted successfully" });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
