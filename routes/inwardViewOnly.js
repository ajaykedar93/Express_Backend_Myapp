// routes/inwardViewOnly.js
// ✅ VIEW ONLY API
// ✅ Used for SHARE LINK page
// ❌ No POST / PUT / DELETE
// ✅ NEW: month filter (default current month)

const express = require("express");
const db = require("../db");

const router = express.Router();

/* ---------------- helpers ---------------- */

function toISODate(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ✅ month helpers
function getCurrentMonthStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isValidMonthStr(ym) {
  if (!ym || typeof ym !== "string") return false;
  if (!/^\d{4}-\d{2}$/.test(ym)) return false;
  const [y, m] = ym.split("-").map(Number);
  return y > 1970 && m >= 1 && m <= 12;
}

// returns {start, end} where end is next month start (exclusive)
function getMonthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1); // next month
  const startISO = toISODate(start); // YYYY-MM-01
  const endISO = toISODate(end);     // next YYYY-MM-01
  return { start: startISO, end: endISO };
}

// build absolute url (for bill view)
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http")
    .toString()
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "")
    .toString()
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

/* =========================================================
   ✅ LIST – VIEW ONLY (FOR SHARE LINK)
   GET /api/inward-view?month=YYYY-MM
   - month is PRIORITY
   - if month not provided => current month
   - (optional) supports from/to if you ever want
   ========================================================= */

router.get("/", async (req, res) => {
  // ✅ month priority (default current month)
  let month = String(req.query.month || "").trim();
  if (!month) month = getCurrentMonthStr();

  const hasMonth = isValidMonthStr(month);

  // optional fallback: from/to if month invalid and user provided from/to
  const from = toISODate(req.query.from);
  const to = toISODate(req.query.to);

  try {
    let q = `
      SELECT
        h.id               AS inward_id,
        h.seq_no           AS sr_no,
        h.work_date,
        h.store,

        i.id               AS item_id,
        i.item_order,
        i.material,
        i.quantity,
        i.quantity_type,
        i.material_use,
        i.upload_id,

        u.mime_type
      FROM inward h
      JOIN inward_items i ON i.inward_id = h.id
      LEFT JOIN inward_uploads u ON u.id = i.upload_id
    `;

    const params = [];
    const where = [];

    if (hasMonth) {
      const { start, end } = getMonthRange(month);
      params.push(start);
      where.push(`h.work_date >= $${params.length}`);
      params.push(end);
      where.push(`h.work_date < $${params.length}`);
    } else {
      // if month invalid, you can still use from/to (optional)
      if (from) {
        params.push(from);
        where.push(`h.work_date >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        where.push(`h.work_date <= $${params.length}`);
      }
    }

    if (where.length) q += ` WHERE ` + where.join(" AND ");

    // ✅ same sequence everywhere
    q += `
      ORDER BY
        h.work_date ASC,
        h.seq_no ASC,
        i.item_order ASC
    `;

    const r = await db.query(q, params);
    const base = getBaseUrl(req);

    // ✅ FLATTENED rows (perfect for table UI)
    const data = r.rows.map((x) => ({
      inward_id: x.inward_id,
      sr_no: x.sr_no,
      work_date: String(x.work_date || "").slice(0, 10),
      store: x.store,

      item_order: x.item_order,
      material: x.material,
      quantity: x.quantity,
      quantity_type: x.quantity_type,
      material_use: x.material_use,

      // bill view
      file_url: x.upload_id ? `${base}/api/inward-view/upload/${x.upload_id}/view` : null,
      mime_type: x.mime_type || "",
    }));

    return res.json({
      success: true,
      month: hasMonth ? month : null,
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: String(err),
    });
  }
});

/* =========================================================
   ✅ BILL VIEW (INLINE)
   GET /api/inward-view/upload/:uploadId/view
   ========================================================= */

router.get("/upload/:uploadId/view", async (req, res) => {
  const uploadId = Number(req.params.uploadId);
  if (Number.isNaN(uploadId)) {
    return res.status(400).json({ success: false, message: "Invalid uploadId" });
  }

  try {
    const r = await db.query(
      `SELECT file_name, mime_type, file_data
       FROM inward_uploads
       WHERE id=$1`,
      [uploadId]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ success: false, message: "File not found" });
    }

    const f = r.rows[0];
    res.setHeader("Content-Type", f.mime_type);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(f.file_name || "file").replace(/"/g, "")}"`
    );

    return res.end(f.file_data);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: String(err),
    });
  }
});

module.exports = router;
