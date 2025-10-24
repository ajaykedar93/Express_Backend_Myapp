// routes/investment_deposit.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// ---------- helpers ----------
const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const badReq = (res, msg) => res.status(400).json({ error: msg });
const isISODate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* =========================================================
   A) READ: All rules (joined with names)  GET /api/deposits
   ========================================================= */
router.get("/", async (_req, res) => {
  try {
    // explicit columns (no withdrawal_amount)
    const q = `
      SELECT
        d.deposit_id,
        d.category_id,
        c.category_name,
        d.subcategory_id,
        s.subcategory_name,
        d.deposit_amount,
        d.risk,
        d.reward,
        d.trading_days,
        d.traded_days,
        d.ratio,
        d.created_at,
        d.updated_at
      FROM investment_deposit_logic d
      JOIN investment_category c    ON c.category_id = d.category_id
      JOIN investment_subcategory s ON s.subcategory_id = d.subcategory_id
      ORDER BY d.deposit_id;
    `;
    const { rows } = await db.query(q);
    return res.json(rows);
  } catch (e) {
    console.error("GET /api/deposits error:", e);
    return res.status(500).send("Server Error");
  }
});

/* =======================================================================================
   B) READ: One rule by (category_id, subcategory_id)  GET /api/deposits/:category/:sub
   ======================================================================================= */
router.get("/:category_id/:subcategory_id", async (req, res) => {
  try {
    const { category_id, subcategory_id } = req.params;
    const q = `
      SELECT
        d.deposit_id,
        d.category_id,
        c.category_name,
        d.subcategory_id,
        s.subcategory_name,
        d.deposit_amount,
        d.risk,
        d.reward,
        d.trading_days,
        d.traded_days,
        d.ratio,
        d.created_at,
        d.updated_at
      FROM investment_deposit_logic d
      JOIN investment_category c    ON c.category_id = d.category_id
      JOIN investment_subcategory s ON s.subcategory_id = d.subcategory_id
      WHERE d.category_id=$1 AND d.subcategory_id=$2
      LIMIT 1;
    `;
    const { rows } = await db.query(q, [category_id, subcategory_id]);
    if (!rows.length) return res.status(404).send("Rule not found");
    return res.json(rows[0]);
  } catch (e) {
    console.error("GET /api/deposits/:cat/:sub error:", e);
    return res.status(500).send("Server Error");
  }
});

/* =====================================================================================================
   C) Derived: CURRENT CAPITAL for a day  (deposit + Σ net_pnl for that day)
      GET /api/deposits/:category_id/:subcategory_id/capital?date=YYYY-MM-DD
   ===================================================================================================== */
router.get("/:category_id/:subcategory_id/capital", async (req, res) => {
  try {
    const { category_id, subcategory_id } = req.params;
    const date = req.query.date;
    if (!date || !isISODate(date)) return badReq(res, "date is required in YYYY-MM-DD format");

    // base deposit (no withdrawal component now)
    const baseQ = `
      SELECT deposit_amount AS base_deposit
      FROM investment_deposit_logic
      WHERE category_id=$1 AND subcategory_id=$2
      LIMIT 1;
    `;
    const baseRes = await db.query(baseQ, [category_id, subcategory_id]);
    const base_deposit = baseRes.rows.length ? Number(baseRes.rows[0].base_deposit) : 0;

    // day net (profit - loss - brokerage)
    const pnlQ = `
      SELECT COALESCE(SUM(net_pnl),0)::numeric(15,2) AS day_net
      FROM trading_journal
      WHERE trade_date=$1 AND category_id=$2 AND subcategory_id=$3;
    `;
    const pnlRes = await db.query(pnlQ, [date, category_id, subcategory_id]);
    const day_net = Number(pnlRes.rows[0].day_net || 0);

    const current_capital = base_deposit + day_net;
    return res.json({
      date,
      category_id: Number(category_id),
      subcategory_id: Number(subcategory_id),
      base_deposit,
      day_net,
      current_capital,
    });
  } catch (e) {
    console.error("GET /api/deposits/:cat/:sub/capital error:", e);
    return res.status(500).send("Server Error");
  }
});

/* ==========================================================
   D) UPSERT: Add/Update rule  POST /api/deposits
   ========================================================== */
router.post("/", async (req, res) => {
  try {
    const {
      category_id,
      subcategory_id,
      deposit_amount,
      risk,
      reward,
      trading_days,
      ratio,
      // withdrawal_amount removed from API
    } = req.body;

    if (!category_id || !subcategory_id) {
      return badReq(res, "category_id and subcategory_id are required.");
    }

    const _deposit = num(deposit_amount);
    const _risk = num(risk);
    const _reward = num(reward);
    const _days = num(trading_days);

    if (!Number.isFinite(_deposit) || !Number.isFinite(_risk) || !Number.isFinite(_reward)) {
      return badReq(res, "deposit_amount, risk, reward must be numbers.");
    }
    if (!Number.isInteger(_days) || _days <= 0) {
      return badReq(res, "trading_days must be a positive integer.");
    }
    if (ratio && String(ratio).length > 10) {
      return badReq(res, "ratio must be <= 10 characters.");
    }

    const q = `
      INSERT INTO investment_deposit_logic
        (category_id, subcategory_id, deposit_amount, risk, reward, trading_days, ratio)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (category_id, subcategory_id)
      DO UPDATE SET
        deposit_amount = EXCLUDED.deposit_amount,
        risk           = EXCLUDED.risk,
        reward         = EXCLUDED.reward,
        trading_days   = EXCLUDED.trading_days,
        ratio          = EXCLUDED.ratio
      RETURNING deposit_id;
    `;
    const { rows } = await db.query(q, [
      category_id,
      subcategory_id,
      _deposit,
      _risk,
      _reward,
      _days,
      ratio ?? null,
    ]);

    // return with names (explicit cols)
    const { rows: out } = await db.query(
      `SELECT
         d.deposit_id,
         d.category_id,
         c.category_name,
         d.subcategory_id,
         s.subcategory_name,
         d.deposit_amount,
         d.risk,
         d.reward,
         d.trading_days,
         d.traded_days,
         d.ratio,
         d.created_at,
         d.updated_at
       FROM investment_deposit_logic d
       JOIN investment_category c    ON c.category_id = d.category_id
       JOIN investment_subcategory s ON s.subcategory_id = d.subcategory_id
       WHERE d.deposit_id = $1`,
      [rows[0].deposit_id]
    );

    return res.status(200).json(out[0]);
  } catch (e) {
    console.error("POST /api/deposits error:", e);
    return res.status(500).send("Server Error");
  }
});

/* ==========================================================================================
   E) PATCH by deposit_id  PATCH /api/deposits/:deposit_id
   Body: { deposit_amount, risk, reward, trading_days, ratio, traded_days }
   (withdrawal_amount removed)
   ========================================================================================== */
router.patch("/:deposit_id", async (req, res) => {
  try {
    const { deposit_id } = req.params;
    const allowed = new Set([
      "deposit_amount",
      "risk",
      "reward",
      "trading_days",
      "ratio",
      "traded_days",
    ]);

    const entries = Object.entries(req.body).filter(([k, v]) => allowed.has(k) && v !== undefined);
    if (!entries.length) return badReq(res, "No valid fields to update.");

    // basic validations
    for (const [k, v] of entries) {
      if (["deposit_amount", "risk", "reward"].includes(k)) {
        if (!Number.isFinite(num(v))) return badReq(res, `${k} must be a number.`);
      }
      if (k === "trading_days" && !(Number.isInteger(Number(v)) && Number(v) > 0)) {
        return badReq(res, "trading_days must be a positive integer.");
      }
      if (k === "traded_days" && !(Number.isInteger(Number(v)) && Number(v) >= 0)) {
        return badReq(res, "traded_days must be a non-negative integer.");
      }
      if (k === "ratio" && String(v).length > 10) {
        return badReq(res, "ratio must be <= 10 characters.");
      }
    }

    const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(", ");
    const vals = entries.map(([, v]) => v);

    const q = `
      UPDATE investment_deposit_logic
      SET ${sets}
      WHERE deposit_id = $${vals.length + 1}
      RETURNING
        deposit_id, category_id, subcategory_id,
        deposit_amount, risk, reward, trading_days, traded_days, ratio,
        created_at, updated_at;
    `;
    const { rows } = await db.query(q, [...vals, deposit_id]);
    if (!rows.length) return res.status(404).send("Deposit not found");

    return res.json(rows[0]);
  } catch (e) {
    console.error("PATCH /api/deposits/:id error:", e);
    return res.status(500).send("Server Error");
  }
});

/* =========================================================================================
   F) PATCH traded_days safely  PATCH /api/deposits/:deposit_id/traded-days
   Body: { add?: number, set?: number }
   ========================================================================================= */
router.patch("/:deposit_id/traded-days", async (req, res) => {
  try {
    const { deposit_id } = req.params;
    const add = req.body.add !== undefined ? Number(req.body.add) : undefined;
    const set = req.body.set !== undefined ? Number(req.body.set) : undefined;
    if (add === undefined && set === undefined) return badReq(res, "Provide 'add' or 'set'.");
    if (add !== undefined && !Number.isInteger(add)) return badReq(res, "'add' must be an integer.");
    if (set !== undefined && !Number.isInteger(set)) return badReq(res, "'set' must be an integer.");

    const cur = await db.query(
      `SELECT traded_days, trading_days FROM investment_deposit_logic WHERE deposit_id=$1`,
      [deposit_id]
    );
    if (!cur.rows.length) return res.status(404).send("Deposit not found");

    const { traded_days, trading_days } = cur.rows[0];
    let next = traded_days;
    if (add !== undefined) next = traded_days + add;
    if (set !== undefined) next = set;
    next = Math.max(0, Math.min(next, trading_days)); // clamp

    const { rows } = await db.query(
      `UPDATE investment_deposit_logic SET traded_days=$1 WHERE deposit_id=$2
       RETURNING deposit_id, traded_days, trading_days`,
      [next, deposit_id]
    );
    return res.json(rows[0]);
  } catch (e) {
    console.error("PATCH traded-days error:", e);
    return res.status(500).send("Server Error");
  }
});

/* =========================================================================================
   G) DELETE by pair (category_id/subcategory_id)   DELETE /api/deposits/:category_id/:subcategory_id
   ========================================================================================= */
router.delete("/:category_id/:subcategory_id", async (req, res) => {
  try {
    const { category_id, subcategory_id } = req.params;
    const q = `
      DELETE FROM investment_deposit_logic
      WHERE category_id=$1 AND subcategory_id=$2
      RETURNING deposit_id;
    `;
    const { rows } = await db.query(q, [category_id, subcategory_id]);
    if (!rows.length) return res.status(404).send("Deposit not found");
    return res.json({ message: "Deposit deleted successfully" });
  } catch (e) {
    console.error("DELETE pair error:", e);
    return res.status(500).send("Server Error");
  }
});

/* =========================================================================================
   H) DELETE by deposit_id   DELETE /api/deposits/id/:deposit_id
   ========================================================================================= */
router.delete("/id/:deposit_id", async (req, res) => {
  try {
    const { deposit_id } = req.params;
    const { rows } = await db.query(
      `DELETE FROM investment_deposit_logic WHERE deposit_id=$1 RETURNING deposit_id`,
      [deposit_id]
    );
    if (!rows.length) return res.status(404).send("Deposit not found");
    return res.json({ message: "Deposit deleted successfully" });
  } catch (e) {
    console.error("DELETE id error:", e);
    return res.status(500).send("Server Error");
  }
});

module.exports = router;
