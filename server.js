// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const app = express();

/* ---------------- Middleware ---------------- */
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

/* ---------------- Routers (imports) ---------------- */
// Movies / Series / Downloads
const moviesRouter = require("./routes/movies");
const seriesRouter = require("./routes/series");
const downloadRouter = require("./routes/download");

// Generic categories
const allCategoriesRouter = require("./routes/Allcategories"); // mounted at /api
const categoryRouterLegacy = require("./routes/category");
const subcategoryRouterLegacy = require("./routes/subcategory");

// Admin + Favorites + Library
const adminRouter = require("./routes/admin");
const favoriteRouter = require("./routes/favorite");
const libraryRouter = require("./routes/library");




// Documents
const documentRouter = require("./routes/document");



// Work-related
const workDetailsRouter = require("./routes/workdetails");
const workCategoryRouter = require("./routes/workcategory");



// Transactions / Summaries (legacy finance flows)
const dailyTransactionRouter = require("./routes/dailyTransaction");
const mainTransactionRouter = require("./routes/mainTransaction");
const monthlySummaryRouterLegacy = require("./routes/monthlySummary");
const financeTotalsRouter = require("./routes/financeTotals");

// Transaction categories
const transactionCategoryRouter = require("./routes/transactioncategory");
const transactionCategoryWiseRouter = require("./routes/transactionscategorywise");





// Investment module (your new flows)
const invCategoryRouter = require("./routes/investment_category");
const invSubcategoryRouter = require("./routes/investment_subcategory");
const invDepositRouter = require("./routes/investment_deposit_logic");
const monthSummaryRouter = require("./routes/investment_month_summary");
const investmentTradingJournalRouter = require("./routes/investment_tradingjournal");


const userInvestmentRoutes = require('./routes/user_investment');
const passwordManagerRoutes = require("./routes/passwordManager"); // <- see file below
// const adminImpDocumentRouter = require("./routes/admin_impdocument");
const adminImpDocumentRouter = require("./routes/imodocument");


/* ---------------- Routes ---------------- */
// Media
app.use("/api/movies", moviesRouter);
app.use("/api/series", seriesRouter);
app.use("/api/download", downloadRouter);

// Generic categories
app.use("/api", allCategoriesRouter);            // e.g. /api/Allcategories endpoints
app.use("/api/category", categoryRouterLegacy);  // legacy category endpoints
app.use("/api/subcategory", subcategoryRouterLegacy);

// Admin + favorites + library
app.use("/api/admin", adminRouter);
app.use("/api/favorites", favoriteRouter);
app.use("/api/library", libraryRouter);

// Documents
app.use("/api/documents", documentRouter);

// Work-related
app.use("/api", workDetailsRouter);
const inwardRoutes = require("./routes/inward");
app.use("/api", inwardRoutes); // so endpoints become /api/inward, /api/inward/export, etc.

app.use("/api/workcategory", workCategoryRouter);

// Finance / transactions (legacy)
app.use("/api/dailyTransaction", dailyTransactionRouter);
app.use("/api/mainTransaction", mainTransactionRouter);
app.use("/api", monthlySummaryRouterLegacy); // stays under its own internal subpaths
app.use("/api", financeTotalsRouter);

// Transaction categories
app.use("/api/transaction-category", transactionCategoryRouter);
// ❗ Fix: give the “categorywise” router its own unique base to avoid clashing
app.use("/api/transaction-category", transactionCategoryWiseRouter);

// Investment (new)
app.use("/api/investment_category", invCategoryRouter);       // was duplicated before; now only once
app.use("/api/investment_subcategory", invSubcategoryRouter);
app.use("/api/deposits", invDepositRouter);
app.use("/api/monthly_summary", monthSummaryRouter);
app.use("/api/trading_journal", investmentTradingJournalRouter);

/* ---------- Routers (ONLY user_investment) ---------- */
app.use("/api/user_investment", require("./routes/user_investment"));
// Mount once at /api  (so /api/password-manager works)
app.use("/api", require("./routes/passwordManager"));
app.use("/api/act_favorite", require("./routes/actFavorite"));
app.use("/api/notes", require("./routes/notes")); // ✅ Mount Notes API
app.use("/api", require("./routes/websites")); // ✅ your router


app.use("/api/admin_impdocument", adminImpDocumentRouter);


const userActFavoriteRoutes = require("./routes/userActFavorite");
app.use("/api", userActFavoriteRoutes);

app.use("/api/act_favorite", require("./routes/actFavorite"));


// ✅ keep only new defensive one
app.use("/api/sitekharch", require("./routes/sitekharch_new"));





/* ---------------- Health Check ---------------- */
app.get("/health", (_req, res) => res.json({ status: "OK" }));

/* ---------------- 404 ---------------- */
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ error: "Route not found" });
});

/* ---------------- Global Error Handler ---------------- */
app.use((err, _req, res, _next) => {
  console.error("Unhandled Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Something went wrong!",
  });
});

/* ---------------- Start Server ---------------- */
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// Keep-alive for large/slow uploads
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
module.exports = app;
