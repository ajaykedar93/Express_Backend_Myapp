// routes/series.js
// Fully aligned with DB: categories/subcategories/genres, primary_genre_id,
// suggestions, dup checks, CRUD for series + seasons, list with filters/pagination.
// Now supports is_watched (boolean): create/read/update/filter.

const express = require("express");
const router = express.Router();
const db = require("../db"); // pg Pool/Client

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------
const toInt = (v) => Number(v);
const isInt = (v) => Number.isInteger(v);
const between = (n, a, b) => Number.isInteger(n) && n >= a && n <= b;
const normName = (s = "") => String(s).replace(/\s+/g, " ").trim();
const isDataUrl = (s) =>
  typeof s === "string" && /^data:image\/(png|jpe?g|webp);base64,/.test(s);
const parseBoolLoose = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(s)) return true;
  if (["false", "f", "0", "no", "n"].includes(s)) return false;
  return null;
};

// fetch one series with category, subcategory, seasons, genres, primary genre
async function fetchSeriesFull(seriesId) {
  const sql = `
    SELECT
      s.series_id,
      s.series_name,
      s.category_id,
      c.name  AS category_name,
      c.color AS category_color,
      s.subcategory_id,
      sc.name AS subcategory_name,
      s.release_year,
      s.poster_url,
      s.is_watched,
      s.primary_genre_id,
      pg.name AS primary_genre_name,
      s.created_at,
      s.updated_at,
      COALESCE((
        SELECT json_agg(json_build_object(
                   'season_id', x.season_id,
                   'season_no', x.season_no,
                   'year', x.year
               ) ORDER BY x.season_no, x.season_id)
        FROM (
          SELECT DISTINCT se.season_id, se.season_no, se.year
          FROM seasons se
          WHERE se.series_id = s.series_id
        ) x
      ), '[]'::json) AS seasons,
      COALESCE((
        SELECT json_agg(json_build_object(
                   'genre_id', x.genre_id,
                   'name', x.name
               ) ORDER BY x.name, x.genre_id)
        FROM (
          SELECT DISTINCT g.genre_id, g.name
          FROM series_genres sg
          JOIN genres g ON g.genre_id = sg.genre_id
          WHERE sg.series_id = s.series_id
        ) x
      ), '[]'::json) AS genres
    FROM series s
    JOIN categories c ON c.category_id = s.category_id
    LEFT JOIN subcategories sc ON sc.subcategory_id = s.subcategory_id
    LEFT JOIN genres pg ON pg.genre_id = s.primary_genre_id
    WHERE s.series_id = $1
    GROUP BY s.series_id, c.category_id, sc.subcategory_id, pg.genre_id;
  `;
  const { rows } = await db.query(sql, [seriesId]);
  return rows[0] || null;
}

// ------------------------------------------------------------------
// COUNTS
// ------------------------------------------------------------------

// GET /api/series/count -> { total }
router.get("/count", async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS total FROM series;`);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error counting series" });
  }
});

// GET /api/series/count/by-category
router.get("/count/by-category", async (_req, res) => {
  try {
    const sql = `
      SELECT
        c.category_id,
        c.name  AS category_name,
        c.color AS category_color,
        COALESCE(COUNT(s.series_id),0)::int AS total
      FROM categories c
      LEFT JOIN series s ON s.category_id = c.category_id
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

// ------------------------------------------------------------------
// FEEDERS / SUGGESTIONS / DUP-CHECKS
// ------------------------------------------------------------------

// categories feeder
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

// subcategories feeder (optional filter by category_id)
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
    const catId = toInt(cid);
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

// genres feeder
router.get("/genres", async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT genre_id, name FROM genres ORDER BY name;`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching genres" });
  }
});

// suggestions (prefix -> infix) -> /api/series/suggest?q=game&limit=10
router.get("/suggest", async (req, res) => {
  try {
    const q = normName(req.query.q || "");
    const limit = Math.min(Math.max(toInt(req.query.limit) || 10, 1), 50);
    if (!q) return res.json([]);

    const { rows } = await db.query(
      `
      (
        SELECT DISTINCT series_name
        FROM series
        WHERE series_name ILIKE $1 || '%'
        ORDER BY series_name
        LIMIT $2
      )
      UNION
      (
        SELECT DISTINCT series_name
        FROM series
        WHERE series_name ILIKE '%' || $1 || '%'
        ORDER BY series_name
        LIMIT $2
      )
      LIMIT $2;
      `,
      [q, limit]
    );
    res.json(rows.map((r) => r.series_name));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching suggestions" });
  }
});

/**
 * duplicate series check
 * Accepts release_year or year (frontend parity):
 * /api/series/duplicate-series?series_name=..[&category_id=..&release_year=..|&year=..&subcategory_id=..]
 */
router.get("/duplicate-series", async (req, res) => {
  try {
    const series_name = normName(req.query.series_name || "");
    if (!series_name) {
      return res.status(400).json({ error: "series_name is required" });
    }

    // accept either release_year or year
    const yearParam = req.query.release_year ?? req.query.year;
    const hasCategory = req.query.category_id != null && req.query.category_id !== "";
    const hasYear = yearParam != null && yearParam !== "";

    // MODE 1: name-only duplicate
    if (!hasCategory || !hasYear) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM series WHERE INITCAP(series_name) = INITCAP($1) LIMIT 1;`,
        [series_name]
      );
      return res.json({ duplicate: rowCount > 0, mode: "name-only" });
    }

    // MODE 2: strict composite
    const category_id = toInt(req.query.category_id);
    const release_year = toInt(yearParam);
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
      FROM series
      WHERE INITCAP(series_name) = INITCAP($1)
        AND category_id = $2
        AND release_year = $3
        AND COALESCE(subcategory_id, 0) = COALESCE($4, 0)
      `,
      [series_name, category_id, release_year, subcategory_id]
    );
    res.json({ duplicate: rowCount > 0, mode: "composite" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error checking duplicate (series)" });
  }
});

// duplicate season -> /api/series/duplicate-season?series_id=..&season_no=..
router.get("/duplicate-season", async (req, res) => {
  try {
    const series_id = toInt(req.query.series_id);
    const season_no = toInt(req.query.season_no);
    if (!isInt(series_id) || !isInt(season_no)) {
      return res.status(400).json({ error: "series_id and season_no must be integers" });
    }
    const { rowCount } = await db.query(
      `SELECT 1 FROM seasons WHERE series_id=$1 AND season_no=$2`,
      [series_id, season_no]
    );
    res.json({ duplicate: rowCount > 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error checking duplicate (season)" });
  }
});

// ------------------------------------------------------------------
// SERIES CRUD (+ list with filters/search/pagination)
// ------------------------------------------------------------------

// Add Series (supports is_watched; defaults to false if omitted)
router.post("/", async (req, res) => {
  let {
    series_name,
    category_id,
    subcategory_id = null,
    release_year,
    poster_url = null,
    genre_ids,
    primary_genre_id = null,
    is_watched, // NEW
  } = req.body || {};

  if (!series_name || category_id == null || release_year == null) {
    return res.status(400).json({ error: "series_name, category_id, release_year are required" });
  }

  // normalize empties
  poster_url = poster_url === "" ? null : poster_url;

  const catId = toInt(category_id);
  const yr = toInt(release_year);
  const subId = subcategory_id == null || subcategory_id === "" ? null : toInt(subcategory_id);
  const pgId = primary_genre_id == null || primary_genre_id === "" ? null : toInt(primary_genre_id);
  const iw = parseBoolLoose(is_watched); // null => default false

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

    // ensure category exists
    const c = await client.query(`SELECT 1 FROM categories WHERE category_id=$1`, [catId]);
    if (!c.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Category does not exist" });
    }

    // ensure primary genre exists if provided
    if (pgId != null) {
      const g = await client.query(`SELECT 1 FROM genres WHERE genre_id=$1`, [pgId]);
      if (!g.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "primary_genre_id does not exist" });
      }
    }

    const seriesNameNorm = normName(series_name);

    // composite duplicate
    const dupComposite = await client.query(
      `
      SELECT 1
      FROM series
      WHERE INITCAP(series_name) = INITCAP($1)
        AND category_id = $2
        AND release_year = $3
        AND COALESCE(subcategory_id, 0) = COALESCE($4, 0)
      `,
      [seriesNameNorm, catId, yr, subId]
    );
    if (dupComposite.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Duplicate series exists (name+category+year+subcategory)" });
    }

    // name-only duplicate (global)
    const dupNameOnly = await client.query(
      `SELECT 1 FROM series WHERE INITCAP(series_name)=INITCAP($1) LIMIT 1;`,
      [seriesNameNorm]
    );
    if (dupNameOnly.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Duplicate series name exists" });
    }

    // insert
    const ins = await client.query(
      `INSERT INTO series
         (series_name, category_id, subcategory_id, release_year, poster_url, is_watched, primary_genre_id)
       VALUES (INITCAP($1), $2, $3, $4, $5, $6, $7)
       RETURNING series_id;`,
      [seriesNameNorm, catId, subId, yr, poster_url, iw === null ? false : iw, pgId]
    );
    const seriesId = ins.rows[0].series_id;

    // add genres (if any)
    if (Array.isArray(genre_ids) && genre_ids.length) {
      await client.query(
        `INSERT INTO series_genres (series_id, genre_id)
         SELECT $1, UNNEST($2::int[])
         ON CONFLICT DO NOTHING;`,
        [seriesId, genre_ids]
      );
    }

    // DB trigger should auto-create Season 1 with release_year
    await client.query("COMMIT");

    const full = await fetchSeriesFull(seriesId);
    res.status(201).json(full);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Duplicate series" });
    }
    res.status(500).json({ error: "Error adding series" });
  } finally {
    client.release();
  }
});

// List Series: filters (category, subcategory, date range, is_watched), search q, pagination
// /api/series?category_id=1&subcategory_id=2&is_watched=true&q=game&date_from=2025-01-01&date_to=2025-12-31&limit=50&offset=0
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
      conds.push(`s.category_id = $${i}`);
    }
    if (subcategory_id != null && subcategory_id !== "") {
      const sid = toInt(subcategory_id);
      if (!isInt(sid)) return res.status(400).json({ error: "subcategory_id must be integer" });
      params.push(sid); i++;
      conds.push(`s.subcategory_id = $${i}`);
    }
    if (req.query.is_watched != null && req.query.is_watched !== "") {
      const iw = parseBoolLoose(req.query.is_watched);
      if (iw === null) return res.status(400).json({ error: "is_watched must be true/false/1/0/yes/no" });
      params.push(iw); i++;
      conds.push(`s.is_watched = $${i}`);
    }
    if (date_from) {
      params.push(date_from); i++;
      conds.push(`s.created_at >= $${i}`);
    }
    if (date_to) {
      params.push(date_to); i++;
      conds.push(`s.created_at < ($${i}::date + INTERVAL '1 day')`);
    }
    if (q) {
      params.push(`%${normName(q)}%`); i++;
      conds.push(`s.series_name ILIKE $${i}`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    // Build display_no directly from base table; include primary genre fields
    const sql = `
      WITH base AS (
        SELECT
          ROW_NUMBER() OVER (ORDER BY s.created_at, s.series_id) AS display_no,
          s.series_id,
          s.series_name,
          s.release_year,
          s.category_id,
          c.name  AS category_name,
          c.color AS category_color,
          s.subcategory_id,
          sc.name AS subcategory_name,
          s.primary_genre_id,
          pg.name AS primary_genre_name,
          s.poster_url,
          s.is_watched,
          s.created_at,
          s.updated_at
        FROM series s
        JOIN categories c ON c.category_id = s.category_id
        LEFT JOIN subcategories sc ON sc.subcategory_id = s.subcategory_id
        LEFT JOIN genres pg ON pg.genre_id = s.primary_genre_id
        ${where}
      )
      SELECT
        b.*,
        COALESCE((
          SELECT json_agg(json_build_object(
                   'season_id', x.season_id,
                   'season_no', x.season_no,
                   'year', x.year
                 ) ORDER BY x.season_no, x.season_id)
          FROM (
            SELECT DISTINCT se.season_id, se.season_no, se.year
            FROM seasons se
            WHERE se.series_id = b.series_id
          ) x
        ), '[]'::json) AS seasons
      FROM base b
      ORDER BY b.display_no
      LIMIT $${i + 1} OFFSET $${i + 2};
    `;
    const { rows } = await db.query(sql, [...params, limit, offset]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching series" });
  }
});

// find series by exact name (+ optional category/release_year/subcategory)
async function findSeriesId({ name, category_id = null, release_year = null, subcategory_id = null }) {
  const nameNorm = normName(name || "");
  const params = [nameNorm];
  const where = [`INITCAP(s.series_name) = INITCAP($1)`];

  if (category_id != null) {
    params.push(Number(category_id));
    where.push(`s.category_id = $${params.length}`);
  }
  if (release_year != null) {
    params.push(Number(release_year));
    where.push(`s.release_year = $${params.length}`);
  }
  if (subcategory_id != null) {
    params.push(Number(subcategory_id));
    where.push(`s.subcategory_id = $${params.length}`);
  }

  const sql = `
    SELECT s.series_id
    FROM series s
    WHERE ${where.join(" AND ")}
    ORDER BY s.created_at, s.series_id
    LIMIT 1;
  `;
  const { rows } = await db.query(sql, params);
  return rows[0]?.series_id || null;
}

// GET /api/series/by-name?name=...
router.get("/by-name", async (req, res) => {
  try {
    const { name, category_id, release_year, subcategory_id } = req.query || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const seriesId = await findSeriesId({
      name: name.trim(),
      category_id,
      release_year,
      subcategory_id,
    });
    if (!seriesId) return res.status(404).json({ error: "Series not found" });

    const full = await fetchSeriesFull(seriesId);
    res.json(full);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error finding series by name" });
  }
});

// GET /api/series/by-name/:name
router.get("/by-name/:name", async (req, res) => {
  try {
    const name = req.params.name;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const seriesId = await findSeriesId({ name: name.trim() });
    if (!seriesId) return res.status(404).json({ error: "Series not found" });

    const full = await fetchSeriesFull(seriesId);
    res.json(full);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error finding series by name" });
  }
});

// Get One
router.get("/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const row = await fetchSeriesFull(id);
    if (!row) return res.status(404).json({ error: "Series not found" });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error fetching series" });
  }
});

// Update ONLY poster_url (drag/drop) and is_watched (yes/no)
router.put("/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  let { poster_url, is_watched } = req.body || {};

  const sets = [];
  const params = [];

  // If client sent poster_url, allow clearing with "" or null, or setting to data URL / http(s)
  if (Object.prototype.hasOwnProperty.call(req.body, "poster_url")) {
    poster_url = poster_url === "" ? null : poster_url;
    if (
      poster_url != null &&
      !(isDataUrl(poster_url) || /^https?:\/\//i.test(String(poster_url)))
    ) {
      return res
        .status(400)
        .json({ error: "poster_url must be a data:image/* base64 URL or http(s) URL" });
    }
    params.push(poster_url);
    sets.push(`poster_url = $${params.length}`);
  }

  // If client sent is_watched, coerce to boolean (accepts true/false/1/0/yes/no)
  if (Object.prototype.hasOwnProperty.call(req.body, "is_watched")) {
    const iw = parseBoolLoose(is_watched);
    if (iw === null) {
      return res
        .status(400)
        .json({ error: "is_watched must be true/false/1/0/yes/no" });
    }
    params.push(iw);
    sets.push(`is_watched = $${params.length}`);
  }

  if (!sets.length) {
    return res
      .status(400)
      .json({ error: "Provide at least one of: poster_url, is_watched" });
  }

  // Always touch updated_at
  sets.push(`updated_at = NOW()`);

  const sql = `
    UPDATE series
    SET ${sets.join(", ")}
    WHERE series_id = $${params.length + 1}
    RETURNING series_id, poster_url, is_watched, updated_at;
  `;

  try {
    const { rows } = await db.query(sql, [...params, id]);
    if (!rows.length) return res.status(404).json({ error: "Series not found" });
    // Return minimal fresh state (no heavy joins)
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error updating series (poster/is_watched)" });
  }
});

// Delete Series
router.delete("/:id", async (req, res) => {
  const id = toInt(req.params.id);
  if (!isInt(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const del = await db.query(`DELETE FROM series WHERE series_id=$1`, [id]);
    if (!del.rowCount) {
      return res.status(404).json({ error: "Series not found" });
    }
    res.json({ message: "Series deleted successfully" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error deleting series" });
  }
});

// ------------------------------------------------------------------
// SEASONS
// ------------------------------------------------------------------

// Add/Upsert season (>=2) with mandatory year (Season 1 auto-created by DB on series insert)
router.post("/seasons", async (req, res) => {
  const { series_id, season_no, year } = req.body || {};
  const sid = toInt(series_id);
  const sn = toInt(season_no);
  const yr = toInt(year);

  if (!isInt(sid) || !isInt(sn) || !isInt(yr)) {
    return res.status(400).json({ error: "series_id, season_no, year must be integers" });
  }
  if (sn < 2) return res.status(400).json({ error: "season_no must be >= 2" });
  if (!between(yr, 1888, 2100)) return res.status(400).json({ error: "year must be 1888..2100" });

  try {
    const sv = await db.query(`SELECT 1 FROM series WHERE series_id=$1`, [sid]);
    if (!sv.rowCount) return res.status(404).json({ error: "Series not found" });

    const sql = `
      INSERT INTO seasons (series_id, season_no, year)
      VALUES ($1, $2, $3)
      ON CONFLICT ON CONSTRAINT seasons_unq
      DO UPDATE SET year = EXCLUDED.year
      RETURNING *;
    `;
    const { rows } = await db.query(sql, [sid, sn, yr]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error adding/updating season" });
  }
});

// Update Season
router.put("/seasons/:seasonId", async (req, res) => {
  const seasonId = toInt(req.params.seasonId);
  const { season_no, year } = req.body || {};
  const sn = toInt(season_no);
  const yr = toInt(year);

  if (!isInt(seasonId) || !isInt(sn) || !isInt(yr)) {
    return res.status(400).json({ error: "seasonId, season_no, year must be integers" });
  }
  if (sn < 1) return res.status(400).json({ error: "season_no must be >= 1" });
  if (!between(yr, 1888, 2100)) return res.status(400).json({ error: "year must be 1888..2100" });

  try {
    const q = `
      WITH _old AS (
        SELECT series_id FROM seasons WHERE season_id=$1
      )
      UPDATE seasons se
      SET season_no=$2, year=$3
      FROM _old
      WHERE se.season_id=$1
      RETURNING se.*;
    `;
    const { rows } = await db.query(q, [seasonId, sn, yr]);
    if (!rows.length) return res.status(404).json({ error: "Season not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "Season number already exists for this series" });
    }
    res.status(500).json({ error: "Error updating season" });
  }
});

// Delete Season
router.delete("/seasons/:seasonId", async (req, res) => {
  const seasonId = toInt(req.params.seasonId);
  if (!isInt(seasonId)) return res.status(400).json({ error: "Invalid seasonId" });

  try {
    const del = await db.query(`DELETE FROM seasons WHERE season_id=$1`, [seasonId]);
    if (!del.rowCount) return res.status(404).json({ error: "Season not found" });
    res.json({ message: "Season deleted successfully" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error deleting season" });
  }
});

module.exports = router;
