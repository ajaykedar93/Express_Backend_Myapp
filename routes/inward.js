// routes/inward.js
// ✅ PostgreSQL + Express + PDFKit + Multer (memory) -> BYTEA in DB
// ✅ ONE BILL FILE per inward (bill)
// ✅ upload routes BEFORE "/:id"
// ✅ GET ONE returns ABSOLUTE file_url so React opens correctly
//
// ✅ NEW RULES:
// 1) Same Date + Same Store + Same Material => Quantity ADD (NO new row)
// 2) Sr.No is per Date only (stable) + Date prints per Store group
//    - 1 Sr.No per date (printed once for that date across all stores)
//    - Date printed for each store's first row even if same date
// 3) Sr.No never breaks even if delete/update => use inward_day_seq

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
 *  bill (single file)
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

  let billFile = null;
  let files = [];

  // multer.fields -> req.files is OBJECT: { bill:[...], files:[...] }
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

    // ✅ Only first row (a) requires material_use (your existing rule)
    const material_use = isNonEmptyString(it.material_use) ? it.material_use.trim() : null;

    const quantity =
      it.quantity === null || it.quantity === undefined || it.quantity === ""
        ? null
        : Number(it.quantity);

    const quantity_type = isNonEmptyString(it.quantity_type) ? it.quantity_type.trim() : null;

    const image_path = isNonEmptyString(it.image_path) ? it.image_path.trim() : null;

    if (!material) errors.push(`items[${idx}].material is required.`);
    if (idx === 0 && !material_use) errors.push(`items[${idx}].material_use is required for subpoint a).`);
    if (quantity !== null && Number.isNaN(quantity)) errors.push(`items[${idx}].quantity must be a number.`);

    return {
      item_order: idx + 1, // DB may reassign when inserting new
      material,
      quantity,
      quantity_type,
      material_use,
      image_path,
      upload_id: null,
    };
  });

  // ✅ block duplicates inside same request (material only, because merge rule is by material)
  const seen = new Set();
  for (let i = 0; i < cleanItems.length; i++) {
    const k = `${work_date}||${store.toLowerCase()}||${cleanItems[i].material.toLowerCase()}`;
    if (seen.has(k)) {
      errors.push(`Duplicate material not allowed inside request (Row ${i + 1}).`);
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

/* ---------------- Date-wise stable sequence helpers ---------------- */

/**
 * ✅ Concurrency-safe: if two requests create same work_date simultaneously, no crash.
 * Requires inward_day_seq(work_date UNIQUE, seq_no ...)
 */
async function getOrCreateDaySeqRow(client, work_date) {
  const r = await client.query(
    `
    INSERT INTO inward_day_seq (work_date)
    VALUES ($1)
    ON CONFLICT (work_date)
    DO UPDATE SET work_date = EXCLUDED.work_date
    RETURNING id, seq_no
    `,
    [work_date]
  );
  return r.rows[0]; // {id, seq_no}
}

/* =========================================================
   ✅ UPLOAD ROUTES (BEFORE "/:id")
   ========================================================= */

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
 * ✅ LIST (FAST)
 * GET /api/inward?from=YYYY-MM-DD&to=YYYY-MM-DD
 * ✅ returns items inline so React loads fast
 */
router.get("/", async (req, res) => {
  const from = toISODate(req.query.from);
  const to = toISODate(req.query.to);

  try {
    const base = getBaseUrl(req);

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

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // ✅ items inline (JSON aggregation) -> much faster frontend
    const q = `
      SELECT
        i.id,
        ds.seq_no,
        i.work_date,
        i.store,
        i.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', it.id,
              'item_order', it.item_order,
              'material', it.material,
              'quantity', it.quantity,
              'quantity_type', it.quantity_type,
              'material_use', it.material_use,
              'image_path', it.image_path,
              'upload_id', it.upload_id,
              'file_url',
                CASE
                  WHEN it.upload_id IS NOT NULL THEN $1 || '/api/inward/upload/' || it.upload_id || '/view'
                  ELSE it.image_path
                END
            )
            ORDER BY it.item_order
          ) FILTER (WHERE it.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM inward i
      LEFT JOIN inward_day_seq ds ON ds.id = i.day_seq_id
      LEFT JOIN inward_items it ON it.inward_id = i.id
      ${whereSql}
      GROUP BY i.id, ds.seq_no, i.work_date, i.store, i.created_at
      ORDER BY i.work_date DESC, ds.seq_no DESC NULLS LAST, i.store ASC, i.id DESC
    `;

    // $1 is base url, rest are date filters
    const r = await db.query(q, [base, ...params]);
    return res.json({ success: true, data: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/**
 * ✅ MULTI PDF (range)
 * GET /api/inward/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * ✅ PDF RULES:
 * - Sr.No printed ONCE per date (across stores)
 * - Date printed for EACH store group first row (even if same date)
 */
router.get("/pdf", async (req, res) => {
  const from = toISODate(req.query.from);
  const to = toISODate(req.query.to);

  try {
    let q = `
      SELECT
        i.id,
        ds.seq_no,
        i.work_date,
        i.store
      FROM inward i
      LEFT JOIN inward_day_seq ds ON ds.id = i.day_seq_id
    `;
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
    if (where.length) q += ` WHERE ` + where.join(" AND ");
    q += ` ORDER BY i.work_date ASC, i.store ASC, i.id ASC`;

    const headers = await db.query(q, params);
    const ids = headers.rows.map((r) => r.id);
    if (ids.length === 0) return res.status(404).json({ success: false, message: "No records found" });

    const items = await db.query(
      `
      SELECT inward_id, item_order, material, quantity, quantity_type, material_use, image_path, upload_id
      FROM inward_items
      WHERE inward_id = ANY($1::bigint[])
      ORDER BY inward_id, item_order
      `,
      [ids]
    );

    const map = new Map();
    for (const h of headers.rows) map.set(h.id, { ...h, items: [] });
    for (const it of items.rows) {
      const rec = map.get(it.inward_id);
      if (rec) rec.items.push(it);
    }

    const records = Array.from(map.values()).filter((r) => (r.items || []).length > 0);
    return drawInwardPDF(res, records, "inward-details.pdf");
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
      `
      SELECT
        i.id,
        ds.seq_no,
        i.work_date,
        i.store,
        i.created_at
      FROM inward i
      LEFT JOIN inward_day_seq ds ON ds.id = i.day_seq_id
      WHERE i.id=$1
      `,
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
    const header = await db.query(
      `
      SELECT
        i.id,
        ds.seq_no,
        i.work_date,
        i.store
      FROM inward i
      LEFT JOIN inward_day_seq ds ON ds.id = i.day_seq_id
      WHERE i.id=$1
      `,
      [inwardId]
    );
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
    return drawInwardPDF(res, [rec], `inward-${rec.seq_no || inwardId}.pdf`);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  }
});

/**
 * ✅ CREATE (MERGE MODE)
 * POST /api/inward
 *
 * ✅ If same (Date + Store) header exists:
 *    - do NOT create new inward header
 *    - for each item: if same material exists => ADD quantity, else insert new row
 *
 * ✅ One bill per inward:
 *    - if new bill uploaded: set upload_id for ALL items of that inward
 */
router.post(
  "/",
  upload.fields([{ name: "bill", maxCount: 1 }, { name: "files", maxCount: 50 }]),
  async (req, res) => {
    const payload = readPayload(req);
    const v = validateHeaderAndItems(payload);

    if (!v.ok) {
      return res.status(400).json({ success: false, message: "Validation failed", errors: v.errors });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // ✅ date-wise stable seq row
      const dayRow = await getOrCreateDaySeqRow(client, v.work_date);
      const daySeqId = dayRow.id;
      const daySeqNo = dayRow.seq_no;

      // ✅ check if header exists for same date + store
      const existingHeader = await client.query(
        `SELECT id FROM inward WHERE work_date=$1 AND store=$2 LIMIT 1`,
        [v.work_date, v.store]
      );

      let inwardId = null;
      let createdNew = false;

      if (existingHeader.rowCount) {
        inwardId = existingHeader.rows[0].id;

        // ensure day_seq_id is set even for old records
        await client.query(`UPDATE inward SET day_seq_id=$1 WHERE id=$2 AND (day_seq_id IS NULL OR day_seq_id<>$1)`, [daySeqId, inwardId]);
      } else {
        const header = await client.query(
          `INSERT INTO inward (work_date, store, day_seq_id) VALUES ($1,$2,$3) RETURNING id`,
          [v.work_date, v.store, daySeqId]
        );
        inwardId = header.rows[0].id;
        createdNew = true;
      }

      // ✅ Bill logic (one per inward)
      let newBillUploaded = false;
      let commonUploadId = null;

      if (payload.billFile && payload.billFile.buffer) {
        if (!isAllowedBillFile(payload.billFile)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: "Only image or PDF allowed for bill." });
        }
        commonUploadId = await insertUpload(client, payload.billFile);
        newBillUploaded = true;
      } else {
        const oldUpload = await client.query(
          `SELECT upload_id FROM inward_items WHERE inward_id=$1 AND upload_id IS NOT NULL ORDER BY id LIMIT 1`,
          [inwardId]
        );
        commonUploadId = oldUpload.rowCount ? oldUpload.rows[0].upload_id : null;
      }

      // ✅ if new bill uploaded -> apply to ALL existing items immediately
      if (newBillUploaded && commonUploadId) {
        await client.query(
          `UPDATE inward_items SET upload_id=$1 WHERE inward_id=$2`,
          [commonUploadId, inwardId]
        );
      }

      // legacy support ONLY if no commonUploadId
      let indexToFile = new Map();
      if (!commonUploadId && isMultipart(req)) {
        indexToFile = buildIndexToFileMap(payload.fileIndexMap, payload.files);
      }

      // existing items map by material lower
      const existingItems = await client.query(
        `SELECT id, material, quantity, quantity_type, material_use, upload_id, item_order
         FROM inward_items
         WHERE inward_id=$1`,
        [inwardId]
      );

      const byMaterial = new Map();
      for (const r of existingItems.rows) {
        byMaterial.set(String(r.material || "").toLowerCase(), r);
      }

      // for inserting new, get current max item_order
      const maxOrderRes = await client.query(
        `SELECT COALESCE(MAX(item_order),0) AS mx FROM inward_items WHERE inward_id=$1`,
        [inwardId]
      );
      let nextOrder = Number(maxOrderRes.rows[0].mx || 0) + 1;

      for (let idx = 0; idx < v.items.length; idx++) {
        const it = v.items[idx];
        const key = it.material.toLowerCase();

        // attach upload_id
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

        const found = byMaterial.get(key);

        // ✅ MERGE: same material -> add qty
        if (found) {
          const oldQty = found.quantity === null || found.quantity === undefined ? null : Number(found.quantity);
          const newQty = it.quantity === null || it.quantity === undefined ? null : Number(it.quantity);

          let finalQty = oldQty;
          if (newQty !== null && !Number.isNaN(newQty)) {
            if (finalQty === null || finalQty === undefined || Number.isNaN(Number(finalQty))) finalQty = 0;
            finalQty = Number(finalQty) + Number(newQty);
          }

          const finalQtyType = it.quantity_type ? it.quantity_type : found.quantity_type;
          const finalUse = found.material_use ? found.material_use : it.material_use;
          const finalUpload = it.upload_id ? it.upload_id : found.upload_id;

          await client.query(
            `
            UPDATE inward_items
            SET quantity=$1, quantity_type=$2, material_use=$3, upload_id=$4
            WHERE id=$5
            `,
            [finalQty, finalQtyType, finalUse, finalUpload, found.id]
          );
        } else {
          // ✅ insert new row
          await client.query(
            `
            INSERT INTO inward_items
              (inward_id, item_order, material, quantity, quantity_type, material_use, image_path, upload_id)
            VALUES
              ($1,$2,$3,$4,$5,$6,$7,$8)
            `,
            [inwardId, nextOrder, it.material, it.quantity, it.quantity_type, it.material_use, it.image_path, it.upload_id]
          );
          nextOrder++;
        }
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: createdNew ? "Inward created" : "Inward merged (quantity added)",
        data: { id: inwardId, seq_no: daySeqNo, work_date: v.work_date, store: v.store },
      });
    } catch (err) {
      await client.query("ROLLBACK");

      if (pgDuplicateError(err)) {
        return res.status(409).json({
          success: false,
          message: "Duplicate not allowed (Same Date + Store + Material must be unique).",
          error: err.detail || String(err),
        });
      }

      return res.status(500).json({ success: false, message: "Server error", error: String(err) });
    } finally {
      client.release();
    }
  }
);

/**
 * ✅ UPDATE (replaces all items)
 * PUT /api/inward/:id
 *
 * ✅ keeps day_seq_id for that date
 * Note: If bill not sent, it keeps previous bill (if any) by reading old upload_id.
 */
router.put(
  "/:id",
  upload.fields([{ name: "bill", maxCount: 1 }, { name: "files", maxCount: 50 }]),
  async (req, res) => {
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

      const dayRow = await getOrCreateDaySeqRow(client, v.work_date);
      const daySeqId = dayRow.id;
      const daySeqNo = dayRow.seq_no;

      // header update (may throw duplicate if same date+store already exists for another record)
      await client.query(
        `UPDATE inward SET work_date=$1, store=$2, day_seq_id=$3 WHERE id=$4`,
        [v.work_date, v.store, daySeqId, inwardId]
      );

      // old upload_id
      const oldUpload = await client.query(
        `SELECT upload_id FROM inward_items WHERE inward_id=$1 AND upload_id IS NOT NULL ORDER BY id LIMIT 1`,
        [inwardId]
      );
      const oldUploadId = oldUpload.rowCount ? oldUpload.rows[0].upload_id : null;

      // new bill?
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

      // insert fresh items (order 1..N)
      let order = 1;
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
          [inwardId, order, it.material, it.quantity, it.quantity_type, it.material_use, it.image_path, it.upload_id]
        );

        order++;
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Inward updated",
        data: { id: inwardId, seq_no: daySeqNo, work_date: v.work_date, store: v.store },
      });
    } catch (err) {
      await client.query("ROLLBACK");

      if (pgDuplicateError(err)) {
        return res.status(409).json({
          success: false,
          message: "Duplicate not allowed (Same Date + Store must be unique).",
          error: err.detail || String(err),
        });
      }

      return res.status(500).json({ success: false, message: "Server error", error: String(err) });
    } finally {
      client.release();
    }
  }
);

/**
 * ✅ DELETE (SAFE)
 * DELETE /api/inward/:id
 * ✅ deletes items first, then header
 * ✅ day_seq table untouched => seq remains stable forever
 */
router.delete("/:id", async (req, res) => {
  const inwardId = Number(req.params.id);
  if (Number.isNaN(inwardId)) return res.status(400).json({ success: false, message: "Invalid id" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM inward_items WHERE inward_id=$1`, [inwardId]);

    const del = await client.query(`DELETE FROM inward WHERE id=$1 RETURNING id`, [inwardId]);
    if (del.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Inward not found" });
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Inward deleted" });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, message: "Server error", error: String(err) });
  } finally {
    client.release();
  }
});

/* ---------------- PDF ---------------- */

function drawInwardPDF(res, records, fileName = "inward-details.pdf") {
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

  // ✅ NEW PDF PRINT RULE TRACKERS
  const printedSrForDate = new Set(); // date -> srno printed once
  const printedDateForDateStore = new Set(); // date||store -> date printed per store group

  for (const rec of records) {
    const items = rec.items || [];
    if (items.length === 0) continue;

    const dateKey = String(rec.work_date).slice(0, 10);
    const storeKey = String(rec.store || "");
    const dateStoreKey = `${dateKey}||${storeKey}`;

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const subLetter = String.fromCharCode(97 + ((it.item_order || (idx + 1)) - 1));
      const materialText = `${subLetter}) ${it.material || ""}`.trim();

      const qtyText =
        it.quantity === null || it.quantity === undefined
          ? ""
          : `${it.quantity}${it.quantity_type ? " " + it.quantity_type : ""}`;

      // ✅ SrNo only once per date across all stores
      const srText = !printedSrForDate.has(dateKey) && idx === 0 ? String(rec.seq_no || "") : "";

      // ✅ Date should appear for each store group first row
      const dateText =
        !printedDateForDateStore.has(dateStoreKey) && idx === 0
          ? formatDateDDMMYYYY(dateKey)
          : "";

      const storeText = idx === 0 ? storeKey : "";
      const useText = it.material_use || "";

      const materialH = measureCellHeight(materialText, cols.find((c) => c.key === "material").w - 8, "Times-Roman", 10);
      const useH = measureCellHeight(useText, cols.find((c) => c.key === "use").w - 8, "Times-Roman", 10);
      const rowH = Math.max(22, Math.ceil(Math.max(materialH, useH) + 8));

      drawRow(
        { srno: srText, date: dateText, material: materialText, qty: qtyText, store: storeText, use: useText },
        rowH
      );

      if (!printedSrForDate.has(dateKey) && idx === 0) printedSrForDate.add(dateKey);
      if (!printedDateForDateStore.has(dateStoreKey) && idx === 0) printedDateForDateStore.add(dateStoreKey);
    }

    drawBoldSeparationLine();
  }

  doc.end();
}

module.exports = router;
