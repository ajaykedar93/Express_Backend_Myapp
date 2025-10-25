// routes/imodocument.js
// Works with the provided SQL where table resolves to lower-case: admin_impdocument

const express = require("express");
const router = express.Router();
const pool = require("../db");
const multer = require("multer");

// Multer (accept ANY file type, 100 MB, memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/* ---------------- Helpers ---------------- */

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

// tags: accept array / CSV / JSON-string
function parseTags(input) {
  if (input == null) return null;
  if (Array.isArray(input)) return input.map((x) => String(x || "").trim()).filter(Boolean);
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x || "").trim()).filter(Boolean);
    } catch {}
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return null;
}

// uniform error → http
function normalizePgError(err) {
  console.error("[admin_impdocument] PG Error:", {
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
  if (err.code === "42P01")
    return { status: 500, message: 'Table admin_impdocument not found (check DDL & schema)' };
  return { status: 500, message: "Internal Server Error" };
}

// map DB row → API shape (lower-case cols from unquoted table)
const mapRow = (r) => ({
  document_id: r.documentid,
  label: r.label,
  description: r.description,
  original_name: r.originalname,
  mime_type: r.mimetype,
  file_size: r.filesize,
  sha256: r.sha256hash,
  tags: r.tags || [],
  created_at: r.createdat,
  updated_at: r.updatedat,
});

/* ---------------- Routes ---------------- */

/**
 * POST   /             → upload/add a document (multipart/form-data)
 * GET    /             → list documents (filter + pagination)
 * GET    /:id          → get metadata by id
 * GET    /:id/view     → inline view (Content-Disposition: inline)
 * GET    /:id/download → download (Content-Disposition: attachment)
 * PATCH  /:id          → update metadata and/or replace file
 * DELETE /:id          → delete one
 * POST   /bulk-delete  → delete multiple by ids
 */

/* ===== POST / (upload new) =====
   Body (multipart/form-data):
   - label (required)
   - description (optional)
   - tags (optional: array / CSV / JSON string)
   - file (required) [field name: "file"]
*/
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const { label, description } = req.body || {};
    const file = req.file;

    if (!isNonEmptyString(label)) return res.status(400).json({ error: "label is required" });
    if (!file) return res.status(400).json({ error: "file is required" });

    const tags = parseTags(req.body.tags) || [];

    const sql = `
      INSERT INTO admin_impdocument
        (label, description, originalname, mimetype, filecontent, tags, createdat, updatedat)
      VALUES ($1,    $2,          $3,          $4,       $5,         $6,  NOW(),   NOW())
      RETURNING *
    `;
    const params = [
      label.trim(),
      description || null,
      file.originalname || "upload.bin",
      file.mimetype || "application/octet-stream",
      file.buffer, // BYTEA
      tags,
    ];

    const { rows } = await pool.query(sql, params);
    return res.status(201).json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    return res.status(status).json({ error: message });
  }
});

/* ===== GET / (list with filters & pagination) =====
   Query:
   - q     (search label/description)
   - tag   (?tag=finance&tag=2025 … can repeat)
   - mime  (prefix like image/ or exact e.g. application/pdf)
   - page, limit  (defaults: 1, 20; max limit 100)
   NOTE: does NOT return filecontent.
*/
router.get("/", async (req, res) => {
  try {
    const { q, mime } = req.query;
    const tags = ([]).concat(req.query.tag || []);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    let i = 1;

    if (q && String(q).trim()) {
      where.push(
        `to_tsvector('simple', coalesce(label,'') || ' ' || coalesce(description,'')) @@ plainto_tsquery('simple', $${i++})`
      );
      params.push(String(q).trim());
    }

    if (mime && String(mime).trim()) {
      const m = String(mime).trim();
      if (m.endsWith("/")) {
        where.push(`mimetype LIKE $${i++}`);
        params.push(`${m}%`);
      } else {
        where.push(`mimetype = $${i++}`);
        params.push(m);
      }
    }

    if (tags.length > 0) {
      where.push(`tags && $${i++}::text[]`);
      params.push(tags.map(String));
    }

    const base = `
      FROM admin_impdocument
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
    `;

    const dataSql = `
      SELECT documentid,label,description,originalname,mimetype,
             filesize,sha256hash,tags,createdat,updatedat
      ${base}
      ORDER BY createdat DESC, documentid DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countSql = `SELECT COUNT(*) ${base}`;

    const [data, count] = await Promise.all([pool.query(dataSql, params), pool.query(countSql, params)]);

    const total = Number(count.rows[0].count || 0);
    res.json({
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
      rows: data.rows.map(mapRow),
    });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* ===== GET /:id (metadata only) ===== */
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { rows } = await pool.query(
      `SELECT documentid,label,description,originalname,mimetype,filesize,sha256hash,tags,createdat,updatedat
         FROM admin_impdocument
        WHERE documentid = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* ===== GET /:id/view (inline) ===== */
router.get("/:id/view", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { rows } = await pool.query(
      `SELECT originalname,mimetype,filesize,filecontent
         FROM admin_impdocument
        WHERE documentid = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const r = rows[0];
    res.setHeader("Content-Type", r.mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(r.originalname || "file")}"`);
    if (r.filesize != null) res.setHeader("Content-Length", String(r.filesize));
    return res.send(r.filecontent);
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* ===== GET /:id/download (attachment) ===== */
router.get("/:id/download", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { rows } = await pool.query(
      `SELECT originalname,mimetype,filesize,filecontent
         FROM admin_impdocument
        WHERE documentid = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const r = rows[0];
    res.setHeader("Content-Type", r.mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(r.originalname || "download")}"`);
    if (r.filesize != null) res.setHeader("Content-Length", String(r.filesize));
    return res.send(r.filecontent);
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* ===== PATCH /:id =====
   Accepts multipart/form-data if replacing file.
   Fields: label, description, tags, file?
*/
router.patch("/:id", upload.single("file"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const fields = [];
    const values = [];
    let i = 1;

    if (req.body.label !== undefined) {
      if (!isNonEmptyString(req.body.label)) return res.status(400).json({ error: "label cannot be empty" });
      fields.push(`label = $${i++}`);
      values.push(req.body.label.trim());
    }
    if (req.body.description !== undefined) {
      fields.push(`description = $${i++}`);
      values.push(req.body.description || null);
    }
    if (req.body.tags !== undefined) {
      const tags = parseTags(req.body.tags) || [];
      fields.push(`tags = $${i++}`);
      values.push(tags);
    }

    const file = req.file;
    if (file) {
      fields.push(`originalname = $${i++}`);
      values.push(file.originalname || "upload.bin");
      fields.push(`mimetype = $${i++}`);
      values.push(file.mimetype || "application/octet-stream");
      fields.push(`filecontent = $${i++}`);
      values.push(file.buffer); // trigger will update filesize & sha256hash
    }

    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

    fields.push(`updatedat = NOW()`);

    const sql = `
      UPDATE admin_impdocument
         SET ${fields.join(", ")}
       WHERE documentid = $${i}
      RETURNING *
    `;
    values.push(id);

    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* ===== DELETE /:id ===== */
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { rowCount } = await pool.query(`DELETE FROM admin_impdocument WHERE documentid = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* ===== POST /bulk-delete =====
   Body: { ids: [1,2,3] }
*/
router.post("/bulk-delete", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((x) => Number(x)).filter(Number.isFinite)
      : [];
    if (ids.length === 0) return res.status(400).json({ error: "ids array required" });

    const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(",");
    const { rowCount } = await pool.query(
      `DELETE FROM admin_impdocument WHERE documentid IN (${placeholders})`,
      ids
    );
    res.json({ deleted: rowCount });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

module.exports = router;
