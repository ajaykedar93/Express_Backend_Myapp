// routes/userActFavorite.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

const multer = require("multer");
const path = require("path");
const fs = require("fs");

/* =========================================================
   FILE UPLOADS: extra images
   ========================================================= */

// physical folder:   <project-root>/uploads/actress_images
// public URL prefix: /uploads/actress_images/...
const uploadRoot = path.join(__dirname, "..", "uploads", "actress_images");
const uploadPublicPrefix = "/uploads/actress_images";

fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadRoot);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^\w\-]+/g, "");
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${base || "img"}-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/* =========================================================
   HELPERS
   ========================================================= */

const asyncHandler =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

function ok(res, data, meta) {
  const payload = { success: true, data };
  if (meta) payload.meta = meta;
  return res.json(payload);
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
  return rows[0] ? rows[0].id : null;
}

/** Normalize images input to JSON text for jsonb column */
function toJsonbTextArray(arr) {
  if (!Array.isArray(arr)) return null;
  const filtered = arr
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter((v) => v.length > 0);
  return filtered.length ? JSON.stringify(filtered) : null;
}

/* =========================================================
   COUNTRIES
   ========================================================= */

/**
 * GET /api/act_favorite/countries?search=uk&limit=20
 */
router.get(
  "/countries",
  asyncHandler(async (req, res) => {
    const { search = "", limit = 50 } = req.query;
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));

    let rows;
    if (search) {
      const s = `%${search}%`;
      rows = (
        await pool.query(
          `SELECT id, country_name
           FROM country_list
           WHERE lower(country_name) LIKE lower($1)
           ORDER BY country_name ASC
           LIMIT $2`,
          [s, lim]
        )
      ).rows;
    } else {
      rows = (
        await pool.query(
          `SELECT id, country_name
           FROM country_list
           ORDER BY country_name ASC
           LIMIT $1`,
          [lim]
        )
      ).rows;
    }

    return ok(res, rows);
  })
);

/* =========================================================
   FAVORITES CRUD
   ========================================================= */

/**
 * GET /api/act_favorite/user-act-favorite
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
           OR lower(coalesce(u.notes, '')) LIKE $${idx}
           OR lower(coalesce(u.profile_image, '')) LIKE $${idx} )`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total =
      (
        await pool.query(
          `SELECT count(*)::int AS total FROM user_act_favorite u ${whereSql}`,
          params
        )
      ).rows[0]?.total ?? 0;

    const data = (
      await pool.query(
        `
        SELECT u.*, c.country_name
        FROM user_act_favorite u
        LEFT JOIN country_list c ON c.id = u.country_id
        ${whereSql}
        ORDER BY ${orderBy} ${orderDir}, u.id ${orderDir}
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `,
        [...params, lim, offset]
      )
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
 * GET /api/act_favorite/user-act-favorite/:id
 */
router.get(
  "/user-act-favorite/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, "Invalid id");

    const { rows } = await pool.query(
      `
      SELECT u.*, c.country_name
      FROM user_act_favorite u
      LEFT JOIN country_list c ON c.id = u.country_id
      WHERE u.id = $1
      LIMIT 1
    `,
      [id]
    );
    if (!rows.length) return fail(res, 404, "Not found");

    return ok(res, rows[0]);
  })
);

/**
 * POST /api/act_favorite/user-act-favorite
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
      images,
      images_raw,
      notes,
    } = req.body || {};

    if (!favorite_actress_name || !favorite_movie_series) {
      return fail(
        res,
        400,
        "favorite_actress_name and favorite_movie_series are required"
      );
    }

    const cid = await resolveCountryId({ country_id, country_name });
    const imagesJsonText = toJsonbTextArray(images);

    const { rows } = await pool.query(
      `
      INSERT INTO user_act_favorite (
        country_id, favorite_actress_name, age, actress_dob,
        favorite_movie_series, profile_image, images, images_raw, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
      RETURNING *;
    `,
      [
        cid,
        favorite_actress_name,
        age ?? null,
        actress_dob ?? null,
        favorite_movie_series,
        profile_image ?? null,
        imagesJsonText,
        images_raw ?? null,
        notes ?? null,
      ]
    );
    const created = rows[0];

    const withCountry = (
      await pool.query(
        `
        SELECT u.*, c.country_name
        FROM user_act_favorite u
        LEFT JOIN country_list c ON c.id = u.country_id
        WHERE u.id = $1
      `,
        [created.id]
      )
    ).rows[0];

    return ok(res, withCountry);
  })
);

/**
 * PATCH /api/act_favorite/user-act-favorite/:id
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
      images,
      replaceImages = false,
      images_raw,
      notes,
    } = req.body || {};

    const cid =
      country_id !== undefined || country_name !== undefined
        ? await resolveCountryId({ country_id, country_name })
        : undefined;

    const sets = [];
    const params = [];
    const add = (frag, val, castJsonb = false) => {
      params.push(val);
      const idx = params.length;
      sets.push(`${frag} = $${idx}${castJsonb ? "::jsonb" : ""}`);
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
      add("images", imagesJsonText, true);
    }

    if (!sets.length) return fail(res, 400, "No updatable fields provided");

    const { rows } = await pool.query(
      `
      UPDATE user_act_favorite
      SET ${sets.join(", ")}
      WHERE id = $${params.length + 1}
      RETURNING *;
    `,
      [...params, id]
    );
    if (!rows.length) return fail(res, 404, "Not found");

    const withCountry = (
      await pool.query(
        `
        SELECT u.*, c.country_name
        FROM user_act_favorite u
        LEFT JOIN country_list c ON c.id = u.country_id
        WHERE u.id = $1
      `,
        [id]
      )
    ).rows[0];

    return ok(res, withCountry);
  })
);

/**
 * PATCH /api/act_favorite/user-act-favorite/:id/images
 *  - multipart: files[] (field "files") -> uploaded & appended
 *  - JSON: { add?: string[], remove?: string[] }
 */
router.patch(
  "/user-act-favorite/:id/images",
  upload.array("files"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return fail(res, 400, "Invalid id");

    // base like: http://localhost:5000  OR https://express-backend-myapp.onrender.com
    const hostBase =
      process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;

    // 1) URLs for uploaded files
    const uploadedUrls = (req.files || []).map((file) => {
      const filename = path.basename(file.filename || file.path);
      // final URL stored in DB:
      //   http(s)://host/uploads/actress_images/<filename>
      return `${hostBase}${uploadPublicPrefix}/${filename}`;
    });

    // 2) parse add/remove from body
    const body = req.body || {};
    let add = [];
    let remove = [];

    if (Array.isArray(body.add)) {
      add = body.add;
    } else if (typeof body.add === "string") {
      try {
        const parsed = JSON.parse(body.add);
        if (Array.isArray(parsed)) add = parsed;
        else if (parsed) add = [String(parsed)];
      } catch {
        add = [body.add];
      }
    }

    if (Array.isArray(body.remove)) {
      remove = body.remove;
    } else if (typeof body.remove === "string") {
      try {
        const parsed = JSON.parse(body.remove);
        if (Array.isArray(parsed)) remove = parsed;
        else if (parsed) remove = [String(parsed)];
      } catch {
        remove = [body.remove];
      }
    }

    // merge uploaded URLs into add[]
    add = [...uploadedUrls, ...add];

    const addText = toJsonbTextArray(add);
    const removeArr = Array.isArray(remove)
      ? remove.map((v) => String(v || "").trim()).filter(Boolean)
      : [];

    await pool.query("BEGIN");
    try {
      // append new images
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

      // remove specified
      if (removeArr.length) {
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
        `
        SELECT u.*, c.country_name
        FROM user_act_favorite u
        LEFT JOIN country_list c ON c.id = u.country_id
        WHERE u.id = $1
      `,
        [id]
      );

      await pool.query("COMMIT");
      if (!rows.length) return fail(res, 404, "Not found");

      return ok(res, rows[0]); // React DetailView expects full row here
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  })
);

/**
 * DELETE /api/act_favorite/user-act-favorite/:id
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

/* =========================================================
   ROUTER-LEVEL ERROR HANDLER
   ========================================================= */

router.use((err, req, res, _next) => {
  console.error("[user-act-favorite] Error:", err);
  if (err.code === "22P02") {
    return fail(res, 400, "Invalid value for one of the fields");
  }
  if (err.code === "23505") {
    return fail(
      res,
      409,
      "Duplicate: same actress + country + movie/series already exists"
    );
  }
  return res.status(500).json({ success: false, message: "Server error" });
});

module.exports = router;
