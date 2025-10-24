const express = require("express");
const router = express.Router();
const db = require("../db"); // pg Pool


// Helper: get local current date
function getToday() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}


// 1️⃣ GET daily transactions + totals
router.get("/daily", async (req, res) => {
  const { date } = req.query;
  const targetDate = date || getToday();

  try {
    const dailyRes = await db.query(
      `SELECT d.*, c.category_name, s.subcategory_name
       FROM DailyTransaction d
       LEFT JOIN Category c ON d.category_id = c.category_id
       LEFT JOIN Subcategory s ON d.subcategory_id = s.subcategory_id
       WHERE d.transaction_date=$1
       ORDER BY d.created_at ASC`,
      [targetDate]
    );

    const totalsRes = await db.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) AS total_debit,
         COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) AS total_credit,
         COUNT(*) AS total_transactions
       FROM DailyTransaction
       WHERE transaction_date=$1`,
      [targetDate]
    );

    res.json({
      date: targetDate,
      dailyTransactions: dailyRes.rows,
      totals: totalsRes.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// 2️⃣ GET suggestions (unsaved daily transactions)
router.get("/suggestions", async (req, res) => {
  const { date } = req.query;
  const targetDate = date || getToday();

  try {
    const mainRes = await db.query(
      "SELECT transaction_id FROM MainTransaction WHERE date=$1",
      [targetDate]
    );

    let excludedIds = [];
    if (mainRes.rows.length > 0) {
      const linkedRes = await db.query(
        "SELECT daily_transaction_id FROM MainTransactionDetail WHERE main_transaction_id=$1",
        [mainRes.rows[0].transaction_id]
      );
      excludedIds = linkedRes.rows.map(r => r.daily_transaction_id);
    }

    const query = `
      SELECT d.*, c.category_name, s.subcategory_name
      FROM DailyTransaction d
      LEFT JOIN Category c ON d.category_id = c.category_id
      LEFT JOIN Subcategory s ON d.subcategory_id = s.subcategory_id
      WHERE d.transaction_date=$1
      ${excludedIds.length ? `AND d.daily_transaction_id NOT IN (${excludedIds.join(",")})` : ""}
      ORDER BY d.created_at ASC
    `;
    const suggestionsRes = await db.query(query, [targetDate]);

    res.json({ date: targetDate, suggestions: suggestionsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// 3️⃣ SAVE transactions (insert/update main + details)
router.post("/save", async (req, res) => {
  const { date } = req.body;
  const targetDate = date || getToday();

  try {
    await db.query("BEGIN");

    // Check if main transaction exists
    let mainRes = await db.query(
      "SELECT transaction_id FROM MainTransaction WHERE date=$1 FOR UPDATE",
      [targetDate]
    );

    let mainId;
    if (mainRes.rows.length > 0) {
      mainId = mainRes.rows[0].transaction_id;
      await db.query(
        "DELETE FROM MainTransactionDetail WHERE main_transaction_id=$1",
        [mainId]
      );
    } else {
      const insert = await db.query(
        `INSERT INTO MainTransaction(date, total_debit, total_credit, total_transactions)
         VALUES($1,0,0,0) RETURNING transaction_id`,
        [targetDate]
      );
      mainId = insert.rows[0].transaction_id;
    }

    const allDaily = await db.query(
      "SELECT daily_transaction_id, type, amount FROM DailyTransaction WHERE transaction_date=$1",
      [targetDate]
    );

    for (let d of allDaily.rows) {
      await db.query(
        `INSERT INTO MainTransactionDetail(main_transaction_id, daily_transaction_id)
         VALUES($1,$2)`,
        [mainId, d.daily_transaction_id]
      );
    }

    const totals = allDaily.rows.reduce(
      (acc, t) => {
        if (t.type === "debit") acc.total_debit += Number(t.amount);
        else if (t.type === "credit") acc.total_credit += Number(t.amount);
        acc.total_transactions += 1;
        return acc;
      },
      { total_debit: 0, total_credit: 0, total_transactions: 0 }
    );

    await db.query(
      `UPDATE MainTransaction
       SET total_debit=$1, total_credit=$2, total_transactions=$3
       WHERE transaction_id=$4`,
      [totals.total_debit, totals.total_credit, totals.total_transactions, mainId]
    );

    await db.query("COMMIT");
    res.json({ message: "Transactions saved successfully", mainId });
  } catch (err) {
    await db.query("ROLLBACK");
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// 4️⃣ DELETE main transaction
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM MainTransactionDetail WHERE main_transaction_id=$1", [id]);
    await db.query("DELETE FROM MainTransaction WHERE transaction_id=$1", [id]);
    await db.query("COMMIT");
    res.json({ message: "Main transaction deleted" });
  } catch (err) {
    await db.query("ROLLBACK");
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// 5️⃣ GET all main transactions (by default current date)

router.get("/", async (req, res) => {
  const { date } = req.query;
  const targetDate = date || getToday();

  try {
    const mainRes = await db.query(
      `SELECT * FROM MainTransaction WHERE date::date = $1 ORDER BY date DESC`,
      [targetDate]
    );
    res.json(mainRes.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
