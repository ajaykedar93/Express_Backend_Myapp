// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const compression = require("compression");

const app = express();

/* ---------------- Middleware ---------------- */
app.use(compression());
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://express-backend-myapp.onrender.com",
      "http://localhost:3000",
    ],
    credentials: true,
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

/* ---------------- Routers (imports) ---------------- */
// Movies / Series / Downloads
const moviesRouter = require("./routes/movies");
const seriesRouter = require("./routes/series");
const downloadRouter = require("./routes/download");

// Generic categories
const allCategoriesRouter = require("./routes/Allcategories");
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

// Other routes
const userInvestmentRoutes = require("./routes/user_investment");
const passwordManagerRoutes = require("./routes/passwordManager");
const adminImpDocumentRouter = require("./routes/imodocument");

// NEW DPR API
const monthDprRoutes = require("./routes/monthdpr");

// Inward
const inwardRoutes = require("./routes/inward");
const inwardViewOnly = require("./routes/inwardViewOnly");

// Investment module
const investmentPlatformSegment = require("./routes/INVESTMENT/investment_platform_segment");
const investmentPlan = require("./routes/INVESTMENT/investment_plan");
const investmentTradingJournal = require("./routes/INVESTMENT/investment_tradingjournal");
const investmentDipWid = require("./routes/INVESTMENT/investment_dipwid");
const investmentGetViewTradingJournal = require("./routes/INVESTMENT/investment_getview_tradingjournal");

// Notes / websites / favorites
const notesMyAppRoutes = require("./routes/Notes/notesmyapp");
const notesRoutes = require("./routes/notes");
const websitesRoutes = require("./routes/websites");
const sitekharchNewRoutes = require("./routes/sitekharch_new");
const userActFavoriteRoutes = require("./routes/userActFavorite");
const addListFevActRoutes = require("./routes/addlistfevact");

/* ---------------- Routes ---------------- */

// NEW DPR API
app.use("/api/monthdpr", monthDprRoutes);

// Media
app.use("/api/movies", moviesRouter);
app.use("/api/series", seriesRouter);
app.use("/api/download", downloadRouter);

// Generic categories
app.use("/api", allCategoriesRouter);
app.use("/api/category", categoryRouterLegacy);
app.use("/api/subcategory", subcategoryRouterLegacy);

// Admin + favorites + library
app.use("/api/admin", adminRouter);
app.use("/api/favorites", favoriteRouter);
app.use("/api/library", libraryRouter);

// Documents
app.use("/api/documents", documentRouter);

// Work-related
app.use("/api", workDetailsRouter);
app.use("/api/workcategory", workCategoryRouter);

// Inward
app.use("/api/inward", inwardRoutes);
app.use("/api/inward-view", inwardViewOnly);

// Finance / transactions (legacy)
app.use("/api/dailyTransaction", dailyTransactionRouter);
app.use("/api/mainTransaction", mainTransactionRouter);
app.use("/api", monthlySummaryRouterLegacy);
app.use("/api", financeTotalsRouter);

// Transaction categories
app.use("/api/transaction-category", transactionCategoryRouter);
app.use("/api/transaction-category", transactionCategoryWiseRouter);

// Investment Routes
app.use("/api/investment/platform-segment", investmentPlatformSegment);
app.use("/api/investment/plan", investmentPlan);
app.use("/api/investment/tradingjournal", investmentTradingJournal);
app.use("/api/investment/dipwid", investmentDipWid);
app.use("/api/investment/tradingjournal-view", investmentGetViewTradingJournal);
app.use(
  "/api/investment/trading",
  require("./routes/INVESTMENT/investment_newapitrading")
);

// User investment
app.use("/api/user_investment", userInvestmentRoutes);

// Password manager
app.use("/api", passwordManagerRoutes);

// Notes / websites / documents / favorites
app.use("/api/notes-myapp", notesMyAppRoutes);
app.use("/api/notes", notesRoutes);
app.use("/api", websitesRoutes);
app.use("/api/admin_impdocument", adminImpDocumentRouter);
app.use("/api/sitekharch", sitekharchNewRoutes);
app.use("/api/act_favorite", userActFavoriteRoutes);
app.use("/api/add-list-actress", addListFevActRoutes);

/* ---------------- Health Check ---------------- */
app.get("/health", (_req, res) => {
  res.json({ status: "OK" });
});

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