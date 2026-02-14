// routes/notesmyapp.js
"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../db");
const multer = require("multer");

// ---------- Upload (any format) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

// ---------- Helpers ----------
// ✅ user_id is SERIAL/INTEGER now (admin.user_id), not UUID
function isIntId(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0;
}

// dd/mm/yyyy -> YYYY-MM-DD (Postgres DATE)
function parseDDMMYYYY(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr !== "string") return null;

  const m = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  if (yyyy < 1900 || yyyy > 9999) return null;
  if (mm < 1 || mm > 12) return null;

  const daysInMonth = new Date(yyyy, mm, 0).getDate();
  if (dd < 1 || dd > daysInMonth) return null;

  const pad2 = (n) => String(n).padStart(2, "0");
  return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
}

// "hh:mm AM/PM" -> "HH:MM:SS" (Postgres TIME)
function parse12HrTime(timeStr) {
  if (!timeStr) return null;
  if (typeof timeStr !== "string") return null;

  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/i);
  if (!m) return null;

  let hh = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3].toUpperCase();

  if (hh < 1 || hh > 12) return null;
  if (min < 0 || min > 59) return null;

  if (ap === "AM") {
    if (hh === 12) hh = 0;
  } else {
    if (hh !== 12) hh += 12;
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  return `${pad2(hh)}:${pad2(min)}:00`;
}

// Convert DB date/time to strict display formats
function formatDDMMYYYY(dateObj) {
  if (!dateObj) return null;
  const d = new Date(dateObj);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function format12HrHHMM(timeStr) {
  if (!timeStr) return null; // timeStr like "13:05:00"
  const parts = String(timeStr).split(":");
  if (parts.length < 2) return null;
  let hh = Number(parts[0]);
  const mm = parts[1];

  const ap = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;

  return `${String(hh).padStart(2, "0")}:${mm} ${ap}`;
}

// ---------- CREATE (multipart/form-data) ----------
// Fields optional for note (user_id required - INTEGER)
// body: user_id, note_title, note_description, note_info, note_date (dd/mm/yyyy), note_time (hh:mm AM/PM)
// file: image (any format)
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const {
      user_id,
      note_title = null,
      note_description = null,
      note_info = null,
      note_date = null,
      note_time = null,
    } = req.body;

    if (!isIntId(user_id)) {
      return res.status(400).json({
        ok: false,
        message: "Valid user_id (INTEGER) is required.",
      });
    }

    const dbDate = note_date ? parseDDMMYYYY(note_date) : null;
    if (note_date && !dbDate) {
      return res.status(400).json({
        ok: false,
        message: "note_date must be in dd/mm/yyyy format.",
      });
    }

    const dbTime = note_time ? parse12HrTime(note_time) : null;
    if (note_time && !dbTime) {
      return res.status(400).json({
        ok: false,
        message: "note_time must be in hh:mm AM/PM format (12-hour).",
      });
    }

    const imageBuffer = req.file ? req.file.buffer : null;
    const imageName = req.file ? req.file.originalname : null;
    const imageMime = req.file ? req.file.mimetype : null;

    const q = `
      INSERT INTO notes_myapp (
        user_id,
        note_title,
        note_description,
        note_info,
        note_date,
        note_time,
        image_data,
        image_filename,
        image_mime_type
      )
      VALUES (
        $1::int,
        NULLIF($2, ''),
        NULLIF($3, ''),
        NULLIF($4, ''),
        COALESCE($5::date, (now() AT TIME ZONE 'Asia/Kolkata')::date),
        COALESCE($6::time, (now() AT TIME ZONE 'Asia/Kolkata')::time(0)),
        $7,
        $8,
        $9
      )
      RETURNING
        note_id, user_id, sr_no,
        note_title, note_description, note_info,
        note_date, note_time,
        (image_data IS NOT NULL) AS has_image,
        created_at
    `;

    const result = await pool.query(q, [
      Number(user_id),
      note_title,
      note_description,
      note_info,
      dbDate,
      dbTime,
      imageBuffer,
      imageName,
      imageMime,
    ]);

    const row = result.rows[0];
    return res.status(201).json({
      ok: true,
      data: {
        ...row,
        note_date: formatDDMMYYYY(row.note_date),
        note_time: format12HrHHMM(row.note_time),
      },
    });
  } catch (err) {
    console.error("POST /notes_myapp error:", err);
    return res.status(500).json({ ok: false, message: "Server error." });
  }
});

// ---------- GET ALL BY USER ----------
// /api/notes-myapp?user_id=INTEGER
router.get("/", async (req, res) => {
  try {
    const user_id = req.query.user_id;

    if (!isIntId(user_id)) {
      return res.status(400).json({
        ok: false,
        message: "Valid user_id (INTEGER) is required.",
      });
    }

    const q = `
      SELECT
        note_id, user_id, sr_no,
        note_title, note_description, note_info,
        note_date, note_time,
        (image_data IS NOT NULL) AS has_image,
        created_at
      FROM notes_myapp
      WHERE user_id = $1::int
      ORDER BY sr_no ASC, created_at ASC
    `;

    const result = await pool.query(q, [Number(user_id)]);

    const data = result.rows.map((r) => ({
      ...r,
      note_date: formatDDMMYYYY(r.note_date),
      note_time: format12HrHHMM(r.note_time),
    }));

    return res.json({ ok: true, data });
  } catch (err) {
    console.error("GET /notes_myapp error:", err);
    return res.status(500).json({ ok: false, message: "Server error." });
  }
});

// ---------- GET ONE NOTE ----------
// /api/notes-myapp/:note_id?user_id=INTEGER
router.get("/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;
    const user_id = req.query.user_id;

    // note_id is UUID
    const isUUID =
      typeof note_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(note_id);

    if (!isUUID) {
      return res.status(400).json({
        ok: false,
        message: "Valid note_id (UUID) is required.",
      });
    }
    if (!isIntId(user_id)) {
      return res.status(400).json({
        ok: false,
        message: "Valid user_id (INTEGER) is required.",
      });
    }

    const q = `
      SELECT
        note_id, user_id, sr_no,
        note_title, note_description, note_info,
        note_date, note_time,
        (image_data IS NOT NULL) AS has_image,
        image_filename, image_mime_type,
        created_at
      FROM notes_myapp
      WHERE note_id = $1 AND user_id = $2::int
      LIMIT 1
    `;

    const result = await pool.query(q, [note_id, Number(user_id)]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Note not found." });
    }

    const r = result.rows[0];
    return res.json({
      ok: true,
      data: {
        ...r,
        note_date: formatDDMMYYYY(r.note_date),
        note_time: format12HrHHMM(r.note_time),
      },
    });
  } catch (err) {
    console.error("GET /notes_myapp/:note_id error:", err);
    return res.status(500).json({ ok: false, message: "Server error." });
  }
});

// ---------- GET IMAGE (binary anytime) ----------
// /api/notes-myapp/:note_id/image?user_id=INTEGER
router.get("/:note_id/image", async (req, res) => {
  try {
    const { note_id } = req.params;
    const user_id = req.query.user_id;

    const isUUID =
      typeof note_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(note_id);

    if (!isUUID) {
      return res.status(400).json({ ok: false, message: "Valid note_id (UUID) is required." });
    }
    if (!isIntId(user_id)) {
      return res.status(400).json({ ok: false, message: "Valid user_id (INTEGER) is required." });
    }

    const q = `
      SELECT image_data, image_mime_type, image_filename
      FROM notes_myapp
      WHERE note_id = $1 AND user_id = $2::int
      LIMIT 1
    `;
    const result = await pool.query(q, [note_id, Number(user_id)]);

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Note not found." });
    }

    const row = result.rows[0];
    if (!row.image_data) {
      return res.status(404).json({ ok: false, message: "No image for this note." });
    }

    const mime = row.image_mime_type || "application/octet-stream";
    res.setHeader("Content-Type", mime);

    if (row.image_filename) {
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${row.image_filename.replace(/"/g, "")}"`
      );
    }

    return res.send(row.image_data);
  } catch (err) {
    console.error("GET /notes_myapp/:note_id/image error:", err);
    return res.status(500).json({ ok: false, message: "Server error." });
  }
});

// ---------- UPDATE (multipart/form-data) ----------
// /api/notes-myapp/:note_id
// body: user_id (required INTEGER), note_title?, note_description?, note_info?, note_date?, note_time?, remove_image? ("true"/"false")
// file: image? (optional)
router.put("/:note_id", upload.single("image"), async (req, res) => {
  try {
    const { note_id } = req.params;
    const {
      user_id,
      note_title,
      note_description,
      note_info,
      note_date,
      note_time,
      remove_image,
    } = req.body;

    const isUUID =
      typeof note_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(note_id);

    if (!isUUID) {
      return res.status(400).json({ ok: false, message: "Valid note_id (UUID) is required." });
    }
    if (!isIntId(user_id)) {
      return res.status(400).json({ ok: false, message: "Valid user_id (INTEGER) is required." });
    }

    const dbDate = note_date ? parseDDMMYYYY(note_date) : null;
    if (note_date && !dbDate) {
      return res.status(400).json({ ok: false, message: "note_date must be in dd/mm/yyyy format." });
    }

    const dbTime = note_time ? parse12HrTime(note_time) : null;
    if (note_time && !dbTime) {
      return res.status(400).json({ ok: false, message: "note_time must be in hh:mm AM/PM format (12-hour)." });
    }

    const hasNewImage = !!req.file;
    const removeImg = String(remove_image || "").toLowerCase() === "true";

    const imageBuffer = hasNewImage ? req.file.buffer : null;
    const imageName = hasNewImage ? req.file.originalname : null;
    const imageMime = hasNewImage ? req.file.mimetype : null;

    const q = `
      UPDATE notes_myapp
      SET
        note_title       = COALESCE(NULLIF($3, ''), note_title),
        note_description = COALESCE(NULLIF($4, ''), note_description),
        note_info        = COALESCE(NULLIF($5, ''), note_info),
        note_date        = COALESCE($6::date, note_date),
        note_time        = COALESCE($7::time, note_time),

        image_data      = CASE
                            WHEN $8::boolean THEN NULL
                            WHEN $9::boolean THEN $10
                            ELSE image_data
                          END,
        image_filename  = CASE
                            WHEN $8::boolean THEN NULL
                            WHEN $9::boolean THEN $11
                            ELSE image_filename
                          END,
        image_mime_type = CASE
                            WHEN $8::boolean THEN NULL
                            WHEN $9::boolean THEN $12
                            ELSE image_mime_type
                          END
      WHERE note_id = $1 AND user_id = $2::int
      RETURNING
        note_id, user_id, sr_no,
        note_title, note_description, note_info,
        note_date, note_time,
        (image_data IS NOT NULL) AS has_image,
        created_at
    `;

    const result = await pool.query(q, [
      note_id,
      Number(user_id),
      note_title ?? null,
      note_description ?? null,
      note_info ?? null,
      dbDate,
      dbTime,
      removeImg,
      hasNewImage,
      imageBuffer,
      imageName,
      imageMime,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Note not found." });
    }

    const row = result.rows[0];
    return res.json({
      ok: true,
      data: {
        ...row,
        note_date: formatDDMMYYYY(row.note_date),
        note_time: format12HrHHMM(row.note_time),
      },
    });
  } catch (err) {
    console.error("PUT /notes_myapp/:note_id error:", err);
    return res.status(500).json({ ok: false, message: "Server error." });
  }
});

// ---------- DELETE ----------
// /api/notes-myapp/:note_id?user_id=INTEGER
router.delete("/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;
    const user_id = req.query.user_id;

    const isUUID =
      typeof note_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(note_id);

    if (!isUUID) {
      return res.status(400).json({ ok: false, message: "Valid note_id (UUID) is required." });
    }
    if (!isIntId(user_id)) {
      return res.status(400).json({ ok: false, message: "Valid user_id (INTEGER) is required." });
    }

    const q = `
      DELETE FROM notes_myapp
      WHERE note_id = $1 AND user_id = $2::int
      RETURNING note_id
    `;
    const result = await pool.query(q, [note_id, Number(user_id)]);

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Note not found." });
    }

    return res.json({ ok: true, message: "Deleted successfully." });
  } catch (err) {
    console.error("DELETE /notes_myapp/:note_id error:", err);
    return res.status(500).json({ ok: false, message: "Server error." });
  }
});

module.exports = router;
