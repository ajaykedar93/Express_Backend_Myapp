// routes/inward.js
const express = require("express");
const router = express.Router();
const db = require("../db"); // Your db.query function
const PDFDocument = require("pdfkit");
const moment = require("moment");

const TABLE = "inward";
const PK = "id";

const ALLOWED_FIELDS = [
  "category_id",
  "work_date",
  "work_time",
  "details",
  "quantity",
  "quantity_type",
  "extra_details",
  "extra_quantity",
  "extra_quantity_type",
  "extra_items",
];

// ---------------------------
// Helpers
// ---------------------------
function normalizeExtrasArray(extrasAll) {
  if (!Array.isArray(extrasAll)) return [];
  return extrasAll
    .map((e) => ({
      details: e?.details ?? null,
      quantity: e?.quantity === "" || e?.quantity == null ? null : Number(e.quantity),
      quantity_type: e?.quantity_type ?? null,
    }))
    .filter(
      (e) =>
        (e.details && String(e.details).trim() !== "") ||
        e.quantity !== null ||
        (e.quantity_type && String(e.quantity_type).trim() !== "")
    );
}

function ensureLegacyFromExtras(data) {
  const legacyProvided =
    data.extra_details !== undefined ||
    data.extra_quantity !== undefined ||
    data.extra_quantity_type !== undefined;

  if (legacyProvided) return data;

  let arr = [];
  if (Array.isArray(data.extra_items)) arr = data.extra_items;
  else if (typeof data.extra_items === "string") {
    try {
      arr = JSON.parse(data.extra_items);
    } catch {
      arr = [];
    }
  }

  const first = arr[0];
  if (!first) return data;

  return {
    ...data,
    extra_details: data.extra_details ?? first.details ?? null,
    extra_quantity: data.extra_quantity ?? first.quantity ?? null,
    extra_quantity_type: data.extra_quantity_type ?? first.quantity_type ?? null,
  };
}

function prepareDataFromBody(body) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }

  if (Object.prototype.hasOwnProperty.call(body, "extras_all")) {
    out.extra_items = normalizeExtrasArray(body.extras_all);
  }

  if (typeof out.extra_items === "string") {
    try {
      out.extra_items = JSON.parse(out.extra_items);
    } catch {
      out.extra_items = [];
    }
  }
  if (!Array.isArray(out.extra_items)) out.extra_items = [];

  if (out.work_date !== undefined && String(out.work_date).trim() === "") {
    delete out.work_date;
  }

  return ensureLegacyFromExtras(out);
}

function buildInsert(data) {
  const cols = [];
  const vals = [];
  const ph = [];
  let i = 1;

  for (const k of ALLOWED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    const v = data[k];
    if (v === undefined) continue;

    cols.push(k);
    if (k === "extra_items") {
      vals.push(JSON.stringify(v));
      ph.push(`$${i++}::jsonb`);
    } else {
      vals.push(v);
      ph.push(`$${i++}`);
    }
  }

  if (cols.length === 0) return null;

  return {
    text: `INSERT INTO ${TABLE} (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING *`,
    values: vals,
  };
}

function buildUpdate(id, data) {
  const sets = [];
  const vals = [];
  let i = 1;

  for (const k of ALLOWED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    const v = data[k];
    if (v === undefined) continue;

    if (k === "extra_items") {
      vals.push(JSON.stringify(v));
      sets.push(`${k} = $${i++}::jsonb`);
    } else {
      vals.push(v);
      sets.push(`${k} = $${i++}`);
    }
  }

  if (sets.length === 0) return null;

  vals.push(id);
  return {
    text: `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE ${PK} = $${i} RETURNING *`,
    values: vals,
  };
}

// ---------------------------
// Routes
// ---------------------------

// ---------------------------
// Export PDF (must be first, before /:id)
// ---------------------------
router.get("/inward/export", async (req, res) => {
  try {
    const { date, month } = req.query;

    // Build SQL query
    let query = `SELECT seq_no, work_date, work_time, details, quantity, quantity_type FROM ${TABLE}`;
    const conditions = [];

    if (date) conditions.push(`work_date = '${date}'`);
    else if (month) conditions.push(`TO_CHAR(work_date, 'Month') = '${month}'`);

    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");

    query += " ORDER BY work_date ASC, seq_no ASC";

    const result = await db.query(query);
    const records = result.rows;

    // PDF setup
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=inward_export_${moment().format("YYYYMMDD")}.pdf`
    );

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    // --- PDF Header ---
    doc.fontSize(22).fillColor("#333333").text("Inward Details", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor("#555555")
       .text(`Generated on: ${moment().format("YYYY-MM-DD")}`, { align: "right" });
    doc.moveDown(1);

    // --- Table Layout ---
    const tableTop = 120;
    const rowHeight = 22;

    // Fixed equal column widths (A4 width ~ 595, minus margins ~ 40*2 = 515 usable space)
    const colWidth = 80; // ~6 equal columns
    const colX = [50, 130, 210, 290, 370, 450]; // X positions for 6 columns

    // --- Table Header ---
    const headers = ["Seq", "Date", "Details", "Quantity", "Qty Type", "Work Time"];
    doc.fontSize(10).fillColor("#000000").font("Helvetica-Bold");

    headers.forEach((h, i) => {
      doc.text(h, colX[i], tableTop, { width: colWidth, align: "center" });
    });

    // --- Table Rows ---
    let y = tableTop + 20;
    doc.font("Helvetica").fontSize(9).fillColor("#000000");

    records.forEach((rec, idx) => {
      const row = [
        rec.seq_no ?? idx + 1,
        moment(rec.work_date).format("YYYY-MM-DD"), // only date
        rec.details || "-",
        rec.quantity ?? "-",
        rec.quantity_type ?? "-",
        rec.work_time ?? "-"
      ];

      row.forEach((val, i) => {
        doc.text(String(val), colX[i], y, { width: colWidth, align: "center" });
      });

      y += rowHeight;

      // New page check
      if (y > 750) {
        doc.addPage();
        y = 50;

        // Repeat table header
        headers.forEach((h, i) => {
          doc.font("Helvetica-Bold");
          doc.text(h, colX[i], y, { width: colWidth, align: "center" });
        });
        doc.font("Helvetica");
        y += rowHeight;
      }
    });

    doc.end();
  } catch (err) {
    console.error("PDF export error:", err);
    res.status(500).json({ error: "Failed to export PDF" });
  }
});

// ---------------------------
// List / Filters
// GET /inward?category_id=&date=&month=
// ---------------------------
router.get("/inward", async (req, res) => {
  try {
    const { category_id, date, month } = req.query;
    const cond = [];
    const vals = [];
    let i = 1;

    if (category_id) {
      cond.push(`category_id = $${i++}`);
      vals.push(Number(category_id));
    }

    if (date) {
      cond.push(`work_date = $${i++}`);
      vals.push(date);
    } else if (month) {
      const months = [
        "January","February","March","April","May","June",
        "July","August","September","October","November","December"
      ];
      const monthIndex = months.indexOf(month);
      if (monthIndex >= 0) {
        const year = new Date().getFullYear();
        const firstDay = `${year}-${String(monthIndex+1).padStart(2,"0")}-01`;
        const lastDay = new Date(year, monthIndex+1, 0);
        const lastDayStr = `${year}-${String(monthIndex+1).padStart(2,"0")}-${String(lastDay.getDate()).padStart(2,"0")}`;
        cond.push(`work_date >= $${i++}`);
        vals.push(firstDay);
        cond.push(`work_date <= $${i++}`);
        vals.push(lastDayStr);
      }
    }

    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const sql = `SELECT ${PK}, seq_no, work_date, work_time, details, quantity, quantity_type 
                 FROM ${TABLE} ${where} ORDER BY work_date ASC, seq_no ASC, ${PK} ASC`;

    const result = await db.query(sql, vals);

    const flatData = result.rows.map((row, idx) => ({
      id: row.id,
      seq_no: row.seq_no ?? idx+1,
      work_date: row.work_date,
      work_time: row.work_time,
      details: row.details,
      quantity: row.quantity,
      quantity_type: row.quantity_type
    }));

    res.json({ data: flatData });
  } catch (e) {
    console.error("GET /inward", e);
    res.status(500).json({ error: "Failed to fetch inward records" });
  }
});

// ---------------------------
// GET /inward/:id
// ---------------------------
router.get("/inward/:id", async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(isNaN(id)) return res.status(400).json({error:"Invalid ID"});
    const result = await db.query(`SELECT * FROM ${TABLE} WHERE ${PK}=$1`,[id]);
    if(result.rows.length===0) return res.status(404).json({error:"Not found"});
    res.json(result.rows[0]);
  }catch(e){
    console.error("GET /inward/:id",e);
    res.status(500).json({error:"Failed to fetch inward record"});
  }
});

// ---------------------------
// POST /inward
// ---------------------------
router.post("/inward", async (req,res)=>{
  try{
    const raw = req.body||{};
    if(raw.category_id==null) return res.status(400).json({error:"category_id is required"});
    if(!raw.details || String(raw.details).trim()==="") return res.status(400).json({error:"details is required"});

    const data = prepareDataFromBody(raw);
    const ins = buildInsert(data);
    if(!ins) return res.status(400).json({error:"No valid fields provided"});

    const result = await db.query(ins.text, ins.values);
    res.status(201).json(result.rows[0]);
  }catch(e){
    console.error("POST /inward",e);
    res.status(500).json({error:"Failed to create inward record"});
  }
});

// ---------------------------
// PUT /inward/:id
// ---------------------------
router.put("/inward/:id", async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(isNaN(id)) return res.status(400).json({error:"Invalid ID"});

    const data = prepareDataFromBody(req.body||{});
    const upd = buildUpdate(id,data);
    if(!upd) return res.status(400).json({error:"No updatable fields provided"});

    const result = await db.query(upd.text,upd.values);
    if(result.rows.length===0) return res.status(404).json({error:"Record not found"});

    res.json(result.rows[0]);
  }catch(e){
    console.error("PUT /inward/:id",e);
    res.status(500).json({error:"Failed to update inward record"});
  }
});

// ---------------------------
// DELETE /inward/:id
// ---------------------------
router.delete("/inward/:id", async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(isNaN(id)) return res.status(400).json({error:"Invalid ID"});

    const result = await db.query(`DELETE FROM ${TABLE} WHERE ${PK}=$1 RETURNING *`,[id]);
    if(result.rows.length===0) return res.status(404).json({error:"Record not found"});

    res.json({ok:true, deleted: result.rows[0]});
  }catch(e){
    console.error("DELETE /inward/:id",e);
    res.status(500).json({error:"Failed to delete inward record"});
  }
});

// ---------------------------
// POST /inward/resequence
// ---------------------------
router.post("/inward/resequence", async (req,res)=>{
  try{
    const orderBy = String(req.body?.orderBy||"").toLowerCase();
    let orderExpr = `work_date ASC, ${PK} ASC`;
    if(orderBy==="id") orderExpr = `${PK} ASC`;
    else if(orderBy==="category_id") orderExpr = `category_id ASC, ${PK} ASC`;

    const sql = `
      WITH ordered AS (
        SELECT ${PK}, ROW_NUMBER() OVER (ORDER BY ${orderExpr}) AS rn
        FROM ${TABLE}
      )
      UPDATE ${TABLE} t
      SET seq_no = o.rn
      FROM ordered o
      WHERE t.${PK}=o.${PK}
      RETURNING t.${PK};
    `;
    const result = await db.query(sql);
    res.json({ok:true, resequenced: result.rows.length});
  }catch(e){
    console.error("POST /inward/resequence",e);
    res.status(500).json({error:"Failed to resequence"});
  }
});

module.exports = router;
