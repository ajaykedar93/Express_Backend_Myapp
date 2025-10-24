// db.js
const { Pool, types } = require("pg"); // ✅ include 'types'

// Parse Postgres DATE (1082) and TIMESTAMP WITHOUT TIMEZONE (1114) as plain strings
types.setTypeParser(1082, (val) => val); // DATE → 'YYYY-MM-DD' string
types.setTypeParser(1114, (val) => val); // TIMESTAMP WITHOUT TZ → string as-is

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // from .env
  ssl: { rejectUnauthorized: false }, // required for Supabase or hosted Postgres

  // Recommended stability options
  max: 10,                     // maximum number of clients in the pool
  idleTimeoutMillis: 30000,    // close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // fail if connection takes >10s
  keepAlive: true,             // prevent network idle timeouts
});

// Catch unexpected idle client errors
pool.on("error", (err) => {
  console.error("[PG Pool Error] Unexpected idle client error:", err);
});

// Export the pool for app-wide use
module.exports = pool;
