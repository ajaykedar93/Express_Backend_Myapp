// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const morgan = require("morgan");

const app = express();

/* ----------------------- Prod hardening & fast defaults ----------------------- */
// Hide Express signature
app.disable("x-powered-by");

// Security headers (kept lightweight to avoid perf hit)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// HTTP compression (gzip/br) for faster responses
app.use(compression());

// Ultra-lean logging (skip in production if you want absolute minimum overhead)
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("tiny"));
}

/* ----------------------- CORS (cache preflights) ----------------------- */
const allowedOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim());

const corsOptions = {
  origin: allowedOrigins.length && allowedOrigins[0] !== "*" ? allowedOrigins : true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400, // cache preflight for 24h (huge win on Render)
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/* ----------------------- Parsers (keep light globally) ----------------------- */
// Keep global parsers small; use per-route large limits only where needed
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

/* ----------------------- HTTP caching & ETags ----------------------- */
// Strong ETags help with client/proxy caching
app.set("etag", "strong");

// Sensible default cache headers for idempotent GETs
app.use((req, res, next) => {
  if (req.method === "GET") {
    // public cache for 60s, shared (CDN/proxy) 5 min, allow stale while revalidating
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
  }
  next();
});

/* ----------------------- Micro-cache for GETs (memory LRU-style) ----------------------- */
// ~1 minute micro-cache to shave repeated hits on Render instances
const microCache = new Map(); // key -> { body, headers, status, exp }
const MICRO_TTL_MS = 60 * 1000;

function cacheKey(req) {
  // Cache by full URL + accept encoding (safe for compressed output)
  return `${req.method}:${req.originalUrl}|ae=${req.headers["accept-encoding"] || ""}`;
}

app.use((req, res, next) => {
  if (req.method !== "GET") return next();

  const key = cacheKey(req);
  const now = Date.now();
  const hit = microCache.get(key);

  if (hit && hit.exp > now) {
    // Serve from cache
    res.status(hit.status);
    for (const [h, v] of Object.entries(hit.headers)) {
      res.setHeader(h, v);
    }
    return res.end(hit.body);
  }

  // Capture response
  const originalWrite = res.write;
  const originalEnd = res.end;
  const chunks = [];

  res.write = function (chunk, ...args) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return originalWrite.call(this, chunk, ...args);
  };

  res.end = function (chunk, ...args) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyBuffer = Buffer.concat(chunks);

    // Only cache successful, cacheable responses
    if (res.statusCode >= 200 && res.statusCode < 400) {
      const headers = {};
      for (const [h, v] of Object.entries(res.getHeaders())) {
        // Avoid caching set-cookie (session/secure stuff)
        if (String(h).toLowerCase() !== "set-cookie") headers[h] = v;
      }
      microCache.set(key, {
        body: bodyBuffer,
        headers,
        status: res.statusCode,
        exp: Date.now() + MICRO_TTL_MS,
      });
    }

    return originalEnd.call(this, bodyBuffer, ...args);
  };

  next();
});

/* ----------------------- Routers (imports) ----------------------- */
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
const inwardRouter = require("./routes/inward");
const siteKharchRouter = require("./routes/site_kharch");
const workCategoryRouter = require("./routes/workcategory");

// Transactions / Summaries (legacy finance flows)
const dailyTransactionRouter = require("./routes/dailyTransaction");
const mainTransactionRouter = require("./routes/mainTransaction");
const monthlySummaryRouterLegacy = require("./routes/monthlySummary");
const financeTotalsRouter = require("./routes/financeTotals");

// Transaction categories
const transactionCategoryRouter = require("./routes/transactioncategory");
const transactionCategoryWiseRouter = require("./routes/transactionscategorywise");

// Investment module
const invCategoryRouter = require("./routes/investment_category");
const invSubcategoryRouter = require("./routes/investment_subcategory");
const invDepositRouter = require("./routes/investment_deposit_logic");
const monthSummaryRouter = require("./routes/investment_month_summary");
const investmentTradingJournalRouter = require("./routes/investment_tradingjournal");

const userInvestmentRoutes = require("./routes/user_investment");
const passwordManagerRoutes = require("./routes/passwordManager");
const adminImpDocumentRouter = require("./routes/imodocument");

// Extra routers
const actFavoriteRouter = require("./routes/actFavorite");
const notesRouter = require("./routes/notes");
const websitesRouter = require("./routes/websites");

/* ----------------------- Routes (kept identical) ----------------------- */
// Media
app.use("/api/movies", moviesRouter);
app.use("/api/series", seriesRouter);
app.use("/api/download", downloadRouter);

// Generic categories
app.use("/api", allCategoriesRouter);            // e.g. /api/Allcategories
app.use("/api/category", categoryRouterLegacy);  // legacy
app.use("/api/subcategory", subcategoryRouterLegacy);

// Admin + favorites + library
app.use("/api/admin", adminRouter);
app.use("/api/favorites", favoriteRouter);
app.use("/api/library", libraryRouter);

// Documents
app.use("/api/documents", documentRouter);

// Work-related
app.use("/api", workDetailsRouter);
app.use("/api", inwardRouter);
app.use("/api", siteKharchRouter);
app.use("/api/workcategory", workCategoryRouter);

// Finance / transactions (legacy)
app.use("/api/dailyTransaction", dailyTransactionRouter);
app.use("/api/mainTransaction", mainTransactionRouter);
app.use("/api", monthlySummaryRouterLegacy);
app.use("/api", financeTotalsRouter);

// Transaction categories
app.use("/api/transaction-category", transactionCategoryRouter);
// unique base (no clash)
app.use("/api/transaction-category", transactionCategoryWiseRouter);

// Investment (new)
app.use("/api/investment_category", invCategoryRouter);
app.use("/api/investment_subcategory", invSubcategoryRouter);
app.use("/api/deposits", invDepositRouter);
app.use("/api/monthly_summary", monthSummaryRouter);
app.use("/api/trading_journal", investmentTradingJournalRouter);

// User investment + other utilities
app.use("/api/user_investment", userInvestmentRoutes);
app.use("/api", passwordManagerRoutes);
app.use("/api/act_favorite", actFavoriteRouter);
app.use("/api/notes", notesRouter);
app.use("/api", websitesRouter);
app.use("/api/admin_impdocument", adminImpDocumentRouter);

/* ----------------------- Health Check ----------------------- */
app.get("/health", (_req, res) => res.json({ status: "OK" }));

/* ----------------------- 404 ----------------------- */
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ error: "Route not found" });
});

/* ----------------------- Global Error Handler ----------------------- */
app.use((err, _req, res, _next) => {
  console.error("Unhandled Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Something went wrong!",
  });
});

/* ----------------------- Start Server ----------------------- */
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// Keep-alive for large/slow uploads (Render routers/load balancers are strict)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

module.exports = app;
