// routes/transactioncategory.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// -----------------------------------------------------------------------------
// Schema (PostgreSQL, case-insensitive identifiers => stored as lowercase)
//   category(
//     category_id serial PK,
//     category_name varchar(50) UNIQUE NOT NULL,
//     category_color varchar(7) DEFAULT '#000000'  -- HEX #RRGGBB
//   )
//
//   subcategory(
//     subcategory_id serial PK,
//     subcategory_name varchar(50) NOT NULL,
//     category_id int NOT NULL REFERENCES category(category_id) ON DELETE CASCADE,
//     UNIQUE(subcategory_name, category_id)
//   )
// -----------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const HEX_COLOR_RE = /^#([0-9a-fA-F]{6})$/;

function isValidHex(hex) {
  return !hex || HEX_COLOR_RE.test(hex);
}
function normHex(hex) {
  return hex ? String(hex).toUpperCase() : hex;
}
function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}
function pgIsUniqueViolation(err) {
  return err && err.code === "23505"; // unique_violation
}
function pgIsForeignKeyViolation(err) {
  return err && err.code === "23503"; // foreign_key_violation
}
function badRequest(res, msg) {
  return res.status(400).json({ error: msg || "Bad Request" });
}
function notFound(res, msg) {
  return res.status(404).json({ error: msg || "Not Found" });
}
function serverError(res, err, label) {
  console.error(label || "Server Error:", err);
  return res.status(500).json({ error: "Internal Server Error" });
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY ENDPOINTS
// Mount this router at: /api/transaction-category (recommended)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /categories
 * Query params:
 *  - search       : string (ILIKE on category_name)
 *  - limit        : number
 *  - offset       : number
 *  - includeSub   : "true" to include subcategories grouped under each category
 *  - color        : #RRGGBB exact match (case-insensitive)
 */
router.get("/categories", async (req, res) => {
  try {
    const { search = "", limit, offset, includeSub, color } = req.query;

    const clauses = [];
    const params = [];
    let idx = 1;

    if (search) {
      clauses.push(`category_name ILIKE $${idx++}`);
      params.push(`%${String(search).trim()}%`);
    }

    if (color) {
      const hex = String(color).trim();
      if (!HEX_COLOR_RE.test(hex)) {
        return badRequest(res, "Invalid color. Use #RRGGBB.");
      }
      clauses.push(`UPPER(category_color) = UPPER($${idx++})`);
      params.push(hex);
    }

    const whereSQL = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const baseSQL = `
      SELECT category_id, category_name, category_color
      FROM category
      ${whereSQL}
      ORDER BY category_name ASC
    `;

    const hasLimit = Number.isInteger(+limit);
    const hasOffset = Number.isInteger(+offset);

    const paginatedSQL =
      hasLimit || hasOffset
        ? `${baseSQL} ${hasLimit ? `LIMIT ${+limit}` : ""} ${hasOffset ? `OFFSET ${+offset}` : ""}`
        : baseSQL;

    const { rows: cats } = await db.query(paginatedSQL, params);

    // Optionally include subcategories grouped under each category
    if (String(includeSub).toLowerCase() === "true" && cats.length) {
      const ids = cats.map((c) => c.category_id);
      const { rows: subs } = await db.query(
        `SELECT subcategory_id, subcategory_name, category_id
         FROM subcategory
         WHERE category_id = ANY($1::int[])
         ORDER BY subcategory_name ASC`,
        [ids]
      );

      const map = new Map(cats.map((c) => [c.category_id, { ...c, subcategories: [] }]));
      subs.forEach((s) => {
        const bucket = map.get(s.category_id);
        if (bucket) bucket.subcategories.push(s);
      });

      return res.status(200).json(Array.from(map.values()));
    }

    return res.status(200).json(cats);
  } catch (err) {
    return serverError(res, err, "Error fetching categories");
  }
});

/**
 * GET /categories/by-color
 * Returns categories grouped by color.
 * Query params:
 *  - colors       : comma-separated list of #RRGGBB (optional)
 *  - minCount     : integer (default 1). Use 2 to get only colors shared by 2+ categories.
 *  - search       : string (optional, narrows names inside groups)
 */
router.get("/categories/by-color", async (req, res) => {
  try {
    const { colors = "", minCount = "1", search = "" } = req.query;

    const params = [];
    let idx = 1;
    const whereParts = [];

    if (search) {
      whereParts.push(`c.category_name ILIKE $${idx++}`);
      params.push(`%${String(search).trim()}%`);
    }

    if (colors) {
      const colorArray = String(colors)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const c of colorArray) {
        if (!HEX_COLOR_RE.test(c)) {
          return badRequest(res, `Invalid color '${c}'. Use #RRGGBB.`);
        }
      }

      whereParts.push(`UPPER(c.category_color) = ANY($${idx++})`);
      params.push(colorArray.map((c) => c.toUpperCase()));
    }

    const min = Math.max(parseInt(minCount, 10) || 1, 1);
    const whereSQL = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const havingSQL = `HAVING COUNT(*) >= ${min}`;

    const sql = `
      SELECT
        UPPER(c.category_color) AS color,
        json_agg(
          json_build_object(
            'category_id', c.category_id,
            'category_name', c.category_name,
            'category_color', c.category_color
          )
          ORDER BY c.category_name ASC
        ) AS categories
      FROM category c
      ${whereSQL}
      GROUP BY UPPER(c.category_color)
      ${havingSQL}
      ORDER BY color ASC
    `;

    const { rows } = await db.query(sql, params);

    const result = rows.map((r) => ({
      color: r.color, // #RRGGBB uppercase
      categories: r.categories,
    }));

    return res.status(200).json(result);
  } catch (err) {
    return serverError(res, err, "Error fetching categories by color");
  }
});

/**
 * GET /categories/with-subcategories
 * Convenience endpoint: all categories + nested subcategories
 */
router.get("/categories/with-subcategories", async (_req, res) => {
  try {
    const { rows: cats } = await db.query(
      `SELECT category_id, category_name, category_color
       FROM category
       ORDER BY category_name ASC`
    );
    if (!cats.length) return res.status(200).json([]);

    const ids = cats.map((c) => c.category_id);
    const { rows: subs } = await db.query(
      `SELECT subcategory_id, subcategory_name, category_id
       FROM subcategory
       WHERE category_id = ANY($1::int[])
       ORDER BY subcategory_name ASC`,
      [ids]
    );

    const map = new Map(cats.map((c) => [c.category_id, { ...c, subcategories: [] }]));
    subs.forEach((s) => {
      const bucket = map.get(s.category_id);
      if (bucket) bucket.subcategories.push(s);
    });

    return res.status(200).json(Array.from(map.values()));
  } catch (err) {
    return serverError(res, err, "Error fetching categories with subcategories");
  }
});

/**
 * GET /categories/summary
 * Returns { total_categories, total_subcategories }
 */
router.get("/categories/summary", async (_req, res) => {
  try {
    const { rows: a } = await db.query(`SELECT COUNT(*)::int AS total_categories FROM category`);
    const { rows: b } = await db.query(`SELECT COUNT(*)::int AS total_subcategories FROM subcategory`);
    return res.status(200).json({ ...a[0], ...b[0] });
  } catch (err) {
    return serverError(res, err, "Error fetching summary");
  }
});

/**
 * GET /colors
 * Distinct list of colors currently used by categories (palette)
 */
router.get("/colors", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT category_color
       FROM category
       WHERE category_color IS NOT NULL
       ORDER BY category_color ASC`
    );
    return res.status(200).json(rows.map((r) => r.category_color));
  } catch (err) {
    return serverError(res, err, "Error fetching colors");
  }
});

/**
 * POST /categories
 * Body: { category_name, category_color? }
 */
router.post("/categories", async (req, res) => {
  try {
    let { category_name, category_color } = req.body || {};
    if (!category_name || String(category_name).trim() === "") {
      return badRequest(res, "category_name is required");
    }
    category_name = String(category_name).trim();
    category_color = normHex(category_color);

    if (!isValidHex(category_color)) {
      return badRequest(res, "category_color must be HEX like #RRGGBB");
    }

    const { rows } = await db.query(
      `INSERT INTO category (category_name, category_color)
       VALUES ($1, COALESCE($2, '#000000'))
       RETURNING category_id, category_name, category_color`,
      [category_name, category_color || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (pgIsUniqueViolation(err)) {
      return res.status(409).json({ error: "Category name already exists" });
    }
    return serverError(res, err, "Error creating category");
  }
});

/**
 * PUT /categories/:id
 * Body: { category_name?, category_color? }
 */
router.put("/categories/:id", async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (Number.isNaN(id)) return badRequest(res, "Invalid category id");

    let { category_name, category_color } = req.body || {};
    const fields = [];
    const values = [];
    let idx = 1;

    if (category_name && String(category_name).trim() !== "") {
      fields.push(`category_name = $${idx++}`);
      values.push(String(category_name).trim());
    }

    if (category_color !== undefined) {
      category_color = normHex(category_color);
      if (category_color && !isValidHex(category_color)) {
        return badRequest(res, "category_color must be HEX like #RRGGBB");
      }
      fields.push(`category_color = $${idx++}`);
      values.push(category_color || null);
    }

    if (fields.length === 0) {
      return badRequest(res, "Nothing to update");
    }

    values.push(id);
    const sql = `
      UPDATE category
      SET ${fields.join(", ")}
      WHERE category_id = $${idx}
      RETURNING category_id, category_name, category_color
    `;
    const { rowCount, rows } = await db.query(sql, values);
    if (rowCount === 0) return notFound(res, "Category not found");

    return res.status(200).json(rows[0]);
  } catch (err) {
    if (pgIsUniqueViolation(err)) {
      return res.status(409).json({ error: "Category name already exists" });
    }
    return serverError(res, err, "Error updating category");
  }
});

/**
 * DELETE /categories/:id
 * Cascade deletion of its subcategories (by FK ON DELETE CASCADE)
 */
router.delete("/categories/:id", async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (Number.isNaN(id)) return badRequest(res, "Invalid category id");

    const { rowCount, rows } = await db.query(
      `DELETE FROM category
       WHERE category_id = $1
       RETURNING category_id, category_name, category_color`,
      [id]
    );
    if (rowCount === 0) return notFound(res, "Category not found");

    return res.status(200).json({
      message: "Category deleted successfully",
      category: rows[0],
    });
  } catch (err) {
    return serverError(res, err, "Error deleting category");
  }
});

/**
 * GET /categories/:id/subcategories
 * List all subcategories under a category
 */
router.get("/categories/:id/subcategories", async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (Number.isNaN(id)) return badRequest(res, "Invalid category id");

    const cat = await db.query(`SELECT 1 FROM category WHERE category_id = $1`, [id]);
    if (cat.rowCount === 0) return notFound(res, "Category not found");

    const { rows } = await db.query(
      `SELECT subcategory_id, subcategory_name, category_id
       FROM subcategory
       WHERE category_id = $1
       ORDER BY subcategory_name ASC`,
      [id]
    );
    return res.status(200).json(rows);
  } catch (err) {
    return serverError(res, err, "Error fetching subcategories");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUBCATEGORY ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /subcategories
 * List subcategories with their category.
 * Query:
 *   category_id? (filter by category)
 *   search?     (ILIKE on subcategory name)
 *   limit?, offset? (pagination)
 */
router.get("/subcategories", async (req, res) => {
  try {
    const { category_id, search = "", limit, offset } = req.query;

    const clauses = [];
    const params = [];
    let idx = 1;

    if (category_id !== undefined) {
      const cid = toInt(category_id);
      if (Number.isNaN(cid)) return badRequest(res, "Invalid category_id");
      clauses.push(`s.category_id = $${idx++}`);
      params.push(cid);
    }
    if (search) {
      clauses.push(`s.subcategory_name ILIKE $${idx++}`);
      params.push(`%${String(search).trim()}%`);
    }

    const whereSQL = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const baseSQL = `
      SELECT s.subcategory_id, s.subcategory_name, s.category_id,
             c.category_name, c.category_color
      FROM subcategory s
      JOIN category c ON c.category_id = s.category_id
      ${whereSQL}
      ORDER BY c.category_name, s.subcategory_name
    `;

    const hasLimit = Number.isInteger(+limit);
    const hasOffset = Number.isInteger(+offset);

    const paginatedSQL =
      hasLimit || hasOffset
        ? `${baseSQL} ${hasLimit ? `LIMIT ${+limit}` : ""} ${hasOffset ? `OFFSET ${+offset}` : ""}`
        : baseSQL;

    const { rows } = await db.query(paginatedSQL, params);
    return res.status(200).json(rows);
  } catch (err) {
    return serverError(res, err, "Error fetching subcategories");
  }
});

/**
 * POST /subcategories
 * Body: { subcategory_name, category_id }
 */
router.post("/subcategories", async (req, res) => {
  try {
    let { subcategory_name, category_id } = req.body || {};

    if (!subcategory_name || String(subcategory_name).trim() === "") {
      return badRequest(res, "subcategory_name is required");
    }
    const cid = toInt(category_id);
    if (Number.isNaN(cid)) return badRequest(res, "Valid category_id is required");

    // validate category exists
    const cat = await db.query(`SELECT 1 FROM category WHERE category_id = $1`, [cid]);
    if (cat.rowCount === 0) return notFound(res, "Category not found");

    const { rows } = await db.query(
      `INSERT INTO subcategory (subcategory_name, category_id)
       VALUES ($1, $2)
       RETURNING subcategory_id, subcategory_name, category_id`,
      [String(subcategory_name).trim(), cid]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (pgIsUniqueViolation(err)) {
      return res.status(409).json({ error: "Subcategory already exists in this category" });
    }
    if (pgIsForeignKeyViolation(err)) {
      return badRequest(res, "Invalid category_id");
    }
    return serverError(res, err, "Error creating subcategory");
  }
});

/**
 * PUT /subcategories/:id
 * Body: { subcategory_name?, category_id? }
 */
router.put("/subcategories/:id", async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (Number.isNaN(id)) return badRequest(res, "Invalid subcategory id");

    let { subcategory_name, category_id } = req.body || {};

    const fields = [];
    const values = [];
    let idx = 1;

    if (subcategory_name && String(subcategory_name).trim() !== "") {
      fields.push(`subcategory_name = $${idx++}`);
      values.push(String(subcategory_name).trim());
    }
    if (category_id !== undefined) {
      const cid = toInt(category_id);
      if (Number.isNaN(cid)) return badRequest(res, "Invalid category_id");
      const cat = await db.query(`SELECT 1 FROM category WHERE category_id = $1`, [cid]);
      if (cat.rowCount === 0) return notFound(res, "Target category not found");
      fields.push(`category_id = $${idx++}`);
      values.push(cid);
    }

    if (fields.length === 0) return badRequest(res, "Nothing to update");

    values.push(id);
    const sql = `
      UPDATE subcategory
      SET ${fields.join(", ")}
      WHERE subcategory_id = $${idx}
      RETURNING subcategory_id, subcategory_name, category_id
    `;
    const { rowCount, rows } = await db.query(sql, values);
    if (rowCount === 0) return notFound(res, "Subcategory not found");

    return res.status(200).json(rows[0]);
  } catch (err) {
    if (pgIsUniqueViolation(err)) {
      return res.status(409).json({ error: "Subcategory already exists in this category" });
    }
    if (pgIsForeignKeyViolation(err)) {
      return badRequest(res, "Invalid category_id");
    }
    return serverError(res, err, "Error updating subcategory");
  }
});

/**
 * DELETE /subcategories/:id
 */
router.delete("/subcategories/:id", async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (Number.isNaN(id)) return badRequest(res, "Invalid subcategory id");

    const { rowCount, rows } = await db.query(
      `DELETE FROM subcategory
       WHERE subcategory_id = $1
       RETURNING subcategory_id, subcategory_name, category_id`,
      [id]
    );
    if (rowCount === 0) return notFound(res, "Subcategory not found");

    return res.status(200).json({
      message: "Subcategory deleted successfully",
      subcategory: rows[0],
    });
  } catch (err) {
    return serverError(res, err, "Error deleting subcategory");
  }
});

module.exports = router;
