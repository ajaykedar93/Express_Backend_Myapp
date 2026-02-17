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
const compression = require('compression');
app.use(compression());
app.use(cors({ origin: ["http://localhost:5173","https://express-backend-myapp.onrender.com", "http://localhost:3000"], credentials: true }));
app.use(compression());


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
app.use("/api/inward", inwardRoutes);
// server.js / app.js
const inwardViewOnly = require("./routes/inwardViewOnly");
app.use("/api/inward-view", inwardViewOnly);


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


// Investment module (your new flows)
// Investment Routes
// =========================

// 1. Platform & Segment
const investmentPlatformSegment = require("./routes/INVESTMENT/investment_platform_segment");
app.use("/api/investment/platform-segment", investmentPlatformSegment);

// 2. Investment Plan
const investmentPlan = require("./routes/INVESTMENT/investment_plan");
app.use("/api/investment/plan", investmentPlan);

// 3. Trading Journal (Create, Get, Delete)
const investmentTradingJournal = require("./routes/INVESTMENT/investment_tradingjournal");
app.use("/api/investment/tradingjournal", investmentTradingJournal);

// 4. Investment Report (Month report, Mistakes repeat)
const investmentReport = require("./routes/INVESTMENT/investment_report");
app.use("/api/investment/report", investmentReport);

// 5. Deposit / Withdrawal
const investmentDipWid = require("./routes/INVESTMENT/investment_dipwid");
app.use("/api/investment/dipwid", investmentDipWid);

// 6. Trading Journal Views (Daily summary, Entry details)
const investmentGetViewTradingJournal = require("./routes/INVESTMENT/investment_getview_tradingjournal");
app.use("/api/investment/tradingjournal-view", investmentGetViewTradingJournal);


// ✅ Import routes
const notesMyAppRoutes = require("./routes/Notes/notesmyapp");
app.use("/api/notes-myapp", notesMyAppRoutes);



/* ---------- Routers (ONLY user_investment) ---------- */
app.use("/api/user_investment", require("./routes/user_investment"));
// Mount once at /api  (so /api/password-manager works)
app.use("/api", require("./routes/passwordManager"));

app.use("/api/notes", require("./routes/notes")); // ✅ Mount Notes API
app.use("/api", require("./routes/websites")); // ✅ your router


app.use("/api/admin_impdocument", adminImpDocumentRouter);


// ✅ keep only new defensive one
app.use("/api/sitekharch", require("./routes/sitekharch_new"));


app.use("/api/act_favorite", require("./routes/userActFavorite"));







const addListFevActRoutes = require("./routes/addlistfevact");
app.use("/api/add-list-actress", addListFevActRoutes);





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

