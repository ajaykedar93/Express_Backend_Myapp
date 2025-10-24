// routes/Allcategories.js
// CRUD for: categories, subcategories, genres
// - Clean validation
// - Helpful error messages (409 for conflicts, 404 for not found)
// - Case-insensitive unique names via INITCAP (matches DB unique indexes)
//
// Expected DB tables (typical):
//   categories(category_id PK, name UNIQUE CI, color, ...)
//   subcategories(subcategory_id PK, category_id FK->categories, name, UNIQUE(category_id, INITCAP(name)))
//   genres(genre_id PK, name UNIQUE CI)
// Foreign keys from movies/series should use ON DELETE RESTRICT (or NO ACTION)

const express = require("express");
const router = express.Router();
const db = require("../db"); // pg Pool/Client

// --------------------------------------
// helpers
// --------------------------------------
const toInt = (v) => Number(v);
const isInt = (v) => Number.isInteger(v);
const norm = (s = "") => String(s).replace(/\s+/g, " ").trim();
const isHexColor = (s) => typeof s === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s);

// --------------------------------------
// CATEGORIES
// --------------------------------------

/** List categories (id, name, color) */
router.get("/categories", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT category_id, name, color
       FROM categories
       ORDER BY name;`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching categories" });
  }
});

/** Get category by id */
router.get("/categories/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const { rows } = await db.query(
      `SELECT category_id, name, color
       FROM categories
       WHERE category_id=$1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Category not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching category" });
  }
});

/** Create category { name, color } */
router.post("/categories", async (req, res) => {
  try {
    const name = norm(req.body?.name || "");
    const color = norm(req.body?.color || "");

    if (!name) return res.status(400).json({ error: "name is required" });
    if (!color || !isHexColor(color))
      return res.status(400).json({ error: "color must be a hex like #ff0000" });

    const { rows } = await db.query(
      `INSERT INTO categories (name, color)
       VALUES (INITCAP($1), $2)
       RETURNING category_id, name, color;`,
      [name, color]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Category name already exists" });
    }
    res.status(500).json({ error: "Error creating category" });
  }
});

/** Update category by id */
router.put("/categories/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const name = norm(req.body?.name || "");
    const color = norm(req.body?.color || "");
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!color || !isHexColor(color))
      return res.status(400).json({ error: "color must be a hex like #ff0000" });

    const { rows, rowCount } = await db.query(
      `UPDATE categories
       SET name  = INITCAP($1),
           color = $2
       WHERE category_id = $3
       RETURNING category_id, name, color;`,
      [name, color, id]
    );
    if (!rowCount) return res.status(404).json({ error: "Category not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Category name already exists" });
    }
    res.status(500).json({ error: "Error updating category" });
  }
});

/** Delete category by id
 *  Note: movies/series reference categories with ON DELETE RESTRICT.
 *  If in use, deletion will fail with 23503 (foreign key violation).
 */
router.delete("/categories/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const r = await db.query(`DELETE FROM categories WHERE category_id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category deleted" });
  } catch (e) {
    console.error(e);
    if (e.code === "23503") {
      return res
        .status(409)
        .json({ error: "Category is used by movies/series and cannot be deleted" });
    }
    res.status(500).json({ error: "Error deleting category" });
  }
});

// --------------------------------------
// SUBCATEGORIES
// --------------------------------------

/** List subcategories; optional filter by category_id */
router.get("/subcategories", async (req, res) => {
  try {
    const cid = req.query.category_id;
    if (cid == null || cid === "") {
      const { rows } = await db.query(
        `SELECT subcategory_id, category_id, name
         FROM subcategories
         ORDER BY name;`
      );
      return res.json(rows);
    }
    const category_id = toInt(cid);
    if (!isInt(category_id))
      return res.status(400).json({ error: "category_id must be integer" });

    const { rows } = await db.query(
      `SELECT subcategory_id, category_id, name
       FROM subcategories
       WHERE category_id = $1
       ORDER BY name;`,
      [category_id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching subcategories" });
  }
});

/** Get subcategory by id */
router.get("/subcategories/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const { rows } = await db.query(
      `SELECT subcategory_id, category_id, name
       FROM subcategories
       WHERE subcategory_id=$1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Subcategory not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching subcategory" });
  }
});

/** Create subcategory { category_id, name } */
router.post("/subcategories", async (req, res) => {
  try {
    const category_id = toInt(req.body?.category_id);
    const name = norm(req.body?.name || "");
    if (!isInt(category_id)) return res.status(400).json({ error: "category_id is required" });
    if (!name) return res.status(400).json({ error: "name is required" });

    // ensure category exists
    const c = await db.query(`SELECT 1 FROM categories WHERE category_id=$1`, [category_id]);
    if (!c.rowCount) return res.status(400).json({ error: "Category does not exist" });

    const { rows } = await db.query(
      `INSERT INTO subcategories (category_id, name)
       VALUES ($1, INITCAP($2))
       RETURNING subcategory_id, category_id, name;`,
      [category_id, name]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Subcategory already exists in this category" });
    }
    if (e.code === "23503") {
      return res.status(400).json({ error: "Category does not exist" });
    }
    res.status(500).json({ error: "Error creating subcategory" });
  }
});

/** Update subcategory { category_id, name } */
router.put("/subcategories/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const category_id = toInt(req.body?.category_id);
    const name = norm(req.body?.name || "");
    if (!isInt(category_id)) return res.status(400).json({ error: "category_id is required" });
    if (!name) return res.status(400).json({ error: "name is required" });

    // ensure category exists
    const c = await db.query(`SELECT 1 FROM categories WHERE category_id=$1`, [category_id]);
    if (!c.rowCount) return res.status(400).json({ error: "Category does not exist" });

    const { rows, rowCount } = await db.query(
      `UPDATE subcategories
       SET category_id = $1,
           name        = INITCAP($2)
       WHERE subcategory_id = $3
       RETURNING subcategory_id, category_id, name;`,
      [category_id, name, id]
    );
    if (!rowCount) return res.status(404).json({ error: "Subcategory not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Subcategory already exists in this category" });
    }
    if (e.code === "23503") {
      return res
        .status(409)
        .json({ error: "Subcategory is used by movies/series and cannot be moved/deleted" });
    }
    res.status(500).json({ error: "Error updating subcategory" });
  }
});

/** Delete subcategory by id */
router.delete("/subcategories/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const r = await db.query(`DELETE FROM subcategories WHERE subcategory_id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: "Subcategory not found" });
    res.json({ message: "Subcategory deleted" });
  } catch (e) {
    console.error(e);
    if (e.code === "23503") {
      return res
        .status(409)
        .json({ error: "Subcategory is used by movies/series and cannot be deleted" });
    }
    res.status(500).json({ error: "Error deleting subcategory" });
  }
});

// --------------------------------------
// GENRES
// --------------------------------------

/** List genres */
router.get("/genres", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT genre_id, name
       FROM genres
       ORDER BY name;`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching genres" });
  }
});

/** Get genre by id */
router.get("/genres/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const { rows } = await db.query(
      `SELECT genre_id, name
       FROM genres
       WHERE genre_id=$1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Genre not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching genre" });
  }
});

/** Create genre { name } */
router.post("/genres", async (req, res) => {
  try {
    const name = norm(req.body?.name || "");
    if (!name) return res.status(400).json({ error: "name is required" });

    const { rows } = await db.query(
      `INSERT INTO genres (name)
       VALUES (INITCAP($1))
       RETURNING genre_id, name;`,
      [name]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Genre already exists" });
    }
    res.status(500).json({ error: "Error creating genre" });
  }
});

/** Update genre { name } */
router.put("/genres/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const name = norm(req.body?.name || "");
    if (!name) return res.status(400).json({ error: "name is required" });

    const { rows, rowCount } = await db.query(
      `UPDATE genres
       SET name = INITCAP($1)
       WHERE genre_id = $2
       RETURNING genre_id, name;`,
      [name, id]
    );
    if (!rowCount) return res.status(404).json({ error: "Genre not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Genre already exists" });
    }
    res.status(500).json({ error: "Error updating genre" });
  }
});

/** Delete genre by id */
router.delete("/genres/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const r = await db.query(`DELETE FROM genres WHERE genre_id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: "Genre not found" });
    res.json({ message: "Genre deleted" });
  } catch (e) {
    console.error(e);
    if (e.code === "23503") {
      return res.status(409).json({ error: "Genre is used by a movie/series and cannot be deleted" });
    }
    res.status(500).json({ error: "Error deleting genre" });
  }
});

module.exports = router;
