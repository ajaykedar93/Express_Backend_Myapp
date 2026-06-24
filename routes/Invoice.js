const express = require("express");
const db = require("../db");

const router = express.Router();

/* ================= Helpers ================= */

function getFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  if (month >= 4) {
    return `${year}-${String(year + 1).slice(-2)}`;
  }

  return `${year - 1}-${String(year).slice(-2)}`;
}

function safeText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function numberToWords(num) {
  num = Math.round(Number(num || 0));

  if (num === 0) return "Zero";

  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen"
  ];

  const tens = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"
  ];

  function belowHundred(n) {
    if (n < 20) return ones[n];
    return `${tens[Math.floor(n / 10)]} ${ones[n % 10]}`.trim();
  }

  function belowThousand(n) {
    let str = "";

    if (n >= 100) {
      str += `${ones[Math.floor(n / 100)]} Hundred `;
      n %= 100;
    }

    if (n > 0) str += belowHundred(n);

    return str.trim();
  }

  let words = "";

  const crore = Math.floor(num / 10000000);
  num %= 10000000;

  const lakh = Math.floor(num / 100000);
  num %= 100000;

  const thousand = Math.floor(num / 1000);
  num %= 1000;

  if (crore) words += `${belowThousand(crore)} Crore `;
  if (lakh) words += `${belowThousand(lakh)} Lakh `;
  if (thousand) words += `${belowThousand(thousand)} Thousand `;
  if (num) words += `${belowThousand(num)} `;

  return words.trim();
}

function calculateInvoice(items, igstRate = 5) {
  let taxableAmount = 0;

  const cleanItems = Array.isArray(items) ? items : [];

  const calculatedItems = cleanItems.map((item, index) => {
    const quantity = Number(item.quantity || item.qty || 0);
    const rate = Number(item.rate || 0);
    const amount = quantity * rate;

    taxableAmount += amount;

    return {
      sr_no: item.sr_no || index + 1,
      description: item.description || "",
      hsn_sac: item.hsn_sac || item.hsn || "251710",
      gst_rate: Number(item.gst_rate || igstRate || 5),
      quantity,
      rate,
      per: item.per || item.unit || "Brass",
      amount
    };
  });

  const igstAmount = taxableAmount * (Number(igstRate || 0) / 100);
  const totalBeforeRound = taxableAmount + igstAmount;
  const grandTotal = Math.round(totalBeforeRound);
  const roundUp = grandTotal - totalBeforeRound;

  return {
    items: calculatedItems,
    taxableAmount,
    igstRate: Number(igstRate || 0),
    igstAmount,
    roundUp,
    grandTotal,
    amountInWords: `${numberToWords(grandTotal)} Rupees Only`,
    taxAmountInWords: `${numberToWords(igstAmount)} Rupees only.`
  };
}

function validateInvoiceRequest(body) {
  const errors = [];

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push("At least one material item is required.");
  }

  if (Array.isArray(body.items) && body.items.length > 8) {
    errors.push("Maximum 8 material rows are allowed for one-page invoice.");
  }

  (body.items || []).forEach((item, index) => {
    if (!safeText(item.description).trim()) {
      errors.push(`Item ${index + 1}: description is required.`);
    }

    if (Number(item.quantity || item.qty) <= 0) {
      errors.push(`Item ${index + 1}: quantity must be greater than 0.`);
    }

    if (Number(item.rate) <= 0) {
      errors.push(`Item ${index + 1}: rate must be greater than 0.`);
    }
  });

  return errors;
}

/* =========================================================
   API 1: Next Invoice No
   GET /api/invoices/next-no
========================================================= */

router.get("/invoices/next-no", async (req, res) => {
  try {
    const invoiceDate = req.query.date ? new Date(req.query.date) : new Date();
    const financialYear = getFinancialYear(invoiceDate);

    const result = await db.query(
      "SELECT last_number FROM invoice_sequences WHERE financial_year = $1",
      [financialYear]
    );

    const nextNumber =
      result.rows.length > 0 ? Number(result.rows[0].last_number) + 1 : 1;

    res.json({
      success: true,
      financialYear,
      nextInvoiceNo: `${nextNumber}/${financialYear}`,
      nextNumber
    });
  } catch (error) {
    console.error("Next invoice no error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to get next invoice number"
    });
  }
});

/* =========================================================
   API 2: Create Invoice
   POST /api/invoices
========================================================= */

router.post("/invoices", async (req, res) => {
  const client = await db.connect();

  try {
    const body = req.body || {};
    const validationErrors = validateInvoiceRequest(body);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationErrors
      });
    }

    await client.query("BEGIN");

    const invoiceDate = body.invoice_date || new Date();
    const financialYear = getFinancialYear(new Date(invoiceDate));

    let invoiceNo = safeText(body.invoice_no).trim();

    if (!invoiceNo) {
      const seqResult = await client.query(
        "SELECT last_number FROM invoice_sequences WHERE financial_year = $1 FOR UPDATE",
        [financialYear]
      );

      let nextNumber = 1;

      if (seqResult.rows.length === 0) {
        await client.query(
          "INSERT INTO invoice_sequences (financial_year, last_number) VALUES ($1, $2)",
          [financialYear, 1]
        );
      } else {
        nextNumber = Number(seqResult.rows[0].last_number) + 1;

        await client.query(
          "UPDATE invoice_sequences SET last_number = $1, updated_at = CURRENT_TIMESTAMP WHERE financial_year = $2",
          [nextNumber, financialYear]
        );
      }

      invoiceNo = `${nextNumber}/${financialYear}`;
    }

    const calculation = calculateInvoice(body.items || [], body.igst_rate || 5);

    const invoiceResult = await client.query(
      `
      INSERT INTO invoices (
        invoice_no,
        invoice_date,

        supplier_name,
        supplier_address,
        supplier_gstin,
        supplier_state_name,
        supplier_state_code,

        consignee_name,
        consignee_state_name,
        consignee_state_code,

        buyer_name,
        buyer_gstin,
        buyer_state_name,
        buyer_state_code,
        buyer_address,

        bank_name,
        bank_account_no,
        bank_branch,
        bank_ifsc,

        taxable_amount,
        igst_rate,
        igst_amount,
        round_up,
        grand_total,
        amount_in_words,
        tax_amount_in_words
      )
      VALUES (
        $1,$2,
        $3,$4,$5,$6,$7,
        $8,$9,$10,
        $11,$12,$13,$14,$15,
        $16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26
      )
      RETURNING *
      `,
      [
        invoiceNo,
        invoiceDate,

        body.supplier_name || "ARVIND NAVNATH SHELKE",
        body.supplier_address ||
          "1 Adgaon Kh, Pimpli Lokai Shirdi, Tal:- Rahata Dist :- Ahmednagar",
        body.supplier_gstin || "27KNNVPS8477J1ZE",
        body.supplier_state_name || "Maharashtra",
        body.supplier_state_code || "27",

        body.consignee_name || "BIOSEL SOLAR PRIVATE LIMITED",
        body.consignee_state_name || "Gujrat",
        body.consignee_state_code || "24",

        body.buyer_name || "BIOSEL SOLAR PRIVATE LIMITED",
        body.buyer_gstin || "24AALCB1497J1ZE",
        body.buyer_state_name || "Gujrat",
        body.buyer_state_code || "24",
        body.buyer_address ||
          "BUNGLOWS NO.82, GULMAHOR-ENCLAV, 2, GULMAHOR GREEN AND GOLF COUNTRY, COUNTRY CLUB, Kolat, Ahmedabad, Gujarat,382210",

        body.bank_name || "STATE BANK OF INDIA",
        body.bank_account_no || "41116710845",
        body.bank_branch || "LONI BK",
        body.bank_ifsc || "SBIN0006322",

        calculation.taxableAmount,
        calculation.igstRate,
        calculation.igstAmount,
        calculation.roundUp,
        calculation.grandTotal,
        calculation.amountInWords,
        calculation.taxAmountInWords
      ]
    );

    const invoice = invoiceResult.rows[0];

    for (const item of calculation.items) {
      await client.query(
        `
        INSERT INTO invoice_items (
          invoice_id,
          sr_no,
          description,
          hsn_sac,
          gst_rate,
          quantity,
          rate,
          per,
          amount
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          invoice.id,
          item.sr_no,
          item.description,
          item.hsn_sac,
          item.gst_rate,
          item.quantity,
          item.rate,
          item.per,
          item.amount
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      invoice,
      items: calculation.items
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Create invoice error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Invoice number already exists. Please use another invoice number."
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to create invoice",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   API 3: Get All Invoices
   GET /api/invoices
========================================================= */

router.get("/invoices", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT *
      FROM invoices
      ORDER BY id DESC
      `
    );

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error("Get invoices error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch invoices"
    });
  }
});

/* =========================================================
   API 4: Get Single Invoice
   GET /api/invoices/:id
========================================================= */

router.get("/invoices/:id", async (req, res) => {
  try {
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [req.params.id]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found"
      });
    }

    const itemsResult = await db.query(
      "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sr_no ASC",
      [req.params.id]
    );

    res.json({
      success: true,
      invoice: invoiceResult.rows[0],
      items: itemsResult.rows
    });
  } catch (error) {
    console.error("Get invoice error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch invoice"
    });
  }
});

/* =========================================================
   API 5: Update Invoice
   PUT /api/invoices/:id
========================================================= */

router.put("/invoices/:id", async (req, res) => {
  const client = await db.connect();

  try {
    const body = req.body || {};
    const validationErrors = validateInvoiceRequest(body);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationErrors
      });
    }

    await client.query("BEGIN");

    const existingInvoice = await client.query(
      "SELECT * FROM invoices WHERE id = $1",
      [req.params.id]
    );

    if (existingInvoice.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Invoice not found"
      });
    }

    const calculation = calculateInvoice(body.items || [], body.igst_rate || 5);

    const invoiceResult = await client.query(
      `
      UPDATE invoices SET
        invoice_no = $1,
        invoice_date = $2,

        supplier_name = $3,
        supplier_address = $4,
        supplier_gstin = $5,
        supplier_state_name = $6,
        supplier_state_code = $7,

        consignee_name = $8,
        consignee_state_name = $9,
        consignee_state_code = $10,

        buyer_name = $11,
        buyer_gstin = $12,
        buyer_state_name = $13,
        buyer_state_code = $14,
        buyer_address = $15,

        bank_name = $16,
        bank_account_no = $17,
        bank_branch = $18,
        bank_ifsc = $19,

        taxable_amount = $20,
        igst_rate = $21,
        igst_amount = $22,
        round_up = $23,
        grand_total = $24,
        amount_in_words = $25,
        tax_amount_in_words = $26,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $27
      RETURNING *
      `,
      [
        body.invoice_no,
        body.invoice_date,

        body.supplier_name,
        body.supplier_address,
        body.supplier_gstin,
        body.supplier_state_name,
        body.supplier_state_code,

        body.consignee_name,
        body.consignee_state_name,
        body.consignee_state_code,

        body.buyer_name,
        body.buyer_gstin,
        body.buyer_state_name,
        body.buyer_state_code,
        body.buyer_address,

        body.bank_name,
        body.bank_account_no,
        body.bank_branch,
        body.bank_ifsc,

        calculation.taxableAmount,
        calculation.igstRate,
        calculation.igstAmount,
        calculation.roundUp,
        calculation.grandTotal,
        calculation.amountInWords,
        calculation.taxAmountInWords,

        req.params.id
      ]
    );

    await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [
      req.params.id
    ]);

    for (const item of calculation.items) {
      await client.query(
        `
        INSERT INTO invoice_items (
          invoice_id,
          sr_no,
          description,
          hsn_sac,
          gst_rate,
          quantity,
          rate,
          per,
          amount
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          req.params.id,
          item.sr_no,
          item.description,
          item.hsn_sac,
          item.gst_rate,
          item.quantity,
          item.rate,
          item.per,
          item.amount
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Invoice updated successfully",
      invoice: invoiceResult.rows[0],
      items: calculation.items
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Update invoice error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Invoice number already exists. Please use another invoice number."
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update invoice",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   API 6: Delete Invoice
   DELETE /api/invoices/:id
========================================================= */

router.delete("/invoices/:id", async (req, res) => {
  try {
    const result = await db.query(
      "DELETE FROM invoices WHERE id = $1 RETURNING *",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found"
      });
    }

    res.json({
      success: true,
      message: "Invoice deleted successfully"
    });
  } catch (error) {
    console.error("Delete invoice error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete invoice"
    });
  }
});

module.exports = router;