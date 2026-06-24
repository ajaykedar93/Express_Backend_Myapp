const express = require("express");
const PDFDocument = require("pdfkit");
const db = require("../db");

const router = express.Router();

/* ================= HELPERS ================= */

function safeText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function fixed2(value) {
  return Number(value || 0).toFixed(2);
}

function formatDate(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "";

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();

  return `${dd}.${mm}.${yyyy}`;
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

  const calculatedItems = (Array.isArray(items) ? items : []).map(
    (item, index) => {
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
        amount,
      };
    }
  );

  const igstAmount = taxableAmount * (Number(igstRate || 0) / 100);
  const beforeRoundTotal = taxableAmount + igstAmount;
  const grandTotal = Math.round(beforeRoundTotal);
  const roundUp = grandTotal - beforeRoundTotal;

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
    errors.push("Maximum 8 material rows are allowed.");
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

/* ================= DRAW HELPERS ================= */

function line(doc, x1, y1, x2, y2) {
  doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
}

function box(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

function txt(doc, text, x, y, w, h, opt = {}) {
  const size = opt.size || 8;
  const font = opt.bold ? "Helvetica-Bold" : "Helvetica";
  const align = opt.align || "left";
  const padding = opt.padding ?? 2;

  let ty = y + padding;

  if (opt.valign === "middle") {
    ty = y + h / 2 - size / 1.6;
  }

  if (opt.valign === "bottom") {
    ty = y + h - size - padding;
  }

  doc.save();

  doc.rect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1)).clip();

  doc.font(font).fontSize(size).text(safeText(text), x + padding, ty, {
    width: Math.max(1, w - padding * 2),
    height: Math.max(1, h - padding * 2),
    align,
    lineGap: opt.lineGap ?? 0.2,
    ellipsis: true,
  });

  doc.restore();
}

/* ================= MAIN PDF ================= */

function generateInvoicePDF(invoice, items, res, disposition = "attachment") {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename=invoice-${safeText(invoice.invoice_no).replace(
      /\//g,
      "-"
    )}.pdf`
  );

  doc.pipe(res);

  doc.lineWidth(0.65);
  doc.strokeColor("#000000");
  doc.fillColor("#000000");

  /* ================= EXACT PAGE AREA ================= */

  const X = 30;
  const Y = 10;
  const W = 535;
  const H = 820;
  const R = X + W;
  const B = Y + H;

  box(doc, X, Y, W, H);

  /* ================= TITLE ================= */

  const titleH = 24;

  line(doc, X, Y + titleH, R, Y + titleH);

  txt(doc, "TAX INVOICE", X, Y, W, titleH, {
    bold: true,
    size: 11,
    align: "center",
    valign: "middle",
  });

  /* ================= TOP BLOCK ================= */

  const leftW = 240;
  const rightW = W - leftW;
  const splitX = X + leftW;
  const rightHalf = rightW / 2;

  const topY = Y + titleH;
  const sellerH = 86;
  const consigneeH = 70;
  const buyerH = 140;

  // vertical separator from top to item table
  line(doc, splitX, topY, splitX, topY + sellerH + consigneeH + buyerH);

  // seller bottom line only left
  line(doc, X, topY + sellerH, splitX, topY + sellerH);

  // consignee bottom line only left
  line(doc, X, topY + sellerH + consigneeH, splitX, topY + sellerH + consigneeH);

  // buyer bottom full
  line(
    doc,
    X,
    topY + sellerH + consigneeH + buyerH,
    R,
    topY + sellerH + consigneeH + buyerH
  );

  // right side header area
  const rightHeaderH = sellerH + consigneeH;
  line(doc, splitX + rightHalf, topY, splitX + rightHalf, topY + rightHeaderH);

  const r1 = 43;
  const r2 = 29;
  const r3 = 29;
  const r4 = 29;
  const r5 = rightHeaderH - r1 - r2 - r3 - r4;

  let ry = topY + r1;
  line(doc, splitX, ry, R, ry);

  ry += r2;
  line(doc, splitX, ry, R, ry);

  ry += r3;
  line(doc, splitX, ry, R, ry);

  ry += r4;
  line(doc, splitX, ry, R, ry);

  /* Seller text */
  txt(doc, invoice.supplier_name || "ARVIND NAVNATH SHELKE", X + 2, topY + 2, leftW - 4, 12, {
    bold: true,
    size: 7.4,
  });

  txt(
    doc,
    invoice.supplier_address ||
      "1 Adgaon Kh, Pimpli Lokai Shirdi\nTal:- Rahata Dist :- Ahmednagar",
    X + 2,
    topY + 16,
    leftW - 4,
    28,
    {
      size: 7.2,
      lineGap: 1,
    }
  );

  txt(
    doc,
    `GSTIN/UIN :- ${invoice.supplier_gstin || "27KNNVPS8477J1ZE"}`,
    X + 2,
    topY + 46,
    leftW - 4,
    11,
    {
      size: 7.2,
    }
  );

  txt(
    doc,
    `State Name : ${invoice.supplier_state_name || "Maharashtra"}, Code : ${
      invoice.supplier_state_code || "27"
    }`,
    X + 2,
    topY + 60,
    leftW - 4,
    11,
    {
      size: 7.2,
    }
  );

  txt(doc, `Email :- ${invoice.supplier_email || ""}`, X + 2, topY + 74, leftW - 4, 10, {
    size: 7.2,
  });

  /* Right header text */
  txt(doc, `Invoice No.  ${invoice.invoice_no || ""}`, splitX + 2, topY + 2, rightHalf - 4, 13, {
    bold: true,
    size: 7.2,
  });

  txt(
    doc,
    `Dated:- ${formatDate(invoice.invoice_date)}`,
    splitX + rightHalf + 2,
    topY + 2,
    rightHalf - 4,
    13,
    {
      bold: true,
      size: 7.2,
    }
  );

  txt(doc, "Delivery Note", splitX + 2, topY + r1 + 3, rightHalf - 4, 12, {
    size: 7.2,
  });

  txt(doc, "Suppliers Ref.", splitX + 2, topY + r1 + r2 + 3, rightHalf - 4, 12, {
    size: 7.2,
  });

  txt(
    doc,
    "Other Reference (s)",
    splitX + rightHalf + 2,
    topY + r1 + r2 + 3,
    rightHalf - 4,
    12,
    {
      size: 7.2,
    }
  );

  txt(
    doc,
    "Despatch Document No.",
    splitX + 2,
    topY + r1 + r2 + r3 + 3,
    rightHalf - 4,
    12,
    {
      size: 7.2,
    }
  );

  txt(
    doc,
    "Delivery Note Date",
    splitX + rightHalf + 2,
    topY + r1 + r2 + r3 + 3,
    rightHalf - 4,
    12,
    {
      size: 7.2,
    }
  );

  txt(
    doc,
    "Despatch Through",
    splitX + 2,
    topY + r1 + r2 + r3 + r4 + 3,
    rightHalf - 4,
    12,
    {
      size: 7.2,
    }
  );

  txt(
    doc,
    "Destination",
    splitX + rightHalf + 2,
    topY + r1 + r2 + r3 + r4 + 3,
    rightHalf - 4,
    12,
    {
      size: 7.2,
    }
  );

  /* ================= CONSIGNEE ================= */

  const consigneeY = topY + sellerH;

  txt(doc, "Consignee", X + 2, consigneeY + 4, leftW - 4, 12, {
    size: 7.2,
  });

  txt(
    doc,
    invoice.consignee_name || "BIOSEL SOLAR PRIVATE LIMITED",
    X + 2,
    consigneeY + 18,
    leftW - 4,
    12,
    {
      bold: true,
      size: 7.2,
    }
  );

  txt(
    doc,
    `State Name : ${invoice.consignee_state_name || "Gujrat"}, Code : ${
      invoice.consignee_state_code || "24"
    }`,
    X + 2,
    consigneeY + 32,
    leftW - 4,
    12,
    {
      size: 7.2,
    }
  );

  /* ================= BUYER ================= */

  const buyerY = consigneeY + consigneeH;

  txt(doc, "Buyer ( if other than consignee)", X + 2, buyerY + 5, leftW - 4, 11, {
    size: 7.2,
  });

  txt(doc, invoice.buyer_name || "BIOSEL SOLAR PRIVATE LIMITED", X + 2, buyerY + 19, leftW - 4, 11, {
    bold: true,
    size: 7.2,
  });

  txt(doc, `GSTIN/UIN :      ${invoice.buyer_gstin || "24AALCB1497J1ZE"}`, X + 2, buyerY + 34, leftW - 4, 11, {
    bold: true,
    size: 7.2,
  });

  txt(
    doc,
    `State Name : ${invoice.buyer_state_name || "Gujrat"}, Code : ${
      invoice.buyer_state_code || "24"
    }`,
    X + 2,
    buyerY + 49,
    leftW - 4,
    11,
    {
      size: 7.2,
    }
  );

  txt(
    doc,
    invoice.buyer_address ||
      "BUNGLOWS NO.82, GULMAHOR-ENCLAV,\n2, GULMAHOR GREEN AND GOLF COUNTRY,\nCOUNTRY CLUB, Kolat, Ahmedabad\nGujarat,382210",
    X + 2,
    buyerY + 64,
    leftW - 4,
    62,
    {
      size: 7.05,
      lineGap: 1,
    }
  );

  /* ================= ITEM TABLE ================= */

  const tableY = topY + sellerH + consigneeH + buyerH;
  const tableH = 236;
  const headerH = 38;

  box(doc, X, tableY, W, tableH);

  const c1 = 29;
  const c2 = 190;
  const c3 = 54;
  const c4 = 48;
  const c5 = 48;
  const c6 = 46;
  const c7 = 46;
  const c8 = W - c1 - c2 - c3 - c4 - c5 - c6 - c7;

  const x1 = X;
  const x2 = x1 + c1;
  const x3 = x2 + c2;
  const x4 = x3 + c3;
  const x5 = x4 + c4;
  const x6 = x5 + c5;
  const x7 = x6 + c6;
  const x8 = x7 + c7;

  [x2, x3, x4, x5, x6, x7, x8].forEach((vx) => {
    line(doc, vx, tableY, vx, tableY + tableH);
  });

  line(doc, X, tableY + headerH, R, tableY + headerH);

  txt(doc, "Sr.\nNo", x1, tableY, c1, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Description of Goods", x2, tableY, c2, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "HSN/SAC", x3, tableY, c3, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "GST Rate", x4, tableY, c4, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Quantity\nShipped", x5, tableY, c5, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Rate", x6, tableY, c6, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Per", x7, tableY, c7, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Amount", x8, tableY, c8, headerH, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  const pdfItems = Array.isArray(items) ? items.slice(0, 8) : [];
  let itemY = tableY + headerH + 10;

  pdfItems.forEach((item, index) => {
    txt(doc, item.sr_no || index + 1, x1 + 1, itemY, c1 - 2, 14, {
      size: 7.2,
      align: "right",
    });

    txt(doc, item.description || "", x2 + 3, itemY, c2 - 6, 14, {
      size: 7.2,
      bold: true,
    });

    txt(doc, item.hsn_sac || "251710", x3 + 1, itemY, c3 - 2, 14, {
      size: 7.2,
      align: "center",
    });

    txt(doc, `${Number(item.gst_rate || invoice.igst_rate || 5).toFixed(0)}%`, x4 + 1, itemY, c4 - 2, 14, {
      size: 7.2,
      bold: true,
      align: "center",
    });

    txt(doc, Number(item.quantity || 0).toFixed(2), x5 + 1, itemY, c5 - 2, 14, {
      size: 7.2,
      align: "center",
    });

    txt(doc, Number(item.rate || 0).toFixed(0), x6 + 1, itemY, c6 - 2, 14, {
      size: 7.2,
      align: "right",
    });

    txt(doc, item.per || "Brass", x7 + 1, itemY, c7 - 2, 14, {
      size: 7.2,
      align: "center",
    });

    txt(doc, fixed2(item.amount), x8 + 1, itemY, c8 - 2, 14, {
      size: 7.2,
      bold: true,
      align: "right",
    });

    itemY += 18;
  });

  // Amount box inside amount column
  const amountLineY = tableY + 118;

  line(doc, x8, amountLineY, R, amountLineY);
  line(doc, x8, amountLineY + 16, R, amountLineY + 16);

  txt(doc, fixed2(invoice.taxable_amount), x8 + 1, amountLineY + 1, c8 - 2, 13, {
    size: 7.2,
    bold: true,
    align: "right",
  });

  txt(doc, fixed2(invoice.igst_amount), x8 + 1, amountLineY + 17, c8 - 2, 13, {
    size: 7.2,
    bold: true,
    align: "right",
  });

  txt(doc, `OUTPUT IGST -@ ${Number(invoice.igst_rate || 5).toFixed(0)}%`, x2 + 42, tableY + 130, 140, 15, {
    size: 7.3,
    bold: true,
    align: "center",
  });

  txt(doc, "Round Up", x2 + 70, tableY + 182, 80, 14, {
    size: 7.1,
    align: "center",
  });

  txt(doc, fixed2(invoice.round_up), x8 + 1, tableY + 182, c8 - 2, 14, {
    size: 7.2,
    bold: true,
    align: "right",
  });

  const totalY = tableY + tableH - 21;
  line(doc, X, totalY, R, totalY);

  txt(doc, "Total", x2 + 155, totalY + 2, 50, 15, {
    size: 7.4,
    bold: true,
    align: "right",
  });

  txt(doc, fixed2(invoice.grand_total), x8 + 1, totalY + 2, c8 - 2, 15, {
    size: 7.4,
    bold: true,
    align: "right",
  });

  /* ================= AMOUNT WORDS ================= */

  let y = tableY + tableH;
  const amountWordsH = 29;

  box(doc, X, y, W, amountWordsH);

  txt(doc, "Amount Chargeable ( in words )", X + 2, y + 2, 260, 10, {
    size: 7.2,
  });

  txt(doc, "E. & O.E", R - 52, y + 2, 48, 10, {
    size: 7.2,
    align: "right",
  });

  txt(doc, invoice.amount_in_words, X + 2, y + 14, W - 4, 11, {
    size: 7.3,
    bold: true,
  });

  /* ================= TAX TABLE ================= */

  y += amountWordsH;

  const taxH = 55;

  box(doc, X, y, W, taxH);

  const t1 = 265;
  const t2 = 55;
  const t3 = 50;
  const t4 = 50;
  const t5 = 64;
  const t6 = W - t1 - t2 - t3 - t4 - t5;

  const tx2 = X + t1;
  const tx3 = tx2 + t2;
  const tx4 = tx3 + t3;
  const tx5 = tx4 + t4;
  const tx6 = tx5 + t5;

  [tx2, tx3, tx4, tx5, tx6].forEach((vx) => {
    line(doc, vx, y, vx, y + taxH);
  });

  line(doc, X, y + 29, R, y + 29);
  line(doc, X, y + 42, R, y + 42);

  txt(doc, "HSN/SAC", X, y + 1, t1, 28, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Taxable\nValue", tx2, y + 1, t2, 28, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "IGST\nRate", tx3, y + 1, t3, 28, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "IGST\nRate", tx4, y + 1, t4, 28, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Amount", tx5, y + 1, t5, 28, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  txt(doc, "Total Tax Amount", tx6, y + 1, t6, 28, {
    size: 7,
    align: "center",
    valign: "middle",
  });

  const hsnCode = items[0]?.hsn_sac ? String(items[0].hsn_sac).slice(0, 4) : "2517";

  txt(doc, hsnCode, X + 1, y + 30, t1 - 2, 11, {
    size: 7,
  });

  txt(doc, fixed2(invoice.taxable_amount), tx2 + 1, y + 30, t2 - 2, 11, {
    size: 7,
    align: "right",
  });

  txt(doc, `${Number(invoice.igst_rate || 0).toFixed(2)}%`, tx3 + 1, y + 30, t3 - 2, 11, {
    size: 7,
    align: "center",
  });

  txt(doc, "0.00%", tx4 + 1, y + 30, t4 - 2, 11, {
    size: 7,
    align: "center",
  });

  txt(doc, Number(invoice.igst_amount || 0).toFixed(0), tx5 + 1, y + 30, t5 - 2, 11, {
    size: 7,
    align: "right",
  });

  txt(doc, fixed2(invoice.igst_amount), tx6 + 1, y + 30, t6 - 2, 11, {
    size: 7,
    bold: true,
    align: "right",
  });

  txt(doc, "Total", X + 1, y + 43, t1 - 2, 10, {
    size: 7,
    bold: true,
  });

  txt(doc, fixed2(invoice.taxable_amount), tx2 + 1, y + 43, t2 - 2, 10, {
    size: 7,
    align: "right",
  });

  txt(doc, Number(invoice.igst_amount || 0).toFixed(0), tx5 + 1, y + 43, t5 - 2, 10, {
    size: 7,
    align: "right",
  });

  txt(doc, fixed2(invoice.igst_amount), tx6 + 1, y + 43, t6 - 2, 10, {
    size: 7,
    bold: true,
    align: "right",
  });

  /* ================= TAX WORDS ================= */

  y += taxH;
  const taxWordsH = 43;

  box(doc, X, y, W, taxWordsH);

  txt(doc, `Tax Amount ( In Words ): ${invoice.tax_amount_in_words}`, X + 2, y + 16, W - 4, 12, {
    size: 7.2,
  });

  /* ================= DECLARATION + BANK ================= */

  y += taxWordsH;
  const declarationH = 69;
  const bankX = X + 290;

  box(doc, X, y, W, declarationH);
  line(doc, bankX, y, bankX, y + declarationH);

  txt(doc, "Declaration", X + 2, y + 4, 120, 10, {
    size: 7.2,
  });

  txt(
    doc,
    "We declare that this invoice shows the actual price of the\ngoods described and that all particulars are true and correct",
    X + 2,
    y + 17,
    278,
    40,
    {
      size: 7.05,
      lineGap: 1,
    }
  );

  txt(doc, "Company Bank Details", bankX + 2, y + 4, R - bankX - 4, 10, {
    size: 7.2,
  });

  txt(doc, `Bank Name        : ${invoice.bank_name || "STATE BANK OF INDIA"}`, bankX + 2, y + 17, R - bankX - 4, 10, {
    size: 7.05,
    bold: true,
  });

  txt(doc, `A/c No           : ${invoice.bank_account_no || "41116710845"}`, bankX + 2, y + 30, R - bankX - 4, 10, {
    size: 7.05,
    bold: true,
  });

  txt(doc, `Branch           : ${invoice.bank_branch || "LONI BK"}`, bankX + 2, y + 43, R - bankX - 4, 10, {
    size: 7.05,
    bold: true,
  });

  txt(doc, `IFSC CODE        : ${invoice.bank_ifsc || "SBIN0006322"}`, bankX + 2, y + 56, R - bankX - 4, 10, {
    size: 7.05,
    bold: true,
  });

  /* ================= SIGNATURE ================= */

  y += declarationH;
  const signH = B - y;

  box(doc, X, y, W, signH);
  line(doc, bankX, y, bankX, y + signH);

  txt(doc, "Customer Seal And Signature", X + 2, y + 5, 230, 11, {
    size: 7.2,
  });

  txt(doc, invoice.supplier_name || "ARVIND NAVNATH SHELKE", bankX + 2, y + 5, R - bankX - 4, 11, {
    size: 7.2,
    bold: true,
    align: "center",
  });

  txt(doc, "Authorised Signature", bankX + 2, y + signH - 24, R - bankX - 4, 12, {
    size: 7.2,
    bold: true,
    align: "center",
  });

  doc.end();
}

/* =========================================================
   API 1: DOWNLOAD SAVED PDF
   GET /api/invoices/:id/pdf
========================================================= */

router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [req.params.id]
    );

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

    generateInvoicePDF(invoiceResult.rows[0], itemsResult.rows, res, "attachment");
  } catch (error) {
    console.error("PDF download error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to generate PDF",
      error: error.message,
    });
  }
});

/* =========================================================
   API 2: INLINE VIEW PDF
   GET /api/invoices/:id/pdf-view
========================================================= */

router.get("/invoices/:id/pdf-view", async (req, res) => {
  try {
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [req.params.id]
    );

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

    generateInvoicePDF(invoiceResult.rows[0], itemsResult.rows, res, "inline");
  } catch (error) {
    console.error("PDF view error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to view PDF",
      error: error.message,
    });
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

    const calculation = calculateInvoice(body.items || [], body.igst_rate || 5);

    const invoice = {
      invoice_no: body.invoice_no || "PREVIEW",
      invoice_date: body.invoice_date || new Date(),

      supplier_name: body.supplier_name || "ARVIND NAVNATH SHELKE",
      supplier_address:
        body.supplier_address ||
        "1 Adgaon Kh, Pimpli Lokai Shirdi\nTal:- Rahata Dist :- Ahmednagar",
      supplier_gstin: body.supplier_gstin || "27KNNVPS8477J1ZE",
      supplier_state_name: body.supplier_state_name || "Maharashtra",
      supplier_state_code: body.supplier_state_code || "27",
      supplier_email: body.supplier_email || "",

      consignee_name: body.consignee_name || "BIOSEL SOLAR PRIVATE LIMITED",
      consignee_state_name: body.consignee_state_name || "Gujrat",
      consignee_state_code: body.consignee_state_code || "24",

      buyer_name: body.buyer_name || "BIOSEL SOLAR PRIVATE LIMITED",
      buyer_gstin: body.buyer_gstin || "24AALCB1497J1ZE",
      buyer_state_name: body.buyer_state_name || "Gujrat",
      buyer_state_code: body.buyer_state_code || "24",
      buyer_address:
        body.buyer_address ||
        "BUNGLOWS NO.82, GULMAHOR-ENCLAV,\n2, GULMAHOR GREEN AND GOLF COUNTRY,\nCOUNTRY CLUB, Kolat, Ahmedabad\nGujarat,382210",

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

    generateInvoicePDF(invoice, calculation.items, res, "inline");
  } catch (error) {
    console.error("PDF preview error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to generate preview PDF",
      error: error.message,
    });
  }
});

module.exports = router;