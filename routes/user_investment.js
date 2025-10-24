// routes/user_investment.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

/* -------------------------------------------------------
 * Helpers
 * ----------------------------------------------------- */

// Month name ↔ number
const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];
const monthNameToNum = (name) => {
  if (!name) return null;
  const i = MONTHS.findIndex(m => m.toLowerCase() === String(name).trim().toLowerCase());
  return i >= 0 ? i + 1 : null;
};
const numToMonthName = (n) => MONTHS[(n - 1 + 12) % 12];

// Validate numeric (>=0)
const isNonNegNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
};

// Normalize Postgres errors → HTTP
function normalizePgError(err) {
  console.error("[user_investment] PG Error:", {
    code: err?.code,
    message: err?.message,
    detail: err?.detail,
    constraint: err?.constraint,
  });

  if (!err) return { status: 500, message: "Internal Server Error" };
  if (err.code === "23505") return { status: 409, message: "Record already exists for this month." };
  if (err.code === "23514") {
    // Check constraint (most likely record_date != month end)
    return { status: 400, message: err.detail || "Check constraint failed" };
  }
  if (err.code === "22P02" || err.code === "22007")
    return { status: 400, message: "Invalid data format." };
  return { status: 500, message: "Internal Server Error" };
}

// ✅ Last day-of-month from a first-of-month date (works with column names or bind params)
function sqlMonthEndExpr(alias = "month_start") {
  // Cast the alias/param to DATE *before* date_trunc so Postgres can infer the type.
  return `(date_trunc('month', (${alias})::date) + INTERVAL '1 month' - INTERVAL '1 day')::date`;
}

// Build month_start (first of month) from inputs; returns { month_start: 'YYYY-MM-DD', label }
function resolveMonthStart({ month_start, month_name, year_value } = {}) {
  // 1) If month_start provided, trust it, but coerce to first-of-month
  if (month_start) {
    const s = String(month_start).slice(0, 10);
    const d = new Date(s);
    if (isNaN(d)) throw new Error("Invalid month_start");
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const iso = first.toISOString().slice(0, 10);
    return { month_start: iso, label: `${numToMonthName(first.getUTCMonth()+1)} ${first.getUTCFullYear()}` };
  }

  // 2) If name + year provided
  if (month_name && year_value) {
    const m = monthNameToNum(month_name);
    const y = Number(year_value);
    if (!m || !Number.isInteger(y)) throw new Error("Invalid month_name/year_value");
    const first = new Date(Date.UTC(y, m - 1, 1));
    const iso = first.toISOString().slice(0, 10);
    return { month_start: iso, label: `${numToMonthName(m)} ${y}` };
  }

  // 3) Default: current month
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const iso = first.toISOString().slice(0, 10);
  return { month_start: iso, label: `${numToMonthName(first.getUTCMonth()+1)} ${first.getUTCFullYear()}` };
}

// Row mapper: add month_label + status_color
const mapRow = (r) => {
  const monthLabel = (() => {
    const d = new Date(r.month_start);
    if (!isNaN(d)) return `${numToMonthName(d.getUTCMonth() + 1)} ${d.getUTCFullYear()}`;
    // Fallback if month_start is string
    const y = String(r.month_start).slice(0,4);
    const m = Number(String(r.month_start).slice(5,7));
    return `${numToMonthName(m)} ${y}`;
  })();

  const color = r.profit_loss_status === "PROFIT" ? "green" : "red";

  return {
    id: r.id,
    month_start: String(r.month_start).slice(0,10),
    record_date: String(r.record_date).slice(0,10),
    month_label: monthLabel,

    job_income: r.job_income,
    extra_income: r.extra_income,
    month_kharch: r.month_kharch,
    total_emi: r.total_emi,
    other_kharch: r.other_kharch,

    total_income: r.total_income,
    total_kharch: r.total_kharch,
    net_amount: r.net_amount,
    profit_loss_status: r.profit_loss_status,
    profit_loss_abs: r.profit_loss_abs,
    status_color: color,

    created_at: r.created_at,
  };
};

/* -------------------------------------------------------
 * Bootstrap schema (runs once)
 * ----------------------------------------------------- */
(async () => {
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS user_investment (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

        -- Month anchor (first day)
        month_start date NOT NULL,

        -- Record date must be the last day of that month
        record_date date NOT NULL,

        -- Money fields
        job_income    numeric(12,2) NOT NULL DEFAULT 0 CHECK (job_income    >= 0),
        extra_income  numeric(12,2)          DEFAULT 0 CHECK (extra_income  >= 0),
        month_kharch  numeric(12,2) NOT NULL DEFAULT 0 CHECK (month_kharch  >= 0),
        total_emi     numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_emi     >= 0),
        other_kharch  numeric(12,2)          DEFAULT 0 CHECK (other_kharch  >= 0),

        -- Generated totals (immutable expressions only)
        total_income numeric(12,2) GENERATED ALWAYS AS
          (job_income + COALESCE(extra_income,0)) STORED,

        total_kharch numeric(12,2) GENERATED ALWAYS AS
          (month_kharch + total_emi + COALESCE(other_kharch,0)) STORED,

        net_amount numeric(12,2) GENERATED ALWAYS AS
          ((job_income + COALESCE(extra_income,0)) - (month_kharch + total_emi + COALESCE(other_kharch,0))) STORED,

        profit_loss_status text GENERATED ALWAYS AS
          (CASE WHEN ((job_income + COALESCE(extra_income,0)) - (month_kharch + total_emi + COALESCE(other_kharch,0))) >= 0
                THEN 'PROFIT' ELSE 'LOSS' END) STORED,

        profit_loss_abs numeric(12,2) GENERATED ALWAYS AS
          (ABS((job_income + COALESCE(extra_income,0)) - (month_kharch + total_emi + COALESCE(other_kharch,0)))) STORED,

        created_at timestamptz NOT NULL DEFAULT now(),

        -- Ensure only one record per calendar month
        UNIQUE (month_start),

        -- Ensure record_date equals end-of-month from month_start
        CONSTRAINT chk_record_on_month_end
          CHECK (record_date = ${sqlMonthEndExpr("month_start")})
      );

      CREATE INDEX IF NOT EXISTS idx_ui_month_start ON user_investment (month_start DESC);
      CREATE INDEX IF NOT EXISTS idx_ui_created_at  ON user_investment (created_at DESC);
    `);
    console.log("✅ user_investment table ready");
  } catch (err) {
    console.error("❌ Error creating user_investment table:", err);
  }
})();

/* -------------------------------------------------------
 * Create
 * ----------------------------------------------------- */
/**
 * POST /api/user_investment
 * Body accepts any of:
 *  - { month_start: 'YYYY-MM-DD', ...amounts }
 *  - { month_name: 'October', year_value: 2025, ...amounts }
 *  - {} -> defaults to current month
 * Amounts: job_income (required >=0), extra_income, month_kharch (required >=0), total_emi (required >=0), other_kharch
 */
router.post("/", async (req, res) => {
  try {
    const {
      month_start,
      month_name,
      year_value,
      job_income,
      extra_income,
      month_kharch,
      total_emi,
      other_kharch,
    } = req.body || {};

    // Resolve month
    const resolved = resolveMonthStart({ month_start, month_name, year_value });
    const ms = resolved.month_start;

    // Validate required amounts
    if (!isNonNegNumber(job_income))   return res.status(400).json({ error: "job_income must be a non-negative number" });
    if (!isNonNegNumber(month_kharch)) return res.status(400).json({ error: "month_kharch must be a non-negative number" });
    if (!isNonNegNumber(total_emi))    return res.status(400).json({ error: "total_emi must be a non-negative number" });

    // Optionals default 0
    const extra = isNonNegNumber(extra_income) ? Number(extra_income) : 0;
    const other = isNonNegNumber(other_kharch) ? Number(other_kharch) : 0;

    // record_date MUST equal last day of that month
    const sql = `
      INSERT INTO user_investment
        (month_start, record_date, job_income, extra_income, month_kharch, total_emi, other_kharch)
      VALUES
        ($1, ${sqlMonthEndExpr("$1")}, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const params = [ms, job_income, extra, month_kharch, total_emi, other];

    const { rows } = await pool.query(sql, params);
    res.status(201).json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* -------------------------------------------------------
 * List (with pagination + filters)
 * ----------------------------------------------------- */
/**
 * GET /api/user_investment
 * Query:
 *  - page (default 1), pageSize (default 10)
 *  - year (int), month (1..12), or month_name ('October')
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize || "10", 10)));

    let { year, month, month_name } = req.query;
    let where = "WHERE 1=1";
    const args = [];

    if (year) {
      const y = parseInt(year, 10);
      if (!Number.isInteger(y)) return res.status(400).json({ error: "Invalid year" });
      args.push(y);
      where += ` AND EXTRACT(YEAR FROM month_start) = $${args.length}`;
    }

    if (month_name && !month) {
      const m = monthNameToNum(month_name);
      if (!m) return res.status(400).json({ error: "Invalid month_name" });
      month = m;
    }

    if (month) {
      const m = parseInt(month, 10);
      if (!(m >= 1 && m <= 12)) return res.status(400).json({ error: "Invalid month" });
      args.push(m);
      where += ` AND EXTRACT(MONTH FROM month_start) = $${args.length}`;
    }

    // total count
    const { rows: c } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM user_investment ${where}`, args);
    const total = c[0]?.cnt || 0;

    // paged rows
    const offset = (page - 1) * pageSize;
    const { rows } = await pool.query(
      `
        SELECT * FROM user_investment
        ${where}
        ORDER BY month_start DESC
        LIMIT $${args.length + 1} OFFSET $${args.length + 2}
      `,
      [...args, pageSize, offset]
    );

    res.json({
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      data: rows.map(mapRow),
    });
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* -------------------------------------------------------
 * Get by ID
 * ----------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM user_investment WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* -------------------------------------------------------
 * Update
 * ----------------------------------------------------- */
/**
 * PATCH /api/user_investment/:id
 * Body fields (all optional):
 *  - month_start or (month_name + year_value)  → if you change month, record_date will also be reset to the month end
 *  - job_income, extra_income, month_kharch, total_emi, other_kharch
 */
router.patch("/:id", async (req, res) => {
  try {
    const {
      month_start,
      month_name,
      year_value,
      job_income,
      extra_income,
      month_kharch,
      total_emi,
      other_kharch,
    } = req.body || {};

    const setters = [];
    const params = [];
    let i = 1;

    // If month is changing, we must set BOTH month_start and record_date
    if (month_start || (month_name && year_value)) {
      const resolved = resolveMonthStart({ month_start, month_name, year_value });
      setters.push(`month_start = $${i++}`);
      params.push(resolved.month_start);
      // record_date must be end-of-month for the *new* month_start
      setters.push(`record_date = ${sqlMonthEndExpr(`$${i-1}`)}`);
    }

    const numbers = [
      ["job_income", job_income],
      ["extra_income", extra_income],
      ["month_kharch", month_kharch],
      ["total_emi", total_emi],
      ["other_kharch", other_kharch],
    ];

    for (const [field, val] of numbers) {
      if (val !== undefined) {
        if (!isNonNegNumber(val)) return res.status(400).json({ error: `${field} must be a non-negative number` });
        setters.push(`${field} = $${i++}`);
        params.push(Number(val));
      }
    }

    if (setters.length === 0) return res.status(400).json({ error: "No fields to update" });

    const sql = `
      UPDATE user_investment
         SET ${setters.join(", ")}
       WHERE id = $${i}
   RETURNING *`;
    params.push(req.params.id);

    const { rows } = await pool.query(sql, params);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapRow(rows[0]));
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

/* -------------------------------------------------------
 * Delete
 * ----------------------------------------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM user_investment WHERE id = $1", [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  } catch (err) {
    const { status, message } = normalizePgError(err);
    res.status(status).json({ error: message });
  }
});

module.exports = router;
