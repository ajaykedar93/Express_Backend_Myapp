const express = require("express");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const db = require("../../db");

// Mailer
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

/*
  IMPORTANT FIX:
  Your database currently does not have:
  profile_image_data, profile_image_mime, profile_image_name, profile_image_size

  This backend will NOT crash if those columns are missing.
  Profile image is optional.
  If image columns are missing, profile image upload is ignored safely.
*/

/* ===============================
   Multer Config
   Optional profile image
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

const uploadProfileImage = (req, res, next) => {
  upload.single("profile_image")(req, res, function (error) {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Profile image upload failed",
      });
    }

    next();
  });
};

/* ===============================
   Helpers
================================ */
const cleanEmail = (value) => String(value || "").trim().toLowerCase();

const cleanText = (value) => String(value || "").trim();

const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(email || "").trim());
};

const isValidMobile = (mobile) => {
  return /^[6-9]\d{9}$/.test(String(mobile || "").trim());
};

const generateOTP = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

const addMinutes = (minutes) => {
  return new Date(Date.now() + minutes * 60 * 1000);
};

/* ===============================
   Profile Image Column Check
   This prevents:
   column "profile_image_data" does not exist
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

const normalizeUser = (user) => {
  if (!user) return null;

  return {
    telegram_user_id: user.telegram_user_id,
    full_name: user.full_name,
    mobile_no: user.mobile_no,
    email: user.email,
    is_email_verified: user.is_email_verified,
    profile_image_url: user.has_profile_image
      ? `/api/telegram-users/profile-image/${user.telegram_user_id}`
      : "",
    last_login_at: user.last_login_at,
    created_at: user.created_at,
  };
};

/*
  Mailjet FIX:
  Your error was:
  Type mismatch. Expected type "string". ErrorRelatedTo: Messages.To

  So do not call sendEmail({ to, subject, ... }).
  Call sendEmail(to, subject, html, text), where "to" is a string.
*/
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
            <div style="width:62px;height:62px;border-radius:18px;background:rgba(255,255,255,0.16);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900;">✈</div>
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
              Telegram Login Security • Infinity Techno Solutions
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
      SELECT otp_id, otp_hash, attempts, expires_at, is_used
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

const hasRecentEmailVerification = async (email) => {
  const result = await db.query(
    `
      SELECT otp_id
      FROM telegram_user_otps
      WHERE email = $1
        AND otp_purpose = 'verify_email'
        AND is_used = TRUE
        AND verified_at IS NOT NULL
        AND verified_at >= NOW() - ($2 || ' minutes')::interval
      ORDER BY verified_at DESC
      LIMIT 1
    `,
    [email, OTP_VERIFY_VALID_MINUTES]
  );

  return result.rows.length > 0;
};

/* ===============================
   API 1: Send Email Verify OTP
   POST /api/telegram-users/send-code
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
      `SELECT telegram_user_id FROM telegram_users WHERE email = $1 LIMIT 1`,
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
   POST /api/telegram-users/verify-code
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
   POST /api/telegram-users/register
   form-data:
   full_name, mobile_no, email, password, profile_image(optional)
================================ */
router.post("/register", uploadProfileImage, async (req, res) => {
  try {
    const fullName = cleanText(req.body.full_name);
    const mobileNo = cleanText(req.body.mobile_no);
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");

    if (fullName.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Full name must be at least 3 characters",
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

    const alreadyExists = await db.query(
      `
        SELECT telegram_user_id, email, mobile_no
        FROM telegram_users
        WHERE email = $1 OR mobile_no = $2
        LIMIT 1
      `,
      [email, mobileNo]
    );

    if (alreadyExists.rows.length > 0) {
      const user = alreadyExists.rows[0];

      return res.status(409).json({
        success: false,
        message:
          user.email === email
            ? "Email already registered"
            : "Mobile number already registered",
      });
    }

    const verified = await hasRecentEmailVerification(email);

    if (!verified) {
      return res.status(400).json({
        success: false,
        message: "Please verify your email before registration",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const profileInfo = await getProfileColumnInfo();

    let insertResult;

    /*
      If DB has image columns and image was uploaded, store image.
      If columns are missing, image is ignored safely because profile is optional.
    */
    if (profileInfo.hasAll) {
      const profileImageBuffer = req.file ? req.file.buffer : null;
      const profileImageMime = req.file ? req.file.mimetype : null;
      const profileImageName = req.file ? req.file.originalname : null;
      const profileImageSize = req.file ? req.file.size : null;

      insertResult = await db.query(
        `
          INSERT INTO telegram_users
            (
              full_name,
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
            ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
          RETURNING
            telegram_user_id,
            full_name,
            mobile_no,
            email,
            is_email_verified,
            (profile_image_data IS NOT NULL) AS has_profile_image,
            last_login_at,
            created_at
        `,
        [
          fullName,
          mobileNo,
          email,
          passwordHash,
          profileImageBuffer,
          profileImageMime,
          profileImageName,
          profileImageSize,
        ]
      );
    } else {
      if (req.file) {
        console.warn(
          "Profile image ignored because profile_image_* columns do not exist in telegram_users table."
        );
      }

      insertResult = await db.query(
        `
          INSERT INTO telegram_users
            (
              full_name,
              mobile_no,
              email,
              password_hash,
              is_email_verified
            )
          VALUES
            ($1, $2, $3, $4, TRUE)
          RETURNING
            telegram_user_id,
            full_name,
            mobile_no,
            email,
            is_email_verified,
            FALSE AS has_profile_image,
            last_login_at,
            created_at
        `,
        [fullName, mobileNo, email, passwordHash]
      );
    }

    const user = normalizeUser(insertResult.rows[0]);

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      user,
    });
  } catch (error) {
    console.error("Register telegram user error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Email or mobile already registered",
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
   POST /api/telegram-users/login
   json: email, password
================================ */
router.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter valid email",
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
          mobile_no,
          email,
          password_hash,
          is_email_verified,
          is_active,
          ${hasProfileImageSql},
          last_login_at,
          created_at
        FROM telegram_users
        WHERE email = $1
        LIMIT 1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
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
        message: "Invalid email or password",
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

    const token = jwt.sign(
      {
        telegram_user_id: userRow.telegram_user_id,
        email: userRow.email,
      },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: normalizeUser({
        ...userRow,
        last_login_at: new Date(),
      }),
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
   API 5: Send Forgot Password OTP
   POST /api/telegram-users/forgot-password/send-code
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
        WHERE email = $1 AND is_active = TRUE
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
   POST /api/telegram-users/forgot-password/reset
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
        WHERE email = $1 AND is_active = TRUE
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
        WHERE email = $2
      `,
      [newPasswordHash, email]
    );

    try {
      await sendProfessionalMail({
        to: email,
        subject: "Password Changed Successfully",
        text:
          "Your Telegram Login password has been changed successfully. If this was not you, please contact support immediately.",
        html: `
          <div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;">
            <div style="max-width:520px;margin:auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;padding:24px;text-align:center;">
              <h2 style="margin:0;color:#0f172a;">Password Changed Successfully</h2>
              <p style="color:#475569;font-size:14px;line-height:1.6;">
                Your Telegram Login password has been changed successfully.
              </p>
              <p style="color:#94a3b8;font-size:12px;">
                If this was not you, please contact support immediately.
              </p>
            </div>
          </div>
        `,
        otp: "",
      });
    } catch (mailError) {
      console.warn("Password changed mail failed:", mailError.message);
    }

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
   API 7: Get Profile Image From DB
   GET /api/telegram-users/profile-image/:id

   If image columns do not exist, it returns 404
   instead of crashing.
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
   API 8: Health Check
   GET /api/telegram-users/health
================================ */
router.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Telegram users API is running",
  });
});

module.exports = router;