const express = require("express");
const router = express.Router();
const pool = require("../../db");


// -------------------------------
// helper: get admin user_id
// -------------------------------
function getUserId(req) {
  const uid = req.user?.user_id || req.headers["x-user-id"] || req.body?.user_id;
  if (!uid) return null;
  const n = parseInt(uid, 10);
  return Number.isNaN(n) ? null : n;
}

function isValidISODate(d) {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}
function isValidMonthString(m) {
  return typeof m === "string" && /^\d{4}-\d{2}$/.test(m);
}

/* =========================================================
   PLAN APIs
   POST   /api/plan
   GET    /api/plan
   GET    /api/plan/:id
   PUT    /api/plan/:id   (EXTRA - useful)
   DELETE /api/plan/:id
   ========================================================= */

// POST /api/plan
router.post("/plan", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const {
      subcategory_id,
      plan_name,
      total_fund_deposit,
      risk_loss,
      profit_reward,
      day_trade_limit = 0,
      trading_days,
    } = req.body;

    const subId = parseInt(subcategory_id, 10);
    if (!subId) return res.status(400).json({ message: "subcategory_id is required" });

    const fund = Number(total_fund_deposit);
    const risk = Number(risk_loss);
    const reward = Number(profit_reward);
    const dayLimit = parseInt(day_trade_limit, 10);
    const days = parseInt(trading_days, 10);

    if (!Number.isFinite(fund) || fund < 0) return res.status(400).json({ message: "total_fund_deposit must be >= 0" });
    if (!Number.isFinite(risk) || risk <= 0) return res.status(400).json({ message: "risk_loss must be > 0" });
    if (!Number.isFinite(reward) || reward <= 0) return res.status(400).json({ message: "profit_reward must be > 0" });
    if (!Number.isFinite(dayLimit) || dayLimit < 0) return res.status(400).json({ message: "day_trade_limit must be >= 0" });
    if (!Number.isFinite(days) || days <= 0) return res.status(400).json({ message: "trading_days must be > 0" });

    const subCheck = await pool.query(
      `SELECT 1 FROM investment_subcategory WHERE subcategory_id=$1 AND user_id=$2`,
      [subId, user_id]
    );
    if (subCheck.rowCount === 0) return res.status(404).json({ message: "Subcategory not found for this user" });

    const q = `
      INSERT INTO investment_plan
        (user_id, subcategory_id, plan_name, total_fund_deposit, risk_loss, profit_reward, day_trade_limit, trading_days)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING
        plan_id, user_id, subcategory_id, plan_name,
        total_fund_deposit, risk_loss, profit_reward, target_rr,
        day_trade_limit, trading_days, created_at;
    `;
    const result = await pool.query(q, [user_id, subId, plan_name ?? null, fund, risk, reward, dayLimit, days]);
    return res.status(201).json({ message: "Plan created", data: result.rows[0] });
  } catch (err) {
    console.error("POST /api/plan error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/plan
router.get("/plan", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const q = `
      SELECT
        p.plan_id, p.user_id, p.subcategory_id, p.plan_name,
        p.total_fund_deposit, p.risk_loss, p.profit_reward, p.target_rr,
        p.day_trade_limit, p.trading_days, p.created_at,
        s.subcategory_name, s.is_options,
        c.category_id, c.category_name
      FROM investment_plan p
      JOIN investment_subcategory s ON s.subcategory_id = p.subcategory_id
      JOIN investment_category c ON c.category_id = s.category_id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC, p.plan_id DESC;
    `;
    const result = await pool.query(q, [user_id]);
    return res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /api/plan error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/plan/:id
router.get("/plan/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const plan_id = parseInt(req.params.id, 10);
    if (!plan_id) return res.status(400).json({ message: "Invalid plan id" });

    const q = `
      SELECT
        p.plan_id, p.user_id, p.subcategory_id, p.plan_name,
        p.total_fund_deposit, p.risk_loss, p.profit_reward, p.target_rr,
        p.day_trade_limit, p.trading_days, p.created_at,
        s.subcategory_name, s.is_options,
        c.category_id, c.category_name
      FROM investment_plan p
      JOIN investment_subcategory s ON s.subcategory_id = p.subcategory_id
      JOIN investment_category c ON c.category_id = s.category_id
      WHERE p.plan_id = $1 AND p.user_id = $2;
    `;
    const result = await pool.query(q, [plan_id, user_id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "Plan not found" });

    return res.json({ data: result.rows[0] });
  } catch (err) {
    console.error("GET /api/plan/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/plan/:id  (EXTRA)
router.put("/plan/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const plan_id = parseInt(req.params.id, 10);
    if (!plan_id) return res.status(400).json({ message: "Invalid plan id" });

    const allowed = [
      "plan_name",
      "total_fund_deposit",
      "risk_loss",
      "profit_reward",
      "day_trade_limit",
      "trading_days",
    ];

    const updates = [];
    const params = [];
    let idx = 1;

    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        // validations
        if (k === "total_fund_deposit") {
          const v = Number(req.body[k]);
          if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "total_fund_deposit must be >= 0" });
          params.push(v);
        } else if (k === "risk_loss") {
          const v = Number(req.body[k]);
          if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ message: "risk_loss must be > 0" });
          params.push(v);
        } else if (k === "profit_reward") {
          const v = Number(req.body[k]);
          if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ message: "profit_reward must be > 0" });
          params.push(v);
        } else if (k === "day_trade_limit") {
          const v = parseInt(req.body[k], 10);
          if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "day_trade_limit must be >= 0" });
          params.push(v);
        } else if (k === "trading_days") {
          const v = parseInt(req.body[k], 10);
          if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ message: "trading_days must be > 0" });
          params.push(v);
        } else {
          params.push(req.body[k] ?? null);
        }

        updates.push(`${k} = $${idx++}`);
      }
    }

    if (updates.length === 0) return res.status(400).json({ message: "Nothing to update" });

    params.push(plan_id, user_id);

    const q = `
      UPDATE investment_plan
      SET ${updates.join(", ")}
      WHERE plan_id = $${idx++} AND user_id = $${idx}
      RETURNING
        plan_id, user_id, subcategory_id, plan_name,
        total_fund_deposit, risk_loss, profit_reward, target_rr,
        day_trade_limit, trading_days, created_at;
    `;

    const result = await pool.query(q, params);
    if (result.rowCount === 0) return res.status(404).json({ message: "Plan not found" });

    return res.json({ message: "Plan updated", data: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/plan/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/plan/:id
router.delete("/plan/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const plan_id = parseInt(req.params.id, 10);
    if (!plan_id) return res.status(400).json({ message: "Invalid plan id" });

    const used = await pool.query(
      `SELECT 1 FROM investment_tradingjournal WHERE plan_id=$1 AND user_id=$2 LIMIT 1`,
      [plan_id, user_id]
    );
    if (used.rowCount > 0) {
      return res.status(409).json({ message: "Cannot delete: plan is used in trading journal" });
    }

    const result = await pool.query(
      `DELETE FROM investment_plan WHERE plan_id=$1 AND user_id=$2 RETURNING plan_id;`,
      [plan_id, user_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Plan not found" });

    return res.json({ message: "Plan deleted", deleted_id: result.rows[0].plan_id });
  } catch (err) {
    console.error("DELETE /api/plan/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   JOURNAL APIs
   POST   /api/journal
   GET    /api/journal
   GET    /api/journal?month=YYYY-MM
   GET    /api/journal/:id    (EXTRA)
   PUT    /api/journal/:id    (FIXED)
   DELETE /api/journal/:id
   ========================================================= */

// POST /api/journal
router.post("/journal", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const {
      category_id,
      subcategory_id,
      plan_id,
      trade_date,
      profit = 0,
      loss = 0,
      brokerage = 0,
      trades_count = 1,
      side,
      entry_price,
      exit_price,
      segment,
      trade_logic,
      mistakes,
      strike_price,
      option_type,
    } = req.body;

    const catId = parseInt(category_id, 10);
    const subId = parseInt(subcategory_id, 10);
    if (!catId) return res.status(400).json({ message: "category_id is required" });
    if (!subId) return res.status(400).json({ message: "subcategory_id is required" });

    const SIDE = String(side || "").toUpperCase();
    if (!["BUY", "SELL"].includes(SIDE)) return res.status(400).json({ message: "side must be BUY or SELL" });

    if (!trade_logic || !String(trade_logic).trim()) return res.status(400).json({ message: "trade_logic is required" });

    if (trade_date && !isValidISODate(trade_date)) return res.status(400).json({ message: "trade_date must be YYYY-MM-DD" });

    const ep = Number(entry_price);
    const xp = Number(exit_price);
    if (!Number.isFinite(ep) || ep <= 0) return res.status(400).json({ message: "entry_price must be > 0" });
    if (!Number.isFinite(xp) || xp <= 0) return res.status(400).json({ message: "exit_price must be > 0" });

    const pr = Number(profit);
    const ls = Number(loss);
    const br = Number(brokerage);
    const tc = parseInt(trades_count, 10);

    if (!Number.isFinite(pr) || pr < 0) return res.status(400).json({ message: "profit must be >= 0" });
    if (!Number.isFinite(ls) || ls < 0) return res.status(400).json({ message: "loss must be >= 0" });
    if (!Number.isFinite(br) || br < 0) return res.status(400).json({ message: "brokerage must be >= 0" });
    if (!Number.isFinite(tc) || tc < 0) return res.status(400).json({ message: "trades_count must be >= 0" });

    // ownership checks
    const catCheck = await pool.query(
      `SELECT 1 FROM investment_category WHERE category_id=$1 AND user_id=$2`,
      [catId, user_id]
    );
    if (catCheck.rowCount === 0) return res.status(404).json({ message: "Category not found for this user" });

    const subCheck = await pool.query(
      `SELECT is_options FROM investment_subcategory WHERE subcategory_id=$1 AND user_id=$2 AND category_id=$3`,
      [subId, user_id, catId]
    );
    if (subCheck.rowCount === 0) return res.status(404).json({ message: "Subcategory not found for this category/user" });

    const isOptions = !!subCheck.rows[0].is_options;
    const OPT = option_type ? String(option_type).toUpperCase() : null;

    if (isOptions) {
      const sp = Number(strike_price);
      if (!Number.isFinite(sp) || sp <= 0) return res.status(400).json({ message: "Options: strike_price is required (>0)" });
      if (!["CALL", "PUT"].includes(OPT)) return res.status(400).json({ message: "Options: option_type must be CALL or PUT" });
    }

    let planId = null;
    if (plan_id !== undefined && plan_id !== null && String(plan_id).trim() !== "") {
      planId = parseInt(plan_id, 10);
      if (!planId) return res.status(400).json({ message: "Invalid plan_id" });

      const planCheck = await pool.query(
        `SELECT 1 FROM investment_plan WHERE plan_id=$1 AND user_id=$2 AND subcategory_id=$3`,
        [planId, user_id, subId]
      );
      if (planCheck.rowCount === 0) return res.status(404).json({ message: "Plan not found for this user/subcategory" });
    }

    const q = `
      INSERT INTO investment_tradingjournal
        (user_id, category_id, subcategory_id, plan_id, trade_date,
         profit, loss, brokerage, trades_count,
         side, entry_price, exit_price, segment, trade_logic, mistakes,
         strike_price, option_type)
      VALUES
        ($1,$2,$3,$4, COALESCE($5::date, CURRENT_DATE),
         $6,$7,$8,$9,
         $10,$11,$12,$13,$14,$15,
         $16,$17)
      RETURNING
        journal_id, user_id, category_id, subcategory_id, plan_id, trade_date,
        profit, loss, brokerage, trades_count,
        side, entry_price, exit_price, segment, trade_logic, mistakes,
        strike_price, option_type,
        net_pnl, realized_rr, rr_followed, overtrade, created_at;
    `;

    const result = await pool.query(q, [
      user_id,
      catId,
      subId,
      planId,
      trade_date ?? null,
      pr,
      ls,
      br,
      tc,
      SIDE,
      ep,
      xp,
      segment ?? null,
      String(trade_logic).trim(),
      mistakes ?? null,
      isOptions ? Number(strike_price) : null,
      isOptions ? OPT : null,
    ]);

    return res.status(201).json({ message: "Journal entry created", data: result.rows[0] });
  } catch (err) {
    console.error("POST /api/journal error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/journal (optional month=YYYY-MM)
router.get("/journal", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const { month } = req.query;

    let q = `
      SELECT
        j.*,
        c.category_name,
        s.subcategory_name,
        p.plan_name
      FROM investment_tradingjournal j
      JOIN investment_category c ON c.category_id = j.category_id
      JOIN investment_subcategory s ON s.subcategory_id = j.subcategory_id
      LEFT JOIN investment_plan p ON p.plan_id = j.plan_id
      WHERE j.user_id = $1
    `;
    const params = [user_id];

    if (month) {
      if (!isValidMonthString(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM (e.g., 2026-02)" });
      }
      q += ` AND j.trade_date >= ($2 || '-01')::date
             AND j.trade_date <  (date_trunc('month', ($2 || '-01')::date) + interval '1 month')::date`;
      params.push(month);
    }

    q += ` ORDER BY j.trade_date DESC, j.journal_id DESC;`;

    const result = await pool.query(q, params);
    return res.json({ data: result.rows });
  } catch (err) {
    console.error("GET /api/journal error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/journal/:id  (EXTRA)
router.get("/journal/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const journal_id = parseInt(req.params.id, 10);
    if (!journal_id) return res.status(400).json({ message: "Invalid journal id" });

    const q = `
      SELECT
        j.*,
        c.category_name,
        s.subcategory_name,
        p.plan_name
      FROM investment_tradingjournal j
      JOIN investment_category c ON c.category_id = j.category_id
      JOIN investment_subcategory s ON s.subcategory_id = j.subcategory_id
      LEFT JOIN investment_plan p ON p.plan_id = j.plan_id
      WHERE j.journal_id = $1 AND j.user_id = $2;
    `;
    const result = await pool.query(q, [journal_id, user_id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "Journal entry not found" });
    return res.json({ data: result.rows[0] });
  } catch (err) {
    console.error("GET /api/journal/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/journal/:id  (FIXED fully)
router.put("/journal/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const journal_id = parseInt(req.params.id, 10);
    if (!journal_id) return res.status(400).json({ message: "Invalid journal id" });

    // fetch existing row + is_options
    const existing = await pool.query(
      `
      SELECT j.subcategory_id, j.category_id, j.plan_id, j.strike_price, j.option_type, s.is_options
      FROM investment_tradingjournal j
      JOIN investment_subcategory s ON s.subcategory_id = j.subcategory_id
      WHERE j.journal_id=$1 AND j.user_id=$2
      `,
      [journal_id, user_id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ message: "Journal entry not found" });

    const isOptions = !!existing.rows[0].is_options;
    const subId = existing.rows[0].subcategory_id;

    // normalize incoming values
    const body = { ...req.body };
    if (body.side !== undefined) body.side = String(body.side).toUpperCase();
    if (body.option_type !== undefined) body.option_type = body.option_type ? String(body.option_type).toUpperCase() : null;

    // validate if present
    if (body.trade_date !== undefined && body.trade_date !== null && body.trade_date !== "" && !isValidISODate(body.trade_date)) {
      return res.status(400).json({ message: "trade_date must be YYYY-MM-DD" });
    }
    if (body.side !== undefined && !["BUY", "SELL"].includes(body.side)) {
      return res.status(400).json({ message: "side must be BUY or SELL" });
    }
    if (body.entry_price !== undefined) {
      const v = Number(body.entry_price);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ message: "entry_price must be > 0" });
      body.entry_price = v;
    }
    if (body.exit_price !== undefined) {
      const v = Number(body.exit_price);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ message: "exit_price must be > 0" });
      body.exit_price = v;
    }
    if (body.profit !== undefined) {
      const v = Number(body.profit);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "profit must be >= 0" });
      body.profit = v;
    }
    if (body.loss !== undefined) {
      const v = Number(body.loss);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "loss must be >= 0" });
      body.loss = v;
    }
    if (body.brokerage !== undefined) {
      const v = Number(body.brokerage);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "brokerage must be >= 0" });
      body.brokerage = v;
    }
    if (body.trades_count !== undefined) {
      const v = parseInt(body.trades_count, 10);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "trades_count must be >= 0" });
      body.trades_count = v;
    }
    if (body.trade_logic !== undefined) {
      const v = String(body.trade_logic || "").trim();
      if (!v) return res.status(400).json({ message: "trade_logic cannot be empty" });
      body.trade_logic = v;
    }

    // plan_id validation (must belong to user + same subcategory)
    if (body.plan_id !== undefined && body.plan_id !== null && String(body.plan_id).trim() !== "") {
      const planId = parseInt(body.plan_id, 10);
      if (!planId) return res.status(400).json({ message: "Invalid plan_id" });

      const planCheck = await pool.query(
        `SELECT 1 FROM investment_plan WHERE plan_id=$1 AND user_id=$2 AND subcategory_id=$3`,
        [planId, user_id, subId]
      );
      if (planCheck.rowCount === 0) return res.status(404).json({ message: "Plan not found for this user/subcategory" });

      body.plan_id = planId;
    } else if (body.plan_id === "") {
      body.plan_id = null; // allow clear plan
    }

    // FINAL options validation (based on final values)
    const finalStrike = body.strike_price !== undefined ? body.strike_price : existing.rows[0].strike_price;
    const finalOptType = body.option_type !== undefined ? body.option_type : existing.rows[0].option_type;

    if (isOptions) {
      const sp = Number(finalStrike);
      if (!Number.isFinite(sp) || sp <= 0) return res.status(400).json({ message: "Options: strike_price is required (>0)" });
      if (!["CALL", "PUT"].includes(String(finalOptType || "").toUpperCase())) {
        return res.status(400).json({ message: "Options: option_type must be CALL or PUT" });
      }
      body.strike_price = sp;
      body.option_type = String(finalOptType).toUpperCase();
    } else {
      // Non-options -> force null if user tries to send
      if (body.strike_price !== undefined) body.strike_price = null;
      if (body.option_type !== undefined) body.option_type = null;
    }

    const allowed = [
      "plan_id",
      "trade_date",
      "profit",
      "loss",
      "brokerage",
      "trades_count",
      "side",
      "entry_price",
      "exit_price",
      "segment",
      "trade_logic",
      "mistakes",
      "strike_price",
      "option_type",
    ];

    const updates = [];
    const params = [];
    let idx = 1;

    for (const key of allowed) {
      if (body[key] !== undefined) {
        updates.push(`${key} = $${idx++}`);
        params.push(body[key]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ message: "Nothing to update" });

    params.push(journal_id, user_id);

    const q = `
      UPDATE investment_tradingjournal
      SET ${updates.join(", ")}
      WHERE journal_id = $${idx++} AND user_id = $${idx}
      RETURNING
        journal_id, user_id, category_id, subcategory_id, plan_id, trade_date,
        profit, loss, brokerage, trades_count,
        side, entry_price, exit_price, segment, trade_logic, mistakes,
        strike_price, option_type,
        net_pnl, realized_rr, rr_followed, overtrade, created_at;
    `;

    const result = await pool.query(q, params);
    return res.json({ message: "Journal entry updated", data: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/journal/:id error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// DELETE /api/journal/:id
router.delete("/journal/:id", async (req, res) => {
  try {
    const user_id = getUserId(req);
    if (!user_id) return res.status(401).json({ message: "Unauthorized: user_id missing" });

    const journal_id = parseInt(req.params.id, 10);
    if (!journal_id) return res.status(400).json({ message: "Invalid journal id" });

    const result = await pool.query(
      `DELETE FROM investment_tradingjournal WHERE journal_id=$1 AND user_id=$2 RETURNING journal_id;`,
      [journal_id, user_id]
    );

    if (result.rowCount === 0) return res.status(404).json({ message: "Journal entry not found" });

    return res.json({ message: "Journal entry deleted", deleted_id: result.rows[0].journal_id });
  } catch (err) {
    console.error("DELETE /api/journal/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
