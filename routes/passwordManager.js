// routes/passwordManager.js
// Universal Password Manager API (TEXT notes in additional_info)

const express = require("express");
const router = express.Router();
const pool = require("../db"); // export a pg Pool from ../db

// Allowed types (match table)
const ALLOWED_TYPES = new Set([
  "app",
  "website",
  "email",
  "mobile",
  "screen",
  "cloud",
  "document",
  "private_lock",
  "other",
]);

// ---------- helpers ----------
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

function sanitizeUsername(v) {
  // DB column is NOT NULL DEFAULT '' so we normalize to empty string
  if (v == null) return "";
  return String(v);
}

function validateType(type) {
  if (!isNonEmptyString(type)) return "type is required";
  if (!ALLOWED_TYPES.has(type)) return `type must be one of: ${[...ALLOWED_TYPES].join(", ")}`;
  return null;
}

// No strength rules now
function validatePasswordOpen(pw) {
  if (!isNonEmptyString(pw)) return "password is required";
  return null;
}

function normalizePgError(err) {
  if (err && err.code === "23505") {
    return { status: 409, message: "Duplicate entry: (type, name, username) already exists." };
  }
  if (err && err.code === "23514") {
    return { status: 400, message: "Constraint failed: " + (err.detail || err.message) };
  }
  if (err && (err.code === "22P02" || err.code === "22023")) {
    return { status: 400, message: "Invalid data: " + (err.detail || err.message) };
  }
  if (err && err.client) {
    return { status: 400, message: err.message };
  }
  return { status: 500, message: "Internal Server Error" };
}

const mapRow = (r) => ({
  id: r.id,
  type: r.type,
  name: r.name,
  username: r.username,
  password: r.password,          // plaintext per your schema
  additional_info: r.additional_info, // TEXT (free notes)
  created_at: r.created_at,
  updated_at: r.updated_at,
});

// ===================== Canonical endpoints: /passwords =====================

// GET /api/passwords?type=&q=&limit=&offset=&order=&dir=
router.get("/passwords", async (req, res) => {
  try {
    const type = req.query.type;
    const q = req.query.q;
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    const where = [];
    const params = [];

    if (isNonEmptyString(type)) {
      where.push(`type = $${params.length + 1}`);
      params.push(type);
    }
    if (isNonEmptyString(q)) {
      where.push(`(name ILIKE $${params.length + 1} OR username ILIKE $${params.length + 1} OR additional_info ILIKE $${params.length + 1})`);
      params.push(`%${q}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const orderField = ["name", "updated_at", "created_at"].includes((req.query.order || "").toLowerCase())
      ? req.query.order.toLowerCase()
      : "created_at";
    const dir = (req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const countSql = `SELECT COUNT(*)::bigint AS total FROM password_manager ${whereSql}`;
    const dataSql = `
      SELECT id, type, name, username, password, additional_info, created_at, updated_at
      FROM password_manager
      ${whereSql}
      ORDER BY ${orderField} ${dir}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [countResult, dataResult] = await Promise.all([
      pool.query(countSql, params),
      pool.query(dataSql, [...params, limit, offset]),
    ]);

    res.json({
      total: Number(countResult.rows[0]?.total || 0),
      limit,
      offset,
      items: dataResult.rows.map(mapRow),
    });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// GET one
router.get("/passwords/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const { rows } = await pool.query(
      `SELECT id, type, name, username, password, additional_info, created_at, updated_at
       FROM password_manager WHERE id=$1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// CREATE
router.post("/passwords", async (req, res) => {
  try {
    const { type, name, password } = req.body || {};
    const username = sanitizeUsername(req.body?.username);
    // ✅ accept any text for additional_info; coerce to string or null
    let additional_info = req.body?.additional_info;
    if (additional_info === undefined || additional_info === null) {
      additional_info = null;
    } else {
      additional_info = String(additional_info);
    }

    const tErr = validateType(type);
    if (tErr) return res.status(400).json({ error: tErr });
    if (!isNonEmptyString(name)) return res.status(400).json({ error: "name is required" });
    const pErr = validatePasswordOpen(password);
    if (pErr) return res.status(400).json({ error: pErr });

    const { rows } = await pool.query(
      `INSERT INTO password_manager (type, name, username, password, additional_info, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, type, name, username, password, additional_info, created_at, updated_at`,
      [type, name, username, password, additional_info]
    );

    res.status(201).json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// PATCH
router.patch("/passwords/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const fields = [];
    const values = [];
    let i = 1;

    if (req.body?.type !== undefined) {
      const tErr = validateType(req.body.type);
      if (tErr) return res.status(400).json({ error: tErr });
      fields.push(`type=$${i++}`); values.push(req.body.type);
    }
    if (req.body?.name !== undefined) {
      if (!isNonEmptyString(req.body.name)) return res.status(400).json({ error: "name cannot be empty" });
      fields.push(`name=$${i++}`); values.push(req.body.name);
    }
    if (req.body?.username !== undefined) {
      fields.push(`username=$${i++}`); values.push(sanitizeUsername(req.body.username));
    }
    if (req.body?.password !== undefined) {
      const pErr = validatePasswordOpen(req.body.password);
      if (pErr) return res.status(400).json({ error: pErr });
      fields.push(`password=$${i++}`); values.push(req.body.password);
    }
    if (req.body?.additional_info !== undefined) {
      const ai = req.body.additional_info === null || req.body.additional_info === undefined
        ? null
        : String(req.body.additional_info);
      fields.push(`additional_info=$${i++}`); values.push(ai);
    }

    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    fields.push("updated_at=NOW()");

    const { rows } = await pool.query(
      `UPDATE password_manager
       SET ${fields.join(", ")}
       WHERE id=$${i}
       RETURNING id, type, name, username, password, additional_info, created_at, updated_at`,
      [...values, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// DELETE
router.delete("/passwords/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const { rowCount } = await pool.query("DELETE FROM password_manager WHERE id=$1", [id]);
    if (rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

// ===================== Alias endpoints used by your React: /password-manager =====================
// GET list by type (optional)
router.get("/password-manager", async (req, res) => {
  try {
    const params = [];
    const where = isNonEmptyString(req.query.type) ? (params.push(req.query.type), "WHERE type = $1") : "";
    const { rows } = await pool.query(
      `SELECT id, type, name, username, password, additional_info, created_at, updated_at
       FROM password_manager
       ${where}
       ORDER BY created_at DESC`,
      params
    );
    res.json({ data: rows.map(mapRow) });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ message });
  }
});

// GET one (alias)
router.get("/password-manager/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });

    const { rows } = await pool.query(
      `SELECT id, type, name, username, password, additional_info, created_at, updated_at
       FROM password_manager WHERE id=$1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Not found" });
    res.json({ data: mapRow(rows[0]) });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ message });
  }
});

// CREATE (alias)
router.post("/password-manager", async (req, res) => {
  try {
    const { type, name, password } = req.body || {};
    const username = sanitizeUsername(req.body?.username);
    // ✅ accept any text
    let additional_info = req.body?.additional_info;
    additional_info = (additional_info === undefined || additional_info === null) ? null : String(additional_info);

    const tErr = validateType(type);
    if (tErr) return res.status(400).json({ message: tErr });
    if (!isNonEmptyString(name)) return res.status(400).json({ message: "name is required" });
    const pErr = validatePasswordOpen(password);
    if (pErr) return res.status(400).json({ message: pErr });

    const { rows } = await pool.query(
      `INSERT INTO password_manager (type, name, username, password, additional_info, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, type, name, username, password, additional_info, created_at, updated_at`,
      [type, name, username, password, additional_info]
    );

    res.status(201).json({ message: "Added successfully", data: mapRow(rows[0]) });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ message });
  }
});

// PATCH (alias)
router.patch("/password-manager/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });

    const fields = [];
    const values = [];
    let i = 1;

    if (req.body?.type !== undefined) {
      const tErr = validateType(req.body.type);
      if (tErr) return res.status(400).json({ message: tErr });
      fields.push(`type=$${i++}`); values.push(req.body.type);
    }
    if (req.body?.name !== undefined) {
      if (!isNonEmptyString(req.body.name)) return res.status(400).json({ message: "name cannot be empty" });
      fields.push(`name=$${i++}`); values.push(req.body.name);
    }
    if (req.body?.username !== undefined) {
      fields.push(`username=$${i++}`); values.push(sanitizeUsername(req.body.username));
    }
    if (req.body?.password !== undefined) {
      const pErr = validatePasswordOpen(req.body.password);
      if (pErr) return res.status(400).json({ message: pErr });
      fields.push(`password=$${i++}`); values.push(req.body.password);
    }
    if (req.body?.additional_info !== undefined) {
      const ai = req.body.additional_info === null || req.body.additional_info === undefined
        ? null
        : String(req.body.additional_info);
      fields.push(`additional_info=$${i++}`); values.push(ai);
    }

    if (!fields.length) return res.status(400).json({ message: "No fields to update" });
    fields.push("updated_at=NOW()");

    const { rows } = await pool.query(
      `UPDATE password_manager
       SET ${fields.join(", ")}
       WHERE id=$${i}
       RETURNING id, type, name, username, password, additional_info, created_at, updated_at`,
      [...values, id]
    );

    if (!rows.length) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Updated successfully", data: mapRow(rows[0]) });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ message });
  }
});

// DELETE (alias)
router.delete("/password-manager/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });

    const { rowCount } = await pool.query("DELETE FROM password_manager WHERE id=$1", [id]);
    if (rowCount === 0) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ message });
  }
});

// Types for UI dropdown
router.get("/password-manager/types", (_req, res) => {
  res.json({ types: [...ALLOWED_TYPES] });
});

module.exports = router;
