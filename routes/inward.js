// routes/inward.js
// ✅ PostgreSQL + Express + PDFKit + Multer (memory) -> BYTEA in DB
// ✅ ONE BILL FILE per inward (bill) + optional legacy files[]/fileIndexMap
// ✅ upload routes BEFORE "/:id"
// ✅ GET ONE returns ABSOLUTE file_url so React opens correctly

const express = require("express");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const db = require("../db");

const router = express.Router();

// Multer in-memory (DB BYTEA)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/* ---------------- helpers ---------------- */

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

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

function formatDateDDMMYYYY(iso) {
  if (!iso || typeof iso !== "string") return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}-${m}-${y}`;
}

function pgDuplicateError(err) {
  return err && err.code === "23505";
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function isMultipart(req) {
  const ct = req.headers["content-type"] || "";
  return ct.includes("multipart/form-data");
}

// ✅ build absolute url for frontend (important)
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

/**
 * JSON:
 *  {work_date, store, items:[...]}
 *
 * multipart:
 *  work_date, store
 *  items (json string)
 *  bill (single file)  ✅ NEW
 *  fileIndexMap + files[] (legacy support)
 */
function readPayload(req) {
  if (!isMultipart(req)) {
    return {
      work_date: req.body?.work_date,
      store: req.body?.store,
      items: Array.isArray(req.body?.items) ? req.body.items : [],
      billFile: null,
      fileIndexMap: null,
      files: [],
    };
  }

  const items = safeJsonParse(req.body?.items || "[]", []);
  const fileIndexMap = safeJsonParse(req.body?.fileIndexMap || "{}", {});

  // ✅ multer.fields -> req.files is OBJECT: { bill:[...], files:[...] }
  // ✅ multer.array -> req.files is ARRAY
  let billFile = null;
  let files = [];

  if (Array.isArray(req.files)) {
    files = req.files;
  } else if (req.files && typeof req.files === "object") {
    billFile = Array.isArray(req.files.bill) ? req.files.bill[0] : null;
    files = Array.isArray(req.files.files) ? req.files.files : [];
  }

  if (!billFile && req.file) billFile = req.file;

  return {
    work_date: req.body?.work_date,
    store: req.body?.store,
    items: Array.isArray(items) ? items : [],
    billFile,
    fileIndexMap: fileIndexMap && typeof fileIndexMap === "object" ? fileIndexMap : {},
    files,
  };
}

function validateHeaderAndItems(payload) {
  const errors = [];

  const work_date = toISODate(payload.work_date) || toISODate(new Date());
  const store = isNonEmptyString(payload.store) ? payload.store.trim() : "";

  if (!store) errors.push("store is required.");

  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (rawItems.length === 0) errors.push("items is required (at least 1 item).");

  const cleanItems = rawItems.map((it, idx) => {
    const material = isNonEmptyString(it.material) ? it.material.trim() : "";

    // ✅ OPTIONAL for b/c..., REQUIRED only for a) (idx==0)
    const material_use = isNonEmptyString(it.material_use) ? it.material_use.trim() : null;

    const quantity =
      it.quantity === null || it.quantity === undefined || it.quantity === ""
        ? null
        : Number(it.quantity);

    const quantity_type = isNonEmptyString(it.quantity_type) ? it.quantity_type.trim() : null;

    const image_path = isNonEmptyString(it.image_path) ? it.image_path.trim() : null;

    if (!material) errors.push(`items[${idx}].material is required.`);

    // ✅ Only first row (a) requires material_use
    if (idx === 0 && !material_use) {
      errors.push(`items[${idx}].material_use is required for subpoint a).`);
    }

    if (quantity !== null && Number.isNaN(quantity)) {
      errors.push(`items[${idx}].quantity must be a number.`);
    }

    return {
      item_order: idx + 1,
      material,
      quantity,
      quantity_type,
      material_use,
      image_path,
      upload_id: null,
    };
  });

  // ✅ block duplicates inside same request
  const seen = new Set();
  for (let i = 0; i < cleanItems.length; i++) {
    const useKey = (cleanItems[i].material_use || "").toLowerCase();
    const k = `${work_date}||${store.toLowerCase()}||${cleanItems[i].material.toLowerCase()}||${useKey}`;
    if (seen.has(k)) {
      errors.push(`Duplicate not allowed inside request (Row ${i + 1}).`);
      break;
    }
    seen.add(k);
  }

  return { ok: errors.length === 0, errors, work_date, store, items: cleanItems };
}

/* ---------------- FILE -> DB helpers ---------------- */

function isAllowedBillFile(file) {
  if (!file) return false;
  const mt = String(file.mimetype || "").toLowerCase();
  return mt.startsWith("image/") || mt === "application/pdf";
}

async function insertUpload(client, file) {
  const q = `
    INSERT INTO inward_uploads (file_name, mime_type, file_data)
    VALUES ($1, $2, $3)
    RETURNING id
  `;
  const r = await client.query(q, [
    file.originalname || "file",
    file.mimetype || "application/octet-stream",
    file.buffer,
  ]);
  return r.rows[0].id;
}

/**
 * legacy: fileIndexMap {"0":true,"2":true} + files[] ordered by key
 */
function buildIndexToFileMap(fileIndexMap, files) {
  const idxs = Object.keys(fileIndexMap || {})
    .filter((k) => fileIndexMap[k])
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);

  const map = new Map();
  for (let i = 0; i < idxs.length; i++) {
    map.set(idxs[i], files[i]);
  }
  return map;
}

/* =========================================================
   ✅ UPLOAD ROUTES (BEFORE "/:id")
   ========================================================= */

/**
 * ✅ PREVIEW uploaded file INLINE (for <img> and <iframe>)
 * GET /api/inward/upload/:uploadId/view
 */
router.get("/upload/:uploadId/view", async (req, res) => {
  const uploadId = Number(req.params.uploadId);
  if (Number.isNaN(uploadId)) return res.status(400).json({ success: false, message: "Invalid uploadId" });

  try {
    const r = await db.query(
      `SELECT id, file_name, mime_type, file_data FROM inward_uploads WHERE id=$1`,
      [uploadId]
    );
    if (r.rowCount === 0) return res.status(404).json({ success: false, message: "File not found" });

    const f = r.rows[0];
    const safeName = String(f.file_name || "file").replace(/"/g, "");
    res.setHeader("Content-Type", f.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    return res.end(f.file_data);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/**
 * ✅ DOWNLOAD uploaded file (force download)
 * GET /api/inward/upload/:uploadId/download
 */
router.get("/upload/:uploadId/download", async (req, res) => {
  const uploadId = Number(req.params.uploadId);
  if (Number.isNaN(uploadId)) return res.status(400).json({ success: false, message: "Invalid uploadId" });

  try {
    const r = await db.query(
      `SELECT id, file_name, mime_type, file_data FROM inward_uploads WHERE id=$1`,
      [uploadId]
    );
    if (r.rowCount === 0) return res.status(404).json({ success: false, message: "File not found" });

    const f = r.rows[0];
    const safeName = String(f.file_name || "file").replace(/"/g, "");

    res.setHeader("Content-Type", f.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    return res.end(f.file_data);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/* ---------------- ROUTES ---------------- */

/**
 * ✅ LIST
 * GET /api/inward?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
router.get("/", async (req, res) => {
  const from = toISODate(req.query.from);
  const to = toISODate(req.query.to);

  try {
    let q = `SELECT id, seq_no, work_date, store, created_at FROM inward`;
    const params = [];
    const where = [];

    if (from) {
      params.push(from);
      where.push(`work_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`work_date <= $${params.length}`);
    }
    if (where.length) q += ` WHERE ` + where.join(" AND ");
    q += ` ORDER BY seq_no DESC`;

    const r = await db.query(q, params);
    return res.json({ success: true, data: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/**
 * ✅ MULTI PDF (range)  ✅✅ UPDATED AS PER RULES
 * GET /api/inward/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
router.get("/pdf", async (req, res) => {
  const from = toISODate(req.query.from);
  const to = toISODate(req.query.to);

  try {
    const params = [];
    const where = [];

    if (from) {
      params.push(from);
      where.push(`i.work_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`i.work_date <= $${params.length}`);
    }

    let q = `
      SELECT
        i.work_date,
        i.created_at AS inward_time,
        i.store,
        it.material,
        it.quantity,
        it.quantity_type,
        it.material_use
      FROM inward i
      JOIN inward_items it ON it.inward_id = i.id
    `;
    if (where.length) q += ` WHERE ` + where.join(" AND ");

    // ✅ Sorting Rule: Date -> Time -> Store -> Material
    q += ` ORDER BY i.work_date ASC, i.created_at ASC, i.store ASC, it.material ASC`;

    const r = await db.query(q, params);
    if (!r.rows || r.rows.length === 0) {
      return res.status(404).json({ success: false, message: "No records found" });
    }

    const mergedRows = mergePdfRows(r.rows);
    const finalRows = assignSrNoPerDate(mergedRows);

    return drawInwardPDF(res, finalRows, "inward-details.pdf");
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/**
 * ✅ GET ONE (returns ABSOLUTE file_url)
 * GET /api/inward/:id
 */
router.get("/:id", async (req, res) => {
  const inwardId = Number(req.params.id);
  if (Number.isNaN(inwardId)) return res.status(400).json({ success: false, message: "Invalid id" });

  try {
    const header = await db.query(
      `SELECT id, seq_no, work_date, store, created_at FROM inward WHERE id=$1`,
      [inwardId]
    );
    if (header.rowCount === 0) return res.status(404).json({ success: false, message: "Inward not found" });

    const base = getBaseUrl(req);

    const items = await db.query(
      `
      SELECT
        id, item_order, material, quantity, quantity_type, material_use, image_path, upload_id, created_at,
        CASE
          WHEN upload_id IS NOT NULL THEN $2 || '/api/inward/upload/' || upload_id || '/view'
          ELSE image_path
        END AS file_url
      FROM inward_items
      WHERE inward_id=$1
      ORDER BY item_order
      `,
      [inwardId, base]
    );

    return res.json({ success: true, data: { ...header.rows[0], items: items.rows } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/**
 * ✅ SINGLE PDF
 * GET /api/inward/:id/pdf
 */
router.get("/:id/pdf", async (req, res) => {
  const inwardId = Number(req.params.id);
  if (Number.isNaN(inwardId)) return res.status(400).json({ success: false, message: "Invalid id" });

  try {
    const header = await db.query(`SELECT id, seq_no, work_date, store FROM inward WHERE id=$1`, [inwardId]);
    if (header.rowCount === 0) return res.status(404).json({ success: false, message: "Inward not found" });

    const items = await db.query(
      `
      SELECT item_order, material, quantity, quantity_type, material_use, image_path, upload_id
      FROM inward_items
      WHERE inward_id=$1
      ORDER BY item_order
      `,
      [inwardId]
    );

    const rec = { ...header.rows[0], items: items.rows };
    return drawInwardPDF_OLDSTYLE(res, [rec], `inward-${rec.seq_no}.pdf`); // keep your old single-pdf style
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/**
 * ✅ CREATE
 * POST /api/inward
 */
router.post("/", upload.fields([{ name: "bill", maxCount: 1 }, { name: "files", maxCount: 50 }]), async (req, res) => {
  const payload = readPayload(req);
  const v = validateHeaderAndItems(payload);

  if (!v.ok) {
    return res.status(400).json({ success: false, message: "Validation failed", errors: v.errors });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const header = await client.query(
      `INSERT INTO inward (work_date, store) VALUES ($1,$2) RETURNING id, seq_no, work_date, store`,
      [v.work_date, v.store]
    );
    const inwardId = header.rows[0].id;

    // ✅ NEW: one bill file for whole inward
    let commonUploadId = null;
    if (payload.billFile && payload.billFile.buffer) {
      if (!isAllowedBillFile(payload.billFile)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Only image or PDF allowed for bill." });
      }
      commonUploadId = await insertUpload(client, payload.billFile);
    }

    // legacy support (optional)
    let indexToFile = new Map();
    if (!commonUploadId && isMultipart(req)) {
      indexToFile = buildIndexToFileMap(payload.fileIndexMap, payload.files);
    }

    for (let idx = 0; idx < v.items.length; idx++) {
      const it = v.items[idx];

      if (commonUploadId) {
        it.upload_id = commonUploadId;
      } else {
        const file = indexToFile.get(idx);
        if (file && file.buffer) {
          if (!isAllowedBillFile(file)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "Only image or PDF allowed for bill." });
          }
          const uploadId = await insertUpload(client, file);
          it.upload_id = uploadId;
        }
      }

      await client.query(
        `
        INSERT INTO inward_items
          (inward_id, item_order, material, quantity, quantity_type, material_use, image_path, upload_id)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [inwardId, it.item_order, it.material, it.quantity, it.quantity_type, it.material_use, it.image_path, it.upload_id]
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Inward created", data: header.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");

    if (pgDuplicateError(err)) {
      return res.status(409).json({
        success: false,
        message: "Duplicate entry not allowed (Same Date + Store + Material + Material Use must be unique).",
        error: err.detail || String(err),
      });
    }

    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  } finally {
    client.release();
  }
});

/**
 * ✅ UPDATE (replaces all items)
 * PUT /api/inward/:id
 */
router.put("/:id", upload.fields([{ name: "bill", maxCount: 1 }, { name: "files", maxCount: 50 }]), async (req, res) => {
  const inwardId = Number(req.params.id);
  if (Number.isNaN(inwardId)) return res.status(400).json({ success: false, message: "Invalid id" });

  const payload = readPayload(req);
  const v = validateHeaderAndItems(payload);

  if (!v.ok) {
    return res.status(400).json({ success: false, message: "Validation failed", errors: v.errors });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(`SELECT id FROM inward WHERE id=$1`, [inwardId]);
    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Inward not found" });
    }

    const header = await client.query(
      `UPDATE inward SET work_date=$1, store=$2 WHERE id=$3 RETURNING id, seq_no, work_date, store`,
      [v.work_date, v.store, inwardId]
    );

    // ✅ find old upload_id (to keep if new bill not provided)
    const oldUpload = await client.query(
      `SELECT upload_id FROM inward_items WHERE inward_id=$1 AND upload_id IS NOT NULL ORDER BY id LIMIT 1`,
      [inwardId]
    );
    const oldUploadId = oldUpload.rowCount ? oldUpload.rows[0].upload_id : null;

    // ✅ new bill?
    let commonUploadId = oldUploadId;
    if (payload.billFile && payload.billFile.buffer) {
      if (!isAllowedBillFile(payload.billFile)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Only image or PDF allowed for bill." });
      }
      commonUploadId = await insertUpload(client, payload.billFile);
    }

    // replace items
    await client.query(`DELETE FROM inward_items WHERE inward_id=$1`, [inwardId]);

    // legacy support (ONLY if there is no commonUploadId)
    let indexToFile = new Map();
    if (!commonUploadId && isMultipart(req)) {
      indexToFile = buildIndexToFileMap(payload.fileIndexMap, payload.files);
    }

    for (let idx = 0; idx < v.items.length; idx++) {
      const it = v.items[idx];

      if (commonUploadId) {
        it.upload_id = commonUploadId;
      } else {
        const file = indexToFile.get(idx);
        if (file && file.buffer) {
          if (!isAllowedBillFile(file)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "Only image or PDF allowed for bill." });
          }
          const uploadId = await insertUpload(client, file);
          it.upload_id = uploadId;
        }
      }

      await client.query(
        `
        INSERT INTO inward_items
          (inward_id, item_order, material, quantity, quantity_type, material_use, image_path, upload_id)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [inwardId, it.item_order, it.material, it.quantity, it.quantity_type, it.material_use, it.image_path, it.upload_id]
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Inward updated", data: header.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");

    if (pgDuplicateError(err)) {
      return res.status(409).json({
        success: false,
        message: "Duplicate entry not allowed (Same Date + Store + Material + Material Use must be unique).",
        error: err.detail || String(err),
      });
    }

    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  } finally {
    client.release();
  }
});

/**
 * ✅ DELETE
 * DELETE /api/inward/:id
 */
router.delete("/:id", async (req, res) => {
  const inwardId = Number(req.params.id);
  if (Number.isNaN(inwardId)) return res.status(400).json({ success: false, message: "Invalid id" });

  try {
    const del = await db.query(`DELETE FROM inward WHERE id=$1 RETURNING id`, [inwardId]);
    if (del.rowCount === 0) return res.status(404).json({ success: false, message: "Inward not found" });

    return res.json({ success: true, message: "Inward deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/* ---------------- PDF HELPERS (NEW MERGE + SRNO RULES) ---------------- */

function normalizeKey(v) {
  return String(v || "").trim().toLowerCase();
}

// ✅ Merge: same date + store + material (+ quantity_type)
function mergePdfRows(rows) {
  const map = new Map();

  for (const x of rows) {
    const dateISO = toISODate(x.work_date) || "";
    const store = String(x.store || "").trim();
    const material = String(x.material || "").trim();
    const qtyType = String(x.quantity_type || "").trim(); // keep unit safe

    const key = `${dateISO}||${normalizeKey(store)}||${normalizeKey(material)}||${normalizeKey(qtyType)}`;

    const qtyNum =
      x.quantity === null || x.quantity === undefined || x.quantity === ""
        ? 0
        : Number(x.quantity);

    const useText = String(x.material_use || "").trim();

    if (!map.has(key)) {
      map.set(key, {
        work_date: dateISO,
        inward_time: x.inward_time || null,
        store,
        material,
        quantity: Number.isFinite(qtyNum) ? qtyNum : 0,
        quantity_type: qtyType || "",
        use_set: useText ? new Set([useText]) : new Set(),
      });
    } else {
      const m = map.get(key);

      if (Number.isFinite(qtyNum)) m.quantity += qtyNum;
      if (useText) m.use_set.add(useText);

      // earliest time for stable ordering
      if (m.inward_time && x.inward_time && new Date(x.inward_time) < new Date(m.inward_time)) {
        m.inward_time = x.inward_time;
      }
    }
  }

  const merged = Array.from(map.values()).map((m) => ({
    work_date: m.work_date,
    inward_time: m.inward_time,
    store: m.store,
    material: m.material,
    quantity: m.quantity,
    quantity_type: m.quantity_type,
    material_use: Array.from(m.use_set).join("; "),
  }));

  // sort: Date -> Time -> Store -> Material
  merged.sort((a, b) => {
    const da = String(a.work_date || "");
    const db = String(b.work_date || "");
    if (da !== db) return da.localeCompare(db);

    const ta = a.inward_time ? new Date(a.inward_time).getTime() : 0;
    const tb = b.inward_time ? new Date(b.inward_time).getTime() : 0;
    if (ta !== tb) return ta - tb;

    const sa = String(a.store || "").toLowerCase();
    const sb = String(b.store || "").toLowerCase();
    if (sa !== sb) return sa.localeCompare(sb);

    const ma = String(a.material || "").toLowerCase();
    const mb = String(b.material || "").toLowerCase();
    return ma.localeCompare(mb);
  });

  return merged;
}

// ✅ Sr.No per Date only first row
function assignSrNoPerDate(rows) {
  let sr = 0;
  let lastDate = null;

  return rows.map((r) => {
    const d = String(r.work_date || "").slice(0, 10);
    let srText = "";

    if (d && d !== lastDate) {
      sr += 1;
      srText = String(sr);
      lastDate = d;
    }

    return { ...r, srno: srText };
  });
}

/* ---------------- PDF (NEW FORMAT FOR /pdf) ---------------- */

function drawInwardPDF(res, rows, fileName = "inward-details.pdf") {
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    autoFirstPage: true,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const { left, right, top, bottom } = doc.page.margins;
  const usableWidth = pageWidth - left - right;

  doc.font("Times-Bold").fontSize(16);
  doc.text("Inward Details", left, top, { width: usableWidth, align: "center" });

  let y = top + 30;

  const cols = [
    { key: "srno", label: "Sr.No", w: 50, align: "center" },
    { key: "date", label: "Date", w: 70, align: "center" },
    { key: "material", label: "Material", w: 150, align: "left" },
    { key: "qty", label: "Quantity", w: 80, align: "center" },
    { key: "store", label: "Store", w: 90, align: "left" },
    { key: "use", label: "Material Use", w: usableWidth - (50 + 70 + 150 + 80 + 90), align: "left" },
  ];

  const tableLeft = left;
  const tableRight = left + usableWidth;

  function ensurePageSpace(needed) {
    const pageBottomY = doc.page.height - bottom;
    if (y + needed > pageBottomY) {
      doc.addPage();
      doc.font("Times-Bold").fontSize(14);
      doc.text("Inward Details", left, doc.page.margins.top, { width: usableWidth, align: "center" });
      y = doc.page.margins.top + 26;
      drawHeaderRow();
    }
  }

  function drawTableBorder(x, y0, w, h, thick = 0.7) {
    doc.lineWidth(thick).rect(x, y0, w, h).stroke();
  }

  function drawHeaderRow() {
    const headerH = 24;
    ensurePageSpace(headerH + 10);

    drawTableBorder(tableLeft, y, usableWidth, headerH, 1);

    let x = tableLeft;
    doc.font("Times-Bold").fontSize(11);
    for (const c of cols) {
      doc.lineWidth(0.7).moveTo(x, y).lineTo(x, y + headerH).stroke();
      doc.text(c.label, x + 4, y + 6, { width: c.w - 8, align: c.align });
      x += c.w;
    }
    doc.lineWidth(0.7).moveTo(tableRight, y).lineTo(tableRight, y + headerH).stroke();
    y += headerH;
  }

  function measureCellHeight(text, width, fontName, fontSize) {
    doc.font(fontName).fontSize(fontSize);
    return doc.heightOfString(text || "", { width: Math.max(10, width), align: "left" });
  }

  function drawRow(cells, rowH) {
    ensurePageSpace(rowH + 5);
    drawTableBorder(tableLeft, y, usableWidth, rowH, 0.7);

    let x = tableLeft;
    for (const c of cols) {
      doc.lineWidth(0.7).moveTo(x, y).lineTo(x, y + rowH).stroke();

      const padX = 4;
      const padY = 4;
      doc.font("Times-Roman").fontSize(10);

      doc.text(String(cells[c.key] ?? ""), x + padX, y + padY, {
        width: c.w - padX * 2,
        height: rowH - padY * 2,
        align: c.align,
      });

      x += c.w;
    }
    doc.lineWidth(0.7).moveTo(tableRight, y).lineTo(tableRight, y + rowH).stroke();
    y += rowH;
  }

  drawHeaderRow();

  for (const r of rows) {
    const dateText = formatDateDDMMYYYY(String(r.work_date || "").slice(0, 10)); // ✅ every row
    const qtyText = `${r.quantity ?? ""}${r.quantity_type ? " " + r.quantity_type : ""}`.trim();

    const materialText = String(r.material || "");
    const storeText = String(r.store || "");
    const useText = String(r.material_use || "");

    const materialH = measureCellHeight(materialText, cols.find((c) => c.key === "material").w - 8, "Times-Roman", 10);
    const useH = measureCellHeight(useText, cols.find((c) => c.key === "use").w - 8, "Times-Roman", 10);
    const rowH = Math.max(22, Math.ceil(Math.max(materialH, useH) + 8));

    drawRow(
      {
        srno: r.srno || "",
        date: dateText,
        material: materialText,
        qty: qtyText,
        store: storeText,
        use: useText,
      },
      rowH
    );
  }

  doc.end();
}

/* ---------------- OLD PDF (kept for /:id/pdf) ---------------- */
// तुझं जुने logic जशास तसं ठेवले आहे, single inward pdf ला तसाच output येईल.
function drawInwardPDF_OLDSTYLE(res, records, fileName = "inward-details.pdf") {
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    autoFirstPage: true,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const { left, right, top, bottom } = doc.page.margins;
  const usableWidth = pageWidth - left - right;

  doc.font("Times-Bold").fontSize(16);
  doc.text("Inward Details", left, top, { width: usableWidth, align: "center" });

  let y = top + 30;

  const cols = [
    { key: "srno", label: "Sr.No", w: 50, align: "center" },
    { key: "date", label: "Date", w: 70, align: "center" },
    { key: "material", label: "Material", w: 150, align: "left" },
    { key: "qty", label: "Quantity", w: 80, align: "center" },
    { key: "store", label: "Store", w: 90, align: "left" },
    { key: "use", label: "Material Use", w: usableWidth - (50 + 70 + 150 + 80 + 90), align: "left" },
  ];

  const tableLeft = left;
  const tableRight = left + usableWidth;

  function ensurePageSpace(needed) {
    const pageBottomY = doc.page.height - bottom;
    if (y + needed > pageBottomY) {
      doc.addPage();
      doc.font("Times-Bold").fontSize(14);
      doc.text("Inward Details", left, doc.page.margins.top, { width: usableWidth, align: "center" });
      y = doc.page.margins.top + 26;
      drawHeaderRow();
    }
  }

  function drawTableBorder(x, y0, w, h, thick = 0.7) {
    doc.lineWidth(thick).rect(x, y0, w, h).stroke();
  }

  function drawHeaderRow() {
    const headerH = 24;
    ensurePageSpace(headerH + 10);

    drawTableBorder(tableLeft, y, usableWidth, headerH, 1);

    let x = tableLeft;
    doc.font("Times-Bold").fontSize(11);
    for (const c of cols) {
      doc.lineWidth(0.7).moveTo(x, y).lineTo(x, y + headerH).stroke();
      doc.text(c.label, x + 4, y + 6, { width: c.w - 8, align: c.align });
      x += c.w;
    }
    doc.lineWidth(0.7).moveTo(tableRight, y).lineTo(tableRight, y + headerH).stroke();
    y += headerH;
  }

  function measureCellHeight(text, width, fontName, fontSize) {
    doc.font(fontName).fontSize(fontSize);
    return doc.heightOfString(text || "", { width: Math.max(10, width), align: "left" });
  }

  function drawRow(cells, rowH) {
    ensurePageSpace(rowH + 5);
    drawTableBorder(tableLeft, y, usableWidth, rowH, 0.7);

    let x = tableLeft;
    for (const c of cols) {
      doc.lineWidth(0.7).moveTo(x, y).lineTo(x, y + rowH).stroke();

      const padX = 4;
      const padY = 4;
      doc.font("Times-Roman").fontSize(10);

      doc.text(String(cells[c.key] ?? ""), x + padX, y + padY, {
        width: c.w - padX * 2,
        height: rowH - padY * 2,
        align: c.align,
      });

      x += c.w;
    }
    doc.lineWidth(0.7).moveTo(tableRight, y).lineTo(tableRight, y + rowH).stroke();
    y += rowH;
  }

  function drawBoldSeparationLine() {
    ensurePageSpace(10);
    doc.lineWidth(2).moveTo(tableLeft, y).lineTo(tableRight, y).stroke();
    y += 8;
  }

  drawHeaderRow();

  for (const rec of records) {
    const items = rec.items || [];
    if (items.length === 0) continue;

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const subLetter = String.fromCharCode(97 + ((it.item_order || (idx + 1)) - 1));
      const materialText = `${subLetter}) ${it.material || ""}`.trim();

      const qtyText =
        it.quantity === null || it.quantity === undefined
          ? ""
          : `${it.quantity}${it.quantity_type ? " " + it.quantity_type : ""}`;

      const srText = idx === 0 ? String(rec.seq_no) : "";
      const dateText = idx === 0 ? formatDateDDMMYYYY(String(rec.work_date).slice(0, 10)) : "";
      const storeText = idx === 0 ? String(rec.store || "") : "";
      const useText = it.material_use || "";

      const materialH = measureCellHeight(materialText, cols.find((c) => c.key === "material").w - 8, "Times-Roman", 10);
      const useH = measureCellHeight(useText, cols.find((c) => c.key === "use").w - 8, "Times-Roman", 10);
      const rowH = Math.max(22, Math.ceil(Math.max(materialH, useH) + 8));

      drawRow({ srno: srText, date: dateText, material: materialText, qty: qtyText, store: storeText, use: useText }, rowH);
    }

    drawBoldSeparationLine();
  }

  doc.end();
}

module.exports = router;
