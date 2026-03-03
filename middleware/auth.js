// src/middleware/auth.js
const jwt = require("jsonwebtoken");

function auth(req, res, next) {
  try {
    // ✅ Authorization header read
    const authHeader = req.headers.authorization || "";

    // ✅ Support: "Bearer <token>"
    let token = null;

    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }

    // Optional fallback (if frontend sends custom header)
    if (!token && req.headers["x-auth-token"]) {
      token = String(req.headers["x-auth-token"]).trim();
    }

    if (!token) {
      return res.status(401).json({ message: "Token missing" });
    }

    // ✅ Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded || !decoded.user_id) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    // ✅ Attach user to request
    req.user = {
      user_id: decoded.user_id,
      role: decoded.role || "ADMIN",
    };

    next();
  } catch (err) {
    return res.status(401).json({
      message: "Unauthorized or Token Expired",
      error: err.message,
    });
  }
}

module.exports = auth;