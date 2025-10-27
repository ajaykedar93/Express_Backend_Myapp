// routes/movies.js
// Movies API — aligned with React pages (AddMovies / MoviesManager)
// Endpoints:
//   - /api/movies/count
//   - /api/movies/count/by-category
//   - /api/movies/categories
//   - /api/movies/subcategories[?category_id=]
//   - /api/movies/genres
//   - /api/movies/suggest?q=&limit=
//   - /api/movies/duplicate-movie
//   - /api/movies/duplicate-part
//   - /api/movies              (GET list, POST create)
//   - /api/movies/by-name      (GET by exact name + optional filters)
//   - /api/movies/by-name/:name
//   - /api/movies/:id          (GET one, PUT update, DELETE)
//   - /api/movies/parts        (POST add/upsert part >= 2)
//   - /api/movies/parts/:partId (PUT update part, DELETE part)

const express = require("express");
const router = express.Router();
const db = require("../db"); // Must export a pg Pool with .query and .connect

// -------------------------- helpers --------------------------
const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? NaN : n;
};
const isInt = (v) => Number.isInteger(v);
const between = (n, a, b) => Number.isInteger(n) && n >= a && n <= b;
const normName = (s = "") => String(s).replace(/\s+/g, " ").trim();
const isDataUrl = (s) =>
  typeof s === "string" &&
  /^data:image\/(png|jpe?g|webp);base64,/.test(s);

const parseBoolLoose = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(s)) return true;
  if (["false", "f", "0", "no", "n"].includes(s)) return false;
  return null; // treat unknown as not provided
};

// Single-source select for a full movie row
async function fetchMovieFull(movieId) {
  const sql = `
    SELECT
      m.movie_id,
      m.movie_name,
      m.category_id,
      c.name  AS category_name,
      c.color AS category_color,
      m.subcategory_id,
      sc.name AS subcategory_name,
      m.release_year,
      m.poster_url,
      m.is_watched,
      m.primary_genre_id,
      pg.name AS primary_genre_name,
      m.created_at,
      m.updated_at,
      COALESCE((
        SELECT json_agg(json_build_object(
                 'part_id', x.part_id,
                 'part_number', x.part_number,
                 'year', x.year
               ) ORDER BY x.part_number, x.part_id)
        FROM (
          SELECT DISTINCT mp.part_id, mp.part_number, mp.year
          FROM movie_parts mp
          WHERE mp.movie_id = m.movie_id
        ) x
      ), '[]'::json) AS parts,
      COALESCE((
        SELECT json_agg(json_build_object(
                 'genre_id', x.genre_id,
                 'name', x.name
               ) ORDER BY x.name, x.genre_id)
        FROM (
          SELECT DISTINCT g.genre_id, g.name
          FROM movie_genres mg
          JOIN genres g ON g.genre_id = mg.genre_id
          WHERE mg.movie_id = m.movie_id
        ) x
      ), '[]'::json) AS genres
    FROM movies m
    JOIN categories c ON c.category_id = m.category_id
    LEFT JOIN subcategories sc ON sc.subcategory_id = m.subcategory_id
    LEFT JOIN genres pg ON pg.genre_id = m.primary_genre_id
    WHERE m.movie_id = $1
    GROUP BY m.movie_id, c.category_id, sc.subcategory_id, pg.genre_id;
  `;
  const { rows } = await db.query(sql, [movieId]);
  return rows[0] || null;
}

// -------------------------- COUNTS --------------------------

// GET /api/movies/count -> { total }
router.get("/count", async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS total FROM movies;`);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error counting movies" });
  }
});

// GET /api/movies/count/by-category
router.get("/count/by-category", async (_req, res) => {
  try {
    const sql = `
      SELECT
        c.category_id,
        c.name  AS category_name,
        c.color AS category_color,
        COALESCE(COUNT(m.movie_id),0)::int AS total
      FROM categories c
      LEFT JOIN movies m ON m.category_id = c.category_id
      GROUP BY c.category_id, c.name, c.color
      ORDER BY c.name;
    `;
    const { rows } = await db.query(sql);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error counting by category" });
  }
});

// -------------------------- FEEDERS --------------------------

// GET /api/movies/categories
router.get("/categories", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT category_id, name, color FROM categories ORDER BY name;`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching categories" });
  }
});

// GET /api/movies/subcategories[?category_id=]
router.get("/subcategories", async (req, res) => {
  try {
    const cidRaw = req.query.category_id;
    if (cidRaw == null || cidRaw === "") {
      const { rows } = await db.query(
        `SELECT subcategory_id, category_id, name
         FROM subcategories
         ORDER BY name;`
      );
      return res.json(rows);
    }
    const catId = toInt(cidRaw);
    if (!isInt(catId)) return res.status(400).json({ error: "category_id must be integer" });

    const { rows } = await db.query(
      `SELECT subcategory_id, category_id, name
       FROM subcategories
       WHERE category_id = $1
       ORDER BY name;`,
      [catId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching subcategories" });
  }
});

// GET /api/movies/genres
router.get("/genres", async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT genre_id, name FROM genres ORDER BY name;`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching genres" });
  }
});

// -------------------------- SUGGESTIONS & DUP CHECKS --------------------------

// GET /api/movies/suggest?q=&limit=
router.get("/suggest", async (req, res) => {
  try {
    const q = normName(req.query.q || "");
    const limit = Math.min(Math.max(toInt(req.query.limit) || 10, 1), 50);
    if (!q) return res.json([]);

    const { rows } = await db.query(
      `
      (
        SELECT DISTINCT movie_name
        FROM movies
        WHERE movie_name ILIKE $1 || '%'
        ORDER BY movie_name
        LIMIT $2
      )
      UNION
      (
        SELECT DISTINCT movie_name
        FROM movies
        WHERE movie_name ILIKE '%' || $1 || '%'
        ORDER BY movie_name
        LIMIT $2
      )
      LIMIT $2;
      `,
      [q, limit]
    );
    res.json(rows.map((r) => r.movie_name));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching suggestions" });
  }
});

// GET /api/movies/duplicate-movie?movie_name=..[&category_id=..&release_year=..&subcategory_id=..]
router.get("/duplicate-movie", async (req, res) => {
  try {
    const movie_name = normName(req.query.movie_name || "");
    if (!movie_name) return res.status(400).json({ error: "movie_name is required" });

    const hasCategory = req.query.category_id != null && req.query.category_id !== "";
    const hasYear = req.query.release_year != null && req.query.release_year !== "";

    // name-only mode
    if (!hasCategory || !hasYear) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM movies WHERE INITCAP(movie_name) = INITCAP($1) LIMIT 1;`,
        [movie_name]
      );
      return res.json({ duplicate: rowCount > 0, mode: "name-only" });
    }

    // composite mode
    const category_id = toInt(req.query.category_id);
    const release_year = toInt(req.query.release_year);
    const subcategory_id =
      req.query.subcategory_id == null || req.query.subcategory_id === ""
        ? null
        : toInt(req.query.subcategory_id);

    if (!isInt(category_id) || !isInt(release_year)) {
      return res.status(400).json({ error: "category_id and release_year must be integers" });
    }
    if (!between(release_year, 1888, 2100)) {
      return res.status(400).json({ error: "release_year must be 1888..2100" });
    }

    const { rowCount } = await db.query(
      `
      SELECT 1
      FROM movies
      WHERE INITCAP(movie_name) = INITCAP($1)
        AND category_id = $2
        AND release_year = $3
        AND COALESCE(subcategory_id, 0) = COALESCE($4, 0)
      `,
      [movie_name, category_id, release_year, subcategory_id]
    );
    res.json({ duplicate: rowCount > 0, mode: "composite" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error checking duplicate (movie)" });
  }
});

// GET /api/movies/duplicate-part?movie_id=..&part_number=..
router.get("/duplicate-part", async (req, res) => {
  try {
    const movie_id = toInt(req.query.movie_id);
    const part_number = toInt(req.query.part_number);
    if (!isInt(movie_id) || !isInt(part_number)) {
      return res.status(400).json({ error: "movie_id and part_number must be integers" });
    }
    const { rowCount } = await db.query(
      `SELECT 1 FROM movie_parts WHERE movie_id=$1 AND part_number=$2`,
      [movie_id, part_number]
    );
    res.json({ duplicate: rowCount > 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error checking duplicate (part)" });
  }
});

// -------------------------- MOVIES CRUD & LIST --------------------------

// POST /api/movies  (Add Movie)
router.post("/", async (req, res) => {
  const {
    movie_name,
    category_id,
    subcategory_id = null,
    release_year,
    poster_url = null,
    genre_ids,
    primary_genre_id = null,
    is_watched, // NEW (optional, default false)
  } = req.body || {};

  if (!movie_name || category_id == null || release_year == null) {
    return res.status(400).json({ error: "movie_name, category_id, release_year are required" });
  }

  const catId = toInt(category_id);
  const yr = toInt(release_year);
  const subId = (subcategory_id == null || subcategory_id === "") ? null : toInt(subcategory_id);
  const pgId = (primary_genre_id == null || primary_genre_id === "") ? null : toInt(primary_genre_id);
  const iwParsed = parseBoolLoose(is_watched);
  const iw = iwParsed === null ? false : iwParsed;

  // normalize genres to int[]
  let normGenreIds = [];
  if (Array.isArray(genre_ids)) {
    normGenreIds = genre_ids
      .map((x) => Number.parseInt(x, 10))
      .filter((n) => Number.isInteger(n));
  }

  if (!isInt(catId)) return res.status(400).json({ error: "category_id must be integer" });
  if (!between(yr, 1888, 2100))
    return res.status(400).json({ error: "release_year must be 1888..2100" });
  if (subcategory_id != null && subcategory_id !== "" && !isInt(subId))
    return res.status(400).json({ error: "subcategory_id must be integer" });
  if (pgId != null && !isInt(pgId))
    return res.status(400).json({ error: "primary_genre_id must be integer" });
  if (poster_url && !(isDataUrl(poster_url) || /^https?:\/\//i.test(poster_url))) {
    return res.status(400).json({ error: "poster_url must be a data:image/* base64 URL or http(s) URL" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const c = await client.query(`SELECT 1 FROM categories WHERE category_id=$1`, [catId]);
    if (!c.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Category does not exist" });
    }

    if (subId != null) {
      const sc = await client.query(
        `SELECT 1 FROM subcategories WHERE subcategory_id=$1 AND category_id=$2`,
        [subId, catId]
      );
      if (!sc.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "subcategory_id does not belong to category_id" });
      }
    }

    if (pgId != null) {
      const g = await client.query(`SELECT 1 FROM genres WHERE genre_id=$1`, [pgId]);
      if (!g.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "primary_genre_id does not exist" });
      }
    }

    const movieNameNorm = normName(movie_name);

    // composite dup
    const dupComposite = await client.query(
      `
      SELECT 1
      FROM movies
      WHERE INITCAP(movie_name) = INITCAP($1)
        AND category_id = $2
        AND release_year = $3
        AND COALESCE(subcategory_id, 0) = COALESCE($4, 0)
      `,
      [movieNameNorm, catId, yr, subId]
    );
    if (dupComposite.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Duplicate movie exists (name+category+year+subcategory)" });
    }

    // insert
    const ins = await client.query(
      `INSERT INTO movies
         (movie_name, category_id, subcategory_id, release_year, poster_url, is_watched, primary_genre_id)
       VALUES (INITCAP($1), $2, $3, $4, $5, $6, $7)
       RETURNING movie_id;`,
      [movieNameNorm, catId, subId, yr, poster_url, iw, pgId]
    );
    const movieId = ins.rows[0].movie_id;

    // genres
    if (normGenreIds.length) {
      await client.query(
        `INSERT INTO movie_genres (movie_id, genre_id)
         SELECT $1, UNNEST($2::int[])
         ON CONFLICT DO NOTHING;`,
        [movieId, normGenreIds]
      );
    }

    await client.query("COMMIT");

    const full = await fetchMovieFull(movieId);
    res.status(201).json(full);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    if (e.code === "23505") return res.status(409).json({ error: "Duplicate movie" });
    res.status(500).json({ error: "Error adding movie" });
  } finally {
    client.release();
  }
});

// GET /api/movies  (List with filters/pagination)
router.get("/", async (req, res) => {
  try {
    const { category_id, subcategory_id, date_from, date_to, q } = req.query;
    const limit = Math.min(Math.max(toInt(req.query.limit) || 100, 1), 500);
    const offset = Math.max(toInt(req.query.offset) || 0, 0);

    const conds = [];
    const params = [];
    let i = 0;

    if (category_id != null && category_id !== "") {
      const cid = toInt(category_id);
      if (!isInt(cid)) return res.status(400).json({ error: "category_id must be integer" });
      params.push(cid); i++;
      conds.push(`m.category_id = $${i}`);
    }
    if (subcategory_id != null && subcategory_id !== "") {
      const sid = toInt(subcategory_id);
      if (!isInt(sid)) return res.status(400).json({ error: "subcategory_id must be integer" });
      params.push(sid); i++;
      conds.push(`m.subcategory_id = $${i}`);
    }
    if (req.query.is_watched != null && req.query.is_watched !== "") {
      const iw = parseBoolLoose(req.query.is_watched);
      if (iw === null) return res.status(400).json({ error: "is_watched must be true/false/1/0/yes/no" });
      params.push(iw); i++;
      conds.push(`m.is_watched = $${i}`);
    }
    if (date_from) {
      params.push(date_from); i++;
      conds.push(`m.created_at >= $${i}`);
    }
    if (date_to) {
      params.push(date_to); i++;
      conds.push(`m.created_at < ($${i}::date + INTERVAL '1 day')`);
    }
    if (q) {
      params.push(`%${normName(q)}%`); i++;
      conds.push(`m.movie_name ILIKE $${i}`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const sql = `
      WITH base AS (
        SELECT
          ROW_NUMBER() OVER (ORDER BY m.created_at, m.movie_id) AS display_no,
          m.movie_id,
          m.movie_name,
          m.release_year,
          m.category_id,
          c.name  AS category_name,
          c.color AS category_color,
          m.subcategory_id,
          sc.name AS subcategory_name,
          m.primary_genre_id,
          pg.name AS primary_genre_name,
          m.poster_url,
          m.is_watched,
          m.created_at,
          m.updated_at
        FROM movies m
        JOIN categories c ON c.category_id = m.category_id
        LEFT JOIN subcategories sc ON sc.subcategory_id = m.subcategory_id
        LEFT JOIN genres pg ON pg.genre_id = m.primary_genre_id
        ${where}
      )
      SELECT
        b.*,
        COALESCE((
          SELECT json_agg(json_build_object(
                   'part_id', x.part_id,
                   'part_number', x.part_number,
                   'year', x.year
                 ) ORDER BY x.part_number, x.part_id)
          FROM (
            SELECT DISTINCT mp.part_id, mp.part_number, mp.year
            FROM movie_parts mp
            WHERE mp.movie_id = b.movie_id
          ) x
        ), '[]'::json) AS parts
      FROM base b
      ORDER BY b.display_no
      LIMIT $${i + 1} OFFSET $${i + 2};
    `;
    const { rows } = await db.query(sql, [...params, limit, offset]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching movies" });
  }
});

// Utility: find a movie id by exact name (+ optional filters)
async function findMovieId({ name, category_id = null, release_year = null, subcategory_id = null }) {
  const params = [name];
  const where = [`INITCAP(m.movie_name) = INITCAP($1)`];

  if (category_id != null) {
    params.push(Number(category_id));
    where.push(`m.category_id = $${params.length}`);
  }
  if (release_year != null) {
    params.push(Number(release_year));
    where.push(`m.release_year = $${params.length}`);
  }
  if (subcategory_id != null) {
    params.push(Number(subcategory_id));
    where.push(`m.subcategory_id = $${params.length}`);
  }

  const sql = `
    SELECT m.movie_id
    FROM movies m
    WHERE ${where.join(" AND ")}
    ORDER BY m.created_at, m.movie_id
    LIMIT 1;
  `;
  const { rows } = await db.query(sql, params);
  return rows[0]?.movie_id || null;
}

// GET /api/movies/by-name?name=&category_id=&release_year=&subcategory_id=
router.get("/by-name", async (req, res) => {
  try {
    const { name, category_id, release_year, subcategory_id } = req.query || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const movieId = await findMovieId({
      name: name.trim(),
      category_id,
      release_year,
      subcategory_id,
    });
    if (!movieId) return res.status(404).json({ error: "Movie not found" });

    const full = await fetchMovieFull(movieId);
    res.json(full);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error finding movie by name" });
  }
});

// GET /api/movies/by-name/:name
router.get("/by-name/:name", async (req, res) => {
  try {
    const name = req.params.name;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const movieId = await findMovieId({ name: name.trim() });
    if (!movieId) return res.status(404).json({ error: "Movie not found" });

    const full = await fetchMovieFull(movieId);
    res.json(full);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error finding movie by name" });
  }
});

// GET /api/movies/:id (one)
router.get("/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const row = await fetchMovieFull(id);
    if (!row) return res.status(404).json({ error: "Movie not found" });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching movie" });
  }
});

// PUT /api/movies/:id (RESTRICTED update)
// Only allow toggling is_watched and updating poster_url.
// Reject any other fields with 400.
router.put("/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  // Extract allowed fields
  let { is_watched, poster_url } = req.body || {};

  // Detect forbidden fields (anything besides is_watched, poster_url)
  const allowed = new Set(["is_watched", "poster_url"]);
  const forbidden = Object.keys(req.body || {}).filter((k) => !allowed.has(k));
  if (forbidden.length) {
    return res.status(400).json({
      error: "Only is_watched and poster_url can be updated",
      forbidden_fields: forbidden
    });
  }

  // Normalize inputs
  const iwNullable = parseBoolLoose(is_watched); // true/false or null when unset
  if (poster_url === "") poster_url = null;

  if (poster_url && !(isDataUrl(poster_url) || /^https?:\/\//i.test(poster_url))) {
    return res.status(400).json({
      error: "poster_url must be a data:image/* base64 URL or http(s) URL",
    });
  }

  // If nothing to update
  if (iwNullable === null && poster_url === undefined) {
    return res.status(400).json({ error: "No updatable fields provided (is_watched / poster_url)" });
  }

  // Build dynamic SET
  const sets = [];
  const params = [];
  if (iwNullable !== null) {
    params.push(iwNullable);
    sets.push(`is_watched = $${params.length}`);
  }
  if (poster_url !== undefined) {
    params.push(poster_url || null);
    sets.push(`poster_url = $${params.length}`);
  }
  params.push(id);
  const sql = `
    UPDATE movies
       SET ${sets.join(", ")},
           updated_at = NOW()
     WHERE movie_id = $${params.length}
     RETURNING movie_id;
  `;

  try {
    const up = await db.query(sql, params);
    if (!up.rowCount) return res.status(404).json({ error: "Movie not found" });

    const full = await fetchMovieFull(id);
    res.json(full);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error updating movie" });
  }
});

// DELETE /api/movies/:id
router.delete("/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const del = await db.query(`DELETE FROM movies WHERE movie_id=$1`, [id]);
    if (!del.rowCount) return res.status(404).json({ error: "Movie not found" });
    res.json({ message: "Movie deleted successfully" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error deleting movie" });
  }
});

// -------------------------- PARTS --------------------------

// POST /api/movies/parts (add/upsert part >= 2, with year)
router.post("/parts", async (req, res) => {
  const { movie_id, part_number, year } = req.body || {};
  const mid = toInt(movie_id);
  const pn = toInt(part_number);
  const yr = toInt(year);

  if (!isInt(mid) || !isInt(pn) || !isInt(yr)) {
    return res.status(400).json({ error: "movie_id, part_number, year must be integers" });
  }
  if (pn < 2) return res.status(400).json({ error: "part_number must be >= 2" });
  if (!between(yr, 1888, 2100)) return res.status(400).json({ error: "year must be 1888..2100" });

  try {
    const mv = await db.query(`SELECT 1 FROM movies WHERE movie_id=$1`, [mid]);
    if (!mv.rowCount) return res.status(404).json({ error: "Movie not found" });

    const sql = `
      INSERT INTO movie_parts (movie_id, part_number, year)
      VALUES ($1, $2, $3)
      ON CONFLICT ON CONSTRAINT movie_parts_unq
      DO UPDATE SET year = EXCLUDED.year
      RETURNING *;
    `;
    const { rows } = await db.query(sql, [mid, pn, yr]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error adding/updating part" });
  }
});

// PUT /api/movies/parts/:partId
router.put("/parts/:partId", async (req, res) => {
  const partId = toInt(req.params.partId);
  const { part_number, year } = req.body || {};
  const pn = toInt(part_number);
  const yr = toInt(year);

  if (!isInt(partId) || !isInt(pn) || !isInt(yr)) {
    return res.status(400).json({ error: "partId, part_number, year must be integers" });
  }
  if (pn < 1) return res.status(400).json({ error: "part_number must be >= 1" });
  if (!between(yr, 1888, 2100)) return res.status(400).json({ error: "year must be 1888..2100" });

  try {
    const q = `
      WITH _old AS (
        SELECT movie_id FROM movie_parts WHERE part_id=$1
      )
      UPDATE movie_parts mp
      SET part_number=$2, year=$3
      FROM _old
      WHERE mp.part_id=$1
      RETURNING mp.*;
    `;
    const { rows } = await db.query(q, [partId, pn, yr]);
    if (!rows.length) return res.status(404).json({ error: "Part not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Part number already exists for this movie" });
    }
    res.status(500).json({ error: "Error updating part" });
  }
});

// DELETE /api/movies/parts/:partId
router.delete("/parts/:partId", async (req, res) => {
  const partId = toInt(req.params.partId);
  if (!isInt(partId)) return res.status(400).json({ error: "Invalid partId" });

  try {
    const del = await db.query(`DELETE FROM movie_parts WHERE part_id=$1`, [partId]);
    if (!del.rowCount) return res.status(404).json({ error: "Part not found" });
    res.json({ message: "Movie part deleted successfully" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error deleting part" });
  }
});

module.exports = router;
