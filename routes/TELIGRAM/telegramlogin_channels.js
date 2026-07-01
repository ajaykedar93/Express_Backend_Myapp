const express = require("express");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const db = require("../../db");

const router = express.Router();

/* =====================================================
   CONFIG
   Mount in server.js:
   app.use("/api/telegramlogin-channels", telegramloginChannelsRoutes);
===================================================== */
const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";
const PRIVATE_TRUST_DAYS = Number(process.env.PRIVATE_TRUST_DAYS || 365);
const CHANNEL_LOGO_LIMIT_MB = 5;
const NOTE_FILE_LIMIT_MB = 12;

/* =====================================================
   MULTER CONFIG
===================================================== */
const imageStorage = multer.memoryStorage();
const fileStorage = multer.memoryStorage();

const allowedImageMimeTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

const channelLogoUpload = multer({
  storage: imageStorage,
  limits: { fileSize: CHANNEL_LOGO_LIMIT_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const extOk = /jpeg|jpg|png|gif|webp/.test(
      path.extname(file.originalname || "").toLowerCase()
    );
    const mimeOk = allowedImageMimeTypes.includes(file.mimetype);

    if (extOk && mimeOk) return cb(null, true);
    return cb(new Error("Only JPG, PNG, GIF, and WEBP channel logos are allowed"));
  },
});

const noteAttachmentUpload = multer({
  storage: fileStorage,
  limits: { fileSize: NOTE_FILE_LIMIT_MB * 1024 * 1024 },
});

const uploadChannelLogo = (req, res, next) => {
  channelLogoUpload.single("channel_logo")(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Channel logo upload failed",
      });
    }
    return next();
  });
};

const uploadNoteAttachment = (req, res, next) => {
  noteAttachmentUpload.single("attachment")(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Attachment upload failed",
      });
    }
    return next();
  });
};

/* =====================================================
   HELPERS
===================================================== */
const cleanText = (value) => String(value || "").trim();
const cleanEmail = (value) => String(value || "").trim().toLowerCase();
const toInt = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
};

const getClientDeviceId = (req) => {
  return cleanText(
    req.body?.device_id ||
      req.body?.deviceId ||
      req.headers["x-device-id"] ||
      req.headers["x-device"] ||
      ""
  );
};

const getFrontendOrigin = (req) => {
  return cleanText(
    process.env.FRONTEND_URL ||
      process.env.CLIENT_URL ||
      req.get("origin") ||
      `${req.protocol}://${req.get("host")}`
  ).replace(/\/$/, "");
};

const buildShareLink = (req, shareCode) => {
  return `${getFrontendOrigin(req)}/channel/join/${shareCode}`;
};

const extractShareCode = (value) => {
  const text = cleanText(value);
  if (!text) return "";

  try {
    const url = new URL(text);
    const parts = url.pathname.split("/").filter(Boolean);
    const joinIndex = parts.indexOf("join");
    if (joinIndex >= 0 && parts[joinIndex + 1]) return parts[joinIndex + 1];
    return parts[parts.length - 1] || text;
  } catch {
    const parts = text.split("/").filter(Boolean);
    return parts[parts.length - 1] || text;
  }
};

const getAttachmentCategory = (mime = "", filename = "") => {
  const lowerMime = String(mime || "").toLowerCase();
  const lowerName = String(filename || "").toLowerCase();

  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime.includes("pdf") || lowerName.endsWith(".pdf")) return "pdf";
  if (
    lowerMime.includes("spreadsheet") ||
    lowerMime.includes("excel") ||
    /\.(xls|xlsx|csv)$/i.test(lowerName)
  ) {
    return "excel";
  }
  if (
    lowerMime.includes("word") ||
    lowerMime.includes("document") ||
    /\.(doc|docx)$/i.test(lowerName)
  ) {
    return "word";
  }
  if (lowerMime.startsWith("text/") || lowerName.endsWith(".txt")) return "txt";
  return "other";
};

const isPinFormatValid = (pin) => /^\d{4,8}$/.test(String(pin || ""));

const getCurrentUserId = (req) => Number(req.telegramUserId || req.user?.telegram_user_id || 0);

const normalizeChannel = (row, req) => {
  if (!row) return null;

  const channelId = row.channel_id;
  const hasLogo = row.has_channel_logo === true || row.has_channel_logo === "true";
  const shareCode = row.share_code || "";

  return {
    channel_id: channelId,
    id: channelId,
    channel_uuid: row.channel_uuid,
    created_by_user_id: row.created_by_user_id,
    owner_id: row.created_by_user_id,
    owner_name: row.owner_name || row.created_by_name || "",
    owner_email: row.owner_email || row.created_by_email || "",
    channel_name: row.channel_name,
    channel_description: row.channel_description || "",
    channel_type: row.channel_type,
    has_channel_logo: hasLogo,
    channel_logo_url: hasLogo ? `/api/telegramlogin-channels/logo/${channelId}` : "",
    share_code: shareCode,
    share_link: shareCode ? buildShareLink(req, shareCode) : "",
    is_active: row.is_active,
    is_deleted: row.is_deleted,
    created_device_id: row.created_device_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    member_role: row.member_role || null,
    member_status: row.member_status || null,
    access_mode: row.access_mode || "full_access",
    joined_via_link: row.joined_via_link === true,
    joined_at: row.joined_at || null,
    pin_verified_at: row.pin_verified_at || null,
    last_opened_at: row.last_opened_at || null,
    is_owner:
      row.is_owner === true ||
      String(row.member_role || "").toLowerCase() === "owner" ||
      Number(row.created_by_user_id) === getCurrentUserId(req),
    can_share: true,
  };
};

const normalizeInvitation = (row, req) => {
  if (!row) return null;

  const shareCode = row.share_code || "";
  return {
    invitation_id: row.invitation_id,
    id: row.invitation_id,
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    channel_type: row.channel_type,
    sender_user_id: row.sender_user_id,
    sender_name: row.sender_name || "User",
    sender_email: row.sender_email || "",
    receiver_user_id: row.receiver_user_id,
    receiver_name: row.receiver_name || "",
    receiver_email: row.receiver_email || "",
    share_code: shareCode,
    share_link: row.share_link || (shareCode ? buildShareLink(req, shareCode) : ""),
    invitation_status: row.invitation_status,
    status: row.invitation_status,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const normalizeNote = (row) => {
  if (!row) return null;

  const hasAttachment = row.has_attachment === true || row.has_attachment === "true";
  return {
    note_id: row.note_id,
    id: row.note_id,
    channel_id: row.channel_id,
    created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name || "User",
    created_by_email: row.created_by_email || "",
    note_type: row.note_type,
    note_text: row.note_text || "",
    has_attachment: hasAttachment,
    attachment_url: hasAttachment
      ? `/api/telegramlogin-channels/notes/${row.note_id}/attachment`
      : "",
    attachment_mime: row.attachment_mime || "",
    attachment_name: row.attachment_name || "",
    attachment_size: row.attachment_size || 0,
    attachment_category: row.attachment_category || null,
    created_device_id: row.created_device_id || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

/* =====================================================
   AUTH MIDDLEWARE
===================================================== */
const authenticateTelegramUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

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
        SELECT telegram_user_id, full_name, username, mobile_no, email, is_active
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

    req.telegramUserId = telegramUserId;
    req.telegramUser = result.rows[0];
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

/* =====================================================
   DB HELPERS
===================================================== */
const getChannelById = async (channelId) => {
  const result = await db.query(
    `
      SELECT
        c.*,
        (c.channel_logo_data IS NOT NULL) AS has_channel_logo,
        u.full_name AS owner_name,
        u.email AS owner_email
      FROM telegramlogin_channellist c
      INNER JOIN telegram_users u
        ON u.telegram_user_id = c.created_by_user_id
      WHERE c.channel_id = $1
        AND c.is_active = TRUE
        AND c.is_deleted = FALSE
      LIMIT 1
    `,
    [channelId]
  );

  return result.rows[0] || null;
};

const getChannelByShareCode = async (shareCode) => {
  const result = await db.query(
    `
      SELECT
        c.*,
        (c.channel_logo_data IS NOT NULL) AS has_channel_logo,
        u.full_name AS owner_name,
        u.email AS owner_email
      FROM telegramlogin_channellist c
      INNER JOIN telegram_users u
        ON u.telegram_user_id = c.created_by_user_id
      WHERE c.share_code = $1
        AND c.is_active = TRUE
        AND c.is_deleted = FALSE
      LIMIT 1
    `,
    [shareCode]
  );

  return result.rows[0] || null;
};

const getMembership = async ({ channelId, userId }) => {
  const result = await db.query(
    `
      SELECT *
      FROM telegramlogin_channel_members
      WHERE channel_id = $1
        AND telegram_user_id = $2
      LIMIT 1
    `,
    [channelId, userId]
  );

  return result.rows[0] || null;
};

const requireActiveMembership = async (req, res, next) => {
  try {
    const channelId = toInt(req.params.id || req.params.channelId);
    const userId = getCurrentUserId(req);

    if (!channelId) {
      return res.status(400).json({ success: false, message: "Invalid channel id" });
    }

    const channel = await getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }

    const membership = await getMembership({ channelId, userId });
    if (!membership || membership.member_status !== "active") {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this channel",
      });
    }

    req.channel = channel;
    req.membership = membership;
    return next();
  } catch (error) {
    console.error("Membership check error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const requireOwner = async (req, res, next) => {
  try {
    const channelId = toInt(req.params.id || req.params.channelId);
    const userId = getCurrentUserId(req);

    if (!channelId) {
      return res.status(400).json({ success: false, message: "Invalid channel id" });
    }

    const channel = await getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }

    const membership = await getMembership({ channelId, userId });
    const isOwner =
      Number(channel.created_by_user_id) === userId ||
      String(membership?.member_role || "").toLowerCase() === "owner";

    if (!isOwner) {
      return res.status(403).json({
        success: false,
        message: "Only channel owner can perform this action",
      });
    }

    req.channel = channel;
    req.membership = membership;
    return next();
  } catch (error) {
    console.error("Owner check error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const hasTrustedPrivateDevice = async ({ channelId, userId, deviceId }) => {
  if (!deviceId) return false;

  const result = await db.query(
    `
      SELECT trusted_private_device_id
      FROM telegramlogin_private_channel_trusted_devices
      WHERE channel_id = $1
        AND telegram_user_id = $2
        AND device_id = $3
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `,
    [channelId, userId, deviceId]
  );

  if (result.rows.length > 0) {
    await db.query(
      `
        UPDATE telegramlogin_private_channel_trusted_devices
        SET last_used_at = NOW()
        WHERE trusted_private_device_id = $1
      `,
      [result.rows[0].trusted_private_device_id]
    );
    return true;
  }

  return false;
};

const trustPrivateDevice = async ({ channelId, userId, deviceId }) => {
  if (!deviceId) return;

  const expiresAt = new Date(Date.now() + PRIVATE_TRUST_DAYS * 24 * 60 * 60 * 1000);

  await db.query(
    `
      INSERT INTO telegramlogin_private_channel_trusted_devices
        (channel_id, telegram_user_id, device_id, trusted_at, last_used_at, expires_at, is_active)
      VALUES
        ($1, $2, $3, NOW(), NOW(), $4, TRUE)
      ON CONFLICT (channel_id, telegram_user_id, device_id)
      DO UPDATE SET
        trusted_at = NOW(),
        last_used_at = NOW(),
        expires_at = EXCLUDED.expires_at,
        is_active = TRUE
    `,
    [channelId, userId, deviceId, expiresAt]
  );
};

const verifyPrivatePin = async ({ channel, pin }) => {
  if (channel.channel_type !== "private") return true;

  const cleanPin = cleanText(pin);
  if (!isPinFormatValid(cleanPin)) return false;
  if (!channel.security_pin_hash) return false;

  return bcrypt.compare(cleanPin, channel.security_pin_hash);
};

const upsertActiveMember = async ({
  channelId,
  userId,
  role = "member",
  accessMode = "full_access",
  deviceId = "",
  joinedViaLink = false,
  shareCode = "",
  invitationId = null,
  pinVerified = false,
}) => {
  const result = await db.query(
    `
      INSERT INTO telegramlogin_channel_members
        (
          channel_id,
          telegram_user_id,
          member_role,
          member_status,
          access_mode,
          joined_device_id,
          joined_via_link,
          share_code_used,
          invitation_id,
          pin_verified_at,
          last_opened_at,
          joined_at
        )
      VALUES
        ($1, $2, $3, 'active', $4, $5, $6, $7, $8, ${pinVerified ? "NOW()" : "NULL"}, NOW(), NOW())
      ON CONFLICT (channel_id, telegram_user_id)
      DO UPDATE SET
        member_status = 'active',
        access_mode = EXCLUDED.access_mode,
        joined_device_id = COALESCE(EXCLUDED.joined_device_id, telegramlogin_channel_members.joined_device_id),
        joined_via_link = telegramlogin_channel_members.joined_via_link OR EXCLUDED.joined_via_link,
        share_code_used = COALESCE(EXCLUDED.share_code_used, telegramlogin_channel_members.share_code_used),
        invitation_id = COALESCE(EXCLUDED.invitation_id, telegramlogin_channel_members.invitation_id),
        pin_verified_at = CASE
          WHEN EXCLUDED.pin_verified_at IS NOT NULL THEN EXCLUDED.pin_verified_at
          ELSE telegramlogin_channel_members.pin_verified_at
        END,
        last_opened_at = NOW(),
        removed_from_dashboard_at = NULL,
        removed_by_user_id = NULL
      RETURNING *
    `,
    [
      channelId,
      userId,
      role,
      accessMode,
      deviceId || null,
      joinedViaLink,
      shareCode || null,
      invitationId,
    ]
  );

  return result.rows[0];
};

const updateLastOpened = async ({ channelId, userId, pinVerified = false }) => {
  await db.query(
    `
      UPDATE telegramlogin_channel_members
      SET
        last_opened_at = NOW(),
        pin_verified_at = CASE
          WHEN $3 = TRUE THEN NOW()
          ELSE pin_verified_at
        END
      WHERE channel_id = $1
        AND telegram_user_id = $2
    `,
    [channelId, userId, pinVerified]
  );
};

const getMyChannelsRows = async (userId) => {
  const result = await db.query(
    `
      SELECT
        c.*,
        (c.channel_logo_data IS NOT NULL) AS has_channel_logo,
        u.full_name AS owner_name,
        u.email AS owner_email,
        m.member_role,
        m.member_status,
        m.access_mode,
        m.joined_via_link,
        m.joined_at,
        m.pin_verified_at,
        m.last_opened_at,
        (c.created_by_user_id = $1 OR m.member_role = 'owner') AS is_owner
      FROM telegramlogin_channellist c
      INNER JOIN telegramlogin_channel_members m
        ON m.channel_id = c.channel_id
      INNER JOIN telegram_users u
        ON u.telegram_user_id = c.created_by_user_id
      WHERE m.telegram_user_id = $1
        AND m.member_status = 'active'
        AND c.is_active = TRUE
        AND c.is_deleted = FALSE
      ORDER BY c.created_at DESC
    `,
    [userId]
  );

  return result.rows;
};

/* =====================================================
   HEALTH
===================================================== */
router.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Telegram login channels API is running",
  });
});

/* =====================================================
   CHANNEL LOGO
===================================================== */
router.get("/logo/:id", async (req, res) => {
  try {
    const channelId = toInt(req.params.id);
    if (!channelId) {
      return res.status(400).json({ success: false, message: "Invalid channel id" });
    }

    const result = await db.query(
      `
        SELECT channel_logo_data, channel_logo_mime
        FROM telegramlogin_channellist
        WHERE channel_id = $1
          AND channel_logo_data IS NOT NULL
          AND is_active = TRUE
          AND is_deleted = FALSE
        LIMIT 1
      `,
      [channelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Channel logo not found" });
    }

    const logo = result.rows[0];
    res.setHeader("Content-Type", logo.channel_logo_mime || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(logo.channel_logo_data);
  } catch (error) {
    console.error("Get channel logo error:", error);
    return res.status(500).json({ success: false, message: "Server error while loading logo" });
  }
});

/* =====================================================
   MY CHANNELS / CHANNEL DETAILS
===================================================== */
router.get("/my-channels", authenticateTelegramUser, async (req, res) => {
  try {
    const rows = await getMyChannelsRows(getCurrentUserId(req));
    return res.status(200).json({
      success: true,
      message: "Channels loaded successfully",
      channels: rows.map((row) => normalizeChannel(row, req)),
    });
  } catch (error) {
    console.error("My channels error:", error);
    return res.status(500).json({ success: false, message: "Server error while loading channels" });
  }
});

/* =====================================================
   CREATE CHANNEL
   form-data: channel_name, channel_description, channel_type, security_pin, device_id, channel_logo(optional)
===================================================== */
router.post("/create", authenticateTelegramUser, uploadChannelLogo, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    const channelName = cleanText(req.body.channel_name || req.body.name);
    const channelDescription = cleanText(req.body.channel_description || req.body.description);
    const channelType = cleanText(req.body.channel_type || req.body.type || "public").toLowerCase();
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    const deviceId = getClientDeviceId(req);

    if (channelName.length < 3) {
      return res.status(400).json({ success: false, message: "Channel name must be at least 3 characters" });
    }

    if (!["public", "private"].includes(channelType)) {
      return res.status(400).json({ success: false, message: "Select public or private channel" });
    }

    if (!deviceId) {
      return res.status(400).json({ success: false, message: "Device id required" });
    }

    let pinHash = null;
    if (channelType === "private") {
      if (!isPinFormatValid(pin)) {
        return res.status(400).json({ success: false, message: "Private channel PIN must be 4-8 digits" });
      }
      pinHash = await bcrypt.hash(pin, 12);
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
        RETURNING *, (channel_logo_data IS NOT NULL) AS has_channel_logo
      `,
      [
        userId,
        channelName,
        channelDescription || null,
        channelType,
        logoBuffer,
        logoMime,
        logoName,
        logoSize,
        pinHash,
        deviceId,
      ]
    );

    const channel = result.rows[0];

    if (channelType === "private") {
      await trustPrivateDevice({ channelId: channel.channel_id, userId, deviceId });
    }

    return res.status(201).json({
      success: true,
      message: "Channel created successfully",
      channel: normalizeChannel(
        {
          ...channel,
          member_role: "owner",
          member_status: "active",
          access_mode: "full_access",
          is_owner: true,
        },
        req
      ),
    });
  } catch (error) {
    console.error("Create channel error:", error);
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "Duplicate channel/share code" });
    }
    return res.status(500).json({ success: false, message: "Server error while creating channel" });
  }
});

/* =====================================================
   JOIN CHANNEL BY SHARE CODE
   public: direct join
   private: first join needs security_pin unless device is trusted
===================================================== */
router.post("/join/:shareCode", authenticateTelegramUser, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    const shareCode = extractShareCode(req.params.shareCode || req.body.share_code || req.body.share_link);
    const deviceId = getClientDeviceId(req);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    const trustDevice =
      req.body.trust_device === true ||
      req.body.trust_this_device === true ||
      String(req.body.trust_device || req.body.trust_this_device || "").toLowerCase() === "true";

    if (!shareCode) {
      return res.status(400).json({ success: false, message: "Share code required" });
    }

    const channel = await getChannelByShareCode(shareCode);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel link not found or expired" });
    }

    const existingMembership = await getMembership({ channelId: channel.channel_id, userId });
    const alreadyActive = existingMembership?.member_status === "active";
    let pinVerified = false;

    if (channel.channel_type === "private") {
      const trusted = await hasTrustedPrivateDevice({
        channelId: channel.channel_id,
        userId,
        deviceId,
      });

      if (!trusted) {
        const pinOk = await verifyPrivatePin({ channel, pin });
        if (!pinOk) {
          return res.status(403).json({
            success: false,
            pin_required: true,
            message: "Private channel PIN required",
            channel: normalizeChannel(
              {
                ...channel,
                member_role: existingMembership?.member_role || null,
                member_status: existingMembership?.member_status || null,
                access_mode: existingMembership?.access_mode || "full_access",
              },
              req
            ),
          });
        }

        pinVerified = true;
        if (trustDevice) {
          await trustPrivateDevice({ channelId: channel.channel_id, userId, deviceId });
        }
      }
    }

    const invitationResult = await db.query(
      `
        SELECT invitation_id
        FROM telegramlogin_channel_invitations
        WHERE channel_id = $1
          AND receiver_user_id = $2
          AND invitation_status = 'accepted'
        ORDER BY accepted_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [channel.channel_id, userId]
    );

    const membership = await upsertActiveMember({
      channelId: channel.channel_id,
      userId,
      role: Number(channel.created_by_user_id) === userId ? "owner" : "member",
      accessMode: "full_access",
      deviceId,
      joinedViaLink: Number(channel.created_by_user_id) !== userId,
      shareCode,
      invitationId: invitationResult.rows[0]?.invitation_id || null,
      pinVerified,
    });

    const row = {
      ...channel,
      ...membership,
      has_channel_logo: channel.channel_logo_data != null,
      owner_name: channel.owner_name,
      owner_email: channel.owner_email,
      is_owner: Number(channel.created_by_user_id) === userId || membership.member_role === "owner",
    };

    return res.status(200).json({
      success: true,
      message: alreadyActive ? "Channel already joined" : "Channel joined successfully",
      channel: normalizeChannel(row, req),
    });
  } catch (error) {
    console.error("Join channel error:", error);
    return res.status(500).json({ success: false, message: "Server error while joining channel" });
  }
});

/* =====================================================
   OPEN / VERIFY PRIVATE CHANNEL PIN
===================================================== */
router.post("/:id/verify-pin", authenticateTelegramUser, requireActiveMembership, async (req, res) => {
  try {
    const channel = req.channel;
    const userId = getCurrentUserId(req);
    const deviceId = getClientDeviceId(req);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    const trustDevice =
      req.body.trust_device === true ||
      req.body.trust_this_device === true ||
      String(req.body.trust_device || req.body.trust_this_device || "").toLowerCase() === "true";

    if (channel.channel_type !== "private") {
      await updateLastOpened({ channelId: channel.channel_id, userId });
      return res.status(200).json({
        success: true,
        message: "Public channel does not require PIN",
        verified: true,
        channel: normalizeChannel(
          { ...channel, ...req.membership, has_channel_logo: channel.channel_logo_data != null },
          req
        ),
      });
    }

    const trusted = await hasTrustedPrivateDevice({ channelId: channel.channel_id, userId, deviceId });
    if (trusted) {
      await updateLastOpened({ channelId: channel.channel_id, userId });
      return res.status(200).json({
        success: true,
        verified: true,
        trusted_device: true,
        message: "Trusted device verified",
        channel: normalizeChannel(
          { ...channel, ...req.membership, has_channel_logo: channel.channel_logo_data != null },
          req
        ),
      });
    }

    const pinOk = await verifyPrivatePin({ channel, pin });
    if (!pinOk) {
      return res.status(403).json({ success: false, verified: false, message: "Incorrect private channel PIN" });
    }

    if (trustDevice) {
      await trustPrivateDevice({ channelId: channel.channel_id, userId, deviceId });
    }

    await updateLastOpened({ channelId: channel.channel_id, userId, pinVerified: true });

    return res.status(200).json({
      success: true,
      verified: true,
      trusted_device: trustDevice,
      message: trustDevice ? "PIN verified. Device trusted." : "PIN verified successfully",
      channel: normalizeChannel(
        { ...channel, ...req.membership, pin_verified_at: new Date(), has_channel_logo: channel.channel_logo_data != null },
        req
      ),
    });
  } catch (error) {
    console.error("Verify PIN error:", error);
    return res.status(500).json({ success: false, message: "Server error while verifying PIN" });
  }
});

router.post("/:id/open", authenticateTelegramUser, requireActiveMembership, async (req, res) => {
  try {
    const channel = req.channel;
    const userId = getCurrentUserId(req);
    const deviceId = getClientDeviceId(req);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    const trustDevice =
      req.body.trust_device === true ||
      req.body.trust_this_device === true ||
      String(req.body.trust_device || req.body.trust_this_device || "").toLowerCase() === "true";

    if (channel.channel_type === "private") {
      const trusted = await hasTrustedPrivateDevice({ channelId: channel.channel_id, userId, deviceId });
      if (!trusted) {
        const pinOk = await verifyPrivatePin({ channel, pin });
        if (!pinOk) {
          return res.status(403).json({ success: false, pin_required: true, message: "Private channel PIN required" });
        }
        if (trustDevice) {
          await trustPrivateDevice({ channelId: channel.channel_id, userId, deviceId });
        }
        await updateLastOpened({ channelId: channel.channel_id, userId, pinVerified: true });
      } else {
        await updateLastOpened({ channelId: channel.channel_id, userId });
      }
    } else {
      await updateLastOpened({ channelId: channel.channel_id, userId });
    }

    return res.status(200).json({
      success: true,
      message: "Channel opened successfully",
      channel: normalizeChannel(
        { ...channel, ...req.membership, has_channel_logo: channel.channel_logo_data != null },
        req
      ),
    });
  } catch (error) {
    console.error("Open channel error:", error);
    return res.status(500).json({ success: false, message: "Server error while opening channel" });
  }
});

/* =====================================================
   UPDATE CHANNEL
   Owner only. Private PIN is NOT changed from this API.
===================================================== */
router.put("/:id", authenticateTelegramUser, requireOwner, uploadChannelLogo, async (req, res) => {
  try {
    const channel = req.channel;
    const channelId = channel.channel_id;
    const name = cleanText(req.body.channel_name || req.body.name || "");
    const descriptionRaw = req.body.channel_description ?? req.body.description;
    const typeRaw = cleanText(req.body.channel_type || req.body.type || "").toLowerCase();
    const removeLogo =
      req.body.remove_logo === true ||
      String(req.body.remove_logo || "").toLowerCase() === "true";

    const setClauses = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(req.body, "channel_name") || Object.prototype.hasOwnProperty.call(req.body, "name")) {
      if (name.length < 3) {
        return res.status(400).json({ success: false, message: "Channel name must be at least 3 characters" });
      }
      values.push(name);
      setClauses.push(`channel_name = $${values.length}`);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "channel_description") || Object.prototype.hasOwnProperty.call(req.body, "description")) {
      values.push(cleanText(descriptionRaw));
      setClauses.push(`channel_description = $${values.length}`);
    }

    if (typeRaw) {
      if (!["public", "private"].includes(typeRaw)) {
        return res.status(400).json({ success: false, message: "Invalid channel type" });
      }

      if (channel.channel_type === "private" && typeRaw === "private") {
        // PIN is intentionally not changed from update channel.
        values.push("private");
        setClauses.push(`channel_type = $${values.length}`);
      } else if (channel.channel_type === "private" && typeRaw === "public") {
        values.push("public");
        setClauses.push(`channel_type = $${values.length}`);
        setClauses.push(`security_pin_hash = NULL`);
      } else if (channel.channel_type === "public" && typeRaw === "private") {
        const pin = cleanText(req.body.security_pin || req.body.pin || "");
        if (!isPinFormatValid(pin)) {
          return res.status(400).json({
            success: false,
            message: "PIN is required when changing public channel to private",
          });
        }
        const pinHash = await bcrypt.hash(pin, 12);
        values.push("private");
        setClauses.push(`channel_type = $${values.length}`);
        values.push(pinHash);
        setClauses.push(`security_pin_hash = $${values.length}`);
      } else {
        values.push("public");
        setClauses.push(`channel_type = $${values.length}`);
      }
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
    } else if (removeLogo) {
      setClauses.push(`channel_logo_data = NULL`);
      setClauses.push(`channel_logo_mime = NULL`);
      setClauses.push(`channel_logo_name = NULL`);
      setClauses.push(`channel_logo_size = NULL`);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: "No channel details provided for update" });
    }

    values.push(channelId);

    const result = await db.query(
      `
        UPDATE telegramlogin_channellist
        SET ${setClauses.join(", ")}
        WHERE channel_id = $${values.length}
        RETURNING *, (channel_logo_data IS NOT NULL) AS has_channel_logo
      `,
      values
    );

    return res.status(200).json({
      success: true,
      message: "Channel updated successfully",
      channel: normalizeChannel(
        {
          ...result.rows[0],
          member_role: req.membership.member_role,
          member_status: req.membership.member_status,
          access_mode: req.membership.access_mode,
          is_owner: true,
        },
        req
      ),
    });
  } catch (error) {
    console.error("Update channel error:", error);
    return res.status(500).json({ success: false, message: "Server error while updating channel" });
  }
});

/* =====================================================
   DELETE / REMOVE CHANNEL
   Owner:
     public  => must use same created_device_id
     private => must enter correct PIN
   Other member:
     removes only own dashboard access, original channel not deleted
===================================================== */
router.delete("/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = toInt(req.params.id);
    const userId = getCurrentUserId(req);
    const deviceId = getClientDeviceId(req);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");

    if (!channelId) {
      return res.status(400).json({ success: false, message: "Invalid channel id" });
    }

    const channel = await getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }

    const membership = await getMembership({ channelId, userId });
    if (!membership || membership.member_status !== "active") {
      return res.status(403).json({ success: false, message: "Channel access not found" });
    }

    const isOwner = Number(channel.created_by_user_id) === userId || membership.member_role === "owner";

    if (!isOwner) {
      await db.query(
        `
          UPDATE telegramlogin_channel_members
          SET member_status = 'left',
              removed_from_dashboard_at = NOW(),
              removed_by_user_id = $2
          WHERE channel_id = $1
            AND telegram_user_id = $2
        `,
        [channelId, userId]
      );

      return res.status(200).json({
        success: true,
        removed_only: true,
        message: "Channel removed from your dashboard",
      });
    }

    if (channel.channel_type === "public") {
      if (!deviceId || deviceId !== channel.created_device_id) {
        return res.status(403).json({
          success: false,
          message: "Public channel can be deleted only from the created device",
        });
      }
    }

    if (channel.channel_type === "private") {
      const pinOk = await verifyPrivatePin({ channel, pin });
      if (!pinOk) {
        return res.status(403).json({
          success: false,
          message: "Correct private channel PIN required to delete",
        });
      }
    }

    await db.query("BEGIN");

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
      [channelId, userId, deviceId || null]
    );

    await db.query(
      `
        UPDATE telegramlogin_channel_members
        SET member_status = 'left'
        WHERE channel_id = $1
      `,
      [channelId]
    );

    await db.query("COMMIT");

    return res.status(200).json({
      success: true,
      deleted_original: true,
      message: "Channel deleted successfully",
    });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("Delete channel error:", error);
    return res.status(500).json({ success: false, message: "Server error while deleting channel" });
  }
});

router.post("/:id/remove", authenticateTelegramUser, requireActiveMembership, async (req, res) => {
  try {
    const channel = req.channel;
    const userId = getCurrentUserId(req);
    const isOwner = Number(channel.created_by_user_id) === userId || req.membership.member_role === "owner";

    if (isOwner) {
      return res.status(400).json({
        success: false,
        message: "Owner cannot remove access. Use delete channel instead.",
      });
    }

    await db.query(
      `
        UPDATE telegramlogin_channel_members
        SET member_status = 'left',
            removed_from_dashboard_at = NOW(),
            removed_by_user_id = $2
        WHERE channel_id = $1
          AND telegram_user_id = $2
      `,
      [channel.channel_id, userId]
    );

    return res.status(200).json({
      success: true,
      message: "Channel removed from your dashboard",
    });
  } catch (error) {
    console.error("Remove channel access error:", error);
    return res.status(500).json({ success: false, message: "Server error while removing channel" });
  }
});

/* =====================================================
   SHARE LINK / INVITATIONS
===================================================== */
router.post("/send-link", authenticateTelegramUser, async (req, res) => {
  try {
    const senderUserId = getCurrentUserId(req);
    const channelId = toInt(req.body.channel_id || req.body.channelId);
    const receiverIds = Array.isArray(req.body.receiver_ids) ? req.body.receiver_ids.map(toInt).filter(Boolean) : [];
    const receiverEmails = Array.isArray(req.body.receiver_emails)
      ? req.body.receiver_emails.map(cleanEmail).filter(Boolean)
      : [];

    if (!channelId) {
      return res.status(400).json({ success: false, message: "Channel id required" });
    }

    const channel = await getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: "Channel not found" });
    }

    const membership = await getMembership({ channelId, userId: senderUserId });
    if (!membership || membership.member_status !== "active") {
      return res.status(403).json({ success: false, message: "You cannot share this channel" });
    }

    let receiverUserIds = [...new Set(receiverIds)].filter((id) => id !== senderUserId);

    if (receiverEmails.length > 0) {
      const emailResult = await db.query(
        `
          SELECT telegram_user_id
          FROM telegram_users
          WHERE LOWER(email) = ANY($1::text[])
            AND is_active = TRUE
        `,
        [receiverEmails]
      );

      receiverUserIds = [
        ...new Set([
          ...receiverUserIds,
          ...emailResult.rows.map((row) => Number(row.telegram_user_id)).filter((id) => id !== senderUserId),
        ]),
      ];
    }

    if (receiverUserIds.length === 0) {
      return res.status(400).json({ success: false, message: "Select at least one registered user" });
    }

    const shareLink = buildShareLink(req, channel.share_code);
    const invitations = [];

    await db.query("BEGIN");

    for (const receiverUserId of receiverUserIds) {
      const userExists = await db.query(
        `SELECT telegram_user_id FROM telegram_users WHERE telegram_user_id = $1 AND is_active = TRUE LIMIT 1`,
        [receiverUserId]
      );

      if (userExists.rows.length === 0) continue;

      const invitationResult = await db.query(
        `
          INSERT INTO telegramlogin_channel_invitations
            (
              channel_id,
              sender_user_id,
              receiver_user_id,
              share_code,
              share_link,
              invitation_status
            )
          VALUES
            ($1, $2, $3, $4, $5, 'pending')
          RETURNING *
        `,
        [channelId, senderUserId, receiverUserId, channel.share_code, shareLink]
      );

      invitations.push(invitationResult.rows[0]);
    }

    await db.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Channel link sent successfully",
      sent_count: invitations.length,
      invitations: invitations.map((item) => normalizeInvitation({ ...item, channel_name: channel.channel_name, channel_type: channel.channel_type }, req)),
    });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("Send channel link error:", error);
    return res.status(500).json({ success: false, message: "Server error while sending channel link" });
  }
});

router.post("/share-link", authenticateTelegramUser, async (req, res, next) => {
  req.url = "/send-link";
  return router.handle(req, res, next);
});

router.get("/received-links", authenticateTelegramUser, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    const result = await db.query(
      `
        SELECT
          i.*,
          c.channel_name,
          c.channel_type,
          s.full_name AS sender_name,
          s.email AS sender_email,
          r.full_name AS receiver_name,
          r.email AS receiver_email
        FROM telegramlogin_channel_invitations i
        INNER JOIN telegramlogin_channellist c
          ON c.channel_id = i.channel_id
        INNER JOIN telegram_users s
          ON s.telegram_user_id = i.sender_user_id
        INNER JOIN telegram_users r
          ON r.telegram_user_id = i.receiver_user_id
        WHERE i.receiver_user_id = $1
          AND i.invitation_status = 'pending'
          AND c.is_active = TRUE
          AND c.is_deleted = FALSE
        ORDER BY i.created_at DESC
      `,
      [userId]
    );

    return res.status(200).json({
      success: true,
      message: "Received links loaded successfully",
      links: result.rows.map((row) => normalizeInvitation(row, req)),
      invitations: result.rows.map((row) => normalizeInvitation(row, req)),
    });
  } catch (error) {
    console.error("Received links error:", error);
    return res.status(500).json({ success: false, message: "Server error while loading received links" });
  }
});

router.post("/received-links/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const invitationId = toInt(req.params.id || req.body.invitation_id);
    const userId = getCurrentUserId(req);
    const action = cleanText(req.body.action || req.body.status).toLowerCase();

    if (!invitationId) {
      return res.status(400).json({ success: false, message: "Invitation id required" });
    }

    if (!["accept", "accepted", "reject", "rejected", "decline", "declined"].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be accept or reject" });
    }

    const invitationResult = await db.query(
      `
        SELECT
          i.*,
          c.channel_name,
          c.channel_type,
          c.is_active,
          c.is_deleted,
          s.full_name AS sender_name,
          s.email AS sender_email,
          r.full_name AS receiver_name,
          r.email AS receiver_email
        FROM telegramlogin_channel_invitations i
        INNER JOIN telegramlogin_channellist c
          ON c.channel_id = i.channel_id
        INNER JOIN telegram_users s
          ON s.telegram_user_id = i.sender_user_id
        INNER JOIN telegram_users r
          ON r.telegram_user_id = i.receiver_user_id
        WHERE i.invitation_id = $1
          AND i.receiver_user_id = $2
        LIMIT 1
      `,
      [invitationId, userId]
    );

    if (invitationResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Invitation not found" });
    }

    const invitation = invitationResult.rows[0];

    if (invitation.invitation_status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Invitation already ${invitation.invitation_status}`,
      });
    }

    if (!invitation.is_active || invitation.is_deleted) {
      return res.status(404).json({ success: false, message: "Channel link expired" });
    }

    const accepted = ["accept", "accepted"].includes(action);
    const status = accepted ? "accepted" : "rejected";

    const updateResult = await db.query(
      `
        UPDATE telegramlogin_channel_invitations
        SET invitation_status = $1,
            accepted_at = CASE WHEN $1 = 'accepted' THEN NOW() ELSE accepted_at END,
            rejected_at = CASE WHEN $1 = 'rejected' THEN NOW() ELSE rejected_at END
        WHERE invitation_id = $2
        RETURNING *
      `,
      [status, invitationId]
    );

    const updatedInvitation = {
      ...invitation,
      ...updateResult.rows[0],
      share_link: invitation.share_link || buildShareLink(req, invitation.share_code),
    };

    return res.status(200).json({
      success: true,
      accepted,
      rejected: !accepted,
      message: accepted ? "Invitation accepted" : "Invitation rejected",
      invitation: normalizeInvitation(updatedInvitation, req),
      share_link: accepted ? updatedInvitation.share_link : "",
      share_code: accepted ? updatedInvitation.share_code : "",
    });
  } catch (error) {
    console.error("Respond received link error:", error);
    return res.status(500).json({ success: false, message: "Server error while responding to link" });
  }
});

/* =====================================================
   CHANNEL MEMBERS
===================================================== */
router.get("/:id/members", authenticateTelegramUser, requireActiveMembership, async (req, res) => {
  try {
    const channel = req.channel;
    const isOwner = Number(channel.created_by_user_id) === getCurrentUserId(req) || req.membership.member_role === "owner";

    if (!isOwner) {
      return res.status(403).json({ success: false, message: "Only owner can view members" });
    }

    const result = await db.query(
      `
        SELECT
          m.channel_member_id,
          m.channel_id,
          m.telegram_user_id,
          m.member_role,
          m.member_status,
          m.access_mode,
          m.joined_via_link,
          m.joined_at,
          m.last_opened_at,
          u.full_name,
          u.username,
          u.email,
          u.mobile_no
        FROM telegramlogin_channel_members m
        INNER JOIN telegram_users u
          ON u.telegram_user_id = m.telegram_user_id
        WHERE m.channel_id = $1
        ORDER BY
          CASE WHEN m.member_role = 'owner' THEN 0 ELSE 1 END,
          m.joined_at DESC
      `,
      [channel.channel_id]
    );

    return res.status(200).json({
      success: true,
      message: "Members loaded successfully",
      members: result.rows,
    });
  } catch (error) {
    console.error("Members error:", error);
    return res.status(500).json({ success: false, message: "Server error while loading members" });
  }
});

/* =====================================================
   NOTES / CHANNEL FILES
===================================================== */
router.get("/:id/notes", authenticateTelegramUser, requireActiveMembership, async (req, res) => {
  try {
    const channel = req.channel;

    const result = await db.query(
      `
        SELECT
          n.note_id,
          n.channel_id,
          n.created_by_user_id,
          n.note_type,
          n.note_text,
          (n.attachment_data IS NOT NULL) AS has_attachment,
          n.attachment_mime,
          n.attachment_name,
          n.attachment_size,
          n.attachment_category,
          n.created_device_id,
          n.created_at,
          n.updated_at,
          u.full_name AS created_by_name,
          u.email AS created_by_email
        FROM telegramlogin_notes n
        INNER JOIN telegram_users u
          ON u.telegram_user_id = n.created_by_user_id
        WHERE n.channel_id = $1
          AND n.is_deleted = FALSE
        ORDER BY n.created_at ASC
      `,
      [channel.channel_id]
    );

    return res.status(200).json({
      success: true,
      message: "Notes loaded successfully",
      notes: result.rows.map(normalizeNote),
    });
  } catch (error) {
    console.error("Get notes error:", error);
    return res.status(500).json({ success: false, message: "Server error while loading notes" });
  }
});

router.post("/:id/notes", authenticateTelegramUser, requireActiveMembership, uploadNoteAttachment, async (req, res) => {
  try {
    const channel = req.channel;
    const userId = getCurrentUserId(req);
    const noteText = cleanText(req.body.note_text || req.body.text || "");
    const deviceId = getClientDeviceId(req);
    const file = req.file || null;

    if (!noteText && !file) {
      return res.status(400).json({ success: false, message: "Write a note or upload a file" });
    }

    let noteType = "text";
    let category = null;

    if (file) {
      category = getAttachmentCategory(file.mimetype, file.originalname);
      noteType = category === "image" ? "image" : "file";
    }

    const result = await db.query(
      `
        INSERT INTO telegramlogin_notes
          (
            channel_id,
            created_by_user_id,
            note_type,
            note_text,
            attachment_data,
            attachment_mime,
            attachment_name,
            attachment_size,
            attachment_category,
            created_device_id
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          note_id,
          channel_id,
          created_by_user_id,
          note_type,
          note_text,
          (attachment_data IS NOT NULL) AS has_attachment,
          attachment_mime,
          attachment_name,
          attachment_size,
          attachment_category,
          created_device_id,
          created_at,
          updated_at
      `,
      [
        channel.channel_id,
        userId,
        noteType,
        noteText || null,
        file ? file.buffer : null,
        file ? file.mimetype : null,
        file ? file.originalname : null,
        file ? file.size : null,
        category,
        deviceId || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Note added successfully",
      note: normalizeNote({
        ...result.rows[0],
        created_by_name: req.telegramUser.full_name,
        created_by_email: req.telegramUser.email,
      }),
    });
  } catch (error) {
    console.error("Create note error:", error);
    return res.status(500).json({ success: false, message: "Server error while adding note" });
  }
});

router.get("/notes/:noteId/attachment", authenticateTelegramUser, async (req, res) => {
  try {
    const noteId = toInt(req.params.noteId);
    const userId = getCurrentUserId(req);

    if (!noteId) {
      return res.status(400).json({ success: false, message: "Invalid note id" });
    }

    const result = await db.query(
      `
        SELECT
          n.note_id,
          n.channel_id,
          n.attachment_data,
          n.attachment_mime,
          n.attachment_name
        FROM telegramlogin_notes n
        INNER JOIN telegramlogin_channel_members m
          ON m.channel_id = n.channel_id
         AND m.telegram_user_id = $2
         AND m.member_status = 'active'
        WHERE n.note_id = $1
          AND n.is_deleted = FALSE
          AND n.attachment_data IS NOT NULL
        LIMIT 1
      `,
      [noteId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Attachment not found" });
    }

    const attachment = result.rows[0];
    res.setHeader("Content-Type", attachment.attachment_mime || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(attachment.attachment_name || "attachment").replace(/"/g, "")}"`
    );
    return res.send(attachment.attachment_data);
  } catch (error) {
    console.error("Get attachment error:", error);
    return res.status(500).json({ success: false, message: "Server error while loading attachment" });
  }
});

router.delete("/notes/:noteId", authenticateTelegramUser, async (req, res) => {
  try {
    const noteId = toInt(req.params.noteId);
    const userId = getCurrentUserId(req);

    if (!noteId) {
      return res.status(400).json({ success: false, message: "Invalid note id" });
    }

    const result = await db.query(
      `
        SELECT n.note_id, n.channel_id, n.created_by_user_id, c.created_by_user_id AS channel_owner_id
        FROM telegramlogin_notes n
        INNER JOIN telegramlogin_channellist c
          ON c.channel_id = n.channel_id
        INNER JOIN telegramlogin_channel_members m
          ON m.channel_id = n.channel_id
         AND m.telegram_user_id = $2
         AND m.member_status = 'active'
        WHERE n.note_id = $1
          AND n.is_deleted = FALSE
        LIMIT 1
      `,
      [noteId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Note not found" });
    }

    const note = result.rows[0];
    if (Number(note.created_by_user_id) !== userId && Number(note.channel_owner_id) !== userId) {
      return res.status(403).json({ success: false, message: "You cannot delete this note" });
    }

    await db.query(
      `
        UPDATE telegramlogin_notes
        SET is_deleted = TRUE,
            deleted_at = NOW(),
            deleted_by_user_id = $2
        WHERE note_id = $1
      `,
      [noteId, userId]
    );

    return res.status(200).json({ success: true, message: "Note deleted successfully" });
  } catch (error) {
    console.error("Delete note error:", error);
    return res.status(500).json({ success: false, message: "Server error while deleting note" });
  }
});

/* =====================================================
   CHANNEL DETAILS
===================================================== */
router.get("/:id", authenticateTelegramUser, requireActiveMembership, async (req, res) => {
  try {
    const row = {
      ...req.channel,
      ...req.membership,
      has_channel_logo: req.channel.channel_logo_data != null,
      owner_name: req.channel.owner_name,
      owner_email: req.channel.owner_email,
      is_owner:
        Number(req.channel.created_by_user_id) === getCurrentUserId(req) ||
        req.membership.member_role === "owner",
    };

    return res.status(200).json({
      success: true,
      message: "Channel loaded successfully",
      channel: normalizeChannel(row, req),
    });
  } catch (error) {
    console.error("Get channel error:", error);
    return res.status(500).json({ success: false, message: "Server error while loading channel" });
  }
});


module.exports = router;