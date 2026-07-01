const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const db = require("../../db");
const { sendOTP, sendEmail } = require("../../utils/mailer");

const router = express.Router();

/* ===============================
   Config
================================ */
const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const OTP_EXPIRE_MINUTES = 10;
const OTP_VERIFY_VALID_MINUTES = 30;
const OTP_MAX_ATTEMPTS = 5;
const TRUSTED_DEVICE_EXPIRE_DAYS = 365;

/* ===============================
   Multer Config
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

  if (extname && mimetype) return cb(null, true);

  return cb(new Error("Only JPG, PNG, GIF, and WEBP images are allowed"), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const uploadProfileImage = (req, res, next) => {
  upload.single("profile_image")(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Profile image upload failed",
      });
    }

    return next();
  });
};

/* ===============================
   Helpers
================================ */
const cleanEmail = (value) => String(value || "").trim().toLowerCase();

const cleanText = (value) => String(value || "").trim();

const cleanUsername = (value) => {
  const username = cleanText(value).toLowerCase();
  return username || null;
};

const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(email || "").trim());
};

const isValidMobile = (mobile) => {
  return /^[6-9]\d{9}$/.test(String(mobile || "").trim());
};

const isValidUsername = (username) => {
  if (!username) return true;
  return /^[a-z0-9_]{3,80}$/i.test(String(username || "").trim());
};

const generateOTP = () => String(Math.floor(100000 + Math.random() * 900000));

const addMinutes = (minutes) => new Date(Date.now() + minutes * 60 * 1000);

const getClientIp = (req) => {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return String(req.ip || req.socket?.remoteAddress || "").trim();
};

const createSha256Hash = (value) => {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
};

const generateTrustedDeviceToken = () => {
  return crypto.randomBytes(48).toString("hex");
};

const getApiBasePath = (req) => {
  return (req.baseUrl || "/api/telegramlogin-channels").replace(/\/$/, "");
};

const buildProfileImageUrl = (req, user) => {
  if (!user?.has_profile_image) return "";
  return `${getApiBasePath(req)}/profile-image/${user.telegram_user_id}`;
};

/* ===============================
   Column Helpers
================================ */
let profileColumnCache = null;

const getProfileColumnInfo = async () => {
  if (profileColumnCache) return profileColumnCache;

  const result = await db.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'telegram_users'
        AND column_name IN (
          'profile_image_data',
          'profile_image_mime',
          'profile_image_name',
          'profile_image_size'
        )
    `
  );

  const columns = new Set(result.rows.map((row) => row.column_name));

  profileColumnCache = {
    hasData: columns.has("profile_image_data"),
    hasMime: columns.has("profile_image_mime"),
    hasName: columns.has("profile_image_name"),
    hasSize: columns.has("profile_image_size"),
  };

  profileColumnCache.hasAll =
    profileColumnCache.hasData &&
    profileColumnCache.hasMime &&
    profileColumnCache.hasName &&
    profileColumnCache.hasSize;

  return profileColumnCache;
};

const getUserSelectColumns = (profileInfo, tableAlias = "") => {
  const prefix = tableAlias ? `${tableAlias}.` : "";

  const hasProfileImageSql = profileInfo.hasData
    ? `(${prefix}profile_image_data IS NOT NULL) AS has_profile_image`
    : `FALSE AS has_profile_image`;

  return `
    ${prefix}telegram_user_id,
    ${prefix}full_name,
    ${prefix}username,
    ${prefix}mobile_no,
    ${prefix}email,
    ${prefix}is_email_verified,
    ${prefix}is_active,
    ${hasProfileImageSql},
    ${prefix}last_login_at,
    ${prefix}created_at,
    ${prefix}updated_at
  `;
};

const normalizeUser = (user, req) => {
  if (!user) return null;

  return {
    telegram_user_id: user.telegram_user_id,
    full_name: user.full_name,
    username: user.username || "",
    mobile_no: user.mobile_no,
    email: user.email,
    is_email_verified: user.is_email_verified,
    is_active: user.is_active,
    profile_image_url: buildProfileImageUrl(req, user),
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
};

const createLoginJwtToken = (userRow) => {
  return jwt.sign(
    {
      telegram_user_id: userRow.telegram_user_id,
      email: userRow.email,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );
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

    const profileInfo = await getProfileColumnInfo();
    const userColumns = getUserSelectColumns(profileInfo);

    const result = await db.query(
      `
        SELECT
          ${userColumns}
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
    req.telegramUser = normalizeUser(result.rows[0], req);

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
   Mail + OTP Helpers
================================ */
const sendProfessionalMail = async ({ to, subject, text, html, otp }) => {
  const cleanTo = cleanEmail(to);

  if (!isValidEmail(cleanTo)) {
    throw new Error("Invalid email recipient");
  }

  if (typeof sendEmail === "function") {
    return await sendEmail(cleanTo, subject, html, text);
  }

  if (typeof sendOTP === "function") {
    return await sendOTP(cleanTo, otp, subject);
  }

  throw new Error("Mailer function not found");
};

const buildOtpEmail = ({ otp, title, subtitle, purposeText }) => {
  const subject = title;

  const text = `${title}\n\nYour OTP is ${otp}. This code is valid for ${OTP_EXPIRE_MINUTES} minutes.\n\n${purposeText}\n\nDo not share this code with anyone.`;

  const html = `
    <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:520px;margin:0 auto;padding:24px 14px;">
        <div style="background:#ffffff;border-radius:22px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 16px 40px rgba(15,23,42,0.10);">
          <div style="background:linear-gradient(135deg,#1d4ed8,#06b6d4);padding:24px 22px;color:#ffffff;text-align:center;">
            <div style="width:62px;height:62px;border-radius:18px;background:rgba(255,255,255,0.16);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900;">âœˆ</div>
            <h2 style="margin:0;font-size:24px;line-height:1.2;font-weight:900;">${title}</h2>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.86);font-size:13px;font-weight:600;">${subtitle}</p>
          </div>

          <div style="padding:26px 24px;text-align:center;">
            <p style="margin:0 0 14px;color:#334155;font-size:14px;line-height:1.55;font-weight:600;">
              ${purposeText}
            </p>

            <div style="display:inline-block;margin:10px auto 16px;padding:14px 24px;border-radius:16px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:32px;letter-spacing:8px;font-weight:900;">
              ${otp}
            </div>

            <p style="margin:0;color:#64748b;font-size:13px;line-height:1.55;">
              This code is valid for <b>${OTP_EXPIRE_MINUTES} minutes</b>. Please do not share it with anyone.
            </p>
          </div>

          <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 20px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;font-weight:600;">
              Telegram Login Security â€¢ Infinity Techno Solutions
            </p>
          </div>
        </div>
      </div>
    </div>
  `;

  return { subject, text, html };
};

const createOtpRecord = async ({ email, purpose }) => {
  const otp = generateOTP();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = addMinutes(OTP_EXPIRE_MINUTES);

  await db.query(
    `
      UPDATE telegram_user_otps
      SET is_used = TRUE
      WHERE email = $1
        AND otp_purpose = $2
        AND is_used = FALSE
    `,
    [email, purpose]
  );

  await db.query(
    `
      INSERT INTO telegram_user_otps
        (email, otp_hash, otp_purpose, expires_at)
      VALUES
        ($1, $2, $3, $4)
    `,
    [email, otpHash, purpose, expiresAt]
  );

  return otp;
};

const verifyOtpRecord = async ({ email, purpose, otp }) => {
  const result = await db.query(
    `
      SELECT otp_id, otp_hash, attempts, expires_at
      FROM telegram_user_otps
      WHERE email = $1
        AND otp_purpose = $2
        AND is_used = FALSE
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [email, purpose]
  );

  if (result.rows.length === 0) {
    return {
      ok: false,
      status: 400,
      message: "OTP not found. Please send code again.",
    };
  }

  const otpRecord = result.rows[0];

  if (new Date(otpRecord.expires_at).getTime() < Date.now()) {
    await db.query(
      `UPDATE telegram_user_otps SET is_used = TRUE WHERE otp_id = $1`,
      [otpRecord.otp_id]
    );

    return {
      ok: false,
      status: 400,
      message: "OTP expired. Please send code again.",
    };
  }

  if (Number(otpRecord.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    await db.query(
      `UPDATE telegram_user_otps SET is_used = TRUE WHERE otp_id = $1`,
      [otpRecord.otp_id]
    );

    return {
      ok: false,
      status: 429,
      message: "Too many wrong attempts. Please send code again.",
    };
  }

  const matched = await bcrypt.compare(String(otp), otpRecord.otp_hash);

  if (!matched) {
    await db.query(
      `
        UPDATE telegram_user_otps
        SET attempts = attempts + 1
        WHERE otp_id = $1
      `,
      [otpRecord.otp_id]
    );

    return {
      ok: false,
      status: 400,
      message: "Invalid OTP",
    };
  }

  await db.query(
    `
      UPDATE telegram_user_otps
      SET is_used = TRUE,
          verified_at = NOW()
      WHERE otp_id = $1
    `,
    [otpRecord.otp_id]
  );

  return {
    ok: true,
    message: "OTP verified successfully",
  };
};

const hasRecentEmailVerification = async (email, purpose = "verify_email") => {
  const result = await db.query(
    `
      SELECT otp_id
      FROM telegram_user_otps
      WHERE email = $1
        AND otp_purpose = $2
        AND is_used = TRUE
        AND verified_at IS NOT NULL
        AND verified_at >= NOW() - ($3 || ' minutes')::interval
      ORDER BY verified_at DESC
      LIMIT 1
    `,
    [email, purpose, OTP_VERIFY_VALID_MINUTES]
  );

  return result.rows.length > 0;
};

/* ===============================
   Trusted Device Helpers
================================ */
let trustedDeviceTableReady = false;

const ensureTrustedDeviceTable = async () => {
  if (trustedDeviceTableReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS telegram_user_trusted_devices (
      trusted_device_id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL
        REFERENCES telegram_users(telegram_user_id)
        ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      device_id VARCHAR(255),
      device_name VARCHAR(255),
      user_agent TEXT,
      ip_address VARCHAR(100),
      expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  trustedDeviceTableReady = true;
};

const createTrustedDevice = async ({ telegramUserId, req, deviceId, deviceName }) => {
  await ensureTrustedDeviceTable();

  const trustedDeviceToken = generateTrustedDeviceToken();
  const tokenHash = createSha256Hash(trustedDeviceToken);
  const expiresAt = new Date(
    Date.now() + TRUSTED_DEVICE_EXPIRE_DAYS * 24 * 60 * 60 * 1000
  );

  await db.query(
    `
      INSERT INTO telegram_user_trusted_devices
        (
          telegram_user_id,
          token_hash,
          device_id,
          device_name,
          user_agent,
          ip_address,
          expires_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      telegramUserId,
      tokenHash,
      cleanText(deviceId),
      cleanText(deviceName || "Trusted Device"),
      String(req.headers["user-agent"] || ""),
      getClientIp(req),
      expiresAt,
    ]
  );

  return {
    trusted_device_token: trustedDeviceToken,
    trusted_device_expires_at: expiresAt,
  };
};

const verifyTrustedDeviceToken = async ({ trustedDeviceToken, req }) => {
  const token = cleanText(trustedDeviceToken);

  if (!token || token.length < 40) {
    return {
      ok: false,
      status: 400,
      message: "Trusted device token required",
    };
  }

  await ensureTrustedDeviceTable();

  const tokenHash = createSha256Hash(token);
  const profileInfo = await getProfileColumnInfo();
  const userColumns = getUserSelectColumns(profileInfo, "u");

  const result = await db.query(
    `
      SELECT
        td.trusted_device_id,
        td.expires_at AS trusted_device_expires_at,
        ${userColumns}
      FROM telegram_user_trusted_devices td
      INNER JOIN telegram_users u
        ON u.telegram_user_id = td.telegram_user_id
      WHERE td.token_hash = $1
        AND td.is_active = TRUE
        AND td.expires_at > NOW()
        AND u.is_active = TRUE
      LIMIT 1
    `,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return {
      ok: false,
      status: 401,
      message: "Trusted device expired or invalid. Please login again.",
    };
  }

  const userRow = result.rows[0];

  await db.query(
    `
      UPDATE telegram_user_trusted_devices
      SET last_used_at = NOW()
      WHERE trusted_device_id = $1
    `,
    [userRow.trusted_device_id]
  );

  await db.query(
    `
      UPDATE telegram_users
      SET last_login_at = NOW()
      WHERE telegram_user_id = $1
    `,
    [userRow.telegram_user_id]
  );

  return {
    ok: true,
    user: normalizeUser(
      {
        ...userRow,
        last_login_at: new Date(),
      },
      req
    ),
  };
};

/* ===============================
   API 1: Send Email Verify OTP
   POST /send-code
================================ */
router.post("/send-code", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid email",
      });
    }

    const existingUser = await db.query(
      `SELECT telegram_user_id FROM telegram_users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email already registered",
      });
    }

    const otp = await createOtpRecord({
      email,
      purpose: "verify_email",
    });

    const mail = buildOtpEmail({
      otp,
      title: "Verify Your Email",
      subtitle: "Complete your Telegram Login registration",
      purposeText:
        "Use the verification code below to verify your email address and continue account registration.",
    });

    await sendProfessionalMail({
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      otp,
    });

    return res.status(200).json({
      success: true,
      message: "Verification code sent to email",
    });
  } catch (error) {
    console.error("Send email verify OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while sending OTP",
    });
  }
});

/* ===============================
   API 2: Verify Email OTP
   POST /verify-code
================================ */
router.post("/verify-code", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const code = String(req.body.code || "").replace(/\D/g, "").slice(0, 6);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid email",
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 6 digit OTP",
      });
    }

    const verifyResult = await verifyOtpRecord({
      email,
      purpose: "verify_email",
      otp: code,
    });

    if (!verifyResult.ok) {
      return res.status(verifyResult.status).json({
        success: false,
        message: verifyResult.message,
      });
    }

    return res.status(200).json({
      success: true,
      verified: true,
      message: "Email verified successfully",
    });
  } catch (error) {
    console.error("Verify email OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while verifying OTP",
    });
  }
});

/* ===============================
   API 3: Register
   POST /register

   form-data:
   full_name, username(optional), mobile_no, email, password, profile_image(optional)
================================ */
router.post("/register", uploadProfileImage, async (req, res) => {
  try {
    const fullName = cleanText(req.body.full_name);
    const username = cleanUsername(req.body.username);
    const mobileNo = cleanText(req.body.mobile_no);
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");

    if (fullName.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Full name must be at least 3 characters",
      });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({
        success: false,
        message: "Username must be 3-80 characters and contain only letters, numbers, and underscore",
      });
    }

    if (!isValidMobile(mobileNo)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 10 digit mobile number",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid email",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    const duplicateParams = [email, mobileNo];
    let duplicateSql = `
      SELECT telegram_user_id, username, email, mobile_no
      FROM telegram_users
      WHERE LOWER(email) = $1 OR mobile_no = $2
    `;

    if (username) {
      duplicateParams.push(username);
      duplicateSql += ` OR LOWER(username) = $3`;
    }

    duplicateSql += ` LIMIT 1`;

    const alreadyExists = await db.query(duplicateSql, duplicateParams);

    if (alreadyExists.rows.length > 0) {
      const existingUser = alreadyExists.rows[0];

      return res.status(409).json({
        success: false,
        message:
          cleanEmail(existingUser.email) === email
            ? "Email already registered"
            : existingUser.mobile_no === mobileNo
            ? "Mobile number already registered"
            : "Username already registered",
      });
    }

    const verified = await hasRecentEmailVerification(email, "verify_email");

    if (!verified) {
      return res.status(400).json({
        success: false,
        message: "Please verify your email before registration",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const profileInfo = await getProfileColumnInfo();

    let insertResult;

    if (profileInfo.hasAll) {
      insertResult = await db.query(
        `
          INSERT INTO telegram_users
            (
              full_name,
              username,
              mobile_no,
              email,
              password_hash,
              profile_image_data,
              profile_image_mime,
              profile_image_name,
              profile_image_size,
              is_email_verified
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
          RETURNING
            telegram_user_id,
            full_name,
            username,
            mobile_no,
            email,
            is_email_verified,
            is_active,
            (profile_image_data IS NOT NULL) AS has_profile_image,
            last_login_at,
            created_at,
            updated_at
        `,
        [
          fullName,
          username,
          mobileNo,
          email,
          passwordHash,
          req.file ? req.file.buffer : null,
          req.file ? req.file.mimetype : null,
          req.file ? req.file.originalname : null,
          req.file ? req.file.size : null,
        ]
      );
    } else {
      insertResult = await db.query(
        `
          INSERT INTO telegram_users
            (
              full_name,
              username,
              mobile_no,
              email,
              password_hash,
              is_email_verified
            )
          VALUES
            ($1, $2, $3, $4, $5, TRUE)
          RETURNING
            telegram_user_id,
            full_name,
            username,
            mobile_no,
            email,
            is_email_verified,
            is_active,
            FALSE AS has_profile_image,
            last_login_at,
            created_at,
            updated_at
        `,
        [fullName, username, mobileNo, email, passwordHash]
      );
    }

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      user: normalizeUser(insertResult.rows[0], req),
    });
  } catch (error) {
    console.error("Register telegram user error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Email, mobile number, or username already registered",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error while registration",
    });
  }
});

/* ===============================
   API 4: Login
   POST /login

   json:
   username/email/mobile_no, password, trust_device(optional), device_id(optional), device_name(optional)
================================ */
router.post("/login", async (req, res) => {
  try {
    const username = cleanText(
      req.body.username || req.body.email || req.body.mobile_no
    ).toLowerCase();

    const password = String(req.body.password || "");
    const trustDevice =
      req.body.trust_device === true ||
      String(req.body.trust_device || "").toLowerCase() === "true";

    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Enter username, email, or mobile number",
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Enter password",
      });
    }

    const profileInfo = await getProfileColumnInfo();

    const hasProfileImageSql = profileInfo.hasData
      ? `(profile_image_data IS NOT NULL) AS has_profile_image`
      : `FALSE AS has_profile_image`;

    const result = await db.query(
      `
        SELECT
          telegram_user_id,
          full_name,
          username,
          mobile_no,
          email,
          password_hash,
          is_email_verified,
          is_active,
          ${hasProfileImageSql},
          last_login_at,
          created_at,
          updated_at
        FROM telegram_users
        WHERE LOWER(email) = $1
           OR LOWER(username) = $1
           OR mobile_no = $1
        LIMIT 1
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const userRow = result.rows[0];

    if (!userRow.is_active) {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive",
      });
    }

    const passwordMatched = await bcrypt.compare(password, userRow.password_hash);

    if (!passwordMatched) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    await db.query(
      `
        UPDATE telegram_users
        SET last_login_at = NOW()
        WHERE telegram_user_id = $1
      `,
      [userRow.telegram_user_id]
    );

    const token = createLoginJwtToken(userRow);

    let trustedDevice = null;

    if (trustDevice) {
      trustedDevice = await createTrustedDevice({
        telegramUserId: userRow.telegram_user_id,
        req,
        deviceId: req.body.device_id,
        deviceName: req.body.device_name,
      });
    }

    return res.status(200).json({
      success: true,
      message: trustedDevice
        ? "Login successful. This device is now trusted."
        : "Login successful",
      token,
      trusted_device: Boolean(trustedDevice),
      trusted_device_token: trustedDevice
        ? trustedDevice.trusted_device_token
        : undefined,
      trusted_device_expires_at: trustedDevice
        ? trustedDevice.trusted_device_expires_at
        : undefined,
      user: normalizeUser(
        {
          ...userRow,
          last_login_at: new Date(),
        },
        req
      ),
    });
  } catch (error) {
    console.error("Telegram login error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while login",
    });
  }
});

/* ===============================
   API 4A: Trusted Device Login
   POST /trusted-login
================================ */
router.post("/trusted-login", async (req, res) => {
  try {
    const verifyResult = await verifyTrustedDeviceToken({
      trustedDeviceToken: req.body.trusted_device_token,
      req,
    });

    if (!verifyResult.ok) {
      return res.status(verifyResult.status).json({
        success: false,
        message: verifyResult.message,
      });
    }

    const token = createLoginJwtToken(verifyResult.user);

    return res.status(200).json({
      success: true,
      message: "Trusted device login successful",
      token,
      user: verifyResult.user,
    });
  } catch (error) {
    console.error("Trusted device login error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while trusted device login",
    });
  }
});

/* ===============================
   API 4B: Remove Trusted Device
   POST /logout-trusted-device
================================ */
router.post("/logout-trusted-device", async (req, res) => {
  try {
    const trustedDeviceToken = cleanText(req.body.trusted_device_token);

    if (!trustedDeviceToken) {
      return res.status(400).json({
        success: false,
        message: "Trusted device token required",
      });
    }

    await ensureTrustedDeviceTable();

    await db.query(
      `
        UPDATE telegram_user_trusted_devices
        SET is_active = FALSE
        WHERE token_hash = $1
      `,
      [createSha256Hash(trustedDeviceToken)]
    );

    return res.status(200).json({
      success: true,
      message: "Trusted device removed successfully",
    });
  } catch (error) {
    console.error("Remove trusted device error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while removing trusted device",
    });
  }
});

/* ===============================
   API 5: Send Forgot Password OTP
   POST /forgot-password/send-code
================================ */
router.post("/forgot-password/send-code", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid email",
      });
    }

    const userResult = await db.query(
      `
        SELECT telegram_user_id, full_name, email
        FROM telegram_users
        WHERE LOWER(email) = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Email not registered",
      });
    }

    const otp = await createOtpRecord({
      email,
      purpose: "forgot_password",
    });

    const mail = buildOtpEmail({
      otp,
      title: "Reset Your Password",
      subtitle: "Secure password reset request",
      purposeText:
        "Use the OTP below to reset your Telegram Login password. If you did not request this, you can safely ignore this email.",
    });

    await sendProfessionalMail({
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      otp,
    });

    return res.status(200).json({
      success: true,
      message: "Forgot password OTP sent to email",
    });
  } catch (error) {
    console.error("Forgot password OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while sending forgot OTP",
    });
  }
});

/* ===============================
   API 6: Reset Forgot Password
   POST /forgot-password/reset
================================ */
router.post("/forgot-password/reset", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const code = String(req.body.code || "").replace(/\D/g, "").slice(0, 6);
    const newPassword = String(req.body.new_password || req.body.password || "");

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid email",
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 6 digit OTP",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters",
      });
    }

    const userResult = await db.query(
      `
        SELECT telegram_user_id, email
        FROM telegram_users
        WHERE LOWER(email) = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Email not registered",
      });
    }

    const verifyResult = await verifyOtpRecord({
      email,
      purpose: "forgot_password",
      otp: code,
    });

    if (!verifyResult.ok) {
      return res.status(verifyResult.status).json({
        success: false,
        message: verifyResult.message,
      });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    await db.query(
      `
        UPDATE telegram_users
        SET password_hash = $1
        WHERE LOWER(email) = $2
      `,
      [newPasswordHash, email]
    );

    return res.status(200).json({
      success: true,
      message: "Password reset successfully",
    });
  } catch (error) {
    console.error("Reset forgot password error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while resetting password",
    });
  }
});

/* ===============================
   API 6A: Send Old Email OTP For Email Update
   POST /update-email/send-old-code
   Header: Authorization Bearer token
================================ */
router.post("/update-email/send-old-code", authenticateTelegramUser, async (req, res) => {
  try {
    const oldEmail = cleanEmail(req.telegramUser.email);

    const otp = await createOtpRecord({
      email: oldEmail,
      purpose: "update_old_email",
    });

    const mail = buildOtpEmail({
      otp,
      title: "Verify Old Email",
      subtitle: "Confirm your current email address",
      purposeText:
        "Use the OTP below to verify your current email address before updating your account email.",
    });

    await sendProfessionalMail({
      to: oldEmail,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      otp,
    });

    return res.status(200).json({
      success: true,
      message: "Old email verification OTP sent",
    });
  } catch (error) {
    console.error("Send old email OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while sending old email OTP",
    });
  }
});

/* ===============================
   API 6B: Verify Old Email OTP
   POST /update-email/verify-old-code
================================ */
router.post("/update-email/verify-old-code", authenticateTelegramUser, async (req, res) => {
  try {
    const oldEmail = cleanEmail(req.telegramUser.email);
    const code = String(req.body.code || "").replace(/\D/g, "").slice(0, 6);

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 6 digit OTP",
      });
    }

    const verifyResult = await verifyOtpRecord({
      email: oldEmail,
      purpose: "update_old_email",
      otp: code,
    });

    if (!verifyResult.ok) {
      return res.status(verifyResult.status).json({
        success: false,
        message: verifyResult.message,
      });
    }

    return res.status(200).json({
      success: true,
      verified: true,
      message: "Old email verified successfully",
    });
  } catch (error) {
    console.error("Verify old email OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while verifying old email OTP",
    });
  }
});

/* ===============================
   API 6C: Send New Email OTP For Email Update
   POST /update-email/send-new-code
================================ */
router.post("/update-email/send-new-code", authenticateTelegramUser, async (req, res) => {
  try {
    const currentEmail = cleanEmail(req.telegramUser.email);
    const newEmail = cleanEmail(req.body.email || req.body.new_email);

    if (!isValidEmail(newEmail)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid new email",
      });
    }

    if (newEmail === currentEmail) {
      return res.status(400).json({
        success: false,
        message: "New email is same as current email",
      });
    }

    const oldVerified = await hasRecentEmailVerification(
      currentEmail,
      "update_old_email"
    );

    if (!oldVerified) {
      return res.status(400).json({
        success: false,
        message: "Please verify old email first",
      });
    }

    const existing = await db.query(
      `
        SELECT telegram_user_id
        FROM telegram_users
        WHERE LOWER(email) = $1
          AND telegram_user_id <> $2
        LIMIT 1
      `,
      [newEmail, req.telegramUserId]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "New email already registered",
      });
    }

    const otp = await createOtpRecord({
      email: newEmail,
      purpose: "update_new_email",
    });

    const mail = buildOtpEmail({
      otp,
      title: "Verify New Email",
      subtitle: "Confirm your new email address",
      purposeText:
        "Use the OTP below to verify your new email address before updating your profile.",
    });

    await sendProfessionalMail({
      to: newEmail,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      otp,
    });

    return res.status(200).json({
      success: true,
      message: "New email verification OTP sent",
    });
  } catch (error) {
    console.error("Send new email OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while sending new email OTP",
    });
  }
});

/* ===============================
   API 6D: Verify New Email OTP
   POST /update-email/verify-new-code
================================ */
router.post("/update-email/verify-new-code", authenticateTelegramUser, async (req, res) => {
  try {
    const newEmail = cleanEmail(req.body.email || req.body.new_email);
    const code = String(req.body.code || "").replace(/\D/g, "").slice(0, 6);

    if (!isValidEmail(newEmail)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid new email",
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 6 digit OTP",
      });
    }

    const verifyResult = await verifyOtpRecord({
      email: newEmail,
      purpose: "update_new_email",
      otp: code,
    });

    if (!verifyResult.ok) {
      return res.status(verifyResult.status).json({
        success: false,
        message: verifyResult.message,
      });
    }

    return res.status(200).json({
      success: true,
      verified: true,
      message: "New email verified successfully. Now update profile.",
    });
  } catch (error) {
    console.error("Verify new email OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while verifying new email OTP",
    });
  }
});

/* ===============================
   API 7: Get Profile Image From DB
   GET /profile-image/:id
================================ */
router.get("/profile-image/:id", async (req, res) => {
  try {
    const telegramUserId = Number(req.params.id);

    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    const profileInfo = await getProfileColumnInfo();

    if (!profileInfo.hasData || !profileInfo.hasMime) {
      return res.status(404).json({
        success: false,
        message: "Profile image storage not enabled",
      });
    }

    const result = await db.query(
      `
        SELECT profile_image_data, profile_image_mime
        FROM telegram_users
        WHERE telegram_user_id = $1
          AND profile_image_data IS NOT NULL
        LIMIT 1
      `,
      [telegramUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Profile image not found",
      });
    }

    const image = result.rows[0];

    res.setHeader("Content-Type", image.profile_image_mime || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");

    return res.send(image.profile_image_data);
  } catch (error) {
    console.error("Get profile image error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading image",
    });
  }
});

/* ===============================
   API 7A: Upload/Update Profile Image Only
   PUT /profile-image/:id
   form-data: profile_image
================================ */
router.put("/profile-image/:id", authenticateTelegramUser, uploadProfileImage, async (req, res) => {
  try {
    const telegramUserId = Number(req.params.id);

    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    if (telegramUserId !== req.telegramUserId) {
      return res.status(403).json({
        success: false,
        message: "You can update only your own profile image",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Profile image is required",
      });
    }

    const profileInfo = await getProfileColumnInfo();

    if (!profileInfo.hasAll) {
      return res.status(400).json({
        success: false,
        message: "Profile image storage not enabled in database",
      });
    }

    const result = await db.query(
      `
        UPDATE telegram_users
        SET profile_image_data = $1,
            profile_image_mime = $2,
            profile_image_name = $3,
            profile_image_size = $4
        WHERE telegram_user_id = $5
        RETURNING
          telegram_user_id,
          full_name,
          username,
          mobile_no,
          email,
          is_email_verified,
          is_active,
          (profile_image_data IS NOT NULL) AS has_profile_image,
          last_login_at,
          created_at,
          updated_at
      `,
      [
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
        req.file.size,
        telegramUserId,
      ]
    );

    return res.status(200).json({
      success: true,
      message: "Profile image updated successfully",
      user: normalizeUser(result.rows[0], req),
    });
  } catch (error) {
    console.error("Update profile image error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while updating profile image",
    });
  }
});

/* ===============================
   API 7B: Delete Profile Image Only
   DELETE /profile-image/:id
================================ */
router.delete("/profile-image/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const telegramUserId = Number(req.params.id);

    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    if (telegramUserId !== req.telegramUserId) {
      return res.status(403).json({
        success: false,
        message: "You can delete only your own profile image",
      });
    }

    const profileInfo = await getProfileColumnInfo();

    if (!profileInfo.hasAll) {
      return res.status(400).json({
        success: false,
        message: "Profile image storage not enabled in database",
      });
    }

    const result = await db.query(
      `
        UPDATE telegram_users
        SET profile_image_data = NULL,
            profile_image_mime = NULL,
            profile_image_name = NULL,
            profile_image_size = NULL
        WHERE telegram_user_id = $1
        RETURNING
          telegram_user_id,
          full_name,
          username,
          mobile_no,
          email,
          is_email_verified,
          is_active,
          FALSE AS has_profile_image,
          last_login_at,
          created_at,
          updated_at
      `,
      [telegramUserId]
    );

    return res.status(200).json({
      success: true,
      message: "Profile image deleted successfully",
      user: normalizeUser(result.rows[0], req),
    });
  } catch (error) {
    console.error("Delete profile image error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while deleting profile image",
    });
  }
});

/* ===============================
   API 8: Get Logged-In User Profile
   GET /me
================================ */
router.get("/me", authenticateTelegramUser, async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "User profile loaded successfully",
    user: req.telegramUser,
  });
});

/* ===============================
   API 9: Get All Users List
   GET /list
================================ */
router.get("/list", async (req, res) => {
  try {
    const profileInfo = await getProfileColumnInfo();
    const userColumns = getUserSelectColumns(profileInfo);

    const search = cleanText(req.query.search);
    const includeInactive =
      String(req.query.include_inactive || "").toLowerCase() === "true";

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "20", 10), 1),
      100
    );
    const offset = (page - 1) * limit;

    const whereParts = [];
    const params = [];

    if (!includeInactive) {
      whereParts.push("is_active = TRUE");
    }

    if (search) {
      params.push(`%${search}%`);
      whereParts.push(
        `(full_name ILIKE $${params.length} OR username ILIKE $${params.length} OR email ILIKE $${params.length} OR mobile_no ILIKE $${params.length})`
      );
    }

    const whereSql =
      whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const countResult = await db.query(
      `
        SELECT COUNT(*)::INTEGER AS total
        FROM telegram_users
        ${whereSql}
      `,
      params
    );

    params.push(limit);
    const limitParam = params.length;

    params.push(offset);
    const offsetParam = params.length;

    const result = await db.query(
      `
        SELECT
          ${userColumns}
        FROM telegram_users
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${limitParam}
        OFFSET $${offsetParam}
      `,
      params
    );

    return res.status(200).json({
      success: true,
      message: "Users loaded successfully",
      total: countResult.rows[0].total,
      page,
      limit,
      users: result.rows.map((row) => normalizeUser(row, req)),
    });
  } catch (error) {
    console.error("Get all telegram users error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading users",
    });
  }
});

/* ===============================
   API 9A: Get All Registered Users
   GET /all-register-users
================================ */
router.get("/all-register-users", async (req, res) => {
  try {
    const profileInfo = await getProfileColumnInfo();
    const userColumns = getUserSelectColumns(profileInfo);

    const search = cleanText(req.query.search);
    const includeInactive =
      String(req.query.include_inactive || "").toLowerCase() === "true";

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "20", 10), 1),
      100
    );
    const offset = (page - 1) * limit;

    const whereParts = [];
    const params = [];

    if (!includeInactive) {
      whereParts.push("is_active = TRUE");
    }

    if (search) {
      params.push(`%${search}%`);
      whereParts.push(
        `(full_name ILIKE $${params.length} OR username ILIKE $${params.length} OR email ILIKE $${params.length} OR mobile_no ILIKE $${params.length})`
      );
    }

    const whereSql =
      whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const countResult = await db.query(
      `
        SELECT COUNT(*)::INTEGER AS total
        FROM telegram_users
        ${whereSql}
      `,
      params
    );

    params.push(limit);
    const limitParam = params.length;

    params.push(offset);
    const offsetParam = params.length;

    const result = await db.query(
      `
        SELECT
          ${userColumns}
        FROM telegram_users
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${limitParam}
        OFFSET $${offsetParam}
      `,
      params
    );

    return res.status(200).json({
      success: true,
      message: "All registered users loaded successfully",
      total: countResult.rows[0].total,
      page,
      limit,
      users: result.rows.map((row) => normalizeUser(row, req)),
    });
  } catch (error) {
    console.error("Get all registered users error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading registered users",
    });
  }
});

/* ===============================
   API 12: Health Check
   GET /health
================================ */
router.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Telegram users API is running",
  });
});

/* ===============================
   API 9B: Get Single User
   GET /:id
================================ */
router.get("/:id", async (req, res) => {
  try {
    const telegramUserId = Number(req.params.id);

    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    const profileInfo = await getProfileColumnInfo();
    const userColumns = getUserSelectColumns(profileInfo);

    const result = await db.query(
      `
        SELECT
          ${userColumns}
        FROM telegram_users
        WHERE telegram_user_id = $1
        LIMIT 1
      `,
      [telegramUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User loaded successfully",
      user: normalizeUser(result.rows[0], req),
    });
  } catch (error) {
    console.error("Get telegram user error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while loading user",
    });
  }
});

/* ===============================
   API 10: Update User Details
   PUT /:id

   JSON or Form-data:
   full_name, username, mobile_no, email, password, profile_image
================================ */
router.put("/:id", authenticateTelegramUser, uploadProfileImage, async (req, res) => {
  try {
    const telegramUserId = Number(req.params.id);

    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    if (telegramUserId !== req.telegramUserId) {
      return res.status(403).json({
        success: false,
        message: "You can update only your own profile",
      });
    }

    const existingResult = await db.query(
      `
        SELECT telegram_user_id, full_name, username, mobile_no, email
        FROM telegram_users
        WHERE telegram_user_id = $1
        LIMIT 1
      `,
      [telegramUserId]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const existingUser = existingResult.rows[0];

    const hasFullName = Object.prototype.hasOwnProperty.call(req.body, "full_name");
    const hasUsername = Object.prototype.hasOwnProperty.call(req.body, "username");
    const hasMobileNo = Object.prototype.hasOwnProperty.call(req.body, "mobile_no");
    const hasEmail = Object.prototype.hasOwnProperty.call(req.body, "email");
    const hasPassword = Object.prototype.hasOwnProperty.call(req.body, "password");

    const fullName = hasFullName ? cleanText(req.body.full_name) : null;
    const username = hasUsername ? cleanUsername(req.body.username) : undefined;
    const mobileNo = hasMobileNo ? cleanText(req.body.mobile_no) : null;
    const email = hasEmail ? cleanEmail(req.body.email) : null;
    const password = hasPassword ? String(req.body.password || "") : null;

    if (hasFullName && fullName.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Full name must be at least 3 characters",
      });
    }

    if (hasUsername && !isValidUsername(username)) {
      return res.status(400).json({
        success: false,
        message: "Username must be 3-80 characters and contain only letters, numbers, and underscore",
      });
    }

    if (hasMobileNo && !isValidMobile(mobileNo)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid 10 digit mobile number",
      });
    }

    if (hasEmail && !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid email",
      });
    }

    if (hasPassword && password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    if (hasEmail && email !== cleanEmail(existingUser.email)) {
      const currentEmail = cleanEmail(existingUser.email);
      const oldVerified = await hasRecentEmailVerification(
        currentEmail,
        "update_old_email"
      );
      const newVerified = await hasRecentEmailVerification(
        email,
        "update_new_email"
      );

      if (!oldVerified || !newVerified) {
        return res.status(400).json({
          success: false,
          message: "Please verify old email and new email before updating email",
        });
      }
    }

    const duplicateConditions = [];
    const duplicateParams = [];

    if (hasEmail && email !== cleanEmail(existingUser.email)) {
      duplicateParams.push(email);
      duplicateConditions.push(`LOWER(email) = $${duplicateParams.length}`);
    }

    if (hasMobileNo && mobileNo !== existingUser.mobile_no) {
      duplicateParams.push(mobileNo);
      duplicateConditions.push(`mobile_no = $${duplicateParams.length}`);
    }

    if (
      hasUsername &&
      username &&
      username !== cleanUsername(existingUser.username)
    ) {
      duplicateParams.push(username);
      duplicateConditions.push(`LOWER(username) = $${duplicateParams.length}`);
    }

    if (duplicateConditions.length > 0) {
      duplicateParams.push(telegramUserId);

      const duplicateResult = await db.query(
        `
          SELECT telegram_user_id, username, email, mobile_no
          FROM telegram_users
          WHERE (${duplicateConditions.join(" OR ")})
            AND telegram_user_id <> $${duplicateParams.length}
          LIMIT 1
        `,
        duplicateParams
      );

      if (duplicateResult.rows.length > 0) {
        const duplicateUser = duplicateResult.rows[0];

        return res.status(409).json({
          success: false,
          message:
            cleanEmail(duplicateUser.email) === email
              ? "Email already registered"
              : duplicateUser.mobile_no === mobileNo
              ? "Mobile number already registered"
              : "Username already registered",
        });
      }
    }

    const setClauses = [];
    const values = [];

    if (hasFullName) {
      values.push(fullName);
      setClauses.push(`full_name = $${values.length}`);
    }

    if (hasUsername) {
      values.push(username || null);
      setClauses.push(`username = $${values.length}`);
    }

    if (hasMobileNo) {
      values.push(mobileNo);
      setClauses.push(`mobile_no = $${values.length}`);
    }

    if (hasEmail) {
      values.push(email);
      setClauses.push(`email = $${values.length}`);
      setClauses.push(`is_email_verified = TRUE`);
    }

    if (hasPassword) {
      const passwordHash = await bcrypt.hash(password, 12);
      values.push(passwordHash);
      setClauses.push(`password_hash = $${values.length}`);
    }

    if (req.file) {
      const profileInfo = await getProfileColumnInfo();

      if (!profileInfo.hasAll) {
        return res.status(400).json({
          success: false,
          message: "Profile image storage not enabled in database",
        });
      }

      values.push(req.file.buffer);
      setClauses.push(`profile_image_data = $${values.length}`);

      values.push(req.file.mimetype);
      setClauses.push(`profile_image_mime = $${values.length}`);

      values.push(req.file.originalname);
      setClauses.push(`profile_image_name = $${values.length}`);

      values.push(req.file.size);
      setClauses.push(`profile_image_size = $${values.length}`);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid user details provided for update",
      });
    }

    const profileInfo = await getProfileColumnInfo();
    const userColumns = getUserSelectColumns(profileInfo);

    values.push(telegramUserId);

    const result = await db.query(
      `
        UPDATE telegram_users
        SET ${setClauses.join(", ")}
        WHERE telegram_user_id = $${values.length}
        RETURNING
          ${userColumns}
      `,
      values
    );

    return res.status(200).json({
      success: true,
      message: "User updated successfully",
      user: normalizeUser(result.rows[0], req),
    });
  } catch (error) {
    console.error("Update telegram user error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Email, mobile number, or username already registered",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error while updating user",
    });
  }
});

/* ===============================
   API 11: Delete User
   DELETE /:id
================================ */
router.delete("/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const telegramUserId = Number(req.params.id);

    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    if (telegramUserId !== req.telegramUserId) {
      return res.status(403).json({
        success: false,
        message: "You can delete only your own account",
      });
    }

    const existingResult = await db.query(
      `
        SELECT telegram_user_id, full_name, email
        FROM telegram_users
        WHERE telegram_user_id = $1
        LIMIT 1
      `,
      [telegramUserId]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const deleteResult = await db.query(
      `
        DELETE FROM telegram_users
        WHERE telegram_user_id = $1
        RETURNING telegram_user_id, full_name, email
      `,
      [telegramUserId]
    );

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
      deleted_user: deleteResult.rows[0],
    });
  } catch (error) {
    console.error("Delete telegram user error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while deleting user",
    });
  }
});

module.exports = router;