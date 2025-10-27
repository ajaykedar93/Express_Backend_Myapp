// routes/userActFavorite.js
const express = require("express");
const router = express.Router();
const pool = require("../db"); // <- as requested

// ---------------------------
// Helpers
// ---------------------------
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function ok(res, data, meta) {
  return res.json({ success: true, data, ...(meta ? { meta } : {}) });
}
function fail(res, code = 400, message = "Invalid request") {
  return res.status(code).json({ success: false, message });
}

/**
 * Get (or create) a country id from either country_id or country_name.
 * If both given, country_id wins.
 */
async function resolveCountryId({ country_id, country_name }) {
  if (country_id) return country_id;
  if (!country_name || !String(country_name).trim()) return null;

  // Insert if missing; return id either way.
  const q = `
    WITH ins AS (
      INSERT INTO country_list (country_name)
      VALUES ($1)
      ON CONFLICT (country_name) DO NOTHING
      RETURNING id
    )
    SELECT id FROM ins
    UNION ALL
    SELECT id FROM country_list WHERE country_name = $1
    LIMIT 1;
  `;
  const { rows } = await pool.query(q, [country_name.trim()]);
  return rows[0]?.id ?? null;
}

/** Normalize images input to JSON string (server will send as JSONB) */
function toJsonbTextArray(arr) {
  if (!Array.isArray(arr)) return null;
  const filtered = arr
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter((v) => v.length > 0);
  return filtered.length ? JSON.stringify(filtered) : null;
}

// ---------------------------
// Countries
// ---------------------------

/**
 * GET /api/countries?search=uk&limit=20
 */
router.get(
  "/countries",
  asyncHandler(async (req, res) => {
    const { search = "", limit = 50 } = req.query;
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const rows = search
      ? (
          await pool.query(
            `SELECT id, country_name
             FROM country_list
             WHERE lower(country_name) LIKE lower($1)
             ORDER BY country_name ASC
             LIMIT $2`,
            [`%${search}%`, lim]
          )
        ).rows
      : (
          await pool.query(
            `SELECT id, country_name
             FROM country_list
             ORDER BY country_name ASC
             LIMIT $1`,
            [lim]
          )
        ).rows;

    return ok(res, rows);
  })
);

// ---------------------------
// Favorites CRUD
// ---------------------------

/**
 * GET /api/user-act-favorite
 * Query:
 *  - q: search in name/movie/notes/username
 *  - country_id
 *  - page (default 1), limit (default 20, max 200)
 *  - sort (created_at|updated_at|name|movie), dir (asc|desc)
 */
router.get(
  "/user-act-favorite",
  asyncHandler(async (req, res) => {
    const {
      q = "",
      country_id,
      page = 1,
      limit = 20,
      sort = "updated_at",
      dir = "desc",
    } = req.query;

    const p = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 20, 200));
    const offset = (p - 1) * lim;

    const allowedSort = {
      created_at: "u.created_at",
      updated_at: "u.updated_at",
      name: "u.favorite_actress_name",
      movie: "u.favorite_movie_series",
    };
    const orderBy = allowedSort[sort] || "u.updated_at";
    const orderDir = String(dir).toLowerCase() === "asc" ? "ASC" : "DESC";

    const params = [];
    const where = [];

    if (country_id) {
      params.push(Number(country_id));
      where.push(`u.country_id = $${params.length}`);
    }
    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      const idx = params.length;
      where.push(
        `( lower(u.favorite_actress_name) LIKE $${idx}
         OR lower(u.favorite_movie_series) LIKE $${idx}
         OR lower(coalesce(u.notes,'')) LIKE $${idx}
         OR lower(coalesce(u.profile_image,'')) LIKE $${idx} )`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // count
    const countSql = `SELECT count(*)::int AS total FROM user_act_favorite u ${whereSql}`;
    const total = (await pool.query(countSql, params)).rows[0]?.total ?? 0;

    // data
    const dataSql = `
      SELECT
        u.*,
        c.country_name
      FROM user_act_favorite u
      LEFT JOIN country_list c ON c.id = u.country_id
      ${whereSql}
      ORDER BY ${orderBy} ${orderDir}, u.id ${orderDir}
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;
    const data = (
      await pool.query(dataSql, [...params, lim, offset])
    ).rows;

    return ok(res, data, {
      page: p,
      limit: lim,
      total,
      pages: Math.max(1, Math.ceil(total / lim)),
      sort,
      dir: orderDir.toLowerCase(),
    });
  })
);

/**
 * GET /api/user-act-favorite/:id
 */
router.get(
  "/user-act-favorite/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, "Invalid id");

    const sql = `
      SELECT u.*, c.country_name
      FROM user_act_favorite u
      LEFT JOIN country_list c ON c.id = u.country_id
      WHERE u.id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return fail(res, 404, "Not found");

    return ok(res, rows[0]);
  })
);

/**
 * POST /api/user-act-favorite
 * Body:
 *  - country_id? OR country_name?
 *  - favorite_actress_name* (text)
 *  - age? (int>0)
 *  - actress_dob? (YYYY-MM-DD)
 *  - favorite_movie_series* (text)
 *  - profile_image? (text)
 *  - images? (string[])      -> replaces initial images exactly
 *  - images_raw? (text or "url1,url2" or JSON) -> will APPEND via trigger
 *  - notes? (text)
 */
router.post(
  "/user-act-favorite",
  asyncHandler(async (req, res) => {
    const {
      country_id,
      country_name,
      favorite_actress_name,
      age,
      actress_dob,
      favorite_movie_series,
      profile_image,
      images, // array of strings
      images_raw, // string/CSV/JSON text -> trigger appends
      notes,
    } = req.body || {};

    if (!favorite_actress_name || !favorite_movie_series) {
      return fail(res, 400, "favorite_actress_name and favorite_movie_series are required");
    }

    const cid = await resolveCountryId({ country_id, country_name });

    // images can be set directly; images_raw (if present) will be parsed & appended by trigger
    const imagesJsonText = toJsonbTextArray(images); // or null

    const sql = `
      INSERT INTO user_act_favorite (
        country_id, favorite_actress_name, age, actress_dob,
        favorite_movie_series, profile_image, images, images_raw, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
      RETURNING *;
    `;
    const params = [
      cid,
      favorite_actress_name,
      age ?? null,
      actress_dob ?? null,
      favorite_movie_series,
      profile_image ?? null,
      imagesJsonText, // may be null
      images_raw ?? null, // trigger will append if provided
      notes ?? null,
    ];

    try {
      const { rows } = await pool.query(sql, params);
      const created = rows[0];

      // fetch country name
      const withCountry = (
        await pool.query(
          `SELECT u.*, c.country_name
           FROM user_act_favorite u
           LEFT JOIN country_list c ON c.id = u.country_id
           WHERE u.id = $1`,
          [created.id]
        )
      ).rows[0];

      return ok(res, withCountry);
    } catch (e) {
      // Unique violation, etc.
      if (e.code === "23505") {
        return fail(
          res,
          409,
          "Duplicate: same actress + country + movie/series already exists"
        );
      }
      throw e;
    }
  })
);

/**
 * PATCH /api/user-act-favorite/:id
 * Body: any subset of columns.
 *  - If you include images_raw (string/CSV/JSON), trigger will APPEND to existing images
 *  - If you include images (string[]), set replaceImages=true to REPLACE entire images array
 *    otherwise it will be ignored (use the /images helper route to add/remove)
 */
router.patch(
  "/user-act-favorite/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, "Invalid id");

    const {
      country_id,
      country_name,
      favorite_actress_name,
      age,
      actress_dob,
      favorite_movie_series,
      profile_image,
      images, // replace?
      replaceImages = false,
      images_raw, // append via trigger
      notes,
    } = req.body || {};

    const cid =
      country_id !== undefined || country_name !== undefined
        ? await resolveCountryId({ country_id, country_name })
        : undefined;

    // Build dynamic UPDATE
    const sets = [];
    const params = [];
    const add = (frag, val) => {
      params.push(val);
      sets.push(`${frag} = $${params.length}`);
    };

    if (cid !== undefined) add("country_id", cid);
    if (favorite_actress_name !== undefined)
      add("favorite_actress_name", favorite_actress_name);
    if (age !== undefined) add("age", age);
    if (actress_dob !== undefined) add("actress_dob", actress_dob);
    if (favorite_movie_series !== undefined)
      add("favorite_movie_series", favorite_movie_series);
    if (profile_image !== undefined) add("profile_image", profile_image);
    if (images_raw !== undefined) add("images_raw", images_raw);
    if (notes !== undefined) add("notes", notes);

    if (replaceImages && images !== undefined) {
      const imagesJsonText = toJsonbTextArray(images);
      // Force array (or null)
      add("images", imagesJsonText ? imagesJsonText + "::jsonb" : null);
      // NOTE: we pass text and cast in query; below we’ll adapt to inline casting.
      // To keep paramized: push text and in SQL use $X::jsonb.
      sets[sets.length - 1] = "images = $" + params.length + "::jsonb";
    }

    if (!sets.length) return fail(res, 400, "No updatable fields provided");

    const sql = `
      UPDATE user_act_favorite
      SET ${sets.join(", ")}
      WHERE id = $${params.length + 1}
      RETURNING *;
    `;
    const { rows } = await pool.query(sql, [...params, id]);
    if (!rows.length) return fail(res, 404, "Not found");

    const withCountry = (
      await pool.query(
        `SELECT u.*, c.country_name
         FROM user_act_favorite u
         LEFT JOIN country_list c ON c.id = u.country_id
         WHERE u.id = $1`,
        [id]
      )
    ).rows[0];

    return ok(res, withCountry);
  })
);

/**
 * PATCH /api/user-act-favorite/:id/images
 * Body:
 *  - add?: string[]     (append these)
 *  - remove?: string[]  (remove exact matches of these values)
 *
 * Uses JSONB operators; does not rely on images_raw.
 */
router.patch(
  "/user-act-favorite/:id/images",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, "Invalid id");

    const { add = [], remove = [] } = req.body || {};
    const addText = toJsonbTextArray(add); // string or null
    const removeArr = Array.isArray(remove)
      ? remove.map((v) => String(v || "").trim()).filter(Boolean)
      : [];

    // Start transaction to keep operations atomic
    await pool.query("BEGIN");
    try {
      if (addText) {
        await pool.query(
          `
          UPDATE user_act_favorite
          SET images = COALESCE(images, '[]'::jsonb) || $1::jsonb
          WHERE id = $2
        `,
          [addText, id]
        );
      }

      if (removeArr.length) {
        // Remove any elements that match provided list (exact match on json text)
        await pool.query(
          `
          WITH vals AS (
            SELECT to_jsonb(val) AS v
            FROM unnest($2::text[]) AS val
          )
          UPDATE user_act_favorite
          SET images = (
            SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(user_act_favorite.images,'[]'::jsonb)) AS e
            WHERE NOT EXISTS (SELECT 1 FROM vals WHERE vals.v::text = e::text)
          )
          WHERE id = $1
        `,
          [id, removeArr]
        );
      }

      const { rows } = await pool.query(
        `SELECT u.*, c.country_name
         FROM user_act_favorite u
         LEFT JOIN country_list c ON c.id = u.country_id
         WHERE u.id = $1`,
        [id]
      );

      await pool.query("COMMIT");
      if (!rows.length) return fail(res, 404, "Not found");
      return ok(res, rows[0]);
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  })
);

/**
 * DELETE /api/user-act-favorite/:id
 */
router.delete(
  "/user-act-favorite/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, "Invalid id");

    const { rowCount } = await pool.query(
      `DELETE FROM user_act_favorite WHERE id = $1`,
      [id]
    );
    if (!rowCount) return fail(res, 404, "Not found");

    return ok(res, { id });
  })
);

// ---------------------------
// Error handler (router-local)
// ---------------------------
router.use((err, req, res, _next) => {
  console.error("[user-act-favorite] Error:", err);
  if (err.code === "22P02") {
    // invalid_text_representation (e.g., bad int/date)
    return fail(res, 400, "Invalid value for one of the fields");
  }
  if (err.code === "23505") {
    // unique violation
    return fail(
      res,
      409,
      "Duplicate: same actress + country + movie/series already exists"
    );
  }
  return res.status(500).json({ success: false, message: "Server error" });
});

module.exports = router;
