// routes/websites.js
// Professional APIs for websites + websitecategory, using pg pool and multer for uploads.

const express = require("express");
const crypto = require("crypto");
const multer = require("multer");

const router = express.Router();
const pool = require("../db");

// ---------- Multer config (memory, for BYTEA) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype &&
      /^image\/(png|jpeg|jpg|webp|gif|bmp|svg\+xml)$/i.test(file.mimetype);
    if (!ok) return cb(new Error("Only image files are allowed."));
    cb(null, true);
  },
});

// ---------- Helpers ----------
const isHttpUrl = (u = "") => /^https?:\/\/.+/i.test(String(u || "").trim());
const cleanStr = (s) => (typeof s === "string" ? s.trim() : null);
const toInt = (v, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const statusFromMsg = (msg) =>
  /not found/i.test(msg) ? 404 :
  /invalid|bad request|validation/i.test(msg) ? 400 : 500;

function handleError(res, err, fallbackMsg = "Internal server error") {
  // Keep messages user-safe (DB details can leak via err.detail/hint)
  const raw =
    err?.message ||
    err?.code ||
    String(fallbackMsg);
  const status = statusFromMsg(raw);
  return res.status(status).json({ error: raw });
}

const mapWebsiteRow = (r, { withImageBytes = false } = {}) => {
  const {
    id,
    url,
    name,
    category,
    image_mime,
    image_name,
    image_size,
    created_at,
    updated_at,
  } = r;
  const base = {
    id,
    url,
    name,
    category,
    image_mime,
    image_name,
    image_size,
    created_at,
    updated_at,
  };
  if (withImageBytes && r.image_bytes) {
    base.image_base64 = Buffer.from(r.image_bytes).toString("base64");
  } else {
    base.image = {
      // URL to stream image (recommended for UI <img>)
      href: `/api/websites/${id}/image`,
      mime: image_mime || null,
      name: image_name || null,
      size: image_size || null,
    };
  }
  return base;
};

// Small utility: set cache/etag headers for image responses
function setImageHeaders(res, bytes, mime, filename) {
  const etag = crypto.createHash("sha1").update(bytes).digest("hex");
  res.setHeader("Content-Type", mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename || "image")}"`);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=86400, immutable"); // 1 day
  res.setHeader("Content-Length", Buffer.byteLength(bytes));
  return etag;
}

// ======================================================
// WEBSITES
// ======================================================

/**
 * GET /websites
 * Query:
 *   - page (default 1), limit (default 20, max 100)
 *   - q (search in url/name)
 *   - category (exact match)
 *   - sort (created_at|updated_at|name), dir (asc|desc)
 */
router.get("/websites", async (req, res) => {
  try {
    const page = toInt(req.query.page, 1);
    const limit = Math.min(toInt(req.query.limit, 20), 100);
    const offset = (page - 1) * limit;

    const q = cleanStr(req.query.q);
    const category = cleanStr(req.query.category);

    const sortCol = ["created_at", "updated_at", "name"].includes(
      String(req.query.sort || "").toLowerCase()
    )
      ? String(req.query.sort).toLowerCase()
      : "created_at";
    const dir =
      String(req.query.dir || "").toLowerCase() === "asc" ? "asc" : "desc";

    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where.push(`(url ILIKE $${params.length - 1} OR name ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countSql = `SELECT COUNT(*)::int AS total FROM user_websites ${whereSql}`;
    const { rows: countRows } = await pool.query(countSql, params);
    const total = countRows?.[0]?.total ?? 0;

    const sql = `
      SELECT id, url, name, category, image_mime, image_name, image_size, created_at, updated_at
      FROM user_websites
      ${whereSql}
      ORDER BY ${sortCol} ${dir}
      LIMIT ${limit} OFFSET ${offset};
    `;
    const { rows } = await pool.query(sql, params);

    res.json({
      page,
      limit,
      total,
      items: rows.map((r) => mapWebsiteRow(r)),
    });
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * GET /websites/:id
 * Optional query: include=image (to include base64)
 */
router.get("/websites/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new Error("Invalid id");

    const withImage = String(req.query.include || "").toLowerCase() === "image";

    const { rows } = await pool.query(
      `SELECT *
         FROM user_websites
        WHERE id = $1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Website not found" });
    }

    const row = rows[0];
    return res.json(mapWebsiteRow(row, { withImageBytes: withImage }));
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * HEAD /websites/:id/image
 * Quick metadata check (cache/etag) without body
 */
router.head("/websites/:id/image", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new Error("Invalid id");

    const { rows } = await pool.query(
      `SELECT image_bytes, image_mime, image_name
         FROM user_websites
        WHERE id = $1`,
      [id]
    );

    if (!rows.length || !rows[0].image_bytes) {
      return res.status(404).end();
    }

    const { image_bytes, image_mime, image_name } = rows[0];
    const etag = setImageHeaders(res, image_bytes, image_mime, image_name);
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    // HEAD -> no body
    return res.status(200).end();
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * GET /websites/:id/image
 * Streams the stored screenshot if present
 */
router.get("/websites/:id/image", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new Error("Invalid id");

    const { rows } = await pool.query(
      `SELECT image_bytes, image_mime, image_name
         FROM user_websites
        WHERE id = $1`,
      [id]
    );

    if (!rows.length || !rows[0].image_bytes) {
      return res.status(404).json({ error: "Image not found" });
    }

    const { image_bytes, image_mime, image_name } = rows[0];
    const etag = setImageHeaders(res, image_bytes, image_mime, image_name);
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    return res.send(image_bytes);
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * POST /websites
 * Accepts:
 *  - multipart/form-data with fields: url, name?, category?, image?
 *  - application/json: { url, name?, category?, image_base64?, image_mime?, image_name? }
 */
router.post("/websites", upload.single("image"), async (req, res) => {
  try {
    const body = req.body || {};
    const url = cleanStr(body.url);
    const name = cleanStr(body.name);
    const category = cleanStr(body.category);

    if (!isHttpUrl(url)) {
      return res
        .status(400)
        .json({ error: "Invalid or missing URL (must start with http/https)" });
    }

    // Image: from multipart file OR JSON base64
    let imageBytes = null;
    let imageMime = null;
    let imageName = null;
    let imageSize = null;

    if (req.file) {
      imageBytes = req.file.buffer || null;
      imageMime = req.file.mimetype || null;
      imageName = req.file.originalname || null;
      imageSize = req.file.size || null;
    } else if (body.image_base64) {
      try {
        const b = String(body.image_base64).replace(/^data:[^;]+;base64,/, "");
        imageBytes = Buffer.from(b, "base64");
        imageMime = cleanStr(body.image_mime) || "image/png";
        imageName = cleanStr(body.image_name) || "upload.png";
        imageSize = imageBytes.length;
      } catch {
        return res.status(400).json({ error: "Invalid image_base64" });
      }
    }

    const params = [url, name, category, imageMime, imageName, imageBytes, imageSize];

    const { rows } = await pool.query(
      `INSERT INTO user_websites
         (url, name, category, image_mime, image_name, image_bytes, image_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, url, name, category, image_mime, image_name, image_size, created_at, updated_at`,
      params
    );

    return res.status(201).json(mapWebsiteRow(rows[0]));
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * PUT /websites/:id
 * Accepts multipart (fields + optional new image) or JSON (fields + optional image_base64)
 */
router.put("/websites/:id", upload.single("image"), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new Error("Invalid id");

    const body = req.body || {};
    const url = body.url !== undefined ? cleanStr(body.url) : undefined;
    const name = body.name !== undefined ? cleanStr(body.name) : undefined;
    const category =
      body.category !== undefined ? cleanStr(body.category) : undefined;

    if (url !== undefined && !isHttpUrl(url)) {
      return res
        .status(400)
        .json({ error: "Invalid URL (must start with http/https)" });
    }

    // Decide image update
    let imageBytes = undefined;
    let imageMime = undefined;
    let imageName = undefined;
    let imageSize = undefined;

    const removeImage =
      String(body.remove_image || "").toLowerCase() === "true";

    if (removeImage) {
      imageBytes = null;
      imageMime = null;
      imageName = null;
      imageSize = null;
    } else if (req.file) {
      imageBytes = req.file.buffer || null;
      imageMime = req.file.mimetype || null;
      imageName = req.file.originalname || null;
      imageSize = req.file.size || null;
    } else if (body.image_base64) {
      try {
        const b = String(body.image_base64).replace(/^data:[^;]+;base64,/, "");
        const buf = Buffer.from(b, "base64");
        imageBytes = buf;
        imageMime = cleanStr(body.image_mime) || "image/png";
        imageName = cleanStr(body.image_name) || "upload.png";
        imageSize = buf.length;
      } catch {
        return res.status(400).json({ error: "Invalid image_base64" });
      }
    }

    // Build dynamic update
    const sets = [];
    const params = [];
    const add = (sqlFrag, val) => {
      params.push(val);
      sets.push(`${sqlFrag} = $${params.length}`);
    };

    if (url !== undefined) add("url", url);
    if (name !== undefined) add("name", name);
    if (category !== undefined) add("category", category);
    if (imageMime !== undefined) add("image_mime", imageMime);
    if (imageName !== undefined) add("image_name", imageName);
    if (imageBytes !== undefined) add("image_bytes", imageBytes);
    if (imageSize !== undefined) add("image_size", imageSize);

    if (!sets.length) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const sql = `
      UPDATE user_websites
         SET ${sets.join(", ")}
       WHERE id = $${params.length + 1}
       RETURNING id, url, name, category, image_mime, image_name, image_size, created_at, updated_at
    `;
    params.push(id);

    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: "Website not found" });

    return res.json(mapWebsiteRow(rows[0]));
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * DELETE /websites/:id
 */
router.delete("/websites/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new Error("Invalid id");

    const { rowCount } = await pool.query(
      `DELETE FROM user_websites WHERE id = $1`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: "Website not found" });

    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err);
  }
});

// ======================================================
// WEBSITE CATEGORY (no /categories; using /websitecategory)
// ======================================================

/**
 * GET /websitecategory
 */
router.get("/websitecategory", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, created_at, updated_at
         FROM website_category
        ORDER BY name ASC`
    );
    res.json(rows);
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * POST /websitecategory
 * Body: { name }
 */
router.post("/websitecategory", async (req, res) => {
  try {
    const name = cleanStr(req.body?.name);
    if (!name) return res.status(400).json({ error: "Category name is required" });

    const { rows } = await pool.query(
      `INSERT INTO website_category (name)
       VALUES ($1)
       RETURNING id, name, created_at, updated_at`,
      [name]
    );

    return res.status(201).json(rows[0]);
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * PUT /websitecategory/:id
 * Body: { name }
 * (Triggers will cascade rename into user_websites.category)
 */
router.put("/websitecategory/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new Error("Invalid id");

    const name = cleanStr(req.body?.name);
    if (!name) return res.status(400).json({ error: "Category name is required" });

    const { rows } = await pool.query(
      `UPDATE website_category
          SET name = $1
        WHERE id = $2
        RETURNING id, name, created_at, updated_at`,
      [name, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Category not found" });

    return res.json(rows[0]);
  } catch (err) {
    return handleError(res, err);
  }
});

/**
 * DELETE /websitecategory/:id
 * (Triggers will nullify user_websites.category where matched)
 */
router.delete("/websitecategory/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new Error("Invalid id");

    const { rowCount } = await pool.query(
      `DELETE FROM website_category WHERE id = $1`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: "Category not found" });

    return res.json({ success: true });
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;
