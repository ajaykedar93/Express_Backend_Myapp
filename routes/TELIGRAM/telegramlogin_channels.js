const express = require("express");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const db = require("../../db");

const router = express.Router();

/* ===============================
   Config
================================ */
const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

/* ===============================
   Multer Config - Channel Logo
================================ */
const storage = multer.memoryStorage();

const imageFileFilter = (req, file, cb) => {
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
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const uploadChannelLogo = (req, res, next) => {
  upload.single("channel_logo")(req, res, function (error) {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Channel logo upload failed",
      });
    }

    next();
  });
};

/* ===============================
   Helpers
================================ */
const cleanText = (value) => String(value || "").trim();

const cleanEmail = (value) => String(value || "").trim().toLowerCase();

const isValidId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0;
};

const isValidPin = (pin) => {
  return /^\d{4,8}$/.test(String(pin || "").trim());
};

const getDeviceId = (req) => {
  return cleanText(
    req.body.device_id ||
      req.query.device_id ||
      req.headers["x-device-id"] ||
      req.headers["device-id"]
  );
};

const normalizeChannelType = (value) => {
  const type = cleanText(value).toLowerCase();

  if (type === "private") return "private";

  return "public";
};

const normalizeChannel = (channel) => {
  if (!channel) return null;

  return {
    channel_id: channel.channel_id,
    channel_uuid: channel.channel_uuid,
    created_by_user_id: channel.created_by_user_id,
    created_by_name: channel.created_by_name || "",
    channel_name: channel.channel_name,
    channel_description: channel.channel_description || "",
    channel_type: channel.channel_type,
    is_public: channel.channel_type === "public",
    security_pin_required: Boolean(channel.security_pin_hash),
    channel_logo_url: channel.has_channel_logo
      ? `/api/telegramlogin-channels/logo/${channel.channel_id}`
      : "",
    share_code: channel.share_code,
    share_link: `/channel/join/${channel.share_code}`,
    api_join_url: `/api/telegramlogin-channels/join/${channel.share_code}`,
    created_device_id: channel.created_device_id,
    is_active: channel.is_active,
    is_deleted: channel.is_deleted,
    member_role: channel.member_role || "",
    member_status: channel.member_status || "",
    pin_verified_at: channel.pin_verified_at || null,
    last_opened_at: channel.last_opened_at || null,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
  };
};

const getChannelSelectSql = () => {
  return `
    c.channel_id,
    c.channel_uuid,
    c.created_by_user_id,
    u.full_name AS created_by_name,
    c.channel_name,
    c.channel_description,
    c.channel_type,
    c.security_pin_hash,
    (c.channel_logo_data IS NOT NULL) AS has_channel_logo,
    c.share_code,
    c.created_device_id,
    c.is_active,
    c.is_deleted,
    c.created_at,
    c.updated_at
  `;
};

/* ===============================
   Auth Middleware
================================ */
const authenticateTelegramUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const telegramUserId = Number(decoded.telegram_user_id);

    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    const result = await db.query(
      `
        SELECT telegram_user_id, full_name, email, mobile_no, is_active
        FROM telegram_users
        WHERE telegram_user_id = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [telegramUserId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "User not found or inactive",
      });
    }

    req.telegramUser = result.rows[0];
    req.telegramUserId = telegramUserId;

    return next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Invalid authorization token",
    });
  }
};

/* ===============================
   Permission Helpers
================================ */
const getChannelForUser = async ({ channelId, userId }) => {
  const result = await db.query(
    `
      SELECT
        ${getChannelSelectSql()},
        m.member_role,
        m.member_status,
        m.pin_verified_at,
        m.last_opened_at
      FROM telegramlogin_channellist c
      JOIN telegram_users u
        ON u.telegram_user_id = c.created_by_user_id
      LEFT JOIN telegramlogin_channel_members m
        ON m.channel_id = c.channel_id
       AND m.telegram_user_id = $2
      WHERE c.channel_id = $1
        AND c.is_deleted = FALSE
      LIMIT 1
    `,
    [channelId, userId]
  );

  return result.rows[0] || null;
};

const requireOwnerOrAdmin = async ({ channelId, userId }) => {
  const result = await db.query(
    `
      SELECT member_role, member_status
      FROM telegramlogin_channel_members
      WHERE channel_id = $1
        AND telegram_user_id = $2
        AND member_status = 'active'
        AND member_role IN ('owner', 'admin')
      LIMIT 1
    `,
    [channelId, userId]
  );

  return result.rows.length > 0;
};

/* ===============================
   API 1: Health Check
   GET /api/telegramlogin-channels/health
================================ */
router.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Telegram login channels API is running",
  });
});

/* ===============================
   API 2: Create Channel
   POST /api/telegramlogin-channels/create

   Header:
   Authorization: Bearer <token>

   form-data:
   channel_name
   channel_description optional
   channel_type public/private
   security_pin required for private
   device_id required
   channel_logo optional
================================ */
router.post(
  "/create",
  authenticateTelegramUser,
  uploadChannelLogo,
  async (req, res) => {
    try {
      const channelName = cleanText(req.body.channel_name);
      const channelDescription = cleanText(req.body.channel_description);
      const channelType = normalizeChannelType(req.body.channel_type);
      const securityPin = cleanText(req.body.security_pin);
      const createdDeviceId = getDeviceId(req);

      if (channelName.length < 3) {
        return res.status(400).json({
          success: false,
          message: "Channel name must be at least 3 characters",
        });
      }

      if (!createdDeviceId) {
        return res.status(400).json({
          success: false,
          message: "Device id is required",
        });
      }

      if (channelType === "private" && !isValidPin(securityPin)) {
        return res.status(400).json({
          success: false,
          message: "Private channel requires 4 to 8 digit security PIN",
        });
      }

      let securityPinHash = null;

      if (securityPin) {
        if (!isValidPin(securityPin)) {
          return res.status(400).json({
            success: false,
            message: "Security PIN must be 4 to 8 digits",
          });
        }

        securityPinHash = await bcrypt.hash(securityPin, 12);
      }

      const logoBuffer = req.file ? req.file.buffer : null;
      const logoMime = req.file ? req.file.mimetype : null;
      const logoName = req.file ? req.file.originalname : null;
      const logoSize = req.file ? req.file.size : null;

      const result = await db.query(
        `
          INSERT INTO telegramlogin_channellist
            (
              created_by_user_id,
              channel_name,
              channel_description,
              channel_type,
              channel_logo_data,
              channel_logo_mime,
              channel_logo_name,
              channel_logo_size,
              security_pin_hash,
              created_device_id
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING
            channel_id,
            channel_uuid,
            created_by_user_id,
            channel_name,
            channel_description,
            channel_type,
            security_pin_hash,
            (channel_logo_data IS NOT NULL) AS has_channel_logo,
            share_code,
            created_device_id,
            is_active,
            is_deleted,
            created_at,
            updated_at
        `,
        [
          req.telegramUserId,
          channelName,
          channelDescription || null,
          channelType,
          logoBuffer,
          logoMime,
          logoName,
          logoSize,
          securityPinHash,
          createdDeviceId,
        ]
      );

      const channel = {
        ...result.rows[0],
        created_by_name: req.telegramUser.full_name,
        member_role: "owner",
        member_status: "active",
        pin_verified_at: null,
      };

      return res.status(201).json({
        success: true,
        message: "Channel created successfully",
        channel: normalizeChannel(channel),
      });
    } catch (error) {
      console.error("Create channel error:", error);

      return res.status(500).json({
        success: false,
        message: "Server error while creating channel",
      });
    }
  }
);

/* ===============================
   API 3: Get Channel Logo
   GET /api/telegramlogin-channels/logo/:id
================================ */
router.get("/logo/:id", async (req, res) => {
  try {
    const channelId = Number(req.params.id);

    if (!isValidId(channelId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid channel id",
      });
    }

    const result = await db.query(
      `
        SELECT channel_logo_data, channel_logo_mime
        FROM telegramlogin_channellist
        WHERE channel_id = $1
          AND is_deleted = FALSE
          AND is_active = TRUE
          AND channel_logo_data IS NOT NULL
        LIMIT 1
      `,
      [channelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel logo not found",
      });
    }

    const logo = result.rows[0];

    res.setHeader("Content-Type", logo.channel_logo_mime || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");

    return res.send(logo.channel_logo_data);
  } catch (error) {
    console.error("Get channel logo error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading channel logo",
    });
  }
});

/* ===============================
   API 4: My Channels Dashboard
   GET /api/telegramlogin-channels/my-channels
================================ */
router.get("/my-channels", authenticateTelegramUser, async (req, res) => {
  try {
    const result = await db.query(
      `
        SELECT
          ${getChannelSelectSql()},
          m.member_role,
          m.member_status,
          m.pin_verified_at,
          m.last_opened_at
        FROM telegramlogin_channellist c
        JOIN telegram_users u
          ON u.telegram_user_id = c.created_by_user_id
        JOIN telegramlogin_channel_members m
          ON m.channel_id = c.channel_id
         AND m.telegram_user_id = $1
        WHERE c.is_deleted = FALSE
          AND c.is_active = TRUE
          AND m.member_status = 'active'
        ORDER BY c.created_at DESC
      `,
      [req.telegramUserId]
    );

    return res.status(200).json({
      success: true,
      message: "Channels loaded successfully",
      channels: result.rows.map(normalizeChannel),
    });
  } catch (error) {
    console.error("My channels error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading channels",
    });
  }
});

/* ===============================
   API 5: Get All Public Channels
   GET /api/telegramlogin-channels/public?search=test
================================ */
router.get("/public", authenticateTelegramUser, async (req, res) => {
  try {
    const search = cleanText(req.query.search);
    const params = [];
    let searchSql = "";

    if (search) {
      params.push(`%${search}%`);
      searchSql = `
        AND (
          c.channel_name ILIKE $${params.length}
          OR c.channel_description ILIKE $${params.length}
        )
      `;
    }

    const result = await db.query(
      `
        SELECT
          ${getChannelSelectSql()},
          m.member_role,
          m.member_status,
          m.pin_verified_at,
          m.last_opened_at
        FROM telegramlogin_channellist c
        JOIN telegram_users u
          ON u.telegram_user_id = c.created_by_user_id
        LEFT JOIN telegramlogin_channel_members m
          ON m.channel_id = c.channel_id
         AND m.telegram_user_id = $${params.length + 1}
        WHERE c.is_deleted = FALSE
          AND c.is_active = TRUE
          AND c.channel_type = 'public'
          ${searchSql}
        ORDER BY c.created_at DESC
      `,
      [...params, req.telegramUserId]
    );

    return res.status(200).json({
      success: true,
      message: "Public channels loaded successfully",
      channels: result.rows.map(normalizeChannel),
    });
  } catch (error) {
    console.error("Public channels error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading public channels",
    });
  }
});

/* ===============================
   API 6: Share Link Channel Info
   GET /api/telegramlogin-channels/share/:shareCode
================================ */
router.get("/share/:shareCode", authenticateTelegramUser, async (req, res) => {
  try {
    const shareCode = cleanText(req.params.shareCode);

    if (!shareCode) {
      return res.status(400).json({
        success: false,
        message: "Share code required",
      });
    }

    const result = await db.query(
      `
        SELECT
          ${getChannelSelectSql()},
          m.member_role,
          m.member_status,
          m.pin_verified_at,
          m.last_opened_at
        FROM telegramlogin_channellist c
        JOIN telegram_users u
          ON u.telegram_user_id = c.created_by_user_id
        LEFT JOIN telegramlogin_channel_members m
          ON m.channel_id = c.channel_id
         AND m.telegram_user_id = $2
        WHERE c.share_code = $1
          AND c.is_deleted = FALSE
          AND c.is_active = TRUE
        LIMIT 1
      `,
      [shareCode, req.telegramUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    const channel = result.rows[0];

    return res.status(200).json({
      success: true,
      message: "Channel info loaded successfully",
      can_join: channel.channel_type === "public",
      private_channel: channel.channel_type === "private",
      channel: normalizeChannel(channel),
    });
  } catch (error) {
    console.error("Share channel info error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading channel info",
    });
  }
});

/* ===============================
   API 7: Join Public Channel By Share Link
   POST /api/telegramlogin-channels/join/:shareCode
================================ */
router.post("/join/:shareCode", authenticateTelegramUser, async (req, res) => {
  try {
    const shareCode = cleanText(req.params.shareCode);
    const joinedDeviceId = getDeviceId(req);

    const channelResult = await db.query(
      `
        SELECT channel_id, channel_type, channel_name, is_deleted, is_active
        FROM telegramlogin_channellist
        WHERE share_code = $1
          AND is_deleted = FALSE
          AND is_active = TRUE
        LIMIT 1
      `,
      [shareCode]
    );

    if (channelResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    const channel = channelResult.rows[0];

    if (channel.channel_type !== "public") {
      return res.status(403).json({
        success: false,
        message: "Private channel cannot be joined directly. Owner/admin must add you.",
      });
    }

    const blockedResult = await db.query(
      `
        SELECT member_status
        FROM telegramlogin_channel_members
        WHERE channel_id = $1
          AND telegram_user_id = $2
        LIMIT 1
      `,
      [channel.channel_id, req.telegramUserId]
    );

    if (
      blockedResult.rows.length > 0 &&
      blockedResult.rows[0].member_status === "blocked"
    ) {
      return res.status(403).json({
        success: false,
        message: "You are blocked from this channel",
      });
    }

    await db.query(
      `
        INSERT INTO telegramlogin_channel_members
          (
            channel_id,
            telegram_user_id,
            member_role,
            member_status,
            joined_device_id,
            last_opened_at
          )
        VALUES
          ($1, $2, 'member', 'active', $3, NOW())
        ON CONFLICT (channel_id, telegram_user_id)
        DO UPDATE SET
          member_status = 'active',
          last_opened_at = NOW(),
          updated_at = NOW()
      `,
      [channel.channel_id, req.telegramUserId, joinedDeviceId || null]
    );

    return res.status(200).json({
      success: true,
      message: "Public channel joined successfully",
      channel_id: channel.channel_id,
      channel_name: channel.channel_name,
    });
  } catch (error) {
    console.error("Join public channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while joining channel",
    });
  }
});

/* ===============================
   API 8: Add User To Channel
   POST /api/telegramlogin-channels/:channelId/add-user

   Body:
   telegram_user_id OR email OR mobile_no
   member_role optional: member/admin
================================ */
router.post("/:channelId/add-user", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);

    if (!isValidId(channelId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid channel id",
      });
    }

    const canManage = await requireOwnerOrAdmin({
      channelId,
      userId: req.telegramUserId,
    });

    if (!canManage) {
      return res.status(403).json({
        success: false,
        message: "Only channel owner or admin can add users",
      });
    }

    const memberRole =
      cleanText(req.body.member_role).toLowerCase() === "admin"
        ? "admin"
        : "member";

    const targetUserId = req.body.telegram_user_id || req.body.user_id;
    const email = cleanEmail(req.body.email);
    const mobileNo = cleanText(req.body.mobile_no);

    let userResult;

    if (isValidId(targetUserId)) {
      userResult = await db.query(
        `
          SELECT telegram_user_id, full_name, email, mobile_no
          FROM telegram_users
          WHERE telegram_user_id = $1
            AND is_active = TRUE
          LIMIT 1
        `,
        [Number(targetUserId)]
      );
    } else if (email) {
      userResult = await db.query(
        `
          SELECT telegram_user_id, full_name, email, mobile_no
          FROM telegram_users
          WHERE email = $1
            AND is_active = TRUE
          LIMIT 1
        `,
        [email]
      );
    } else if (mobileNo) {
      userResult = await db.query(
        `
          SELECT telegram_user_id, full_name, email, mobile_no
          FROM telegram_users
          WHERE mobile_no = $1
            AND is_active = TRUE
          LIMIT 1
        `,
        [mobileNo]
      );
    } else {
      return res.status(400).json({
        success: false,
        message: "Provide telegram_user_id, email, or mobile_no",
      });
    }

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const targetUser = userResult.rows[0];

    await db.query(
      `
        INSERT INTO telegramlogin_channel_members
          (
            channel_id,
            telegram_user_id,
            member_role,
            member_status
          )
        VALUES
          ($1, $2, $3, 'active')
        ON CONFLICT (channel_id, telegram_user_id)
        DO UPDATE SET
          member_role = EXCLUDED.member_role,
          member_status = 'active',
          updated_at = NOW()
      `,
      [channelId, targetUser.telegram_user_id, memberRole]
    );

    return res.status(200).json({
      success: true,
      message: "User added to channel successfully",
      added_user: targetUser,
      member_role: memberRole,
    });
  } catch (error) {
    console.error("Add user to channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while adding user",
    });
  }
});

/* ===============================
   API 9: Remove User From Channel
   DELETE /api/telegramlogin-channels/:channelId/member/:memberUserId
================================ */
router.delete(
  "/:channelId/member/:memberUserId",
  authenticateTelegramUser,
  async (req, res) => {
    try {
      const channelId = Number(req.params.channelId);
      const memberUserId = Number(req.params.memberUserId);

      if (!isValidId(channelId) || !isValidId(memberUserId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid channel id or user id",
        });
      }

      const canManage = await requireOwnerOrAdmin({
        channelId,
        userId: req.telegramUserId,
      });

      if (!canManage) {
        return res.status(403).json({
          success: false,
          message: "Only channel owner or admin can remove users",
        });
      }

      const ownerResult = await db.query(
        `
          SELECT created_by_user_id
          FROM telegramlogin_channellist
          WHERE channel_id = $1
          LIMIT 1
        `,
        [channelId]
      );

      if (ownerResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Channel not found",
        });
      }

      if (Number(ownerResult.rows[0].created_by_user_id) === memberUserId) {
        return res.status(400).json({
          success: false,
          message: "Channel owner cannot be removed",
        });
      }

      const result = await db.query(
        `
          UPDATE telegramlogin_channel_members
          SET member_status = 'left',
              updated_at = NOW()
          WHERE channel_id = $1
            AND telegram_user_id = $2
          RETURNING channel_member_id
        `,
        [channelId, memberUserId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Member not found",
        });
      }

      return res.status(200).json({
        success: true,
        message: "User removed from channel successfully",
      });
    } catch (error) {
      console.error("Remove channel member error:", error);

      return res.status(500).json({
        success: false,
        message: "Server error while removing user",
      });
    }
  }
);

/* ===============================
   API 10: Verify Channel PIN
   POST /api/telegramlogin-channels/:channelId/verify-pin

   Body:
   security_pin
================================ */
router.post("/:channelId/verify-pin", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    const securityPin = cleanText(req.body.security_pin || req.body.pin);
    const deviceId = getDeviceId(req);

    if (!isValidId(channelId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid channel id",
      });
    }

    if (!isValidPin(securityPin)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 4 to 8 digit PIN",
      });
    }

    const channel = await getChannelForUser({
      channelId,
      userId: req.telegramUserId,
    });

    if (!channel) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    if (!channel.member_status || channel.member_status !== "active") {
      return res.status(403).json({
        success: false,
        message: "You are not added to this channel",
      });
    }

    if (!channel.security_pin_hash) {
      await db.query(
        `
          UPDATE telegramlogin_channel_members
          SET pin_verified_at = NOW(),
              last_opened_at = NOW(),
              joined_device_id = COALESCE(joined_device_id, $3),
              updated_at = NOW()
          WHERE channel_id = $1
            AND telegram_user_id = $2
        `,
        [channelId, req.telegramUserId, deviceId || null]
      );

      return res.status(200).json({
        success: true,
        message: "No PIN required for this channel",
      });
    }

    const matched = await bcrypt.compare(securityPin, channel.security_pin_hash);

    if (!matched) {
      return res.status(400).json({
        success: false,
        message: "Invalid security PIN",
      });
    }

    await db.query(
      `
        UPDATE telegramlogin_channel_members
        SET pin_verified_at = NOW(),
            last_opened_at = NOW(),
            joined_device_id = COALESCE(joined_device_id, $3),
            updated_at = NOW()
        WHERE channel_id = $1
          AND telegram_user_id = $2
      `,
      [channelId, req.telegramUserId, deviceId || null]
    );

    return res.status(200).json({
      success: true,
      message: "PIN verified successfully. Chat page can open now.",
    });
  } catch (error) {
    console.error("Verify channel PIN error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while verifying PIN",
    });
  }
});

/* ===============================
   API 11: Open Channel / Chat Page Access
   GET /api/telegramlogin-channels/:channelId/open
================================ */
router.get("/:channelId/open", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    const deviceId = getDeviceId(req);

    if (!isValidId(channelId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid channel id",
      });
    }

    let channel = await getChannelForUser({
      channelId,
      userId: req.telegramUserId,
    });

    if (!channel) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    if (channel.channel_type === "public") {
      if (channel.member_status === "blocked") {
        return res.status(403).json({
          success: false,
          message: "You are blocked from this channel",
        });
      }

      await db.query(
        `
          INSERT INTO telegramlogin_channel_members
            (
              channel_id,
              telegram_user_id,
              member_role,
              member_status,
              joined_device_id,
              last_opened_at
            )
          VALUES
            ($1, $2, 'member', 'active', $3, NOW())
          ON CONFLICT (channel_id, telegram_user_id)
          DO UPDATE SET
            member_status = CASE
              WHEN telegramlogin_channel_members.member_status = 'blocked'
              THEN telegramlogin_channel_members.member_status
              ELSE 'active'
            END,
            last_opened_at = NOW(),
            updated_at = NOW()
        `,
        [channelId, req.telegramUserId, deviceId || null]
      );

      channel = await getChannelForUser({
        channelId,
        userId: req.telegramUserId,
      });

      return res.status(200).json({
        success: true,
        can_open: true,
        pin_required: false,
        message: "Public channel opened successfully",
        channel: normalizeChannel(channel),
      });
    }

    if (!channel.member_status || channel.member_status !== "active") {
      return res.status(403).json({
        success: false,
        can_open: false,
        message: "You are not added to this private channel",
      });
    }

    if (channel.security_pin_hash && !channel.pin_verified_at) {
      return res.status(403).json({
        success: false,
        can_open: false,
        pin_required: true,
        message: "Please verify channel PIN to open chat",
        channel: normalizeChannel(channel),
      });
    }

    await db.query(
      `
        UPDATE telegramlogin_channel_members
        SET last_opened_at = NOW(),
            updated_at = NOW()
        WHERE channel_id = $1
          AND telegram_user_id = $2
      `,
      [channelId, req.telegramUserId]
    );

    return res.status(200).json({
      success: true,
      can_open: true,
      pin_required: false,
      message: "Private channel opened successfully",
      channel: normalizeChannel(channel),
    });
  } catch (error) {
    console.error("Open channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while opening channel",
    });
  }
});

/* ===============================
   API 12: Update Channel
   PUT /api/telegramlogin-channels/:channelId

   form-data:
   channel_name optional
   channel_description optional
   channel_type optional public/private
   security_pin optional
   channel_logo optional
   remove_logo true optional
================================ */
router.put(
  "/:channelId",
  authenticateTelegramUser,
  uploadChannelLogo,
  async (req, res) => {
    try {
      const channelId = Number(req.params.channelId);

      if (!isValidId(channelId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid channel id",
        });
      }

      const canManage = await requireOwnerOrAdmin({
        channelId,
        userId: req.telegramUserId,
      });

      if (!canManage) {
        return res.status(403).json({
          success: false,
          message: "Only channel owner or admin can update channel",
        });
      }

      const existingResult = await db.query(
        `
          SELECT channel_type, security_pin_hash
          FROM telegramlogin_channellist
          WHERE channel_id = $1
            AND is_deleted = FALSE
          LIMIT 1
        `,
        [channelId]
      );

      if (existingResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Channel not found",
        });
      }

      const existing = existingResult.rows[0];

      const setClauses = [];
      const values = [];

      if (Object.prototype.hasOwnProperty.call(req.body, "channel_name")) {
        const channelName = cleanText(req.body.channel_name);

        if (channelName.length < 3) {
          return res.status(400).json({
            success: false,
            message: "Channel name must be at least 3 characters",
          });
        }

        values.push(channelName);
        setClauses.push(`channel_name = $${values.length}`);
      }

      if (
        Object.prototype.hasOwnProperty.call(req.body, "channel_description")
      ) {
        values.push(cleanText(req.body.channel_description) || null);
        setClauses.push(`channel_description = $${values.length}`);
      }

      let newChannelType = existing.channel_type;

      if (Object.prototype.hasOwnProperty.call(req.body, "channel_type")) {
        newChannelType = normalizeChannelType(req.body.channel_type);

        values.push(newChannelType);
        setClauses.push(`channel_type = $${values.length}`);
      }

      if (Object.prototype.hasOwnProperty.call(req.body, "security_pin")) {
        const securityPin = cleanText(req.body.security_pin);

        if (!isValidPin(securityPin)) {
          return res.status(400).json({
            success: false,
            message: "Security PIN must be 4 to 8 digits",
          });
        }

        const securityPinHash = await bcrypt.hash(securityPin, 12);

        values.push(securityPinHash);
        setClauses.push(`security_pin_hash = $${values.length}`);
      }

      if (
        newChannelType === "private" &&
        !existing.security_pin_hash &&
        !Object.prototype.hasOwnProperty.call(req.body, "security_pin")
      ) {
        return res.status(400).json({
          success: false,
          message: "Private channel requires security PIN",
        });
      }

      if (req.file) {
        values.push(req.file.buffer);
        setClauses.push(`channel_logo_data = $${values.length}`);

        values.push(req.file.mimetype);
        setClauses.push(`channel_logo_mime = $${values.length}`);

        values.push(req.file.originalname);
        setClauses.push(`channel_logo_name = $${values.length}`);

        values.push(req.file.size);
        setClauses.push(`channel_logo_size = $${values.length}`);
      }

      const removeLogo =
        String(req.body.remove_logo || "").toLowerCase() === "true";

      if (removeLogo) {
        setClauses.push(`channel_logo_data = NULL`);
        setClauses.push(`channel_logo_mime = NULL`);
        setClauses.push(`channel_logo_name = NULL`);
        setClauses.push(`channel_logo_size = NULL`);
      }

      if (setClauses.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No valid data provided for update",
        });
      }

      values.push(channelId);

      await db.query(
        `
          UPDATE telegramlogin_channellist
          SET ${setClauses.join(", ")}
          WHERE channel_id = $${values.length}
        `,
        values
      );

      const updated = await getChannelForUser({
        channelId,
        userId: req.telegramUserId,
      });

      return res.status(200).json({
        success: true,
        message: "Channel updated successfully",
        channel: normalizeChannel(updated),
      });
    } catch (error) {
      console.error("Update channel error:", error);

      return res.status(500).json({
        success: false,
        message: "Server error while updating channel",
      });
    }
  }
);

/* ===============================
   API 13: Delete Channel
   DELETE /api/telegramlogin-channels/:channelId

   Public channel:
   creator + same device only, no PIN

   Private channel:
   creator + security PIN
================================ */
router.delete("/:channelId", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    const deviceId = getDeviceId(req);
    const securityPin = cleanText(req.body.security_pin || req.body.pin);

    if (!isValidId(channelId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid channel id",
      });
    }

    const result = await db.query(
      `
        SELECT
          channel_id,
          channel_name,
          channel_type,
          created_by_user_id,
          created_device_id,
          security_pin_hash,
          is_deleted
        FROM telegramlogin_channellist
        WHERE channel_id = $1
          AND is_deleted = FALSE
        LIMIT 1
      `,
      [channelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
      });
    }

    const channel = result.rows[0];

    if (Number(channel.created_by_user_id) !== Number(req.telegramUserId)) {
      return res.status(403).json({
        success: false,
        message: "Only channel creator can delete channel",
      });
    }

    if (channel.channel_type === "public") {
      if (!deviceId) {
        return res.status(400).json({
          success: false,
          message: "Device id is required to delete public channel",
        });
      }

      if (deviceId !== channel.created_device_id) {
        return res.status(403).json({
          success: false,
          message: "Public channel can be deleted only from the device where it was created",
        });
      }
    }

    if (channel.channel_type === "private") {
      if (!channel.security_pin_hash) {
        return res.status(400).json({
          success: false,
          message: "Private channel PIN is not set",
        });
      }

      if (!isValidPin(securityPin)) {
        return res.status(400).json({
          success: false,
          message: "Enter valid security PIN to delete private channel",
        });
      }

      const matched = await bcrypt.compare(
        securityPin,
        channel.security_pin_hash
      );

      if (!matched) {
        return res.status(400).json({
          success: false,
          message: "Invalid security PIN",
        });
      }
    }

    await db.query(
      `
        UPDATE telegramlogin_channellist
        SET is_deleted = TRUE,
            is_active = FALSE,
            deleted_at = NOW(),
            deleted_by_user_id = $2,
            deleted_device_id = $3
        WHERE channel_id = $1
      `,
      [channelId, req.telegramUserId, deviceId || null]
    );

    return res.status(200).json({
      success: true,
      message: "Channel deleted successfully",
    });
  } catch (error) {
    console.error("Delete channel error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while deleting channel",
    });
  }
});

module.exports = router;