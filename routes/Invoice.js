const express = require("express");
const PDFDocument = require("pdfkit");
const db = require("../db");

const router = express.Router();

/* =========================================================
   GST TAX INVOICE API
   - A4 professional invoice PDF
   - Clean borders, no double lines
   - Text clipped inside cells
   - Auto/manual invoice no
   - Current/manual date
   - PostgreSQL save + PDF download
========================================================= */

/* -------------------- Helpers -------------------- */

function getFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  if (month >= 4) {
    return `${year}-${String(year + 1).slice(-2)}`;
  }

  return `${year - 1}-${String(year).slice(-2)}`;
}

function formatDate(dateValue) {
  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) return "";

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();

  return `${dd}.${mm}.${yyyy}`;
}

function safeText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function fixed2(value) {
  return Number(value || 0).toFixed(2);
}

function numberToWords(num) {
  num = Math.round(Number(num || 0));

  if (num === 0) return "Zero";

  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];

  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  function convertBelowHundred(n) {
    if (n < 20) return ones[n];
    return `${tens[Math.floor(n / 10)]} ${ones[n % 10]}`.trim();
  }

  function convertBelowThousand(n) {
    let str = "";

    if (n >= 100) {
      str += `${ones[Math.floor(n / 100)]} Hundred `;
      n %= 100;
    }

    if (n > 0) {
      str += convertBelowHundred(n);
    }

    return str.trim();
  }

  let words = "";

  const crore = Math.floor(num / 10000000);
  num %= 10000000;

  const lakh = Math.floor(num / 100000);
  num %= 100000;

  const thousand = Math.floor(num / 1000);
  num %= 1000;

  if (crore) words += `${convertBelowThousand(crore)} Crore `;
  if (lakh) words += `${convertBelowThousand(lakh)} Lakh `;
  if (thousand) words += `${convertBelowThousand(thousand)} Thousand `;
  if (num) words += `${convertBelowThousand(num)} `;

  return words.trim();
}

function calculateInvoice(items, igstRate = 5) {
  let taxableAmount = 0;

  const cleanItems = Array.isArray(items) ? items : [];

  const calculatedItems = cleanItems.map((item, index) => {
    const quantity = Number(item.quantity || 0);
    const rate = Number(item.rate || 0);
    const amount = quantity * rate;

    taxableAmount += amount;

    return {
      sr_no: item.sr_no || index + 1,
      description: item.description || "",
      hsn_sac: item.hsn_sac || "251710",
      gst_rate: Number(item.gst_rate || igstRate || 5),
      quantity,
      rate,
      per: item.per || "Brass",
      amount,
    };
  });

  const igstAmount = taxableAmount * (Number(igstRate || 0) / 100);
  const grandTotalBeforeRound = taxableAmount + igstAmount;
  const grandTotal = Math.round(grandTotalBeforeRound);
  const roundUp = grandTotal - grandTotalBeforeRound;

  return {
    items: calculatedItems,
    taxableAmount,
    igstRate: Number(igstRate || 0),
    igstAmount,
    roundUp,
    grandTotal,
    amountInWords: `${numberToWords(grandTotal)} Rupees Only`,
    taxAmountInWords: `${numberToWords(igstAmount)} Rupees only.`,
  };
}

function validateInvoiceRequest(body) {
  const errors = [];

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push("At least one material item is required.");
  }

  if (Array.isArray(body.items) && body.items.length > 8) {
    errors.push(
      "Maximum 8 material rows are allowed for one-page A4 invoice format."
    );
  }

  (body.items || []).forEach((item, index) => {
    if (!safeText(item.description).trim()) {
      errors.push(`Item ${index + 1}: description is required.`);
    }

    if (Number(item.quantity) <= 0 || Number.isNaN(Number(item.quantity))) {
      errors.push(`Item ${index + 1}: quantity must be greater than 0.`);
    }

    if (Number(item.rate) <= 0 || Number.isNaN(Number(item.rate))) {
      errors.push(`Item ${index + 1}: rate must be greater than 0.`);
    }
  });

  return errors;
}

/* -------------------- PDF Drawing Helpers -------------------- */

function drawBox(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

function drawLine(doc, x1, y1, x2, y2) {
  doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
}

function drawTextBox(doc, text, x, y, w, h, options = {}) {
  const padding = options.padding ?? 3;
  const size = options.size || 8;
  const font = options.bold ? "Helvetica-Bold" : "Helvetica";
  const align = options.align || "left";

  let tx = x + padding;
  let ty = y + padding;
  const tw = Math.max(1, w - padding * 2);
  const th = Math.max(1, h - padding * 2);

  if (options.valign === "middle") {
    ty = y + h / 2 - size / 1.6;
  }

  if (options.valign === "bottom") {
    ty = y + h - padding - size - 1;
  }

  doc.save();

  // Clip text inside border/cell area
  doc.rect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1)).clip();

  doc.font(font).fontSize(size);
  doc.text(safeText(text), tx, ty, {
    width: tw,
    height: th,
    align,
    lineGap: options.lineGap ?? 0.5,
    ellipsis: options.ellipsis ?? true,
  });

  doc.restore();
}

function drawGrid(doc, x, y, widths, rowHeights) {
  const totalW = widths.reduce((sum, w) => sum + w, 0);
  const totalH = rowHeights.reduce((sum, h) => sum + h, 0);

  drawBox(doc, x, y, totalW, totalH);

  let cx = x;
  for (let i = 0; i < widths.length - 1; i++) {
    cx += widths[i];
    drawLine(doc, cx, y, cx, y + totalH);
  }

  let cy = y;
  for (let i = 0; i < rowHeights.length - 1; i++) {
    cy += rowHeights[i];
    drawLine(doc, x, cy, x + totalW, cy);
  }
}

/* -------------------- PDF Generator -------------------- */

function generateInvoicePDF(invoice, items, res) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    bufferPages: false,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=invoice-${safeText(invoice.invoice_no).replace(
      /\//g,
      "-"
    )}.pdf`
  );

  doc.pipe(res);

  const pageW = doc.page.width;
  const pageH = doc.page.height;

  const left = 14;
  const top = 14;
  const width = pageW - 28;
  const right = left + width;
  const bottom = pageH - 14;

  doc.lineWidth(0.65);
  doc.strokeColor("#000000");
  doc.fillColor("#000000");

  // Outer border
  drawBox(doc, left, top, width, bottom - top);

  let y = top;

  /* ---------- Title ---------- */
  const titleH = 22;
  drawLine(doc, left, y + titleH, right, y + titleH);

  drawTextBox(doc, "TAX INVOICE", left, y, width, titleH, {
    align: "center",
    bold: true,
    size: 11,
    valign: "middle",
  });

  y += titleH;

  /* ---------- Supplier + Invoice Info ---------- */
  const leftW = 320;
  const rightW = width - leftW;
  const rx = left + leftW;
  const topBlockH = 116;
  const halfRight = rightW / 2;

  drawBox(doc, left, y, width, topBlockH);
  drawLine(doc, rx, y, rx, y + topBlockH);
  drawLine(doc, rx + halfRight, y, rx + halfRight, y + topBlockH);

  let sy = y;
  [29, 29, 29].forEach((h) => {
    sy += h;
    drawLine(doc, rx, sy, right, sy);
  });

  drawTextBox(doc, invoice.supplier_name, left + 3, y + 3, leftW - 6, 14, {
    bold: true,
    size: 8,
  });

  drawTextBox(doc, invoice.supplier_address, left + 3, y + 18, leftW - 6, 24, {
    size: 8,
  });

  drawTextBox(
    doc,
    `GSTIN/UIN :- ${invoice.supplier_gstin}`,
    left + 3,
    y + 45,
    leftW - 6,
    13,
    { size: 8 }
  );

  drawTextBox(
    doc,
    `State Name : ${invoice.supplier_state_name}, Code : ${invoice.supplier_state_code}`,
    left + 3,
    y + 60,
    leftW - 6,
    13,
    { size: 8 }
  );

  drawTextBox(doc, "Email :", left + 3, y + 75, leftW - 6, 13, {
    size: 8,
  });

  drawTextBox(
    doc,
    `Invoice No . ${invoice.invoice_no}`,
    rx + 3,
    y,
    halfRight - 6,
    29,
    {
      size: 8,
      bold: true,
      valign: "middle",
    }
  );

  drawTextBox(
    doc,
    `Dated:- ${formatDate(invoice.invoice_date)}`,
    rx + halfRight + 3,
    y,
    halfRight - 6,
    29,
    {
      size: 8,
      bold: true,
      valign: "middle",
    }
  );

  drawTextBox(doc, "Delivery Note", rx + 3, y + 29, halfRight - 6, 29, {
    size: 8,
    valign: "middle",
  });

  drawTextBox(
    doc,
    "Delivery Note Date",
    rx + halfRight + 3,
    y + 29,
    halfRight - 6,
    29,
    {
      size: 8,
      valign: "middle",
    }
  );

  drawTextBox(doc, "Suppliers Ref.", rx + 3, y + 58, halfRight - 6, 29, {
    size: 8,
    valign: "middle",
  });

  drawTextBox(
    doc,
    "Other Reference (s)",
    rx + halfRight + 3,
    y + 58,
    halfRight - 6,
    29,
    {
      size: 8,
      valign: "middle",
    }
  );

  y += topBlockH;

  /* ---------- Consignee + Buyer + Dispatch ---------- */
  const midBlockH = 118;
  drawBox(doc, left, y, width, midBlockH);
  drawLine(doc, rx, y, rx, y + midBlockH);

  drawTextBox(doc, "Consignee", left + 3, y + 2, leftW - 6, 13, {
    size: 8,
  });

  drawTextBox(doc, invoice.consignee_name, left + 3, y + 16, leftW - 6, 13, {
    bold: true,
    size: 8,
  });

  drawTextBox(
    doc,
    `State Name : ${invoice.consignee_state_name}, Code : ${invoice.consignee_state_code}`,
    left + 3,
    y + 31,
    leftW - 6,
    13,
    { size: 8 }
  );

  drawTextBox(
    doc,
    "Buyer ( if other than consignee)",
    left + 3,
    y + 50,
    leftW - 6,
    13,
    { size: 8 }
  );

  drawTextBox(doc, invoice.buyer_name, left + 3, y + 65, leftW - 6, 13, {
    bold: true,
    size: 8,
  });

  drawTextBox(
    doc,
    `GSTIN/UIN : ${invoice.buyer_gstin}`,
    left + 3,
    y + 79,
    leftW - 6,
    12,
    { size: 8 }
  );

  drawTextBox(
    doc,
    `State Name : ${invoice.buyer_state_name}, Code : ${invoice.buyer_state_code}`,
    left + 3,
    y + 92,
    leftW - 6,
    12,
    { size: 8 }
  );

  drawTextBox(doc, invoice.buyer_address, left + 3, y + 104, leftW - 6, 13, {
    size: 6.8,
  });

  const midHalfH = midBlockH / 2;
  drawLine(doc, rx, y + midHalfH, right, y + midHalfH);
  drawLine(doc, rx + rightW / 2, y + midHalfH, rx + rightW / 2, y + midBlockH);

  drawTextBox(doc, "Despatch Document No.", rx + 3, y + 4, rightW - 6, 20, {
    size: 8,
  });

  drawTextBox(
    doc,
    "Despatch Through",
    rx + 3,
    y + midHalfH + 4,
    rightW / 2 - 6,
    20,
    { size: 8 }
  );

  drawTextBox(
    doc,
    "Destination",
    rx + rightW / 2 + 3,
    y + midHalfH + 4,
    rightW / 2 - 6,
    20,
    { size: 8 }
  );

  y += midBlockH;

  /* ---------- Material Table ---------- */
  const pdfItems = Array.isArray(items) ? items.slice(0, 8) : [];
  const materialRows = Math.max(4, pdfItems.length);
  const headerH = 28;
  const itemRowH = pdfItems.length > 6 ? 17 : 20;

  const cols = [
    { title: "Sr.\nNo", w: 28 },
    { title: "Description of Goods", w: 214 },
    { title: "HSN/SAC", w: 54 },
    { title: "GST\nRate", w: 45 },
    { title: "Quantity", w: 62 },
    { title: "Rate", w: 52 },
    { title: "Per", w: 42 },
    { title: "Amount", w: width - 497 },
  ];

  drawGrid(
    doc,
    left,
    y,
    cols.map((c) => c.w),
    [headerH, ...Array(materialRows).fill(itemRowH)]
  );

  let cx = left;

  cols.forEach((col) => {
    drawTextBox(doc, col.title, cx, y, col.w, headerH, {
      align: "center",
      bold: true,
      size: 7.4,
      valign: "middle",
    });
    cx += col.w;
  });

  let rowY = y + headerH;

  for (let i = 0; i < materialRows; i++) {
    const item = pdfItems[i];

    const values = item
      ? [
          item.sr_no || i + 1,
          item.description,
          item.hsn_sac,
          `${Number(item.gst_rate || invoice.igst_rate || 0).toFixed(0)}%`,
          Number(item.quantity || 0).toFixed(2),
          Number(item.rate || 0).toFixed(0),
          item.per,
          fixed2(item.amount),
        ]
      : ["", "", "", "", "", "", "", ""];

    cx = left;

    values.forEach((value, colIndex) => {
      let align = "right";

      if (colIndex === 1) align = "left";
      if (colIndex === 2 || colIndex === 3 || colIndex === 6) align = "center";

      drawTextBox(doc, value, cx, rowY, cols[colIndex].w, itemRowH, {
        size: pdfItems.length > 6 ? 6.9 : 7.5,
        align,
        valign: "middle",
      });

      cx += cols[colIndex].w;
    });

    rowY += itemRowH;
  }

  y += headerH + materialRows * itemRowH;

  /* ---------- Total Rows ---------- */
  const amountW = 112;
  const labelW = width - amountW;

  drawGrid(doc, left, y, [labelW, amountW], [20, 20, 20, 22]);

  let ty = y;

  drawTextBox(doc, "", left, ty, labelW, 20, { size: 8 });
  drawTextBox(doc, fixed2(invoice.taxable_amount), left + labelW, ty, amountW, 20, {
    size: 8,
    bold: true,
    align: "right",
    valign: "middle",
  });

  ty += 20;

  drawTextBox(
    doc,
    `OUTPUT IGST -@ ${Number(invoice.igst_rate || 0).toFixed(0)}%`,
    left,
    ty,
    labelW,
    20,
    {
      size: 8,
      bold: true,
      align: "right",
      valign: "middle",
    }
  );

  drawTextBox(doc, fixed2(invoice.igst_amount), left + labelW, ty, amountW, 20, {
    size: 8,
    align: "right",
    valign: "middle",
  });

  ty += 20;

  drawTextBox(doc, "Round Up", left, ty, labelW, 20, {
    size: 8,
    align: "right",
    valign: "middle",
  });

  drawTextBox(doc, fixed2(invoice.round_up), left + labelW, ty, amountW, 20, {
    size: 8,
    align: "right",
    valign: "middle",
  });

  ty += 20;

  drawTextBox(doc, "Total", left, ty, labelW, 22, {
    size: 8,
    bold: true,
    align: "right",
    valign: "middle",
  });

  drawTextBox(doc, fixed2(invoice.grand_total), left + labelW, ty, amountW, 22, {
    size: 8,
    bold: true,
    align: "right",
    valign: "middle",
  });

  y += 82;

  /* ---------- Amount In Words ---------- */
  const amountWordsH = 40;
  drawBox(doc, left, y, width, amountWordsH);

  drawTextBox(doc, "Amount Chargeable ( in words )", left + 2, y + 2, width - 70, 14, {
    size: 8,
  });

  drawTextBox(doc, "E. & O.E", right - 62, y + 2, 58, 14, {
    size: 8,
    align: "right",
  });

  drawTextBox(doc, invoice.amount_in_words, left + 2, y + 20, width - 4, 16, {
    size: 8.6,
    bold: true,
  });

  y += amountWordsH;

  /* ---------- Tax Summary Table ---------- */
  const taxHeaderH = 24;
  const taxRowH = 19;

  const taxCols = [
    { title: "HSN/SAC", w: 260 },
    { title: "Taxable\nValue", w: 88 },
    { title: "IGST\nRate", w: 66 },
    { title: "Amount", w: 70 },
    { title: "Total Tax\nAmount", w: width - 484 },
  ];

  drawGrid(
    doc,
    left,
    y,
    taxCols.map((c) => c.w),
    [taxHeaderH, taxRowH, taxRowH]
  );

  cx = left;

  taxCols.forEach((col) => {
    drawTextBox(doc, col.title, cx, y, col.w, taxHeaderH, {
      size: 7.2,
      bold: true,
      align: "center",
      valign: "middle",
    });
    cx += col.w;
  });

  const taxValueRow = [
    "2517",
    fixed2(invoice.taxable_amount),
    `${Number(invoice.igst_rate || 0).toFixed(2)}%`,
    Number(invoice.igst_amount || 0).toFixed(0),
    fixed2(invoice.igst_amount),
  ];

  cx = left;

  taxValueRow.forEach((value, index) => {
    drawTextBox(doc, value, cx, y + taxHeaderH, taxCols[index].w, taxRowH, {
      size: 7.5,
      align: index === 0 ? "left" : "right",
      valign: "middle",
    });

    cx += taxCols[index].w;
  });

  const taxTotalRow = [
    "Total",
    fixed2(invoice.taxable_amount),
    "",
    Number(invoice.igst_amount || 0).toFixed(0),
    fixed2(invoice.igst_amount),
  ];

  cx = left;

  taxTotalRow.forEach((value, index) => {
    drawTextBox(
      doc,
      value,
      cx,
      y + taxHeaderH + taxRowH,
      taxCols[index].w,
      taxRowH,
      {
        size: 7.5,
        bold: index === 0 || index === 4,
        align: index === 0 ? "left" : "right",
        valign: "middle",
      }
    );

    cx += taxCols[index].w;
  });

  y += taxHeaderH + taxRowH + taxRowH;

  /* ---------- Tax Amount In Words ---------- */
  const taxWordsH = 27;
  drawBox(doc, left, y, width, taxWordsH);

  drawTextBox(
    doc,
    `Tax Amount ( In Words ): ${invoice.tax_amount_in_words}`,
    left + 2,
    y + 3,
    width - 4,
    taxWordsH - 6,
    {
      size: 8,
      valign: "middle",
    }
  );

  y += taxWordsH;

  /* ---------- Declaration + Bank Details ---------- */
  const bankH = 74;
  const bottomLeftW = 315;
  const bottomRightW = width - bottomLeftW;

  drawBox(doc, left, y, width, bankH);
  drawLine(doc, left + bottomLeftW, y, left + bottomLeftW, y + bankH);

  drawTextBox(doc, "Declararation", left + 2, y + 2, bottomLeftW - 4, 13, {
    size: 8,
    bold: true,
  });

  drawTextBox(
    doc,
    "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct",
    left + 2,
    y + 17,
    bottomLeftW - 4,
    42,
    {
      size: 7.6,
      lineGap: 1,
    }
  );

  drawTextBox(
    doc,
    "Company Bank Details",
    left + bottomLeftW + 2,
    y + 2,
    bottomRightW - 4,
    13,
    {
      size: 8,
      bold: true,
    }
  );

  drawTextBox(
    doc,
    `Bank Name : ${invoice.bank_name}`,
    left + bottomLeftW + 2,
    y + 17,
    bottomRightW - 4,
    12,
    { size: 7.8 }
  );

  drawTextBox(
    doc,
    `A/c No : ${invoice.bank_account_no}`,
    left + bottomLeftW + 2,
    y + 31,
    bottomRightW - 4,
    12,
    { size: 7.8 }
  );

  drawTextBox(
    doc,
    `Branch : ${invoice.bank_branch}`,
    left + bottomLeftW + 2,
    y + 45,
    bottomRightW - 4,
    12,
    { size: 7.8 }
  );

  drawTextBox(
    doc,
    `IFSC CODE : ${invoice.bank_ifsc}`,
    left + bottomLeftW + 2,
    y + 59,
    bottomRightW - 4,
    12,
    { size: 7.8 }
  );

  y += bankH;

  /* ---------- Final Seal + Signature Section ---------- */
  const signH = bottom - y;
  const signLeftW = 315;
  const signRightW = width - signLeftW;

  drawBox(doc, left, y, width, signH);
  drawLine(doc, left + signLeftW, y, left + signLeftW, y + signH);

  drawTextBox(doc, "Customer Seal And Signature", left + 2, y + 3, signLeftW - 4, 14, {
    size: 8,
  });

  drawTextBox(
    doc,
    "ARVIND NAVNATH SHELKE",
    left + signLeftW + 2,
    y + 3,
    signRightW - 4,
    16,
    {
      size: 8,
      bold: true,
      align: "center",
    }
  );

  drawTextBox(
    doc,
    "Authorised Signature",
    left + signLeftW + 2,
    y + signH - 18,
    signRightW - 4,
    14,
    {
      size: 8,
      bold: true,
      align: "center",
    }
  );

  doc.end();
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
      nextNumber,
    });
  } catch (error) {
    console.error("Next invoice no error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to get next invoice number",
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
        errors: validationErrors,
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
        body.supplier_gstin || "27KNWPS8477J1ZE",
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
          "BUNGLOWS NO.82, GULMAHOR-ENCLAV, 2, GULMAHOR GREEN AND GOLF COUNTRY, COUNTRY CLUB, Kolat, Ahmedabad, Gurjarat,382210",

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
        calculation.taxAmountInWords,
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
          item.amount,
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      invoice,
      items: calculation.items,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Create invoice error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Invoice number already exists. Please use another invoice number.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to create invoice",
      error: error.message,
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
      data: result.rows,
    });
  } catch (error) {
    console.error("Get invoices error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch invoices",
    });
  }
});

/* =========================================================
   API 4: Get Single Invoice With Items
   GET /api/invoices/:id
========================================================= */

router.get("/invoices/:id", async (req, res) => {
  try {
    const invoiceResult = await db.query("SELECT * FROM invoices WHERE id = $1", [
      req.params.id,
    ]);

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const itemsResult = await db.query(
      "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sr_no ASC",
      [req.params.id]
    );

    res.json({
      success: true,
      invoice: invoiceResult.rows[0],
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error("Get invoice error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch invoice",
    });
  }
});

/* =========================================================
   API 5: Download Saved Invoice PDF
   GET /api/invoices/:id/pdf
========================================================= */

router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const invoiceResult = await db.query("SELECT * FROM invoices WHERE id = $1", [
      req.params.id,
    ]);

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const itemsResult = await db.query(
      "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sr_no ASC",
      [req.params.id]
    );

    generateInvoicePDF(invoiceResult.rows[0], itemsResult.rows, res);
  } catch (error) {
    console.error("PDF download error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to generate PDF",
    });
  }
});

/* =========================================================
   API 6: Preview PDF Without Saving
   POST /api/invoices/pdf-preview
========================================================= */

router.post("/invoices/pdf-preview", async (req, res) => {
  try {
    const body = req.body || {};
    const validationErrors = validateInvoiceRequest(body);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationErrors,
      });
    }

    const calculation = calculateInvoice(body.items || [], body.igst_rate || 5);

    const invoice = {
      invoice_no: body.invoice_no || "PREVIEW",
      invoice_date: body.invoice_date || new Date(),

      supplier_name: body.supplier_name || "ARVIND NAVNATH SHELKE",
      supplier_address:
        body.supplier_address ||
        "1 Adgaon Kh, Pimpli Lokai Shirdi, Tal:- Rahata Dist :- Ahmednagar",
      supplier_gstin: body.supplier_gstin || "27KNWPS8477J1ZE",
      supplier_state_name: body.supplier_state_name || "Maharashtra",
      supplier_state_code: body.supplier_state_code || "27",

      consignee_name: body.consignee_name || "BIOSEL SOLAR PRIVATE LIMITED",
      consignee_state_name: body.consignee_state_name || "Gujrat",
      consignee_state_code: body.consignee_state_code || "24",

      buyer_name: body.buyer_name || "BIOSEL SOLAR PRIVATE LIMITED",
      buyer_gstin: body.buyer_gstin || "24AALCB1497J1ZE",
      buyer_state_name: body.buyer_state_name || "Gujrat",
      buyer_state_code: body.buyer_state_code || "24",
      buyer_address:
        body.buyer_address ||
        "BUNGLOWS NO.82, GULMAHOR-ENCLAV, 2, GULMAHOR GREEN AND GOLF COUNTRY, COUNTRY CLUB, Kolat, Ahmedabad, Gurjarat,382210",

      bank_name: body.bank_name || "STATE BANK OF INDIA",
      bank_account_no: body.bank_account_no || "41116710845",
      bank_branch: body.bank_branch || "LONI BK",
      bank_ifsc: body.bank_ifsc || "SBIN0006322",

      taxable_amount: calculation.taxableAmount,
      igst_rate: calculation.igstRate,
      igst_amount: calculation.igstAmount,
      round_up: calculation.roundUp,
      grand_total: calculation.grandTotal,
      amount_in_words: calculation.amountInWords,
      tax_amount_in_words: calculation.taxAmountInWords,
    };

    generateInvoicePDF(invoice, calculation.items, res);
  } catch (error) {
    console.error("PDF preview error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to generate preview PDF",
    });
  }
});

router.put("/invoices/:id", async (req, res) => {
  const client = await db.connect();

  try {
    const body = req.body || {};
    const validationErrors = validateInvoiceRequest(body);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validationErrors,
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
        message: "Invoice not found",
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

        req.params.id,
      ]
    );

    await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [
      req.params.id,
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
          item.amount,
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Invoice updated successfully",
      invoice: invoiceResult.rows[0],
      items: calculation.items,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Update invoice error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Invoice number already exists. Please use another invoice number.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update invoice",
      error: error.message,
    });
  } finally {
    client.release();
  }
}); 

/* =========================================================
   API 7: Delete Invoice
   DELETE /api/invoices/:id
========================================================= */

router.delete("/invoices/:id", async (req, res) => {
  try {
    const result = await db.query("DELETE FROM invoices WHERE id = $1 RETURNING *", [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    res.json({
      success: true,
      message: "Invoice deleted successfully",
    });
  } catch (error) {
    console.error("Delete invoice error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete invoice",
    });
  }
});

module.exports = router;