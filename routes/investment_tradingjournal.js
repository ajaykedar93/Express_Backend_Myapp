// routes/investment_tradingjournal.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/* ================= helpers ================= */
const asNum = (v) =>
  v === undefined || v === null || v === "" ? undefined : Number(v);

const isDateISO = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const badReq = (res, msg) => res.status(400).json({ error: msg });

const hasMaxNDecimals = (v, n) => {
  if (v === undefined || v === null || v === "") return true;
  if (!Number.isFinite(Number(v))) return false;
  const m = String(v).match(/^-?\d+(?:\.(\d+))?$/);
  if (!m) return false;
  const dec = m[1] ? m[1].length : 0;
  return dec <= n;
};

const validateCreate = (b) => {
  if (!b.category_id || !b.subcategory_id)
    return "category_id and subcategory_id are required";

  const entry = asNum(b.trade_entry);
  const exit = asNum(b.trade_exit);
  if (!Number.isFinite(entry) || !Number.isFinite(exit))
    return "trade_entry and trade_exit must be numbers";
  if (!hasMaxNDecimals(b.trade_entry, 4) || !hasMaxNDecimals(b.trade_exit, 4))
    return "trade_entry and trade_exit must have at most 4 decimals";

  const profit = asNum(b.profit_amount) ?? 0;
  const loss = asNum(b.loss_amount) ?? 0;
  const brokerage = asNum(b.brokerage) ?? 0;

  if (!hasMaxNDecimals(b.profit_amount, 2) ||
      !hasMaxNDecimals(b.loss_amount, 2) ||
      !hasMaxNDecimals(b.brokerage, 2)) {
    return "profit_amount, loss_amount, brokerage must have at most 2 decimals";
  }

  if (profit < 0 || loss < 0 || brokerage < 0)
    return "profit_amount, loss_amount, brokerage must be >= 0";
  if (profit > 0 && loss > 0)
    return "Only one of profit_amount or loss_amount can be > 0";
  if (profit === 0 && loss === 0)
    return "Either profit_amount or loss_amount must be > 0";

  if (!b.trade_logic || String(b.trade_logic).trim() === "")
    return "trade_logic is required";

  if (b.trade_date && !isDateISO(b.trade_date))
    return "trade_date must be in YYYY-MM-DD format";

  // broker_name, segment, purpose are optional
  return null;
};

const buildListFilter = (q) => {
  const where = [];
  const params = [];
  let i = 1;

  if (q.date && isDateISO(q.date)) {
    where.push(`tj.trade_date = $${i++}`);
    params.push(q.date);
  }
  if (q.category_id) {
    where.push(`tj.category_id = $${i++}`);
    params.push(Number(q.category_id));
  }
  if (q.subcategory_id) {
    where.push(`tj.subcategory_id = $${i++}`);
    params.push(Number(q.subcategory_id));
  }

  return { where, params };
};

// Re-sequence helper for one (date, cat, sub)
async function resequence(date, category_id, subcategory_id) {
  if (!date || !category_id || !subcategory_id) return;
  await db.query(
    `
    WITH ordered AS (
      SELECT journal_id,
             ROW_NUMBER() OVER (ORDER BY journal_id) AS rn
      FROM trading_journal
      WHERE trade_date=$1 AND category_id=$2 AND subcategory_id=$3
    )
    UPDATE trading_journal t
    SET sequence_no = o.rn
    FROM ordered o
    WHERE t.journal_id = o.journal_id;
  `,
    [date, category_id, subcategory_id]
  );
}

/* ===== SELECT list (plain numbers) ===== */
const SELECT_BASE = `
  tj.journal_id,
  tj.trade_date,
  tj.sequence_no,
  tj.trade_entry::float8   AS trade_entry,
  tj.trade_exit::float8    AS trade_exit,
  COALESCE(tj.profit_amount,0)::float8  AS profit_amount,
  COALESCE(tj.loss_amount,0)::float8    AS loss_amount,
  COALESCE(tj.brokerage,0)::float8      AS brokerage,
  (COALESCE(tj.profit_amount,0) - COALESCE(tj.loss_amount,0) - COALESCE(tj.brokerage,0))::float8 AS net_pnl,
  tj.trade_logic,
  tj.mistakes,
  tj.broker_name,
  tj.segment,
  tj.purpose,
  c.category_id,
  c.category_name,
  s.subcategory_id,
  s.subcategory_name,
  -- Gentle R:R info only
  CASE
    WHEN d.deposit_id IS NULL THEN NULL
    WHEN COALESCE(tj.profit_amount,0) >= COALESCE(d.reward,0)
     AND COALESCE(tj.loss_amount,0)   <= COALESCE(d.risk,0) THEN TRUE
    ELSE FALSE
  END AS rr_respected,
  CASE
    WHEN d.deposit_id IS NULL THEN NULL
    WHEN COALESCE(tj.profit_amount,0) < COALESCE(d.reward,0)
     AND COALESCE(tj.loss_amount,0)   > COALESCE(d.risk,0) THEN 'Target not met; Risk exceeded'
    WHEN COALESCE(tj.profit_amount,0) < COALESCE(d.reward,0) THEN 'Target not met'
    WHEN COALESCE(tj.loss_amount,0)   > COALESCE(d.risk,0) THEN 'Risk exceeded'
    ELSE NULL
  END AS violation_reason
`;

const FROM_JOIN = `
  FROM trading_journal tj
  JOIN investment_category c    ON c.category_id = tj.category_id
  JOIN investment_subcategory s ON s.subcategory_id = tj.subcategory_id
  LEFT JOIN investment_deposit_logic d
         ON d.category_id = tj.category_id AND d.subcategory_id = tj.subcategory_id
`;

/* ================= CREATE (auto sequence, limit=3) ================= */
// POST /api/trading_journal
router.post("/", async (req, res) => {
  try {
    const err = validateCreate(req.body);
    if (err) return badReq(res, err);

    const {
      trade_date, // optional; if omitted CURRENT_DATE
      category_id,
      subcategory_id,
      trade_entry,
      trade_exit,
      profit_amount = 0,
      loss_amount = 0,
      brokerage = 0,
      trade_logic,
      mistakes = null,
      broker_name = null,
      segment = null,
      purpose = null,
    } = req.body;

    // Atomic insert with max-3 check and next sequence_no
    const { rows: ins } = await db.query(
      `
      WITH d AS (
        SELECT COALESCE($1::date, CURRENT_DATE) AS d
      ),
      stats AS (
        SELECT COUNT(*)::int AS cnt, COALESCE(MAX(sequence_no),0)::int AS mx
        FROM trading_journal tj, d
        WHERE tj.trade_date = d.d AND tj.category_id=$2 AND tj.subcategory_id=$3
      )
      INSERT INTO trading_journal
        (trade_date, sequence_no, category_id, subcategory_id,
         trade_entry, trade_exit, profit_amount, loss_amount, brokerage,
         trade_logic, mistakes, broker_name, segment, purpose)
      SELECT
        d.d,
        (stats.mx + 1),
        $2, $3,
        $4::numeric,  -- entry (NUMERIC(18,4) on table)
        $5::numeric,  -- exit
        $6::numeric,  -- profit (NUMERIC(15,2))
        $7::numeric,  -- loss
        $8::numeric,  -- brokerage
        $9, $10, $11, $12, $13
      FROM d, stats
      WHERE stats.cnt < 3
      RETURNING journal_id;
    `,
      [
        trade_date || null,
        Number(category_id),
        Number(subcategory_id),
        trade_entry,
        trade_exit,
        profit_amount,
        loss_amount,
        brokerage,
        String(trade_logic),
        mistakes === null ? null : String(mistakes),
        broker_name === null ? null : String(broker_name),
        segment === null ? null : String(segment),
        purpose === null ? null : String(purpose),
      ]
    );

    if (!ins.length) {
      return badReq(res, "Daily trade limit (3) reached for this Category/Subcategory.");
    }

    const id = ins[0].journal_id;
    const { rows: out } = await db.query(
      `SELECT ${SELECT_BASE} ${FROM_JOIN} WHERE tj.journal_id=$1`,
      [id]
    );
    return res.status(201).json(out[0]);
  } catch (e) {
    console.error("Create journal error:", e);
    return res.status(400).json({
      error: e.message || "Failed to create journal entry",
      hint: e.hint || undefined,
    });
  }
});

/* ================= LIST ================= */
// GET /api/trading_journal?date=YYYY-MM-DD&category_id=..&subcategory_id=..&limit=..&offset=..
router.get("/", async (req, res) => {
  try {
    const { where, params } = buildListFilter(req.query);
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 100;
    const offset = req.query.offset ? Math.max(Number(req.query.offset), 0) : 0;

    const sql = `
      SELECT ${SELECT_BASE}
      ${FROM_JOIN}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY tj.trade_date DESC, tj.category_id, tj.subcategory_id, tj.sequence_no
      LIMIT ${limit} OFFSET ${offset};
    `;
    const { rows } = await db.query(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error("List journal error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

/* ================= READ ONE ================= */
// GET /api/trading_journal/:journal_id
router.get("/:journal_id", async (req, res) => {
  try {
    const { journal_id } = req.params;
    const { rows } = await db.query(
      `SELECT ${SELECT_BASE} ${FROM_JOIN} WHERE tj.journal_id=$1`,
      [journal_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    return res.json(rows[0]);
  } catch (e) {
    console.error("Get one journal error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

/* ================= UPDATE (no manual sequence_no) ================= */
// PATCH /api/trading_journal/:journal_id
// Allowed: trade_date, trade_entry, trade_exit, profit_amount, loss_amount, brokerage,
// trade_logic, mistakes, category_id, subcategory_id, broker_name, segment, purpose
router.patch("/:journal_id", async (req, res) => {
  const client = await db.connect();
  try {
    const { journal_id } = req.params;

    const allowed = new Set([
      "trade_date",
      "trade_entry",
      "trade_exit",
      "profit_amount",
      "loss_amount",
      "brokerage",
      "trade_logic",
      "mistakes",
      "category_id",
      "subcategory_id",
      "broker_name",
      "segment",
      "purpose",
    ]);

    const entries = Object.entries(req.body).filter(
      ([k, v]) => allowed.has(k) && v !== undefined
    );
    if (!entries.length) return badReq(res, "No valid fields to update.");

    // validations
    const map = Object.fromEntries(entries);

    if (map.trade_date && !isDateISO(map.trade_date))
      return badReq(res, "trade_date must be YYYY-MM-DD");

    if (map.trade_entry !== undefined && !hasMaxNDecimals(map.trade_entry, 4))
      return badReq(res, "trade_entry must have at most 4 decimals");
    if (map.trade_exit !== undefined && !hasMaxNDecimals(map.trade_exit, 4))
      return badReq(res, "trade_exit must have at most 4 decimals");

    const p = asNum(map.profit_amount);
    const l = asNum(map.loss_amount);
    const br = asNum(map.brokerage);
    if (p !== undefined && (!hasMaxNDecimals(map.profit_amount, 2) || p < 0))
      return badReq(res, "profit_amount must be >= 0 and <= 2 decimals");
    if (l !== undefined && (!hasMaxNDecimals(map.loss_amount, 2) || l < 0))
      return badReq(res, "loss_amount must be >= 0 and <= 2 decimals");
    if (br !== undefined && (!hasMaxNDecimals(map.brokerage, 2) || br < 0))
      return badReq(res, "brokerage must be >= 0 and <= 2 decimals");

    if (p !== undefined && l !== undefined && p > 0 && l > 0)
      return badReq(res, "Only one of profit_amount or loss_amount can be > 0");

    if (map.trade_logic !== undefined && String(map.trade_logic).trim() === "")
      return badReq(res, "trade_logic cannot be empty");

    await client.query("BEGIN");

    // fetch old group
    const { rows: oldRows } = await client.query(
      `SELECT trade_date, category_id, subcategory_id FROM trading_journal WHERE journal_id=$1 FOR UPDATE`,
      [journal_id]
    );
    if (!oldRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }
    const oldG = oldRows[0];

    // Build SET clauses (cast numerics, no rounding)
    const numFields = new Set(["trade_entry", "trade_exit", "profit_amount", "loss_amount", "brokerage"]);
    const setClauses = entries.map(([k], i) =>
      numFields.has(k) ? `${k} = $${i + 1}::numeric` : `${k} = $${i + 1}`
    );
    const values = entries.map(([, v]) => v);

    const { rows: upd } = await client.query(
      `UPDATE trading_journal
       SET ${setClauses.join(", ")}
       WHERE journal_id = $${values.length + 1}
       RETURNING *`,
      [...values, journal_id]
    );
    if (!upd.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const row = upd[0];
    const newDate = row.trade_date;
    const newCat = row.category_id;
    const newSub = row.subcategory_id;

    // if moved groups, enforce limit and assign next sequence
    if (
      String(oldG.trade_date) !== String(newDate) ||
      Number(oldG.category_id) !== Number(newCat) ||
      Number(oldG.subcategory_id) !== Number(newSub)
    ) {
      const { rows: cntRows } = await client.query(
        `
        SELECT COUNT(*)::int AS cnt, COALESCE(MAX(sequence_no),0)::int AS mx
        FROM trading_journal
        WHERE trade_date=$1 AND category_id=$2 AND subcategory_id=$3
      `,
        [newDate, newCat, newSub]
      );
      const cnt = cntRows[0].cnt;
      const mx = cntRows[0].mx;

      if (cnt >= 3) {
        await client.query("ROLLBACK");
        return badReq(res, "Daily trade limit (3) reached for new Category/Subcategory.");
      }

      await client.query(
        `UPDATE trading_journal SET sequence_no=$1 WHERE journal_id=$2`,
        [mx + 1, journal_id]
      );

      // resequence old group
      await resequence(oldG.trade_date, oldG.category_id, oldG.subcategory_id);
    }

    // resequence new/current group
    await resequence(newDate, newCat, newSub);

    await client.query("COMMIT");

    const { rows: out } = await db.query(
      `SELECT ${SELECT_BASE} ${FROM_JOIN} WHERE tj.journal_id=$1`,
      [journal_id]
    );
    return res.json(out[0]);
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("Patch journal error:", e);
    return res.status(400).json({
      error: e.message || "Failed to update journal entry",
      hint: e.hint || undefined,
    });
  } finally {
    try { client.release(); } catch {}
  }
});

/* ================= DELETE (re-sequence after) ================= */
// DELETE /api/trading_journal/:journal_id
router.delete("/:journal_id", async (req, res) => {
  try {
    const { journal_id } = req.params;
    const { rows } = await db.query(
      `DELETE FROM trading_journal
       WHERE journal_id = $1
       RETURNING trade_date, category_id, subcategory_id`,
      [journal_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const g = rows[0];
    await resequence(g.trade_date, g.category_id, g.subcategory_id);

    return res.json({ message: "Deleted successfully" });
  } catch (e) {
    console.error("Delete journal error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

/* ================= DAILY SUMMARY ================= */
// GET /api/trading_journal/summary/day?date=YYYY-MM-DD&category_id=..&subcategory_id=..
router.get("/summary/day", async (req, res) => {
  try {
    const { date, category_id, subcategory_id } = req.query;
    if (!date || !isDateISO(date)) return badReq(res, "date (YYYY-MM-DD) is required");
    if (!category_id || !subcategory_id)
      return badReq(res, "category_id and subcategory_id are required");

    const baseQ = `
      SELECT (deposit_amount - withdrawal_amount)::float8 AS base_deposit
      FROM investment_deposit_logic
      WHERE category_id = $1 AND subcategory_id = $2
      LIMIT 1
    `;
    const baseRes = await db.query(baseQ, [Number(category_id), Number(subcategory_id)]);
    const base_deposit = baseRes.rows.length ? Number(baseRes.rows[0].base_deposit) : 0;

    const aggQ = `
      SELECT
        COUNT(*)::int                                               AS trades_count,
        COALESCE(SUM(profit_amount), 0)::float8                    AS gross_profit,
        COALESCE(SUM(loss_amount), 0)::float8                      AS gross_loss,
        COALESCE(SUM(brokerage), 0)::float8                        AS total_brokerage,
        COALESCE(SUM(profit_amount - loss_amount - brokerage), 0)::float8 AS day_net
      FROM trading_journal
      WHERE trade_date = $1 AND category_id = $2 AND subcategory_id = $3
    `;
    const aggRes = await db.query(aggQ, [date, Number(category_id), Number(subcategory_id)]);
    const agg = aggRes.rows[0];

    const current_capital = Number(base_deposit) + Number(agg.day_net);
    const limitLeft = Math.max(0, 3 - Number(agg.trades_count));

    return res.json({
      date,
      category_id: Number(category_id),
      subcategory_id: Number(subcategory_id),
      base_deposit: Number(base_deposit),
      trades_count: Number(agg.trades_count),
      gross_profit: Number(agg.gross_profit),
      gross_loss: Number(agg.gross_loss),
      total_brokerage: Number(agg.total_brokerage),
      day_net: Number(agg.day_net),
      current_capital,
      net_deposit: current_capital,
      limit_left: limitLeft,
      status: current_capital >= base_deposit ? "great" : "alert",
    });
  } catch (e) {
    console.error("Summary day error:", e);
    return res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
