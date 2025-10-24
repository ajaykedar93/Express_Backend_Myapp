// utils/mailer.js
require("dotenv").config();
const Mailjet = require("node-mailjet");

// =================== MAILJET CONFIG ===================
const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

/**
 * Send generic email via Mailjet HTTPS API
 * @param {string|string[]} to
 * @param {string} subject
 * @param {string} html
 */
async function sendEmail(to, subject, html) {
  try {
    const toList = Array.isArray(to) ? to : [to];
    const result = await mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: process.env.SENDER_EMAIL,
            Name: "My_App",
          },
          To: toList.map((email) => ({ Email: email })),
          Subject: subject,
          HTMLPart: html,
        },
      ],
    });

    console.log("✅ Mailjet email sent:", result.body.Messages[0].To);
    return result.body;
  } catch (error) {
    console.error("❌ Mailjet send failed:", error?.response?.data || error);
    throw new Error("Email sending failed");
  }
}

/**
 * Send OTP email (My_App branding)
 * @param {string} to
 * @param {string|number} otp
 * @param {number} [expiresInMins=10]
 */
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
