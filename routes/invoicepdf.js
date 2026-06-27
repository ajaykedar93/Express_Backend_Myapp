const express = require("express");
const PDFDocument = require("pdfkit");
const db = require("../db");

const router = express.Router();

/* ================= HELPERS ================= */

function safeText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function num(value) {
  const n = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fixed2(value) {
  return num(value).toFixed(2);
}

function rateText(value) {
  return fixed2(value).replace(/\.00$/, "").replace(/0$/, "");
}

function formatDate(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "";

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();

  return `${dd}.${mm}.${yyyy}`;
}

function cleanStateCode(value, fallback = "") {
  return safeText(value || fallback).trim();
}

function isSameState(supplierStateCode, buyerStateCode) {
  const supplier = cleanStateCode(supplierStateCode);
  const buyer = cleanStateCode(buyerStateCode);
  return Boolean(supplier && buyer && supplier === buyer);
}

function numberToWords(value) {
  let n = Math.round(num(value));
  if (n === 0) return "Zero";

  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];

  const tens = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
  ];

  function belowHundred(x) {
    if (x < 20) return ones[x];
    return `${tens[Math.floor(x / 10)]} ${ones[x % 10]}`.trim();
  }

  function belowThousand(x) {
    let str = "";
    if (x >= 100) {
      str += `${ones[Math.floor(x / 100)]} Hundred `;
      x %= 100;
    }
    if (x > 0) str += belowHundred(x);
    return str.trim();
  }

  let words = "";

  const crore = Math.floor(n / 10000000);
  n %= 10000000;

  const lakh = Math.floor(n / 100000);
  n %= 100000;

  const thousand = Math.floor(n / 1000);
  n %= 1000;

  if (crore) words += `${belowThousand(crore)} Crore `;
  if (lakh) words += `${belowThousand(lakh)} Lakh `;
  if (thousand) words += `${belowThousand(thousand)} Thousand `;
  if (n) words += `${belowThousand(n)} `;

  return words.trim();
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

    if (num(item.quantity || item.qty) <= 0) {
      errors.push(`Item ${index + 1}: quantity must be greater than 0.`);
    }

    if (num(item.rate) <= 0) {
      errors.push(`Item ${index + 1}: rate must be greater than 0.`);
    }
  });

  return errors;
}

function calculateInvoice(items, gstRate = 5, supplierStateCode = "27", buyerStateCode = "27") {
  let taxableAmount = 0;
  const totalGstRate = num(gstRate || 5);
  const sameState = isSameState(supplierStateCode, buyerStateCode);

  const calculatedItems = (Array.isArray(items) ? items : []).map((item, index) => {
    const quantity = num(item.quantity || item.qty);
    const rate = num(item.rate);
    const amount = quantity * rate;

    taxableAmount += amount;

    return {
      sr_no: item.sr_no || index + 1,
      description: item.description || "",
      hsn_sac: item.hsn_sac || item.hsn || "251710",
      gst_rate: num(item.gst_rate || totalGstRate || 5),
      quantity,
      rate,
      per: item.per || item.unit || "Brass",
      amount,
    };
  });

  const totalTaxAmount = taxableAmount * (totalGstRate / 100);
  const cgstRate = sameState ? totalGstRate / 2 : 0;
  const sgstRate = sameState ? totalGstRate / 2 : 0;
  const igstRate = sameState ? 0 : totalGstRate;

  const cgstAmount = sameState ? totalTaxAmount / 2 : 0;
  const sgstAmount = sameState ? totalTaxAmount / 2 : 0;
  const igstAmount = sameState ? 0 : totalTaxAmount;

  const beforeRoundTotal = taxableAmount + totalTaxAmount;
  const grandTotal = Math.round(beforeRoundTotal);
  const roundUp = grandTotal - beforeRoundTotal;

  return {
    items: calculatedItems,
    taxableAmount,
    gstRate: totalGstRate,
    sameState,
    cgstRate,
    sgstRate,
    igstRate,
    cgstAmount,
    sgstAmount,
    igstAmount,
    totalTaxAmount,
    roundUp,
    grandTotal,
    amountInWords: `${numberToWords(grandTotal)} Rupees Only`,
    taxAmountInWords: `${numberToWords(totalTaxAmount)} Rupees only.`,
  };
}

function getTaxBreakup(invoice, items = []) {
  const supplierStateCode = cleanStateCode(invoice.supplier_state_code, "27");
  const buyerStateCode = cleanStateCode(
    invoice.buyer_state_code || invoice.consignee_state_code,
    supplierStateCode
  );

  const sameState = isSameState(supplierStateCode, buyerStateCode);

  const itemsTotal = (items || []).reduce((sum, item) => sum + num(item.amount), 0);
  const taxableAmount = num(invoice.taxable_amount || itemsTotal);

  // Your existing DB stores total GST rate in igst_rate for both cases.
  const totalGstRate = num(invoice.gst_rate || invoice.igst_rate || 5);

  // Your existing DB stores total GST amount in igst_amount for both cases.
  const totalTaxAmount = num(
    invoice.total_tax_amount || invoice.igst_amount || taxableAmount * (totalGstRate / 100)
  );

  const cgstRate = sameState ? totalGstRate / 2 : 0;
  const sgstRate = sameState ? totalGstRate / 2 : 0;
  const igstRate = sameState ? 0 : totalGstRate;

  const cgstAmount = sameState ? totalTaxAmount / 2 : 0;
  const sgstAmount = sameState ? totalTaxAmount / 2 : 0;
  const igstAmount = sameState ? 0 : totalTaxAmount;

  const beforeRoundTotal = taxableAmount + totalTaxAmount;
  const grandTotal = num(invoice.grand_total || Math.round(beforeRoundTotal));
  const roundUp = invoice.round_up === null || invoice.round_up === undefined
    ? grandTotal - beforeRoundTotal
    : num(invoice.round_up);

  return {
    sameState,
    taxableAmount,
    totalGstRate,
    totalTaxAmount,
    cgstRate,
    sgstRate,
    igstRate,
    cgstAmount,
    sgstAmount,
    igstAmount,
    grandTotal,
    roundUp,
  };
}

/* ================= DRAW HELPERS ================= */

function cell(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

function line(doc, x1, y1, x2, y2) {
  doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
}

function write(doc, value, x, y, options = {}) {
  doc.text(safeText(value), x, y, options);
}

function drawSameStateTaxTable(doc, taxY, taxH, firstItem, tax) {
  cell(doc, 12, taxY, 571, taxH);

  line(doc, 280, taxY, 280, taxY + taxH);
  line(doc, 335, taxY, 335, taxY + taxH);
  line(doc, 375, taxY + 25, 375, taxY + taxH);
  line(doc, 418, taxY, 418, taxY + taxH);
  line(doc, 460, taxY + 25, 460, taxY + taxH);
  line(doc, 500, taxY, 500, taxY + taxH);

  line(doc, 335, taxY + 25, 500, taxY + 25);
  line(doc, 12, taxY + 42, 583, taxY + 42);
  line(doc, 12, taxY + 56, 583, taxY + 56);

  doc.font("Helvetica").fontSize(8);
  write(doc, "HSN/SAC", 120, taxY + 18);
  write(doc, "Taxable", 293, taxY + 7);
  write(doc, "Value", 300, taxY + 23);
  write(doc, "CGST", 365, taxY + 8);
  write(doc, "SGST", 448, taxY + 8);
  write(doc, "Rate", 342, taxY + 29);
  write(doc, "Amount", 381, taxY + 29);
  write(doc, "Rate", 426, taxY + 29);
  write(doc, "Amount", 465, taxY + 29);
  write(doc, "Total Tax Amount", 505, taxY + 25);

  const hsn4 = safeText(firstItem.hsn_sac || "251710").slice(0, 4);

  doc.font("Helvetica").fontSize(9);
  write(doc, hsn4, 16, taxY + 45);
  write(doc, fixed2(tax.taxableAmount), 292, taxY + 45);
  write(doc, `${fixed2(tax.cgstRate)}%`, 339, taxY + 45);
  write(doc, fixed2(tax.cgstAmount), 381, taxY + 45);
  write(doc, `${fixed2(tax.sgstRate)}%`, 421, taxY + 45);
  write(doc, fixed2(tax.sgstAmount), 463, taxY + 45);

  doc.font("Helvetica-Bold");
  write(doc, fixed2(tax.totalTaxAmount), 543, taxY + 45);
  write(doc, "Total", 16, taxY + 59);

  doc.font("Helvetica");
  write(doc, fixed2(tax.taxableAmount), 292, taxY + 59);
  write(doc, fixed2(tax.cgstAmount), 381, taxY + 59);
  write(doc, fixed2(tax.sgstAmount), 463, taxY + 59);

  doc.font("Helvetica-Bold");
  write(doc, fixed2(tax.totalTaxAmount), 543, taxY + 59);
}

function drawIgstTaxTable(doc, taxY, taxH, firstItem, tax) {
  cell(doc, 12, taxY, 571, taxH);

  line(doc, 280, taxY, 280, taxY + taxH);
  line(doc, 335, taxY, 335, taxY + taxH);
  line(doc, 418, taxY, 418, taxY + taxH);
  line(doc, 500, taxY, 500, taxY + taxH);

  line(doc, 335, taxY + 25, 500, taxY + 25);
  line(doc, 12, taxY + 42, 583, taxY + 42);
  line(doc, 12, taxY + 56, 583, taxY + 56);

  doc.font("Helvetica").fontSize(8);
  write(doc, "HSN/SAC", 120, taxY + 18);
  write(doc, "Taxable", 293, taxY + 7);
  write(doc, "Value", 300, taxY + 23);
  write(doc, "IGST", 404, taxY + 8);
  write(doc, "Rate", 342, taxY + 29);
  write(doc, "Amount", 440, taxY + 29);
  write(doc, "Total Tax Amount", 505, taxY + 25);

  const hsn4 = safeText(firstItem.hsn_sac || "251710").slice(0, 4);

  doc.font("Helvetica").fontSize(9);
  write(doc, hsn4, 16, taxY + 45);
  write(doc, fixed2(tax.taxableAmount), 292, taxY + 45);
  write(doc, `${fixed2(tax.igstRate)}%`, 339, taxY + 45);
  write(doc, fixed2(tax.igstAmount), 438, taxY + 45);

  doc.font("Helvetica-Bold");
  write(doc, fixed2(tax.totalTaxAmount), 543, taxY + 45);
  write(doc, "Total", 16, taxY + 59);

  doc.font("Helvetica");
  write(doc, fixed2(tax.taxableAmount), 292, taxY + 59);
  write(doc, fixed2(tax.igstAmount), 438, taxY + 59);

  doc.font("Helvetica-Bold");
  write(doc, fixed2(tax.totalTaxAmount), 543, taxY + 59);
}

/* ================= MAIN PDF ================= */

function generateInvoicePDF(invoice, items, res, disposition = "attachment") {
  // The reference image is taller than A4. This custom height keeps the exact original table spacing
  // and prevents the declaration/signature area from being cut.
  const doc = new PDFDocument({ size: [595.28, 960], margin: 0 });

  const safeInvoiceNo = safeText(invoice.invoice_no || "invoice").replace(/\//g, "-");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${disposition}; filename=invoice-${safeInvoiceNo}.pdf`);

  doc.pipe(res);

  doc.lineWidth(1);
  doc.strokeColor("#000000");
  doc.fillColor("#000000");
  doc.font("Helvetica");

  const tax = getTaxBreakup(invoice, items);
  const grandTotal = tax.grandTotal;
  const roundUp = tax.roundUp;

  const firstItem = Array.isArray(items) && items.length > 0
    ? items[0]
    : {
        sr_no: 1,
        description: "Supply Material Wash Sand",
        hsn_sac: "251710",
        gst_rate: tax.totalGstRate || 5,
        quantity: 2,
        rate: 5000,
        per: "Brass",
        amount: tax.taxableAmount || 10000,
      };

  /* ================= OUTER + TITLE ================= */

  cell(doc, 12, 12, 571, 818);
  cell(doc, 12, 12, 571, 28);

  doc.font("Helvetica-Bold").fontSize(14);
  write(doc, "TAX INVOICE", 12, 22, { width: 571, align: "center" });

  /* ================= TOP SECTION ================= */

  cell(doc, 12, 40, 270, 110);
  cell(doc, 12, 150, 270, 20);

  cell(doc, 282, 40, 130, 50);
  cell(doc, 412, 40, 171, 50);
  cell(doc, 282, 90, 130, 40);
  cell(doc, 412, 90, 171, 40);
  cell(doc, 282, 130, 130, 40);
  cell(doc, 412, 130, 171, 40);

  doc.fontSize(9).font("Helvetica-Bold");
  write(doc, invoice.supplier_name || "ARVIND NAVNATH SHELKE", 16, 47);

  const supplierAddressRaw = invoice.supplier_address ||
    "1 Adgaon Kh, Pimpl Lokai Shirdi\nTal:- Rahata Dist :- Ahmednagar";
  const supplierAddress = safeText(supplierAddressRaw).replace(/,\s*Tal:-/i, "\nTal:-");

  doc.font("Helvetica").fontSize(9);
  write(doc, supplierAddress, 16, 66, { width: 250, lineGap: 1.2 });
  write(doc, `GSTIN/UIN :- ${invoice.supplier_gstin || "27KNNVPS8477J1ZE"}`, 16, 106);
  write(doc, `State Name : ${invoice.supplier_state_name || "Maharashtra"}, Code : ${invoice.supplier_state_code || "27"}`, 16, 126);

  // Keep email fully inside seller box; do not touch the horizontal line below.
  doc.font("Helvetica").fontSize(8.5);
  write(doc, `Email :- ${invoice.supplier_email || ""}`, 16, 140, { width: 250 });
  doc.font("Helvetica").fontSize(9);

  doc.font("Helvetica-Bold");
  write(doc, `Invoice No.  ${invoice.invoice_no || ""}`, 287, 48, { width: 120 });
  write(doc, `Dated:-  ${formatDate(invoice.invoice_date)}`, 420, 48, { width: 155 });

  doc.font("Helvetica");
  write(doc, "Delivery Note", 287, 98);
  write(doc, "Suppliers Ref.", 287, 138);
  write(doc, "Other Reference (s)", 420, 138);

  /* ================= CONSIGNEE ================= */

  cell(doc, 12, 170, 270, 90);
  cell(doc, 282, 170, 130, 45);
  cell(doc, 412, 170, 171, 45);
  cell(doc, 282, 215, 130, 45);
  cell(doc, 412, 215, 171, 45);

  doc.font("Helvetica");
  write(doc, "Consignee", 16, 180);
  doc.font("Helvetica-Bold");
  write(doc, invoice.consignee_name || invoice.buyer_name || "BABA ENTERPRISES", 16, 201, { width: 250 });
  doc.font("Helvetica");
  write(
    doc,
    `State Name : ${invoice.consignee_state_name || invoice.buyer_state_name || "Maharashtra"}, Code : ${invoice.consignee_state_code || invoice.buyer_state_code || "27"}`,
    16,
    222,
    { width: 250 }
  );
  write(doc, "Despatch Document No.", 287, 180);
  write(doc, "Delivery Note Date", 420, 180);
  write(doc, "Despatch Through", 287, 225);
  write(doc, "Destination", 420, 225);

  /* ================= BUYER ================= */

  cell(doc, 12, 260, 270, 150);
  cell(doc, 282, 260, 301, 150);

  write(doc, "Buyer ( if other than consignee)", 16, 270);
  doc.font("Helvetica-Bold");
  write(doc, invoice.buyer_name || "BABA ENTERPRISES", 16, 292, { width: 250 });
  doc.font("Helvetica");
  write(doc, invoice.buyer_address || "324/12 NAGAR MANMAD ROAD RAHATA", 16, 315, { width: 250, lineGap: 2 });
  write(doc, `GSTIN Number: ${invoice.buyer_gstin || "27AATFB5667K1ZO"}`, 16, 337, { width: 250 });
  write(doc, `State: ${invoice.buyer_state_code || "27"}-${invoice.buyer_state_name || "Maharashtra"}`, 16, 360, { width: 250 });

  /* ================= ITEM TABLE ================= */

  const y = 410;
  const headerH = 38;
  const bodyH = 205;
  const totalH = 25;
  const tableH = headerH + bodyH + totalH;

  cell(doc, 12, y, 571, tableH);

  const col = {
    desc: 42,
    hsn: 220,
    gst: 280,
    qty: 335,
    rate: 392,
    per: 445,
    amount: 495,
  };

  line(doc, col.desc, y, col.desc, y + tableH);
  line(doc, col.hsn, y, col.hsn, y + tableH);
  line(doc, col.gst, y, col.gst, y + tableH);
  line(doc, col.qty, y, col.qty, y + tableH);
  line(doc, col.rate, y, col.rate, y + tableH);
  line(doc, col.per, y, col.per, y + tableH);
  line(doc, col.amount, y, col.amount, y + tableH);

  line(doc, 12, y + headerH, 583, y + headerH);
  line(doc, 12, y + headerH + bodyH, 583, y + headerH + bodyH);
  line(doc, col.qty, y + 19, col.rate, y + 19);

  // Amount column subtotal lines are drawn dynamically after item rows.

  doc.font("Helvetica").fontSize(8);
  write(doc, "Sr.", 16, y + 6);
  write(doc, "No", 16, y + 23);
  write(doc, "Description of Goods", 78, y + 19);
  write(doc, "HSN/SAC", 228, y + 19);
  write(doc, "GST Rate", 288, y + 19);
  write(doc, "Quantity", 345, y + 7);
  write(doc, "Shipped", 348, y + 25);
  write(doc, "Rate", 414, y + 19);
  write(doc, "Per", 465, y + 19);
  write(doc, "Amount", 525, y + 19);

  const pdfItems = Array.isArray(items) && items.length > 0 ? items.slice(0, 8) : [firstItem];
  const rowStartY = y + 55;
  const rowStep = 18;

  pdfItems.forEach((item, index) => {
    const rowY = rowStartY + index * rowStep;

    doc.font("Helvetica").fontSize(9);
    write(doc, item.sr_no || index + 1, 32, rowY);

    doc.font("Helvetica-Bold");
    write(doc, item.description || "Supply Material Wash Sand", 47, rowY, { width: 165 });

    doc.font("Helvetica");
    write(doc, item.hsn_sac || "251710", 232, rowY);
    write(doc, `${rateText(item.gst_rate || tax.totalGstRate || 5)}%`, 300, rowY);
    write(doc, fixed2(item.quantity || 0), 352, rowY);
    write(doc, num(item.rate || 0).toFixed(0), 413, rowY);
    write(doc, item.per || "Brass", 455, rowY);

    doc.font("Helvetica-Bold");
    write(doc, fixed2(item.amount || 0), 523, rowY, { width: 55, align: "right" });
  });

  // Material taxable total box in amount column.
  // This moves down automatically when 2 or more material rows are added.
  const amountSummaryY = Math.min(
    y + headerH + 72 + Math.max(0, pdfItems.length - 1) * rowStep,
    y + headerH + 122
  );

  line(doc, col.amount, amountSummaryY, 583, amountSummaryY);
  line(doc, col.amount, amountSummaryY + 20, 583, amountSummaryY + 20);

  doc.font("Helvetica-Bold").fontSize(9);
  write(doc, fixed2(tax.taxableAmount), 523, amountSummaryY + 6, { width: 55, align: "right" });

  const taxLabelY1 = amountSummaryY + 28;
  const taxLabelY2 = amountSummaryY + 48;
  const roundY = Math.min(
    Math.max(y + 191, amountSummaryY + 82),
    y + headerH + bodyH - 28
  );

  doc.font("Helvetica").fontSize(9);
  if (tax.sameState) {
    write(doc, fixed2(tax.cgstAmount), 535, taxLabelY1, { width: 40, align: "right" });
    write(doc, fixed2(tax.sgstAmount), 535, taxLabelY2, { width: 40, align: "right" });
  } else {
    write(doc, fixed2(tax.igstAmount), 535, taxLabelY1, { width: 40, align: "right" });
  }
  write(doc, fixed2(roundUp), 540, roundY, { width: 35, align: "right" });

  doc.font("Helvetica-Bold").fontSize(10);
  if (tax.sameState) {
    write(doc, `Output CGST ${rateText(tax.cgstRate)}%`, 82, taxLabelY1);
    write(doc, `Output SGST ${rateText(tax.sgstRate)}%`, 82, taxLabelY2);
  } else {
    write(doc, `Output IGST ${rateText(tax.igstRate)}%`, 82, taxLabelY1);
  }
  write(doc, "Round Up", 108, roundY);

  doc.font("Helvetica-Bold").fontSize(9);
  write(doc, "Total", 190, y + headerH + bodyH + 8);
  write(doc, fixed2(grandTotal), 532, y + headerH + bodyH + 8, { width: 45, align: "right" });

  /* ================= AMOUNT WORDS ================= */

  const wordsY = y + tableH;
  cell(doc, 12, wordsY, 571, 35);

  doc.font("Helvetica").fontSize(9);
  write(doc, "Amount Chargeable ( in words )", 16, wordsY + 6);
  write(doc, "E. & O.E", 542, wordsY + 6);

  doc.font("Helvetica-Bold");
  write(doc, invoice.amount_in_words || `${numberToWords(grandTotal)} Rupees Only`, 16, wordsY + 22, { width: 400 });

  /* ================= TAX SUMMARY ================= */

  const taxY = wordsY + 35;
  const taxH = 70;

  if (tax.sameState) {
    drawSameStateTaxTable(doc, taxY, taxH, firstItem, tax);
  } else {
    drawIgstTaxTable(doc, taxY, taxH, firstItem, tax);
  }

  /* ================= TAX WORDS ================= */

  const taxWordsY = taxY + taxH;
  cell(doc, 12, taxWordsY, 571, 35);

  doc.font("Helvetica").fontSize(9);
  write(
    doc,
    `Tax Amount ( In Words ):  ${invoice.tax_amount_in_words || `${numberToWords(tax.totalTaxAmount)} Rupees only.`}`,
    16,
    taxWordsY + 13,
    { width: 550 }
  );

  /* ================= DECLARATION / BANK ================= */

  const decY = taxWordsY + 35;
  cell(doc, 12, decY, 323, 75);
  cell(doc, 335, decY, 248, 75);

  doc.font("Helvetica").fontSize(9);
  write(doc, "Declaration", 16, decY + 6);
  write(
    doc,
    "We declare that this invoice shows the actual price of the\ngoods described and that all particulars are true and correct",
    16,
    decY + 23,
    { width: 300 }
  );

  write(doc, "Company Bank Details", 340, decY + 6);

  doc.font("Helvetica-Bold");
  write(doc, "Bank Name", 340, decY + 25);
  write(doc, "A/c No", 340, decY + 39);
  write(doc, "Branch", 340, decY + 53);
  write(doc, "IFSC CODE", 340, decY + 67);
  write(doc, `: ${invoice.bank_name || "STATE BANK OF INDIA"}`, 450, decY + 25, { width: 125 });
  write(doc, `: ${invoice.bank_account_no || "41116710845"}`, 450, decY + 39, { width: 125 });
  write(doc, `: ${invoice.bank_branch || "LONI BK"}`, 450, decY + 53, { width: 125 });
  write(doc, `: ${invoice.bank_ifsc || "SBIN0006322"}`, 450, decY + 67, { width: 125 });

  /* ================= SIGNATURE ================= */

  const sigY = decY + 75;
  cell(doc, 12, sigY, 323, 55);
  cell(doc, 335, sigY, 248, 55);

  doc.font("Helvetica").fontSize(9);
  write(doc, "Customer Seal And Signature", 16, sigY + 8);

  doc.font("Helvetica-Bold");
  write(doc, invoice.supplier_name || "ARVIND NAVNATH SHELKE", 350, sigY + 8, { width: 225, align: "center" });
  write(doc, "Authorised Signature", 390, sigY + 40, { width: 170, align: "center" });

  doc.end();
}

/* =========================================================
   API 1: DOWNLOAD SAVED PDF
   GET /api/invoices/:id/pdf
========================================================= */

router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const invoiceResult = await db.query("SELECT * FROM invoices WHERE id = $1", [req.params.id]);

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const itemsResult = await db.query(
      "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sr_no ASC",
      [req.params.id]
    );

    generateInvoicePDF(invoiceResult.rows[0], itemsResult.rows, res, "attachment");
  } catch (error) {
    console.error("PDF download error:", error);
    res.status(500).json({ success: false, message: "Failed to generate PDF", error: error.message });
  }
});

/* =========================================================
   API 2: INLINE VIEW PDF
   GET /api/invoices/:id/pdf-view
========================================================= */

router.get("/invoices/:id/pdf-view", async (req, res) => {
  try {
    const invoiceResult = await db.query("SELECT * FROM invoices WHERE id = $1", [req.params.id]);

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const itemsResult = await db.query(
      "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sr_no ASC",
      [req.params.id]
    );

    generateInvoicePDF(invoiceResult.rows[0], itemsResult.rows, res, "inline");
  } catch (error) {
    console.error("PDF view error:", error);
    res.status(500).json({ success: false, message: "Failed to view PDF", error: error.message });
  }
});

/* =========================================================
   API 3: PREVIEW PDF WITHOUT SAVE
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

    const supplierStateCode = body.supplier_state_code || "27";
    const buyerStateCode = body.buyer_state_code || body.consignee_state_code || "27";
    const gstRate = body.gst_rate || body.igst_rate || 5;

    const calculation = calculateInvoice(body.items || [], gstRate, supplierStateCode, buyerStateCode);

    const invoice = {
      invoice_no: body.invoice_no || "PREVIEW",
      invoice_date: body.invoice_date || new Date(),

      supplier_name: body.supplier_name || "ARVIND NAVNATH SHELKE",
      supplier_address:
        body.supplier_address ||
        "1 Adgaon Kh, Pimpl Lokai Shirdi\nTal:- Rahata Dist :- Ahmednagar",
      supplier_gstin: body.supplier_gstin || "27KNNVPS8477J1ZE",
      supplier_state_name: body.supplier_state_name || "Maharashtra",
      supplier_state_code: supplierStateCode,
      supplier_email: body.supplier_email || "",

      consignee_name: body.consignee_name || body.buyer_name || "BABA ENTERPRISES",
      consignee_state_name: body.consignee_state_name || body.buyer_state_name || "Maharashtra",
      consignee_state_code: body.consignee_state_code || buyerStateCode,

      buyer_name: body.buyer_name || "BABA ENTERPRISES",
      buyer_gstin: body.buyer_gstin || "27AATFB5667K1ZO",
      buyer_state_name: body.buyer_state_name || "Maharashtra",
      buyer_state_code: buyerStateCode,
      buyer_address: body.buyer_address || "324/12 NAGAR MANMAD ROAD RAHATA",

      bank_name: body.bank_name || "STATE BANK OF INDIA",
      bank_account_no: body.bank_account_no || "41116710845",
      bank_branch: body.bank_branch || "LONI BK",
      bank_ifsc: body.bank_ifsc || "SBIN0006322",

      taxable_amount: calculation.taxableAmount,
      gst_rate: calculation.gstRate,
      igst_rate: calculation.gstRate,
      total_tax_amount: calculation.totalTaxAmount,
      igst_amount: calculation.totalTaxAmount,
      round_up: calculation.roundUp,
      grand_total: calculation.grandTotal,
      amount_in_words: calculation.amountInWords,
      tax_amount_in_words: calculation.taxAmountInWords,
    };

    generateInvoicePDF(invoice, calculation.items, res, "inline");
  } catch (error) {
    console.error("PDF preview error:", error);
    res.status(500).json({ success: false, message: "Failed to generate preview PDF", error: error.message });
  }
});

module.exports = router;