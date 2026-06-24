const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const db = require("../../db");

const router = express.Router();

/* ===============================
   Upload Folder Setup
================================ */
const uploadDir = path.join(__dirname, "../../uploads/telegram-channels");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/* ===============================
   Multer Logo Upload Config
================================ */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);

    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, PNG, and WEBP images are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/* ===============================
   Helper Functions
================================ */
const getBaseUrl = (req) => {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
};

const deleteFile = (filePath, folderPath) => {
  if (!filePath) return;

  const fileName = path.basename(filePath);
  const fullPath = path.join(folderPath, fileName);

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
};

const deleteOldLogo = (logoPath) => {
  deleteFile(logoPath, uploadDir);
};

const deleteChannelNoteImages = async (channelId) => {
  const notesUploadDir = path.join(__dirname, "../../uploads/telegram-notes");

  const result = await db.query(
    `SELECT image_path
     FROM telegram_notes
     WHERE channel_id = $1
       AND image_path IS NOT NULL`,
    [channelId]
  );

  result.rows.forEach((note) => {
    deleteFile(note.image_path, notesUploadDir);
  });
};

const cleanChannelName = (name) => {
  return String(name || "").trim().replace(/\s+/g, " ");
};

/* ===============================
   1. Get All Channels
   GET /api/telegram-channels?user_id=7
================================ */
router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    const result = await db.query(
      `SELECT
          c.channel_id,
          c.user_id,
          c.channel_name,
          c.logo_url,
          c.logo_path,
          c.subscribers_count,
          c.last_message,
          c.last_message_time,
          c.created_at,
          c.updated_at,
          COUNT(n.note_id)::INT AS total_messages
       FROM telegram_channels c
       LEFT JOIN telegram_notes n
          ON n.channel_id = c.channel_id
       WHERE c.user_id = $1
       GROUP BY c.channel_id
       ORDER BY c.updated_at DESC, c.created_at DESC`,
      [user_id]
    );

    res.status(200).json({
      success: true,
      channels: result.rows,
    });
  } catch (error) {
    console.error("Get channels error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching channels",
    });
  }
});

/* ===============================
   2. Get Single Channel
   GET /api/telegram-channels/:channel_id
================================ */
router.get("/:channel_id", async (req, res) => {
  try {
    const { channel_id } = req.params;

    const result = await db.query(
      `SELECT
          c.channel_id,
          c.user_id,
          c.channel_name,
          c.logo_url,
          c.logo_path,
          c.subscribers_count,
          c.last_message,
          c.last_message_time,
          c.created_at,
          c.updated_at,
          COUNT(n.note_id)::INT AS total_messages
       FROM telegram_channels c
       LEFT JOIN telegram_notes n
          ON n.channel_id = c.channel_id
       WHERE c.channel_id = $1
       GROUP BY c.channel_id`,
      [channel_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    res.status(200).json({
      success: true,
      channel: result.rows[0],
    });
  } catch (error) {
    console.error("Get single channel error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching channel",
    });
  }
});

/* ===============================
   3. Create Channel
   POST /api/telegram-channels
   form-data:
   user_id
   channel_name
   logo
================================ */
router.post("/", upload.single("logo"), async (req, res) => {
  try {
    const { user_id, channel_name } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    const finalName = cleanChannelName(channel_name);

    if (!finalName) {
      return res.status(400).json({
        success: false,
        message: "Channel name is required",
      });
    }

    let logoUrl = null;
    let logoPath = null;

    if (req.file) {
      logoPath = `/uploads/telegram-channels/${req.file.filename}`;
      logoUrl = `${getBaseUrl(req)}${logoPath}`;
    }

    const result = await db.query(
      `INSERT INTO telegram_channels
        (
          user_id,
          channel_name,
          logo_url,
          logo_path,
          subscribers_count,
          last_message,
          last_message_time,
          created_at,
          updated_at
        )
       VALUES
        ($1, $2, $3, $4, 1, 'No messages yet', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING
          channel_id,
          user_id,
          channel_name,
          logo_url,
          logo_path,
          subscribers_count,
          last_message,
          last_message_time,
          created_at,
          updated_at`,
      [user_id, finalName, logoUrl, logoPath]
    );

    res.status(201).json({
      success: true,
      message: "Channel created successfully",
      channel: {
        ...result.rows[0],
        total_messages: 0,
      },
    });
  } catch (error) {
    console.error("Create channel error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating channel",
    });
  }
});

/* ===============================
   4. Update Channel
   PUT /api/telegram-channels/:channel_id
   form-data:
   channel_name
   logo
   remove_logo = true / false
================================ */
router.put("/:channel_id", upload.single("logo"), async (req, res) => {
  try {
    const { channel_id } = req.params;
    const { channel_name, remove_logo } = req.body;

    const oldResult = await db.query(
      `SELECT *
       FROM telegram_channels
       WHERE channel_id = $1`,
      [channel_id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    const oldChannel = oldResult.rows[0];

    const finalName =
      cleanChannelName(channel_name) || oldChannel.channel_name;

    let logoUrl = oldChannel.logo_url;
    let logoPath = oldChannel.logo_path;

    if (remove_logo === "true") {
      deleteOldLogo(oldChannel.logo_path);
      logoUrl = null;
      logoPath = null;
    }

    if (req.file) {
      deleteOldLogo(oldChannel.logo_path);

      logoPath = `/uploads/telegram-channels/${req.file.filename}`;
      logoUrl = `${getBaseUrl(req)}${logoPath}`;
    }

    const result = await db.query(
      `UPDATE telegram_channels
       SET
          channel_name = $1,
          logo_url = $2,
          logo_path = $3,
          updated_at = CURRENT_TIMESTAMP
       WHERE channel_id = $4
       RETURNING
          channel_id,
          user_id,
          channel_name,
          logo_url,
          logo_path,
          subscribers_count,
          last_message,
          last_message_time,
          created_at,
          updated_at`,
      [finalName, logoUrl, logoPath, channel_id]
    );

    const countResult = await db.query(
      `SELECT COUNT(note_id)::INT AS total_messages
       FROM telegram_notes
       WHERE channel_id = $1`,
      [channel_id]
    );

    res.status(200).json({
      success: true,
      message: "Channel updated successfully",
      channel: {
        ...result.rows[0],
        total_messages: countResult.rows[0].total_messages,
      },
    });
  } catch (error) {
    console.error("Update channel error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating channel",
    });
  }
});

/* ===============================
   5. Delete Channel
   DELETE /api/telegram-channels/:channel_id
================================ */
router.delete("/:channel_id", async (req, res) => {
  try {
    const { channel_id } = req.params;

    const oldResult = await db.query(
      `SELECT *
       FROM telegram_channels
       WHERE channel_id = $1`,
      [channel_id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    const oldChannel = oldResult.rows[0];

    await deleteChannelNoteImages(channel_id);
    deleteOldLogo(oldChannel.logo_path);

    await db.query(
      `DELETE FROM telegram_channels
       WHERE channel_id = $1`,
      [channel_id]
    );

    res.status(200).json({
      success: true,
      message: "Channel deleted successfully",
      deleted_channel_id: Number(channel_id),
    });
  } catch (error) {
    console.error("Delete channel error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting channel",
    });
  }
});

/* ===============================
   6. Update Last Message
   PATCH /api/telegram-channels/:channel_id/last-message
================================ */
router.patch("/:channel_id/last-message", async (req, res) => {
  try {
    const { channel_id } = req.params;
    const { last_message } = req.body;

    const finalMessage =
      String(last_message || "").trim() || "No messages yet";

    const result = await db.query(
      `UPDATE telegram_channels
       SET
          last_message = $1,
          last_message_time = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
       WHERE channel_id = $2
       RETURNING
          channel_id,
          user_id,
          channel_name,
          logo_url,
          logo_path,
          subscribers_count,
          last_message,
          last_message_time,
          created_at,
          updated_at`,
      [finalMessage, channel_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Last message updated successfully",
      channel: result.rows[0],
    });
  } catch (error) {
    console.error("Update last message error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating last message",
    });
  }
});

module.exports = router;