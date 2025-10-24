// utils/mailer.js
require("dotenv").config();
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

// =================== ENV ===================
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  REFRESH_TOKEN,
  SENDER_EMAIL,
} = process.env;

// =================== OAUTH2 SETUP ===================
const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

// =================== CREATE TRANSPORTER ===================
async function createTransporter() {
  try {
    const accessToken = await oAuth2Client.getAccessToken();

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: SENDER_EMAIL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken?.token,
      },
    });

    // Verify connection once
    await transporter.verify();
    console.log("[Mailer] SMTP transporter verified.");
    return transporter;
  } catch (err) {
    console.error("[Mailer] Error creating transporter:", err.message);
    throw err;
  }
}

// =================== SEND GENERIC EMAIL ===================
async function sendEmail(to, subject, html, text) {
  try {
    const transporter = await createTransporter();

    const mailOptions = {
      from: `My_App <${SENDER_EMAIL}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, " "),
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("[Mailer] Email sent:", info.messageId);
    return info;
  } catch (err) {
    console.error("[Mailer] sendEmail failed:", err.message);
    throw err;
  }
}

// =================== SEND OTP EMAIL ===================
async function sendOTP(to, otp, expiresInMins = 10) {
  const subject = `Your My_App OTP: ${otp}`;
  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 550px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px;">
    <h2 style="text-align:center; color:#333;">My_App OTP Verification</h2>
    <p style="font-size:14px; color:#444;">Use the OTP below to continue:</p>
    <div style="text-align:center; margin:20px 0;">
      <div style="display:inline-block; font-size:26px; letter-spacing:4px; font-weight:bold; padding:10px 16px; border:1px dashed #777; border-radius:8px;">
        ${otp}
      </div>
    </div>
    <p style="font-size:13px; color:#444;">This code will expire in <b>${expiresInMins} minutes</b>.</p>
    <p style="font-size:12px; color:#777;">If you didn’t request this, you can safely ignore this email.</p>
    <hr style="border:none; border-top:1px solid #eee;" />
    <p style="font-size:11px; color:#999; text-align:center;">© ${new Date().getFullYear()} My_App</p>
  </div>
  `;
  return sendEmail(to, subject, html);
}

module.exports = { sendEmail, sendOTP };
