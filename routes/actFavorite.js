// routes/actFavorite.js
// Mount at: app.use("/api/act_favorite", require("./routes/actFavorite"));

const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ---------------- Helpers ---------------- */

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

// Try to parse JSON; if it fails, return null
function parseJSONMaybe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Normalize images input: accept string, JSON array, CSV, or array
// Returns: array of strings (no empties) OR null
function safeNormalizeImages(input) {
  if (input == null) return null;

  // Array direct
  if (Array.isArray(input)) {
    return input
      .map((x) => (x == null ? "" : String(x).trim()))
      .filter(Boolean);
  }

  // String input
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;

    // Try JSON parse
    const parsed = parseJSONMaybe(s);
    if (parsed != null) {
      return Array.isArray(parsed)
        ? parsed.map((x) => (x == null ? "" : String(x).trim())).filter(Boolean)
        : [String(parsed).trim()].filter(Boolean);
    }

    // Fallback: comma-separated
    if (s.includes(",")) {
      return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }

    // Single string URL/value
    return [s];
  }

  throw new Error("Invalid format for images");
}

// Convert DB row's images / images_raw into arrays consistently
function coerceImagesOut(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = parseJSONMaybe(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed != null) return [String(parsed)];
    // string but not JSON → maybe CSV?
    if (value.includes(",")) {
      return value.split(",").map((x) => x.trim()).filter(Boolean);
    }
    return [value];
  }
  // PG json/jsonb already comes as object/array
  return Array.isArray(value) ? value : [String(value)];
}

// PostgreSQL error → HTTP
function normalizePgError(err) {
  console.error("[act_favorite] PG Error:", {
    code: err?.code,
    message: err?.message,
    detail: err?.detail,
    table: err?.table,
    column: err?.column,
  });

  if (!err) return { status: 500, message: "Internal Server Error" };
  if (err.code === "23503") return { status: 400, message: err.detail || "Foreign key failed" };
  if (err.code === "23514") return { status: 400, message: err.detail || "Check constraint failed" };
  if (err.code === "23505") return { status: 409, message: err.detail || "Duplicate record" };
  if (err.code === "22P02" || err.code === "22023")
    return { status: 400, message: "Invalid data: " + (err.detail || err.message) };
  return { status: 500, message: "Internal Server Error" };
}

// Resolve country (by id or exact name)
async function resolveCountryId(countryField) {
  if (countryField == null || String(countryField).trim() === "")
    throw new Error("country is required");

  const maybeNum = Number(countryField);
  if (Number.isFinite(maybeNum) && !Number.isNaN(maybeNum)) {
    const id = Math.trunc(maybeNum);
    if (!isPositiveInt(id)) throw new Error("country id must be a positive integer");
    const { rows } = await pool.query("SELECT id FROM country_list WHERE id=$1", [id]);
    if (rows.length === 0) throw new Error("Unknown country id");
    return id;
  }

  const name = String(countryField).trim();
  const { rows } = await pool.query("SELECT id FROM country_list WHERE country_name=$1", [name]);
  if (rows.length === 0) throw new Error(`Unknown country: ${name}`);
  return rows[0].id;
}

// Row mapper (produces consistent JSON structure out)
const mapRow = (r) => ({
  id: r.id,
  country_id: r.country_id,
  country_name: r.country_name ?? null,
  favorite_actress_name: r.favorite_actress_name,
  age: r.age,
  actress_dob: r.actress_dob,
  favorite_movie_series: r.favorite_movie_series,
  profile_image: r.profile_image,
  images: coerceImagesOut(r.images),
  images_raw: coerceImagesOut(r.images_raw),
  notes: r.notes,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/* ---------------- Routes ---------------- */

// GET / → list all
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, c.country_name
         FROM user_act_favorite f
    LEFT JOIN country_list c ON c.id = f.country_id
     ORDER BY f.created_at DESC, f.id DESC`
    );
    res.json(rows.map(mapRow));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// GET /countries → all countries
router.get("/countries", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, country_name FROM country_list ORDER BY country_name ASC"
    );
    res.json(rows);
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// GET /:id
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { rows } = await pool.query(
      `SELECT f.*, c.country_name
         FROM user_act_favorite f
    LEFT JOIN country_list c ON c.id = f.country_id
        WHERE f.id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// POST /
router.post("/", async (req, res) => {
  try {
    const {
      country,
      favorite_actress_name,
      age,
      actress_dob,
      favorite_movie_series,
      profile_image,
      images,
      notes,
    } = req.body || {};

    const country_id = await resolveCountryId(country);

    if (!isNonEmptyString(favorite_actress_name))
      return res.status(400).json({ error: "favorite_actress_name is required" });
    if (!isNonEmptyString(favorite_movie_series))
      return res.status(400).json({ error: "favorite_movie_series is required" });
    if (!isNonEmptyString(profile_image))
      return res.status(400).json({ error: "profile_image is required" });

    // optional fields
    let ageVal = null;
    if (age !== undefined && age !== null && String(age).trim() !== "") {
      const n = Number(age);
      if (!Number.isFinite(n) || n <= 0)
        return res.status(400).json({ error: "age must be positive" });
      ageVal = Math.trunc(n);
    }

    let imagesVal = null;
    try {
      imagesVal = safeNormalizeImages(images);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || "Invalid images") });
    }

    const sql = `
      INSERT INTO user_act_favorite
        (country_id, favorite_actress_name, age, actress_dob,
         favorite_movie_series, profile_image, images_raw, images, notes,
         created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
      RETURNING *`;
    const params = [
      country_id,
      favorite_actress_name.trim(),
      ageVal,
      actress_dob || null,
      favorite_movie_series.trim(),
      profile_image,
      imagesVal ? JSON.stringify(imagesVal) : null,
      imagesVal ? JSON.stringify(imagesVal) : null,
      notes || null,
    ];

    const { rows } = await pool.query(sql, params);
    const { rows: c } = await pool.query("SELECT country_name FROM country_list WHERE id=$1", [
      country_id,
    ]);
    res.status(201).json(mapRow({ ...rows[0], country_name: c[0]?.country_name || null }));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// PATCH /:id
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const fields = [];
    const values = [];
    let i = 1;
    let newCountryId = null;

    if (req.body.country !== undefined) {
      newCountryId = await resolveCountryId(req.body.country);
      fields.push(`country_id = $${i++}`);
      values.push(newCountryId);
    }

    const updatable = [
      "favorite_actress_name",
      "favorite_movie_series",
      "profile_image",
      "notes",
    ];
    for (const key of updatable) {
      if (req.body[key] !== undefined) {
        const val = req.body[key];
        if (val === null || String(val).trim() === "")
          return res.status(400).json({ error: `${key} cannot be empty` });
        fields.push(`${key} = $${i++}`);
        values.push(val);
      }
    }

    if (req.body.age !== undefined) {
      if (req.body.age === null || String(req.body.age).trim() === "") {
        fields.push("age = NULL");
      } else {
        const n = Number(req.body.age);
        if (!Number.isFinite(n) || n <= 0)
          return res.status(400).json({ error: "age must be positive" });
        fields.push(`age = $${i++}`);
        values.push(Math.trunc(n));
      }
    }

    if (req.body.actress_dob !== undefined) {
      if (!req.body.actress_dob) fields.push("actress_dob = NULL");
      else {
        fields.push(`actress_dob = $${i++}`);
        values.push(req.body.actress_dob);
      }
    }

    if (req.body.images !== undefined) {
      let imagesVal = null;
      try {
        imagesVal = safeNormalizeImages(req.body.images);
      } catch (e) {
        return res.status(400).json({ error: String(e.message || "Invalid images") });
      }
      fields.push(`images = $${i++}`);
      values.push(imagesVal ? JSON.stringify(imagesVal) : null);
      fields.push(`images_raw = $${i++}`);
      values.push(imagesVal ? JSON.stringify(imagesVal) : null);
    }

    if (fields.length === 0)
      return res.status(400).json({ error: "No fields to update" });

    fields.push("updated_at = NOW()");
    const sql = `
      UPDATE user_act_favorite
         SET ${fields.join(", ")}
       WHERE id = $${i}
   RETURNING *`;
    values.push(id);

    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const cid = newCountryId ?? rows[0].country_id;
    const { rows: c } = await pool.query("SELECT country_name FROM country_list WHERE id=$1", [
      cid,
    ]);
    res.json(mapRow({ ...rows[0], country_name: c[0]?.country_name || null }));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { rowCount } = await pool.query("DELETE FROM user_act_favorite WHERE id=$1", [id]);
    if (rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

module.exports = router;
