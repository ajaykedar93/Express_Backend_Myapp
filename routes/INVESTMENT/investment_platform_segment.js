// src/routes/investment/investment_platfrom_segment.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");

// ===================== PLATFORM =====================

// GET platforms
router.get("/platform", auth, async (req, res) => {
  const userId = req.user.user_id;
  try {
    const { rows } = await pool.query(
      `SELECT platform_id, platform_name, created_at
       FROM investment_platform
       WHERE user_id = $1
       ORDER BY platform_name ASC`,
      [userId]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Platform fetch failed", error: e.message });
  }
});

// POST platform
router.post("/platform", auth, async (req, res) => {
  const userId = req.user.user_id;
  const { platform_name } = req.body;

  if (!platform_name?.trim()) return res.status(400).json({ message: "platform_name required" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO investment_platform (user_id, platform_name)
       VALUES ($1, $2)
       RETURNING platform_id, platform_name, created_at`,
      [userId, platform_name.trim()]
    );
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Platform create failed", error: e.message });
  }
});

// PUT platform
router.put("/platform/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const id = Number(req.params.id);
  const { platform_name } = req.body;

  if (!id) return res.status(400).json({ message: "Invalid platform_id" });
  if (!platform_name?.trim()) return res.status(400).json({ message: "platform_name required" });

  try {
    const { rows } = await pool.query(
      `UPDATE investment_platform
       SET platform_name = $1
       WHERE user_id = $2 AND platform_id = $3
       RETURNING platform_id, platform_name, created_at`,
      [platform_name.trim(), userId, id]
    );
    if (!rows.length) return res.status(404).json({ message: "Platform not found" });
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Platform update failed", error: e.message });
  }
});

// DELETE platform
router.delete("/platform/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const id = Number(req.params.id);

  if (!id) return res.status(400).json({ message: "Invalid platform_id" });

  try {
    const result = await pool.query(
      `DELETE FROM investment_platform
       WHERE user_id = $1 AND platform_id = $2`,
      [userId, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Platform not found" });
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Platform delete failed", error: e.message });
  }
});

// ===================== SEGMENT =====================

// GET segments (by platform_id optional)
router.get("/segment", auth, async (req, res) => {
  const userId = req.user.user_id;
  const platformId = req.query.platform_id ? Number(req.query.platform_id) : null;

  try {
    const { rows } = await pool.query(
      `SELECT segment_id, platform_id, segment_name, is_options, created_at
       FROM investment_segment
       WHERE user_id = $1
         AND ($2::bigint IS NULL OR platform_id = $2)
       ORDER BY segment_name ASC`,
      [userId, platformId]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: "Segment fetch failed", error: e.message });
  }
});

// POST segment
router.post("/segment", auth, async (req, res) => {
  const userId = req.user.user_id;
  const { platform_id, segment_name, is_options } = req.body;

  const pid = Number(platform_id);
  if (!pid) return res.status(400).json({ message: "platform_id required" });
  if (!segment_name?.trim()) return res.status(400).json({ message: "segment_name required" });

  try {
    // ownership check platform belongs to same user
    const p = await pool.query(
      `SELECT 1 FROM investment_platform WHERE user_id=$1 AND platform_id=$2`,
      [userId, pid]
    );
    if (!p.rowCount) return res.status(400).json({ message: "Invalid platform for user" });

    const { rows } = await pool.query(
      `INSERT INTO investment_segment (user_id, platform_id, segment_name, is_options)
       VALUES ($1, $2, $3, $4)
       RETURNING segment_id, platform_id, segment_name, is_options, created_at`,
      [userId, pid, segment_name.trim(), !!is_options]
    );
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Segment create failed", error: e.message });
  }
});

// PUT segment
router.put("/segment/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const sid = Number(req.params.id);
  const { segment_name, is_options } = req.body;

  if (!sid) return res.status(400).json({ message: "Invalid segment_id" });
  if (!segment_name?.trim()) return res.status(400).json({ message: "segment_name required" });

  try {
    const { rows } = await pool.query(
      `UPDATE investment_segment
       SET segment_name=$1, is_options=$2
       WHERE user_id=$3 AND segment_id=$4
       RETURNING segment_id, platform_id, segment_name, is_options, created_at`,
      [segment_name.trim(), !!is_options, userId, sid]
    );
    if (!rows.length) return res.status(404).json({ message: "Segment not found" });
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: "Segment update failed", error: e.message });
  }
});

// DELETE segment
router.delete("/segment/:id", auth, async (req, res) => {
  const userId = req.user.user_id;
  const sid = Number(req.params.id);

  if (!sid) return res.status(400).json({ message: "Invalid segment_id" });

  try {
    const result = await pool.query(
      `DELETE FROM investment_segment
       WHERE user_id=$1 AND segment_id=$2`,
      [userId, sid]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Segment not found" });
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ message: "Segment delete failed", error: e.message });
  }
});

module.exports = router;
