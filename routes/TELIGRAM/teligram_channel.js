const express = require("express");
const multer = require("multer");
const path = require("path");
const db = require("../../db");

const router = express.Router();

/* ===============================
   Multer Config
   Direct DB upload using memoryStorage
================================ */
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedExt = /jpeg|jpg|png|gif|webp/;

  const allowedMime = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
  ];

  const extname = allowedExt.test(
    path.extname(file.originalname).toLowerCase()
  );

  const mimetype = allowedMime.includes(file.mimetype);

  if (extname && mimetype) {
    return cb(null, true);
  }

  cb(new Error("Only JPG, PNG, GIF, and WEBP images are allowed"), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const uploadLogo = (req, res, next) => {
  upload.single("logo")(req, res, function (error) {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Logo upload failed",
      });
    }

    next();
  });
};

/* ===============================
   Helper Functions
================================ */
const getBaseUrl = (req) => {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
};

const getSafeFileName = (value) => {
  if (!value) return "logo.jpg";

  return path
    .basename(String(value))
    .replace(/[/\\?%*:|"<>]/g, "-")
    .trim();
};

const getLogoUrl = (req, channelId, updatedAt) => {
  const version = updatedAt ? new Date(updatedAt).getTime() : Date.now();

  return `${getBaseUrl(req)}/api/telegram-channels/logo/${channelId}?v=${version}`;
};

const normalizeChannelLogo = (req, channel) => {
  if (!channel) return channel;

  const hasLogo = Boolean(channel.has_logo);

  return {
    ...channel,
    logo_url: hasLogo
      ? getLogoUrl(req, channel.channel_id, channel.updated_at)
      : null,
    logo_path: null,
  };
};

const cleanText = (value) => {
  return String(value || "").trim().replace(/\s+/g, " ");
};

const cleanTagline = (value) => {
  const finalValue = cleanText(value);
  return finalValue || null;
};

const isTrue = (value) => {
  return value === true || value === "true" || value === 1 || value === "1";
};

const cleanPin = (pin) => {
  return String(pin || "").replace(/\D/g, "").slice(0, 4);
};

/* ===============================
   Logo Fetch API
   GET /api/telegram-channels/logo/:channel_id
================================ */
router.get("/logo/:channel_id", async (req, res) => {
  try {
    const { channel_id } = req.params;

    const result = await db.query(
      `SELECT logo_data, logo_mime
       FROM telegram_channels
       WHERE channel_id = $1`,
      [channel_id]
    );

    if (result.rows.length === 0 || !result.rows[0].logo_data) {
      return res.status(404).json({
        success: false,
        message: "Logo not found",
      });
    }

    const logo = result.rows[0];

    const logoBuffer = Buffer.isBuffer(logo.logo_data)
      ? logo.logo_data
      : Buffer.from(logo.logo_data);

    res.setHeader("Content-Type", logo.logo_mime || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");

    return res.end(logoBuffer);
  } catch (error) {
    console.error("Logo fetch error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while fetching logo",
    });
  }
});

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
          c.channel_tagline,
          c.logo_url,
          c.logo_path,
          (c.logo_data IS NOT NULL) AS has_logo,
          c.is_private,
          c.subscribers_count,
          c.last_message,
          c.last_message_time,
          c.created_at,
          c.updated_at,
          (
            SELECT COUNT(n.note_id)::INT
            FROM telegram_notes n
            WHERE n.channel_id = c.channel_id
          ) AS total_messages
       FROM telegram_channels c
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC, c.created_at DESC`,
      [user_id]
    );

    const channels = result.rows.map((channel) =>
      normalizeChannelLogo(req, channel)
    );

    return res.status(200).json({
      success: true,
      channels,
    });
  } catch (error) {
    console.error("Get channels error:", error);

    return res.status(500).json({
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
          c.channel_tagline,
          c.logo_url,
          c.logo_path,
          (c.logo_data IS NOT NULL) AS has_logo,
          c.is_private,
          c.subscribers_count,
          c.last_message,
          c.last_message_time,
          c.created_at,
          c.updated_at,
          (
            SELECT COUNT(n.note_id)::INT
            FROM telegram_notes n
            WHERE n.channel_id = c.channel_id
          ) AS total_messages
       FROM telegram_channels c
       WHERE c.channel_id = $1`,
      [channel_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    return res.status(200).json({
      success: true,
      channel: normalizeChannelLogo(req, result.rows[0]),
    });
  } catch (error) {
    console.error("Get single channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while fetching channel",
    });
  }
});

/* ===============================
   3. Create Channel
   POST /api/telegram-channels

   FormData image field name:
   logo
================================ */
router.post("/", uploadLogo, async (req, res) => {
  try {
    const {
      user_id,
      channel_name,
      channel_tagline,
      is_private,
      private_pin,
    } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    const finalName = cleanText(channel_name);

    if (!finalName) {
      return res.status(400).json({
        success: false,
        message: "Channel name is required",
      });
    }

    const finalTagline = cleanTagline(channel_tagline);
    const finalIsPrivate = isTrue(is_private);
    const finalPrivatePin = finalIsPrivate ? cleanPin(private_pin) : null;

    if (finalIsPrivate && !/^[0-9]{4}$/.test(finalPrivatePin)) {
      return res.status(400).json({
        success: false,
        message: "Private PIN must be exactly 4 digits",
      });
    }

    let logoData = null;
    let logoMime = null;
    let logoName = null;

    if (req.file) {
      logoData = req.file.buffer;
      logoMime = req.file.mimetype;
      logoName = getSafeFileName(req.file.originalname);
    }

    const result = await db.query(
      `INSERT INTO telegram_channels
        (
          user_id,
          channel_name,
          channel_tagline,
          logo_data,
          logo_mime,
          logo_name,
          logo_url,
          logo_path,
          is_private,
          private_pin,
          subscribers_count,
          last_message,
          last_message_time,
          created_at,
          updated_at
        )
       VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          NULL,
          NULL,
          $7,
          $8,
          1,
          'No messages yet',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
       RETURNING
          channel_id,
          user_id,
          channel_name,
          channel_tagline,
          logo_url,
          logo_path,
          (logo_data IS NOT NULL) AS has_logo,
          is_private,
          subscribers_count,
          last_message,
          last_message_time,
          created_at,
          updated_at`,
      [
        user_id,
        finalName,
        finalTagline,
        logoData,
        logoMime,
        logoName,
        finalIsPrivate,
        finalIsPrivate ? finalPrivatePin : null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Channel created successfully",
      channel: {
        ...normalizeChannelLogo(req, result.rows[0]),
        total_messages: 0,
      },
    });
  } catch (error) {
    console.error("Create channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while creating channel",
    });
  }
});

/* ===============================
   4. Update Channel
   PUT /api/telegram-channels/:channel_id

   Update only:
   - channel_name
   - channel_tagline
   - logo
   - remove_logo

   Private status will not change here.
================================ */
router.put("/:channel_id", uploadLogo, async (req, res) => {
  try {
    const { channel_id } = req.params;
    const { channel_name, channel_tagline, remove_logo } = req.body;

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

    const finalName = cleanText(channel_name) || oldChannel.channel_name;

    const finalTagline =
      channel_tagline === undefined
        ? oldChannel.channel_tagline
        : cleanTagline(channel_tagline);

    let logoData = oldChannel.logo_data;
    let logoMime = oldChannel.logo_mime;
    let logoName = oldChannel.logo_name;

    if (remove_logo === "true" || remove_logo === true) {
      logoData = null;
      logoMime = null;
      logoName = null;
    }

    if (req.file) {
      logoData = req.file.buffer;
      logoMime = req.file.mimetype;
      logoName = getSafeFileName(req.file.originalname);
    }

    const result = await db.query(
      `UPDATE telegram_channels
       SET
          channel_name = $1,
          channel_tagline = $2,
          logo_data = $3,
          logo_mime = $4,
          logo_name = $5,
          logo_url = NULL,
          logo_path = NULL,
          updated_at = CURRENT_TIMESTAMP
       WHERE channel_id = $6
       RETURNING
          channel_id,
          user_id,
          channel_name,
          channel_tagline,
          logo_url,
          logo_path,
          (logo_data IS NOT NULL) AS has_logo,
          is_private,
          subscribers_count,
          last_message,
          last_message_time,
          created_at,
          updated_at`,
      [
        finalName,
        finalTagline,
        logoData,
        logoMime,
        logoName,
        channel_id,
      ]
    );

    const countResult = await db.query(
      `SELECT COUNT(note_id)::INT AS total_messages
       FROM telegram_notes
       WHERE channel_id = $1`,
      [channel_id]
    );

    return res.status(200).json({
      success: true,
      message: "Channel updated successfully",
      channel: {
        ...normalizeChannelLogo(req, result.rows[0]),
        total_messages: countResult.rows[0].total_messages,
      },
    });
  } catch (error) {
    console.error("Update channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while updating channel",
    });
  }
});

/* ===============================
   5. Verify Private Channel PIN
   POST /api/telegram-channels/:channel_id/verify-pin
================================ */
router.post("/:channel_id/verify-pin", async (req, res) => {
  try {
    const { channel_id } = req.params;
    const { pin } = req.body;

    const finalPin = cleanPin(pin);

    if (!/^[0-9]{4}$/.test(finalPin)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 4 digit PIN",
        unlocked: false,
      });
    }

    const result = await db.query(
      `SELECT
          channel_id,
          channel_name,
          is_private,
          private_pin
       FROM telegram_channels
       WHERE channel_id = $1`,
      [channel_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
        unlocked: false,
      });
    }

    const channel = result.rows[0];

    if (!channel.is_private) {
      return res.status(200).json({
        success: true,
        message: "Channel is public",
        unlocked: true,
      });
    }

    if (String(channel.private_pin) !== String(finalPin)) {
      return res.status(401).json({
        success: false,
        message: "Wrong PIN",
        unlocked: false,
      });
    }

    return res.status(200).json({
      success: true,
      message: "PIN verified successfully",
      unlocked: true,
    });
  } catch (error) {
    console.error("Verify PIN error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while verifying PIN",
      unlocked: false,
    });
  }
});

/* ===============================
   6. Delete Channel
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

    await db.query(
      `DELETE FROM telegram_channels
       WHERE channel_id = $1`,
      [channel_id]
    );

    return res.status(200).json({
      success: true,
      message: "Channel deleted successfully",
      deleted_channel_id: Number(channel_id),
    });
  } catch (error) {
    console.error("Delete channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while deleting channel",
    });
  }
});

/* ===============================
   7. Update Last Message
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
          channel_tagline,
          logo_url,
          logo_path,
          (logo_data IS NOT NULL) AS has_logo,
          is_private,
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

    return res.status(200).json({
      success: true,
      message: "Last message updated successfully",
      channel: normalizeChannelLogo(req, result.rows[0]),
    });
  } catch (error) {
    console.error("Update last message error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while updating last message",
    });
  }
});

module.exports = router;