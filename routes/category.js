const express = require("express");
const router = express.Router();
const db = require("../db");

// GET all categories
router.get("/", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM Category ORDER BY category_name");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// ADD new category
router.post("/", async (req, res) => {
  const { category_name } = req.body;
  try {
    const result = await db.query(
      "INSERT INTO Category(category_name) VALUES($1) RETURNING *",
      [category_name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// UPDATE category
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { category_name } = req.body;
  try {
    const result = await db.query(
      "UPDATE Category SET category_name=$1 WHERE category_id=$2 RETURNING *",
      [category_name, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// DELETE category
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM Category WHERE category_id=$1", [id]);
    res.json({ message: "Category deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
