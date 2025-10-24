// routes/notes.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

/* ---------------- Date helpers ---------------- */

// Parse many inputs into ISO "YYYY-MM-DD" or null
function toISODate(input) {
  if (!input) return null;

  if (input instanceof Date && !isNaN(input)) {
    return input.toISOString().slice(0, 10);
  }

  const s = String(input).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const m1 = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m1) {
    const [, dStr, monStr, yStr] = m1;
    const monthMap = {
      jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
      jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12
    };
    const mm = monthMap[monStr.slice(0,3).toLowerCase()];
    if (mm) {
      const dd = String(parseInt(dStr, 10)).padStart(2, "0");
      const MM = String(mm).padStart(2, "0");
      return `${yStr}-${MM}-${dd}`;
    }
  }

  const m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m2) {
    const [, d, m, y] = m2;
    const dd = String(parseInt(d, 10)).padStart(2, "0");
    const MM = String(parseInt(m, 10)).padStart(2, "0");
    return `${y}-${MM}-${dd}`;
  }

  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);

  return null;
}

// "YYYY-MM-DD" -> "D Mon YYYY"
function isoToDisplay(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mm, dd] = m;
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const label = monthNames[parseInt(mm, 10) - 1];
  return `${parseInt(dd, 10)} ${label} ${y}`;
}

// Uniform row mapper — return both iso + display, and a backward-compatible note_date
const mapRow = (r) => {
  const iso = (() => {
    const s = r?.note_date && String(r.note_date).slice(0, 10);
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return toISODate(r?.note_date) || null;
  })();

  return {
    id: r.id,
    title: r.title,
    note_date: iso,                  // ← backward-compatible (UI reads this)
    note_date_iso: iso,              // canonical
    note_date_display: isoToDisplay(iso),
    details: r.details,
    user_name: r.user_name ?? null,  // optional
    user_email: r.user_email ?? null,// optional
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
};

/* ---------------- Bootstrap: table + trigger (runs once) ---------------- */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_notes (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
        note_date DATE DEFAULT CURRENT_DATE,
        details TEXT,
        user_name  TEXT,
        user_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_user_name_nonempty
          CHECK (user_name IS NULL OR length(btrim(user_name)) > 0),
        CONSTRAINT chk_user_email_format
          CHECK (user_email IS NULL OR position('@' IN user_email) > 1)
      );

      CREATE OR REPLACE FUNCTION update_user_notes_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at := NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'trg_update_user_notes'
        ) THEN
          CREATE TRIGGER trg_update_user_notes
          BEFORE UPDATE ON user_notes
          FOR EACH ROW
          EXECUTE FUNCTION update_user_notes_timestamp();
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_user_notes_note_date ON user_notes(note_date);
      CREATE INDEX IF NOT EXISTS idx_user_notes_user_name ON user_notes((lower(user_name)));
    `);
    console.log("✅ user_notes table/trigger ready");
  } catch (err) {
    console.error("❌ Error ensuring user_notes:", err.message);
  }
})();

/* ---------------- Create ---------------- */
router.post("/", async (req, res) => {
  try {
    const { title, note_date, details, user_name, user_email } = req.body || {};
    if (!title || String(title).trim() === "") {
      return res.status(400).json({ message: "Title is required." });
    }

    const iso = toISODate(note_date); // may be null -> DEFAULT CURRENT_DATE
    const { rows } = await pool.query(
      `
      INSERT INTO user_notes (title, note_date, details, user_name, user_email)
      VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, NULLIF($4,''), NULLIF($5,''))
      RETURNING *;
      `,
      [title.trim(), iso, details ?? null, user_name ?? "", user_email ?? ""]
    );

    return res.status(201).json({
      message: "Note added successfully",
      data: mapRow(rows[0]),
    });
  } catch (err) {
    console.error("Error adding note:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

/* ---------------- List (with optional filters) ---------------- */
router.get("/", async (req, res) => {
  try {
    const { user_email, date } = req.query;
    const params = [];
    let where = "WHERE 1=1";

    if (user_email) {
      params.push(user_email);
      where += ` AND user_email = $${params.length}`;
    }

    if (date) {
      const iso = toISODate(date);
      if (!iso) return res.status(400).json({ message: "Invalid date filter" });
      params.push(iso);
      where += ` AND note_date = $${params.length}::date`;
    }

    const { rows } = await pool.query(
      `SELECT * FROM user_notes ${where} ORDER BY note_date DESC, id DESC`,
      params
    );

    return res.status(200).json({
      count: rows.length,
      data: rows.map(mapRow),
    });
  } catch (err) {
    console.error("Error fetching notes:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

/* ---------------- Get by ID ---------------- */
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM user_notes WHERE id = $1",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Note not found" });
    return res.status(200).json(mapRow(rows[0]));
  } catch (err) {
    console.error("Error fetching note:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

/* ---------------- Update ---------------- */
router.patch("/:id", async (req, res) => {
  try {
    const { title, note_date, details, user_name, user_email } = req.body || {};
    const iso = note_date === undefined ? undefined : toISODate(note_date);

    const { rows } = await pool.query(
      `
      UPDATE user_notes
         SET title     = COALESCE($1, title),
             note_date = COALESCE($2::date, note_date),
             details   = COALESCE($3, details),
             user_name = COALESCE(NULLIF($4,''), user_name),
             user_email= COALESCE(NULLIF($5,''), user_email),
             updated_at= NOW()
       WHERE id = $6
   RETURNING *;
      `,
      [title ?? null, iso ?? null, details ?? null, user_name ?? "", user_email ?? "", req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ message: "Note not found" });
    return res.status(200).json({ message: "Note updated successfully", data: mapRow(rows[0]) });
  } catch (err) {
    console.error("Error updating note:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

/* ---------------- Delete ---------------- */
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM user_notes WHERE id = $1",
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ message: "Note not found" });
    return res.status(200).json({ message: "Note deleted successfully" });
  } catch (err) {
    console.error("Error deleting note:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

module.exports = router;
