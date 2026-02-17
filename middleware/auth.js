// src/middleware/auth.js
const jwt = require("jsonwebtoken");

function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: "Token missing" });

    // ✅ token मध्ये user_id असणे expected
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded?.user_id) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    req.user = { user_id: decoded.user_id, role: decoded.role || "ADMIN" };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized", error: err.message });
  }
}

module.exports = auth;
