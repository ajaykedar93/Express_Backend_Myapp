// routes/library.js

const express = require("express");
const router = express.Router();
const db = require("../db");

const PAGE_SIZE = 20;

router.get("/list", async (req, res) => {
  try {
    const type = String(req.query.type || "movies").toLowerCase();
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const search = String(req.query.search || "").trim(); // new param
    const limit = PAGE_SIZE;
    const offset = (page - 1) * limit;

    if (!["movies", "series"].includes(type)) {
      return res.status(400).json({ error: "Query param 'type' must be 'movies' or 'series'." });
    }

    let sql;
    let params = [limit, offset];
    let where = "";

    if (search) {
      // search case-insensitive (ILIKE)
      where = "WHERE m.movie_name ILIKE $3";
      if (type === "series") {
        where = "WHERE s.series_name ILIKE $3";
      }
      params = [limit, offset, `%${search}%`];
    }

    if (type === "movies") {
      sql = `
        SELECT
          m.movie_id                                 AS id,
          m.movie_name                               AS title,
          m.release_year,
          m.poster_url,
          COALESCE(m.is_watched, FALSE)              AS is_watched,

          m.category_id,
          c.name                                     AS category_name,
          c.color                                    AS category_color,

          m.subcategory_id,
          sc.name                                    AS subcategory_name,

          (
            SELECT ARRAY_REMOVE(
                     ARRAY_AGG(CONCAT('Part ', mp.part_number, ' (', mp.year, ')') ORDER BY mp.part_number),
                     NULL
                   )
            FROM movie_parts mp
            WHERE mp.movie_id = m.movie_id
          )                                          AS parts,

          (
            SELECT ARRAY_REMOVE(
                     ARRAY_AGG(DISTINCT g.name ORDER BY g.name),
                     NULL
                   )
            FROM movie_genres mg
            JOIN genres g ON g.genre_id = mg.genre_id
            WHERE mg.movie_id = m.movie_id
          )                                          AS genres,

          COUNT(*) OVER()                            AS __total__
        FROM movies m
        JOIN categories c          ON c.category_id = m.category_id
        LEFT JOIN subcategories sc ON sc.subcategory_id = m.subcategory_id
        ${where}
        ORDER BY m.created_at DESC, m.movie_id DESC
        LIMIT $1 OFFSET $2;
      `;
    } else {
      sql = `
        SELECT
          s.series_id                                 AS id,
          s.series_name                               AS title,
          s.release_year,
          s.poster_url,
          COALESCE(s.is_watched, FALSE)               AS is_watched,

          s.category_id,
          c.name                                      AS category_name,
          c.color                                     AS category_color,

          s.subcategory_id,
          sc.name                                     AS subcategory_name,

          (
            SELECT ARRAY_REMOVE(
                     ARRAY_AGG(CONCAT('Season ', se.season_no, ' (', se.year, ')') ORDER BY se.season_no),
                     NULL
                   )
            FROM seasons se
            WHERE se.series_id = s.series_id
          )                                           AS seasons,

          (
            SELECT ARRAY_REMOVE(
                     ARRAY_AGG(DISTINCT g.name ORDER BY g.name),
                     NULL
                   )
            FROM series_genres sg
            JOIN genres g ON g.genre_id = sg.genre_id
            WHERE sg.series_id = s.series_id
          )                                           AS genres,

          COUNT(*) OVER()                             AS __total__
        FROM series s
        JOIN categories c          ON c.category_id = s.category_id
        LEFT JOIN subcategories sc ON sc.subcategory_id = s.subcategory_id
        ${where}
        ORDER BY s.created_at DESC, s.series_id DESC
        LIMIT $1 OFFSET $2;
      `;
    }

    const { rows } = await db.query(sql, params);
    const total = rows[0]?.__total__ ? Number(rows[0].__total__) : 0;
    const total_pages = Math.max(1, Math.ceil(total / limit));

    const items = rows.map((r, i) => ({
      seq: offset + i + 1,
      id: r.id,
      type,
      title: r.title,
      release_year: r.release_year,
      poster_url: r.poster_url,
      is_watched: !!r.is_watched,

      parts: type === "movies" ? (r.parts || []) : [],
      seasons: type === "series" ? (r.seasons || []) : [],

      category: {
        id: r.category_id,
        name: r.category_name,
        color: r.category_color,
      },
      subcategory: r.subcategory_id
        ? { id: r.subcategory_id, name: r.subcategory_name }
        : null,

      genres: r.genres || [],
      right_meta: `${r.release_year || ""}${r.is_watched ? " • Watched" : ""}`,
    }));

    return res.json({
      ok: true,
      type,
      page,
      page_size: limit,
      total,
      total_pages,
      items,
    });
  } catch (err) {
    console.error("GET /api/library/list error:", err);
    return res.status(500).json({ error: "Failed to load list" });
  }
});

module.exports = router;
