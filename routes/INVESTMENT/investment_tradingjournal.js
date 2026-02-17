// src/routes/investment/investment_tradingjouranla.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

// ✅ server-side strict rules
function validateProfitLossBrokerage({ profit, loss, brokerage }) {
  const p = Number(profit);
  const l = Number(loss);
  const b = Number(brokerage);

  if (!Number.isFinite(p) || p < 0) return "profit invalid";
  if (!Number.isFinite(l) || l < 0) return "loss invalid";
  if (!Number.isFinite(b) || b < 0) return "brokerage invalid";

  const ok = (p === 0 && l > 0) || (l === 0 && p > 0) || (p === 0 && l === 0);
  if (!ok) return "Either Profit OR Loss should be > 0 (both cannot be > 0 together)";

  // optional tighten: if profit=0 & loss=0 then brokerage must be 0
  if (p === 0 && l === 0 && b > 0) return "brokerage not allowed when profit=loss=0";

  return "";
}

// POST create journal + child rows
router.post("/", auth, async (req, res) => {
  const userId = req.user.user_id;

  const {
    platform_id,
    segment_id,
    plan_id, // optional
    trade_date,
    profit,
    loss,
    brokerage,
    trade_logic,
    mistakes,
    options = [],
    stocks = [],
  } = req.body;

  const pid = Number(platform_id);
  const sid = Number(segment_id);
  const planId = plan_id ? Number(plan_id) : null;

  if (!pid) return res.status(400).json({ message: "platform_id required" });
  if (!sid) return res.status(400).json({ message: "segment_id required" });
  if (!trade_date) return res.status(400).json({ message: "trade_date required" });
  if (!trade_logic?.trim()) return res.status(400).json({ message: "trade_logic required" });

  const v = validateProfitLossBrokerage({ profit, loss, brokerage });
  if (v) return res.status(400).json({ message: v });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ✅ segment ownership + segment belongs to platform + get is_options
    const seg = await client.query(
      `SELECT segment_id, is_options
       FROM investment_segment
       WHERE user_id=$1 AND segment_id=$2 AND platform_id=$3`,
      [userId, sid, pid]
    );
    if (!seg.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid platform/segment for user" });
    }
    const isOptions = !!seg.rows[0].is_options;

    // ✅ plan ownership validate (if provided)
    if (planId) {
      const pl = await client.query(
        `SELECT 1 FROM investment_plan
         WHERE user_id=$1 AND plan_id=$2 AND platform_id=$3 AND segment_id=$4`,
        [userId, planId, pid, sid]
      );
      if (!pl.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid plan for user/platform/segment" });
      }
    }

    // ✅ enforce options vs stocks rows
    if (isOptions) {
      if (!Array.isArray(options) || options.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Options segment requires options rows" });
      }
      if (Array.isArray(stocks) && stocks.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Options segment cannot accept stocks rows" });
      }
    } else {
      if (!Array.isArray(stocks) || stocks.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "This segment requires stocks rows" });
      }
      if (Array.isArray(options) && options.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Stocks segment cannot accept options rows" });
      }
    }

    const j = await client.query(
      `INSERT INTO investment_tradingjournal
        (user_id, platform_id, segment_id, plan_id, trade_date, profit, loss, brokerage, trade_logic, mistakes)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING journal_id, user_id, platform_id, segment_id, plan_id, trade_date, profit, loss, brokerage, net_pnl, trade_logic, mistakes, created_at`,
      [
        userId,
        pid,
        sid,
        planId,
        trade_date,
        Number(profit),
        Number(loss),
        Number(brokerage),
        trade_logic.trim(),
        mistakes?.trim() ? mistakes.trim() : null,
      ]
    );

    const journalId = j.rows[0].journal_id;

    if (isOptions) {
      for (const r of options) {
        const strike = Number(r.strike_price);
        const entry = Number(r.entry_price);
        const exit = Number(r.exit_price);
        const qty = Number(r.quantity);
        const ot = String(r.option_type || "").toUpperCase();

        if (!Number.isFinite(strike) || strike <= 0) throw new Error("strike_price invalid");
        if (!["CE", "PE"].includes(ot)) throw new Error("option_type must be CE/PE");
        if (!Number.isFinite(entry) || entry <= 0) throw new Error("entry_price invalid");
        if (!Number.isFinite(exit) || exit <= 0) throw new Error("exit_price invalid");
        if (!Number.isFinite(qty) || qty <= 0) throw new Error("quantity invalid");

        await client.query(
          `INSERT INTO investment_tradingjournal_options
            (journal_id, strike_price, option_type, entry_price, exit_price, quantity)
           VALUES
            ($1,$2,$3,$4,$5,$6)`,
          [journalId, strike, ot, entry, exit, qty]
        );
      }
    } else {
      for (const r of stocks) {
        const name = String(r.stock_name || "").trim();
        const entry = Number(r.entry_price);
        const exit = Number(r.exit_price);
        const qty = Number(r.quantity);

        if (!name) throw new Error("stock_name required");
        if (!Number.isFinite(entry) || entry <= 0) throw new Error("entry_price invalid");
        if (!Number.isFinite(exit) || exit <= 0) throw new Error("exit_price invalid");
        if (!Number.isFinite(qty) || qty <= 0) throw new Error("quantity invalid");

        await client.query(
          `INSERT INTO investment_tradingjournal_stocks
            (journal_id, stock_name, entry_price, exit_price, quantity)
           VALUES
            ($1,$2,$3,$4,$5)`,
          [journalId, name, entry, exit, qty]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ data: j.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ message: "Journal create failed", error: e.message });
  } finally {
    client.release();
  }
});

// DELETE journal (user safe)
router.delete("/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid journal_id" });

  try {
    const result = await pool.query(
      `DELETE FROM investment_tradingjournal
       WHERE user_id=$1 AND journal_id=$2`,
      [userId, id]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Journal not found" });
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Journal delete failed", error: e.message });
  }
});

module.exports = router;
