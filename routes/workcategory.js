// routes/workcategory.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// Helper to normalize and validate the name
function cleanName(s) {
  if (typeof s !== "string") return "";
  return s.trim().replace(/\s+/g, " ");
}

// GET all categories
router.get("/", async (_req, res) => {
  try {
    const result = await db.query(
      "SELECT id, category_name FROM workcategory ORDER BY id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single category by id
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await db.query(
      "SELECT id, category_name FROM workcategory WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new category
router.post("/", async (req, res) => {
  try {
    const raw = req.body?.category_name;
    const category_name = cleanName(raw);
    if (!category_name) {
      return res.status(400).json({ error: "category_name is required" });
    }

    const result = await db.query(
      "INSERT INTO workcategory (category_name) VALUES ($1) RETURNING id, category_name",
      [category_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    // Unique violation
    if (err.code === "23505") {
      return res.status(409).json({ error: "Category name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// Update category name
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const raw = req.body?.category_name;
    const category_name = cleanName(raw);
    if (!category_name) {
      return res.status(400).json({ error: "category_name is required" });
    }

    const result = await db.query(
      "UPDATE workcategory SET category_name = $1 WHERE id = $2 RETURNING id, category_name",
      [category_name, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Category name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// Delete category
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await db.query(
      "DELETE FROM workcategory WHERE id = $1 RETURNING id, category_name",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Category not found" });
    }
    res.json({ message: "Category deleted", deleted: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
