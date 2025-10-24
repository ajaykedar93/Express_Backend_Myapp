const express = require("express");
const router = express.Router();
const db = require("../db");

// GET all subcategories
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.*, c.category_name 
       FROM Subcategory s 
       LEFT JOIN Category c ON s.category_id=c.category_id
       ORDER BY s.subcategory_name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// ADD subcategory
router.post("/", async (req, res) => {
  const { subcategory_name, category_id } = req.body;
  try {
    const result = await db.query(
      "INSERT INTO Subcategory(subcategory_name, category_id) VALUES($1,$2) RETURNING *",
      [subcategory_name, category_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// UPDATE subcategory
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { subcategory_name, category_id } = req.body;
  try {
    const result = await db.query(
      "UPDATE Subcategory SET subcategory_name=$1, category_id=$2 WHERE subcategory_id=$3 RETURNING *",
      [subcategory_name, category_id, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// DELETE subcategory
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM Subcategory WHERE subcategory_id=$1", [id]);
    res.json({ message: "Subcategory deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
