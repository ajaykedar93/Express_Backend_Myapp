const express = require("express");
const multer = require("multer");
const path = require("path");
const db = require("../../db");

const router = express.Router();

/* =========================================================
   TRUSTED DEVICE SECURITY
   - Trust is stored in PostgreSQL, not only localStorage.
   - trusted_pin_version stores telegram_channels.pin_updated_at.
   - pin_updated_at changes ONLY when private_pin/is_private changes.
   - Changing channel name/logo/last message does NOT invalidate trust.
   - Changing the PIN in PgAdmin automatically invalidates old trust.
========================================================= */
const ensurePinVersionColumn = async () => {
  await db.query(`
    ALTER TABLE telegram_channels
    ADD COLUMN IF NOT EXISTS pin_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  await db.query(`
    UPDATE telegram_channels
    SET pin_updated_at = COALESCE(pin_updated_at, updated_at, CURRENT_TIMESTAMP)
    WHERE pin_updated_at IS NULL
  `);

  await db.query(`
    CREATE OR REPLACE FUNCTION public.update_telegram_channel_pin_version()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.private_pin IS DISTINCT FROM OLD.private_pin
         OR NEW.is_private IS DISTINCT FROM OLD.is_private THEN
        NEW.pin_updated_at = CURRENT_TIMESTAMP;
      ELSE
        NEW.pin_updated_at = OLD.pin_updated_at;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.query(`
    DROP TRIGGER IF EXISTS trg_telegram_channel_pin_version
    ON public.telegram_channels
  `);

  await db.query(`
    CREATE TRIGGER trg_telegram_channel_pin_version
    BEFORE UPDATE ON public.telegram_channels
    FOR EACH ROW
    EXECUTE FUNCTION public.update_telegram_channel_pin_version()
  `);
};

ensurePinVersionColumn().catch((error) => {
  console.error("PIN version initialization error:", error);
});

const ensureTrustedDeviceTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS telegram_channel_trusted_devices (
      trust_id SERIAL PRIMARY KEY,
      channel_id INT NOT NULL,
      user_id INT NOT NULL,
      device_id VARCHAR(120) NOT NULL,
      trusted_pin_version TIMESTAMP NOT NULL,
      trusted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (channel_id, user_id, device_id)
    )
  `);

  await db.query(`
    ALTER TABLE telegram_channel_trusted_devices
    ADD COLUMN IF NOT EXISTS trusted_pin_version TIMESTAMP
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_tctd_lookup
    ON telegram_channel_trusted_devices(channel_id, user_id, device_id)
  `);
};

ensureTrustedDeviceTable().catch((error) => {
  console.error("Trusted device table initialization error:", error);
});

const isTrustedDevice = async (channelId, userId, deviceId, pinVersion) => {
  const result = await db.query(
    `SELECT 1
     FROM telegram_channel_trusted_devices
     WHERE channel_id = $1
       AND user_id = $2
       AND device_id = $3
       AND trusted_pin_version = $4
     LIMIT 1`,
    [Number(channelId), Number(userId), cleanDeviceId(deviceId), pinVersion]
  );

  return result.rows.length > 0;
};

const saveTrustedDevice = async (
  channelId,
  userId,
  deviceId,
  pinVersion
) => {
  const cleanDevice = cleanDeviceId(deviceId);

  if (!cleanDevice || !pinVersion) return false;

  await db.query(
    `INSERT INTO telegram_channel_trusted_devices
       (channel_id, user_id, device_id, trusted_pin_version, trusted_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (channel_id, user_id, device_id)
     DO UPDATE SET
       trusted_pin_version = EXCLUDED.trusted_pin_version,
       trusted_at = CURRENT_TIMESTAMP`,
    [
      Number(channelId),
      Number(userId),
      cleanDevice,
      pinVersion,
    ]
  );

  return true;
};

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
    path.extname(file.originalname || "").toLowerCase()
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

  // Never expose private_pin or created_device_id in public response.
  const { private_pin, created_device_id, logo_data, logo_mime, logo_name, ...safeChannel } =
    channel;

  return {
    ...safeChannel,
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

const cleanDeviceId = (value) => {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "")
    .slice(0, 120);
};

const getRequestDeviceId = (req) => {
  return cleanDeviceId(
    req.headers["x-device-id"] ||
      req.body?.device_id ||
      req.body?.sender_device_id ||
      req.body?.created_device_id ||
      req.query?.device_id ||
      ""
  );
};

const getRequestPin = (req) => {
  return cleanPin(
    req.headers["x-channel-pin"] ||
      req.body?.pin ||
      req.body?.private_pin ||
      req.query?.pin ||
      ""
  );
};

const setNoStoreHeaders = (res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
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

   Public channel:
   - created_device_id OR device_id required
   - delete later requires same device

   Private channel:
   - private_pin required
   - open/delete requires same PIN only
================================ */
router.post("/", uploadLogo, async (req, res) => {
  try {
    const {
      user_id,
      channel_name,
      channel_tagline,
      is_private,
      private_pin,
      created_device_id,
      device_id,
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
    const finalDeviceId = cleanDeviceId(created_device_id || device_id);
    const finalPrivatePin = finalIsPrivate ? cleanPin(private_pin) : null;

    if (!finalIsPrivate && !finalDeviceId) {
      return res.status(400).json({
        success: false,
        message: "created_device_id or device_id is required for public channel",
      });
    }

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
          created_device_id,
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
          $9,
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
        finalDeviceId || null,
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
      [finalName, finalTagline, logoData, logoMime, logoName, channel_id]
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
        total_messages: countResult.rows[0]?.total_messages || 0,
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

/* =========================================================
   5A. FAST BACKGROUND ACCESS CHECK
   POST /api/telegram-channels/:channel_id/access-check

   Frontend calls this BEFORE opening a channel.
   No channel page is opened until the result is known.

   Public channel:
     allowed=true, needs_pin=false

   Private + trusted device + same PIN version:
     allowed=true, needs_pin=false

   Private + missing/wrong/old trust:
     allowed=false, needs_pin=true

   This endpoint NEVER returns the private PIN.
========================================================= */
router.post("/:channel_id/access-check", async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const channelId = Number(req.params.channel_id);
    const userId = Number(req.body?.user_id);
    const deviceId = getRequestDeviceId(req);

    if (!Number.isInteger(channelId) || channelId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid channel_id",
        allowed: false,
        needs_pin: false,
        trusted_device: false,
      });
    }

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
        allowed: false,
        needs_pin: false,
        trusted_device: false,
      });
    }

    const result = await db.query(
      `SELECT
         channel_id,
         channel_name,
         is_private,
         updated_at
       FROM telegram_channels
       WHERE channel_id = $1
       LIMIT 1`,
      [channelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
        allowed: false,
        needs_pin: false,
        trusted_device: false,
      });
    }

    const channel = result.rows[0];

    if (!isTrue(channel.is_private)) {
      return res.status(200).json({
        success: true,
        message: "Public channel access allowed",
        allowed: true,
        needs_pin: false,
        trusted_device: false,
        is_private: false,
      });
    }

    if (!deviceId) {
      return res.status(200).json({
        success: true,
        message: "This device is not trusted. Enter PIN.",
        allowed: false,
        needs_pin: true,
        trusted_device: false,
        is_private: true,
      });
    }

    const trusted = await isTrustedDevice(
      channelId,
      userId,
      deviceId,
      channel.pin_updated_at
    );

    if (trusted) {
      return res.status(200).json({
        success: true,
        message: "Trusted device",
        allowed: true,
        needs_pin: false,
        trusted_device: true,
        is_private: true,
      });
    }

    return res.status(200).json({
      success: true,
      message: "This device is not trusted or PIN was changed. Enter PIN.",
      allowed: false,
      needs_pin: true,
      trusted_device: false,
      is_private: true,
    });
  } catch (error) {
    console.error("Channel access-check error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while checking channel access",
      allowed: false,
      needs_pin: false,
      trusted_device: false,
    });
  }
});

router.post("/:channel_id/verify-pin", async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const { channel_id } = req.params;
    const finalPin = cleanPin(req.body?.pin || req.body?.private_pin || "");

    if (!/^\d{4}$/.test(finalPin)) {
      return res.status(200).json({
        success: false,
        message: "Enter valid 4 digit PIN",
        unlocked: false,
        verified: false,
        valid: false,
        pin_match: false,
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
        verified: false,
        valid: false,
        pin_match: false,
      });
    }

    const channel = result.rows[0];

    if (!isTrue(channel.is_private)) {
      return res.status(200).json({
        success: true,
        message: "Channel is public",
        unlocked: true,
        verified: true,
        valid: true,
        pin_match: true,
      });
    }

    const storedPin = cleanPin(channel.private_pin);

    if (!/^\d{4}$/.test(storedPin) || storedPin !== finalPin) {
      return res.status(200).json({
        success: false,
        message: "Wrong PIN",
        unlocked: false,
        verified: false,
        valid: false,
        pin_match: false,
      });
    }

    const trustDevice =
      req.body?.trust_device === true ||
      req.body?.trust_device === "true" ||
      req.body?.remember_device === true ||
      req.body?.remember_device === "true";

    const userId = Number(req.body?.user_id);
    const deviceId = getRequestDeviceId(req);

    let trustedDevice = false;

    if (
      trustDevice &&
      Number.isInteger(userId) &&
      userId > 0 &&
      deviceId
    ) {
      // Read the current version AFTER successful PIN validation.
      // A future PgAdmin PIN update changes updated_at, invalidating
      // this trust automatically.
      const versionResult = await db.query(
        `SELECT updated_at
         FROM telegram_channels
         WHERE channel_id = $1
         LIMIT 1`,
        [channel.channel_id]
      );

      const currentPinVersion = versionResult.rows[0]?.updated_at;

      trustedDevice = await saveTrustedDevice(
        channel.channel_id,
        userId,
        deviceId,
        currentPinVersion
      );
    }

    return res.status(200).json({
      success: true,
      message: trustedDevice
        ? "PIN verified and device trusted successfully"
        : "PIN verified successfully",
      unlocked: true,
      verified: true,
      valid: true,
      pin_match: true,
      allowed: true,
      needs_pin: false,
      trusted_device: trustedDevice,
    });
  } catch (error) {
    console.error("Verify PIN error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while verifying PIN",
      unlocked: false,
      verified: false,
      valid: false,
      pin_match: false,
    });
  }
});

/* ===============================
   6. Delete Channel
   DELETE /api/telegram-channels/:channel_id

   Public channel:
   - same created device only

   Private channel:
   - correct same PIN only
   - no device id check
================================ */
router.delete("/:channel_id", async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const { channel_id } = req.params;

    const requestDeviceId = getRequestDeviceId(req);
    const requestPin = getRequestPin(req);

    const oldResult = await db.query(
      `SELECT
          channel_id,
          channel_name,
          is_private,
          private_pin,
          created_device_id
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

    const channel = oldResult.rows[0];
    const privateChannel = isTrue(channel.is_private);

    if (privateChannel) {
      const storedPin = cleanPin(channel.private_pin);

      if (!/^[0-9]{4}$/.test(requestPin)) {
        return res.status(400).json({
          success: false,
          message: "Enter valid 4 digit PIN",
        });
      }

      if (!/^[0-9]{4}$/.test(storedPin) || storedPin !== requestPin) {
        return res.status(401).json({
          success: false,
          message: "Wrong PIN",
        });
      }
    } else {
      const storedDeviceId = cleanDeviceId(channel.created_device_id);

      if (!requestDeviceId) {
        return res.status(400).json({
          success: false,
          message: "device_id is required",
        });
      }

      if (!storedDeviceId) {
        return res.status(403).json({
          success: false,
          message:
            "Delete blocked. This public channel has no creator device saved.",
        });
      }

      if (String(storedDeviceId) !== String(requestDeviceId)) {
        return res.status(403).json({
          success: false,
          message:
            "Delete blocked. Only the device that created this public channel can delete it.",
        });
      }
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

    const finalMessage = String(last_message || "").trim() || "No messages yet";

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