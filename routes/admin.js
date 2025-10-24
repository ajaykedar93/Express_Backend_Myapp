// routes/admin.js
const express = require('express');
const db = require('../db'); // your pooled pg client
const jwt = require('jsonwebtoken');
const upload = require('../middleware/multer');
const bcrypt = require('bcryptjs');

// Mailer (Mailjet HTTPS API): sendOTP / sendEmail
const { sendOTP, sendEmail } = require('../utils/mailer');

const router = express.Router();

// Helpers
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[admin routes] JWT_SECRET is not set in environment variables.');
}

// ------------------------ REGISTER ADMIN ------------------------
router.post('/register', upload, async (req, res) => {
  const {
    admin_name,
    role,
    email,
    alternate_email,
    mobile_number,
    alternate_mobile_number,
    address,
    dob,
    password_hash,
    highest_education,
  } = req.body;

  const profile_photo = req.file ? req.file.buffer : null;

  if (!admin_name || !email || !dob || !password_hash) {
    return res.status(400).json({ error: 'Required fields are missing' });
  }

  try {
    if (!['Admin', 'SuperAdmin', 'New_Admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const emailCheckQuery = `SELECT 1 FROM admin WHERE email = $1`;
    const emailCheckResult = await db.query(emailCheckQuery, [email]);
    if (emailCheckResult.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists. Please use a different email.' });
    }

    const hashedPassword = await hashPassword(password_hash);

    const query = `
      INSERT INTO admin (
        admin_name, role, email, alternate_email, mobile_number,
        alternate_mobile_number, address, profile_photo, dob, password_hash, highest_education
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *;
    `;
    const values = [
      admin_name,
      role,
      email,
      alternate_email || null,
      mobile_number || null,
      alternate_mobile_number || null,
      address || null,
      profile_photo,
      dob,
      hashedPassword,
      highest_education || null,
    ];

    const result = await db.query(query, values);
    res.status(201).json({ message: 'Admin registered successfully', admin: result.rows[0] });
  } catch (error) {
    console.error('[register] error:', error);
    res.status(500).json({ error: 'Error registering admin. Please try again.' });
  }
});

// ------------------------ LOGIN ADMIN ------------------------
router.post('/login', async (req, res) => {
  const { login_id, password_hash } = req.body;

  if (!login_id || !password_hash) {
    return res.status(400).json({ error: 'Email/Phone number and password are required' });
  }

  try {
    const query = `SELECT * FROM admin WHERE email = $1 OR mobile_number = $1`;
    const result = await db.query(query, [login_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const admin = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password_hash, admin.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { user_id: admin.user_id, admin_name: admin.admin_name, role: admin.role },
      JWT_SECRET || 'dev_fallback_secret',
      { expiresIn: '1h' }
    );

    res.status(200).json({
      message: 'Login successful',
      admin: {
        user_id: admin.user_id,
        admin_name: admin.admin_name,
        role: admin.role,
        token,
      },
    });
  } catch (error) {
    console.error('[login] error:', error);
    res.status(500).json({ error: 'Error logging in' });
  }
});

// ------------------------ UPDATE ADMIN ------------------------
router.put('/update/:user_id', upload, async (req, res) => {
  const { user_id } = req.params;
  const {
    admin_name,
    role,
    email,
    alternate_email,
    mobile_number,
    alternate_mobile_number,
    address,
    dob,
    highest_education,
  } = req.body;

  const profile_photo = req.file ? req.file.buffer : null;

  if (!admin_name || !email || !dob) {
    return res.status(400).json({ error: 'Required fields are missing' });
  }

  try {
    if (!['Admin', 'SuperAdmin', 'New_Admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const query = `
      UPDATE admin
      SET
        admin_name = $1,
        role = $2,
        email = $3,
        alternate_email = $4,
        mobile_number = $5,
        alternate_mobile_number = $6,
        address = $7,
        profile_photo = COALESCE($8, profile_photo),
        dob = $9,
        highest_education = $10
      WHERE user_id = $11
      RETURNING *;
    `;

    const values = [
      admin_name,
      role,
      email,
      alternate_email || null,
      mobile_number || null,
      alternate_mobile_number || null,
      address || null,
      profile_photo,
      dob,
      highest_education || null,
      user_id,
    ];

    const result = await db.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    res.status(200).json({ message: 'Admin updated successfully', admin: result.rows[0] });
  } catch (error) {
    console.error('[update] error:', error);
    res.status(500).json({ error: 'Error updating admin' });
  }
});

// ------------------------ DELETE ADMIN ------------------------
router.delete('/delete/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    const query = `DELETE FROM admin WHERE user_id = $1 RETURNING *`;
    const result = await db.query(query, [user_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    res.status(200).json({ message: 'Admin deleted successfully' });
  } catch (error) {
    console.error('[delete] error:', error);
    res.status(500).json({ error: 'Error deleting admin' });
  }
});

// ------------------------ CHECK ONE ADMIN ------------------------
router.get('/check-one-admin', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) FROM admin`;
    const result = await db.query(query);
    const count = parseInt(result.rows[0].count, 10);

    if (count > 0) {
      return res.status(200).json({ message: 'Only one admin exists' });
    }
    res.status(200).json({ message: 'No admin found. Proceed with registration.' });
  } catch (error) {
    console.error('[check-one-admin] error:', error);
    res.status(500).json({ error: 'Error checking admin count' });
  }
});

// ------------------------ GET ALL ADMINS ------------------------
router.get('/get-all', async (req, res) => {
  try {
    const query = `SELECT * FROM admin`;
    const result = await db.query(query);
    res.status(200).json({ admins: result.rows });
  } catch (error) {
    console.error('[get-all] error:', error);
    res.status(500).json({ error: 'Error fetching admins' });
  }
});

// ------------------------ GET NAMES AND PROFILE PHOTOS ------------------------
router.get('/get-names-and-profiles', async (req, res) => {
  try {
    const query = `SELECT user_id, admin_name, profile_photo FROM admin`;
    const result = await db.query(query);

    const admins = result.rows.map((admin) => ({
      user_id: admin.user_id,
      admin_name: admin.admin_name,
      profile_photo: admin.profile_photo
        ? Buffer.from(admin.profile_photo).toString('base64')
        : null,
    }));

    res.status(200).json({ admins });
  } catch (error) {
    console.error('[get-names-and-profiles] error:', error);
    res.status(500).json({ error: 'Error fetching admin names and profiles' });
  }
});

// ============================================================================
//                         FORGOT PASSWORD (OTP) FLOW
// ============================================================================

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
}

// ---------- Step 1: Request OTP ----------
router.post('/forgot/request-otp', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const { rows: users } = await db.query(
      `SELECT user_id FROM admin
       WHERE lower(email) = lower($1) OR lower(alternate_email) = lower($1)
       LIMIT 1;`,
      [email]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Invalidate older unused OTPs for this email (optional)
    await db.query(
      `UPDATE admin_password_resets
       SET used = TRUE
       WHERE lower(email) = lower($1) AND used = FALSE;`,
      [email]
    );

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);

    const { rows: ins } = await db.query(
      `INSERT INTO admin_password_resets (email, otp_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '20 minutes')
       RETURNING id, expires_at;`,
      [email, otpHash]
    );

    // Send email via Mailjet HTTPS mailer -> sender name = "My_App"
    try {
      await sendOTP(email, otp, 20);
    } catch (e) {
      console.error('[forgot/request-otp] sendOTP failed:', e?.response?.data || e?.message || e);
      return res.status(502).json({ error: 'Email sending failed', detail: e?.response?.data || e?.message || String(e) });
    }

    return res.status(200).json({
      message: 'OTP generated; email sent',
      request_id: ins[0].id,
      expires_at: ins[0].expires_at,
    });
  } catch (error) {
    console.error('[forgot/request-otp] error:', error);
    return res.status(500).json({ error: 'Error initiating password reset' });
  }
});

// ---------- Step 2: Verify OTP (does not consume) ----------
router.post('/forgot/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const { rows } = await db.query(
      `SELECT id, otp_hash
         FROM admin_password_resets
        WHERE lower(email) = lower($1)
          AND used = FALSE
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1;`,
      [email]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'OTP not found or expired' });
    }

    const rec = rows[0];
    const ok = await bcrypt.compare(String(otp), rec.otp_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid OTP' });

    return res.status(200).json({ message: 'OTP verified. You may reset your password.' });
  } catch (error) {
    console.error('[forgot/verify-otp] error:', error);
    return res.status(500).json({ error: 'Error verifying OTP' });
  }
});

// ---------- Step 3: Reset Password (atomic) ----------
router.post('/forgot/reset-password', async (req, res) => {
  const client = await db.connect();
  try {
    const { email, otp, new_password } = req.body || {};
    if (!email || !otp || !new_password) {
      return res.status(400).json({ error: 'Email, OTP and new password are required' });
    }

    const emailTrim = String(email).trim();
    const otpStr = String(otp).trim();

    await client.query('BEGIN');

    // 1) Lock latest valid OTP row for this email
    const { rows: otpRows } = await client.query(
      `SELECT id, otp_hash
         FROM admin_password_resets
        WHERE lower(email) = lower($1)
          AND used = FALSE
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE;`,
      [emailTrim]
    );
    if (otpRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'OTP not found or expired' });
    }

    const rec = otpRows[0];
    const ok = await bcrypt.compare(otpStr, rec.otp_hash);
    if (!ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // 2) Update password for primary OR alternate email
    const newHash = await bcrypt.hash(new_password, 10);
    const { rows: userRows } = await client.query(
      `UPDATE admin
          SET password_hash = $1
        WHERE lower(email) = lower($2)
           OR lower(alternate_email) = lower($2)
        RETURNING user_id;`,
      [newHash, emailTrim]
    );
    if (userRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Admin not found for this email' });
    }

    // 3) Consume the OTP
    await client.query(
      `UPDATE admin_password_resets SET used = TRUE WHERE id = $1;`,
      [rec.id]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Password updated successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[forgot/reset-password] error:', error);
    return res.status(500).json({ error: 'Error resetting password' });
  } finally {
    client.release();
  }
});

module.exports = router;
