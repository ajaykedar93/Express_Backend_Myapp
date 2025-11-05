// routes/actFavorite.js
// Mount at: app.use("/api/act_favorite", require("./routes/actFavorite"));

const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ---------------- Helpers ---------------- */

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

function parseJSONMaybe(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Normalize images input: accept string, JSON array, CSV, or array
function safeNormalizeImages(input) {
  if (input == null) return null;

  if (Array.isArray(input)) {
    return input.map((x) => (x == null ? "" : String(x).trim())).filter(Boolean);
  }

  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;

    const parsed = parseJSONMaybe(s);
    if (parsed != null) {
      return Array.isArray(parsed)
        ? parsed.map((x) => (x == null ? "" : String(x).trim())).filter(Boolean)
        : [String(parsed).trim()].filter(Boolean);
    }

    if (s.includes(",")) {
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    }
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
    if (value.includes(",")) return value.split(",").map((x) => x.trim()).filter(Boolean);
    return [value];
  }
  try { return Array.isArray(value) ? value : [String(value)]; } catch { return [String(value)]; }
}

// PostgreSQL error → HTTP
function normalizePgError(err) {
  console.error("[act_favorite] PG Error:", {
    code: err?.code, message: err?.message, detail: err?.detail, table: err?.table, column: err?.column,
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

// Row mappers
const mapRowCore = (r) => ({
  id: r.id,
  country_id: r.country_id,
  country_name: r.country_name ?? null,
  favorite_actress_name: r.favorite_actress_name,
  age: r.age,
  actress_dob: r.actress_dob,
  favorite_movie_series: r.favorite_movie_series,
  profile_image: r.profile_image,
  notes: r.notes,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const mapRowSlim = (r) => ({
  ...mapRowCore(r),
  images_count: Number(r.images_count ?? 0),
});

const mapRowWithImages = (r) => ({
  ...mapRowCore(r),
  images: coerceImagesOut(r.images),
  images_raw: coerceImagesOut(r.images_raw),
});

/* ---------------- Routes ---------------- */

/**
 * GET /            → list all (optional filters: ?q=, ?country=, ?name=, ?series=)
 *                    RETURNS SLIM rows (no images arrays), includes images_count.
 * GET /countries   → list countries
 * GET /:id         → get single
 *    Query:
 *      images=none|count|all|page   (default: none)
 *      offset,limit                 (only when images=page; defaults offset=0, limit=30)
 * GET /:id/images  → paged images only { total, offset, limit, images[] }
 * POST /           → create
 * PATCH /:id       → update (replace images if provided)
 * POST /:id/images/append → append images only
 * POST /:id/images/delete → delete images (all / by urls / by indexes)
 * DELETE /:id      → delete record
 */

// GET / → list all (SLIM; no images arrays)
router.get("/", async (req, res) => {
  try {
    const { q, country, name, series } = req.query;

    const where = [];
    const params = [];
    let i = 1;

    if (country) {
      const maybeNum = Number(country);
      if (Number.isFinite(maybeNum) && maybeNum > 0) {
        where.push(`f.country_id = $${i++}`);
        params.push(Math.trunc(maybeNum));
      } else {
        where.push(`c.country_name = $${i++}`);
        params.push(String(country).trim());
      }
    }
    if (name) {
      where.push(`lower(f.favorite_actress_name) LIKE lower($${i++})`);
      params.push(String(name).trim() + "%");
    }
    if (series) {
      where.push(`lower(f.favorite_movie_series) LIKE lower($${i++})`);
      params.push(String(series).trim() + "%");
    }
    if (q) {
      where.push(`(
        lower(f.favorite_actress_name) LIKE lower($${i})
        OR lower(f.favorite_movie_series) LIKE lower($${i})
        OR lower(COALESCE(f.notes, '')) LIKE lower($${i})
      )`);
      params.push(`%${String(q).trim()}%`);
      i++;
    }

    const sql = `
      SELECT
        f.id, f.country_id, f.favorite_actress_name, f.age, f.actress_dob,
        f.favorite_movie_series, f.profile_image, f.notes,
        f.created_at, f.updated_at,
        c.country_name,
        COALESCE(jsonb_array_length(f.images), 0) AS images_count
      FROM user_act_favorite f
      LEFT JOIN country_list c ON c.id = f.country_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY f.created_at DESC, f.id DESC
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows.map(mapRowSlim));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// GET /countries
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

// helper: build paged images jsonb for a record id
async function fetchPagedImagesJson(id, offset = 0, limit = 30) {
  const { rows } = await pool.query(
    `
    WITH src AS (
      SELECT COALESCE(images, '[]'::jsonb) AS images
      FROM user_act_favorite WHERE id=$1
    ),
    exploded AS (
      SELECT e, ord
      FROM src, LATERAL jsonb_array_elements(src.images) WITH ORDINALITY AS t(e, ord)
    ),
    page AS (
      SELECT e
      FROM exploded
      WHERE ord > $2
      ORDER BY ord
      LIMIT $3
    )
    SELECT
      (SELECT COUNT(*)::int FROM exploded) AS total,
      COALESCE(jsonb_agg(e), '[]'::jsonb) AS page_images
  `,
    [id, offset, limit]
  );
  if (rows.length === 0) return { total: 0, images: [] };
  return {
    total: Number(rows[0].total || 0),
    images: coerceImagesOut(rows[0].page_images),
  };
}

// GET /:id  (controllable images payload)
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  // images=none|count|all|page
  const imagesMode = String(req.query.images || "none").toLowerCase();
  const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Number(req.query.offset)) : 0;
  const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(100, Math.max(1, Number(req.query.limit))) : 30;

  try {
    const { rows } = await pool.query(
      `SELECT f.*, c.country_name
         FROM user_act_favorite f
    LEFT JOIN country_list c ON c.id = f.country_id
        WHERE f.id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const base = mapRowCore(rows[0]);

    if (imagesMode === "none") {
      const { rows: c } = await pool.query(
        "SELECT COALESCE(jsonb_array_length(images),0) AS images_count FROM user_act_favorite WHERE id=$1",
        [id]
      );
      return res.json({ ...base, images_count: Number(c[0]?.images_count || 0) });
    }

    if (imagesMode === "count") {
      const { rows: c } = await pool.query(
        "SELECT COALESCE(jsonb_array_length(images),0) AS images_count, images FROM user_act_favorite WHERE id=$1",
        [id]
      );
      return res.json({
        ...base,
        images_count: Number(c[0]?.images_count || 0),
      });
    }

    if (imagesMode === "page") {
      const { total, images } = await fetchPagedImagesJson(id, offset, limit);
      return res.json({
        ...base,
        images_page: { total, offset, limit, images },
      });
    }

    // default fallback if images=all
    return res.json(mapRowWithImages(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// GET /:id/images → paged images only
router.get("/:id/images", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Number(req.query.offset)) : 0;
  const limit = Number.isFinite(Number(req.query.limit)) ? Math.min(100, Math.max(1, Number(req.query.limit))) : 30;

  try {
    const { total, images } = await fetchPagedImagesJson(id, offset, limit);
    res.json({ total, offset, limit, images });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// POST / (create)
router.post("/", async (req, res) => {
  try {
    const {
      country, favorite_actress_name, age, actress_dob,
      favorite_movie_series, profile_image, images, notes,
    } = req.body || {};

    const country_id = await resolveCountryId(country);

    if (!isNonEmptyString(favorite_actress_name))
      return res.status(400).json({ error: "favorite_actress_name is required" });
    if (!isNonEmptyString(favorite_movie_series))
      return res.status(400).json({ error: "favorite_movie_series is required" });
    if (!isNonEmptyString(profile_image))
      return res.status(400).json({ error: "profile_image is required" });

    let ageVal = null;
    if (age !== undefined && age !== null && String(age).trim() !== "") {
      const n = Number(age);
      if (!Number.isFinite(n) || n <= 0)
        return res.status(400).json({ error: "age must be positive" });
      ageVal = Math.trunc(n);
    }

    let imagesVal = null;
    try { imagesVal = safeNormalizeImages(images); }
    catch (e) { return res.status(400).json({ error: String(e.message || "Invalid images") }); }

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
    const { rows: c } = await pool.query("SELECT country_name FROM country_list WHERE id=$1", [country_id]);
    res.status(201).json(mapRowWithImages({ ...rows[0], country_name: c[0]?.country_name || null }));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// PATCH /:id (replace images if provided)
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

    const updatable = ["favorite_actress_name", "favorite_movie_series", "profile_image", "notes"];
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
      try { imagesVal = safeNormalizeImages(req.body.images); }
      catch (e) { return res.status(400).json({ error: String(e.message || "Invalid images") }); }
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
    const { rows: c } = await pool.query("SELECT country_name FROM country_list WHERE id=$1", [cid]);
    res.json(mapRowWithImages({ ...rows[0], country_name: c[0]?.country_name || null }));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// POST /:id/images/append → append images
router.post("/:id/images/append", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    let toAppend = safeNormalizeImages(req.body?.images);
    if (!toAppend || toAppend.length === 0) {
      return res.status(400).json({ error: "images required (array/CSV/JSON/string)" });
    }

    const asJson = JSON.stringify(toAppend);
    const sql = `
      UPDATE user_act_favorite
         SET images = COALESCE(images, '[]'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE id = $2
   RETURNING *`;
    const { rows } = await pool.query(sql, [asJson, id]);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const { rows: c } = await pool.query("SELECT country_name FROM country_list WHERE id=$1", [
      rows[0].country_id,
    ]);
    res.json(mapRowWithImages({ ...rows[0], country_name: c[0]?.country_name || null }));
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

// POST /:id/images/delete  (all / by urls / by indexes)
router.post("/:id/images/delete", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { all } = req.body || {};

    // normalize urls (optional)
    let urls = null;
    if (req.body?.urls !== undefined) {
      try {
        const arr = safeNormalizeImages(req.body.urls);
        urls = arr && arr.length ? arr : null;
      } catch (e) {
        return res.status(400).json({ error: String(e.message || "Invalid urls") });
      }
    }

    // normalize indexes (optional) -> convert 0-based (client) -> 1-based (SQL ordinality)
    let idxs = null;
    if (req.body?.indexes !== undefined) {
      if (!Array.isArray(req.body.indexes)) {
        return res.status(400).json({ error: "indexes must be an array of integers" });
      }
      const cleaned = [];
      for (const v of req.body.indexes) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) {
          return res.status(400).json({ error: "indexes must be non-negative integers (0-based)" });
        }
        cleaned.push(n + 1);
      }
      idxs = cleaned.length ? cleaned : null;
    }

    if (!all && !urls && !idxs) {
      return res.status(400).json({ error: "Provide one of: all=true, urls, indexes" });
    }

    // 1) Delete ALL
    if (all === true) {
      const { rows } = await pool.query(
        `UPDATE user_act_favorite
            SET images = NULL,
                updated_at = NOW()
          WHERE id = $1
      RETURNING *`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Not found" });

      const { rows: c } = await pool.query("SELECT country_name FROM country_list WHERE id=$1", [
        rows[0].country_id,
      ]);
      return res.json(mapRowWithImages({ ...rows[0], country_name: c[0]?.country_name || null }));
    }

    // 2) Partial delete by URL and/or index
    const { rows } = await pool.query(
      `
      WITH curr AS (
        SELECT e, ord::int
        FROM jsonb_array_elements(
               COALESCE((SELECT images FROM user_act_favorite WHERE id=$1), '[]'::jsonb)
             ) WITH ORDINALITY AS t(e, ord)
      ),
      filtered AS (
        SELECT e
        FROM curr
        WHERE
          ($2::text[] IS NULL OR NOT ((e #>> '{}') = ANY($2::text[])))
          AND
          ($3::int[]  IS NULL OR NOT (ord = ANY($3::int[])))
      ),
      upd AS (
        UPDATE user_act_favorite
           SET images = (SELECT CASE WHEN COUNT(*) = 0 THEN '[]'::jsonb ELSE jsonb_agg(e) END FROM filtered),
               updated_at = NOW()
         WHERE id = $1
     RETURNING *
      )
      SELECT * FROM upd
      `,
      [id, urls, idxs]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const { rows: c } = await pool.query("SELECT country_name FROM country_list WHERE id=$1", [
      rows[0].country_id,
    ]);
    return res.json(mapRowWithImages({ ...rows[0], country_name: c[0]?.country_name || null }));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    return res.status(status).json({ error: message });
  }
});

module.exports = router;
