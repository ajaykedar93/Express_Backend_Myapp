const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../../db");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";
const PRIVATE_TRUST_DAYS = Number(process.env.PRIVATE_TRUST_DAYS || 365);

// ================= Helpers =================
const cleanText = (v) => String(v || "").trim();
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0? n : 0; };
const getClientDeviceId = (req) => cleanText(req.body?.device_id || req.body?.deviceId || req.headers["x-device-id"] || req.headers["x-device"] || "");
const isPinFormatValid = (pin) => /^\d{4,8}$/.test(String(pin || ""));
const getCurrentUserId = (req) => Number(req.telegramUserId || 0);
const getFrontendOrigin = (req) => cleanText(process.env.FRONTEND_URL || process.env.CLIENT_URL || req.get("origin") || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const buildShareLink = (req, code) => `${getFrontendOrigin(req)}/channel/join/${code}`;

// Ensure missing column for Copy PIN in Link Requests
let columnPatched = false;
const ensurePrivatePinColumn = async () => {
  if (columnPatched) return;
  try {
    await db.query(`ALTER TABLE telegramlogin_channel_invitations ADD COLUMN IF NOT EXISTS private_pin_plain VARCHAR(8)`);
    columnPatched = true;
  } catch (e) { console.log("patch skip", e.message); }
};
ensurePrivatePinColumn();

// ================= Auth =================
const authenticateTelegramUser = async (req, res, next) => {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ")? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Authorization token required" });
    const d = jwt.verify(token, JWT_SECRET);
    const uid = Number(d.telegram_user_id);
    if (!uid) return res.status(401).json({ success: false, message: "Invalid token" });
    const r = await db.query(`SELECT telegram_user_id, full_name, email FROM telegram_users WHERE telegram_user_id=$1 AND is_active=TRUE LIMIT 1`, [uid]);
    if (!r.rows.length) return res.status(401).json({ success: false, message: "User not found" });
    req.telegramUserId = uid; req.telegramUser = r.rows[0]; return next();
  } catch (e) { return res.status(401).json({ success: false, message: "Invalid token" }); }
};

// ================= DB Helpers =================
const getChannelById = async (id) => {
  const r = await db.query(`SELECT c.*, (c.channel_logo_data IS NOT NULL) AS has_logo FROM telegramlogin_channellist c WHERE c.channel_id=$1 AND c.is_active=TRUE AND c.is_deleted=FALSE LIMIT 1`, [id]);
  return r.rows[0] || null;
};
const getMembership = async ({ channelId, userId }) => {
  const r = await db.query(`SELECT * FROM telegramlogin_channel_members WHERE channel_id=$1 AND telegram_user_id=$2 LIMIT 1`, [channelId, userId]);
  return r.rows[0] || null;
};
const verifyPrivatePin = async ({ channel, pin }) => {
  if (channel.channel_type!== "private") return true;
  if (!isPinFormatValid(pin)) return false;
  if (!channel.security_pin_hash) return false;
  return bcrypt.compare(String(pin), channel.security_pin_hash);
};
const hasTrustedPrivateDevice = async ({ channelId, userId, deviceId }) => {
  if (!deviceId) return false;
  const r = await db.query(`SELECT trusted_private_device_id FROM telegramlogin_private_channel_trusted_devices WHERE channel_id=$1 AND telegram_user_id=$2 AND device_id=$3 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [channelId, userId, deviceId]);
  return r.rows.length > 0;
};

// ================= 1) ENHANCED SEND-LINK WITH PIN =================
// POST /api/telegramlogin-allmiss/send-link body: channel_id, receiver_ids[], receiver_emails[], security_pin (required for private)
router.post("/send-link", authenticateTelegramUser, async (req, res) => {
  try {
    await ensurePrivatePinColumn();
    const senderId = getCurrentUserId(req);
    const channelId = toInt(req.body.channel_id);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    let receiverIds = Array.isArray(req.body.receiver_ids)? req.body.receiver_ids.map(toInt).filter(Boolean) : [];
    let receiverEmails = Array.isArray(req.body.receiver_emails)? req.body.receiver_emails.map(v=>String(v).toLowerCase().trim()).filter(Boolean) : [];

    if (!channelId) return res.status(400).json({ success: false, message: "Channel id required" });
    const channel = await getChannelById(channelId);
    if (!channel) return res.status(404).json({ success: false, message: "Channel not found" });

    const mem = await getMembership({ channelId, userId: senderId });
    if (!mem || mem.member_status!== "active") return res.status(403).json({ success: false, message: "You cannot share this channel" });

    // Private must verify PIN before share, and we store plain PIN for receiver Copy PIN
    let plainPinToStore = null;
    if (channel.channel_type === "private") {
      const ok = await verifyPrivatePin({ channel, pin });
      if (!ok) return res.status(403).json({ success: false, message: "Correct 4-digit PIN required to share Private channel" });
      plainPinToStore = String(pin);
    }

    if (receiverEmails.length) {
      const er = await db.query(`SELECT telegram_user_id FROM telegram_users WHERE LOWER(email)=ANY($1::text[]) AND is_active=TRUE`, [receiverEmails]);
      receiverIds = [...new Set([...receiverIds,...er.rows.map(r=>Number(r.telegram_user_id))])].filter(id=>id!==senderId);
    }
    receiverIds = [...new Set(receiverIds)].filter(id=>id!==senderId);
    if (!receiverIds.length) return res.status(400).json({ success: false, message: "Select at least one registered user" });

    const shareLink = buildShareLink(req, channel.share_code);
    const created = [];
    await db.query("BEGIN");
    for (const rid of receiverIds) {
      const u = await db.query(`SELECT telegram_user_id FROM telegram_users WHERE telegram_user_id=$1 AND is_active=TRUE LIMIT 1`, [rid]);
      if (!u.rows.length) continue;
      const ins = await db.query(`INSERT INTO telegramlogin_channel_invitations (channel_id, sender_user_id, receiver_user_id, share_code, share_link, private_pin_plain, invitation_status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`, [channelId, senderId, rid, channel.share_code, shareLink, plainPinToStore]);
      created.push(ins.rows[0]);
    }
    await db.query("COMMIT");
    return res.status(201).json({ success: true, message: "Invitation sent with URL and PIN", sent_count: created.length, invitations: created });
  } catch (e) { await db.query("ROLLBACK").catch(()=>{}); console.error(e); return res.status(500).json({ success: false, message: "Server error while sending link" }); }
});

// ================= 2) ENHANCED RECEIVED-LINKS WITH PIN + LOGO =================
// GET /api/telegramlogin-allmiss/received-links
router.get("/received-links", authenticateTelegramUser, async (req, res) => {
  try {
    await ensurePrivatePinColumn();
    const uid = getCurrentUserId(req);
    const r = await db.query(`
      SELECT i.invitation_id, i.channel_id, i.share_code, i.share_link, i.private_pin_plain, i.invitation_status, i.created_at,
             c.channel_name, c.channel_type, (c.channel_logo_data IS NOT NULL) AS has_logo,
             s.full_name AS sender_name
      FROM telegramlogin_channel_invitations i
      JOIN telegramlogin_channellist c ON c.channel_id=i.channel_id AND c.is_active=TRUE AND c.is_deleted=FALSE
      JOIN telegram_users s ON s.telegram_user_id=i.sender_user_id
      WHERE i.receiver_user_id=$1 AND i.invitation_status='pending' ORDER BY i.created_at DESC`, [uid]);
    const links = r.rows.map(row=>({
      invitation_id: row.invitation_id, channel_id: row.channel_id,
      channel_name: row.channel_name, channel_type: row.channel_type,
      channel_logo_url: row.has_logo? `/api/telegramlogin-channels/logo/${row.channel_id}` : "",
      share_code: row.share_code, share_link: row.share_link || buildShareLink(req, row.share_code),
      private_pin: row.private_pin_plain || "", // for Copy PIN in popup
      invitation_status: row.invitation_status, sender_name: row.sender_name, created_at: row.created_at
    }));
    return res.json({ success: true, links, invitations: links });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: "Load failed" }); }
});

// ================= 3) ACCEPT / REJECT - COPY ONLY, NO AUTO JOIN =================
// POST /api/telegramlogin-allmiss/received-links/:id {action: accept|reject}
router.post("/received-links/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const invId = toInt(req.params.id); const uid = getCurrentUserId(req);
    const action = cleanText(req.body.action).toLowerCase();
    if (!invId) return res.status(400).json({ success: false, message: "Invitation id required" });
    const r = await db.query(`SELECT i.*, c.channel_name, c.channel_type FROM telegramlogin_channel_invitations i JOIN telegramlogin_channellist c ON c.channel_id=i.channel_id WHERE i.invitation_id=$1 AND i.receiver_user_id=$2 LIMIT 1`, [invId, uid]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: "Invitation not found" });
    if (r.rows[0].invitation_status!== "pending") return res.status(400).json({ success: false, message: `Already ${r.rows[0].invitation_status}` });
    const isAccept = ["accept","accepted"].includes(action);
    const status = isAccept? "accepted" : "rejected";
    const up = await db.query(`UPDATE telegramlogin_channel_invitations SET invitation_status=$1, accepted_at=CASE WHEN $1='accepted' THEN NOW() ELSE accepted_at END, rejected_at=CASE WHEN $1='rejected' THEN NOW() ELSE rejected_at END WHERE invitation_id=$2 RETURNING *`, [status, invId]);
    const inv = up.rows[0];
    return res.json({
      success: true, accepted: isAccept, message: isAccept? "Copied - paste URL in Join box" : "Invitation rejected",
      share_link: inv.share_link, share_code: inv.share_code,
      private_pin: inv.private_pin_plain || "", // frontend copies this for Private
      invitation: inv
    });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: "Server error" }); }
});

// ================= 4) REMOVE PRIVATE JOINED CHANNEL WITH PIN REQUIRED =================
// POST /api/telegramlogin-allmiss/remove/:id body: security_pin (required for private)
router.post("/remove/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = toInt(req.params.id); const uid = getCurrentUserId(req);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    if (!channelId) return res.status(400).json({ success: false, message: "Invalid id" });
    const channel = await getChannelById(channelId);
    if (!channel) return res.status(404).json({ success: false, message: "Channel not found" });
    const mem = await getMembership({ channelId, userId: uid });
    if (!mem || mem.member_status!=="active") return res.status(403).json({ success: false, message: "Access not found" });
    const isOwner = Number(channel.created_by_user_id)===uid || mem.member_role==="owner";
    if (isOwner) return res.status(400).json({ success: false, message: "Owner must use DELETE, not remove" });
    if (channel.channel_type==="private") {
      const ok = await verifyPrivatePin({ channel, pin });
      if (!ok) return res.status(403).json({ success: false, pin_required:true, message: "Correct PIN required to remove Private channel from dashboard" });
    }
    await db.query(`UPDATE telegramlogin_channel_members SET member_status='left', removed_from_dashboard_at=NOW(), removed_by_user_id=$2 WHERE channel_id=$1 AND telegram_user_id=$2`, [channelId, uid]);
    return res.json({ success: true, removed_only:true, message: "Removed from your dashboard only" });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: "Server error" }); }
});

// ================= 5) BLOCK TYPE & PIN CHANGE ON UPDATE =================
// PUT /api/telegramlogin-allmiss/:id - same as original but blocks type & PIN change per spec
router.put("/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = toInt(req.params.id); const uid = getCurrentUserId(req);
    const name = cleanText(req.body.channel_name || req.body.name || "");
    const desc = cleanText(req.body.channel_description || req.body.description || "");
    const typeAttempt = cleanText(req.body.channel_type || req.body.type || "");
    const pinAttempt = cleanText(req.body.security_pin || req.body.pin || "");
    if (typeAttempt || pinAttempt) return res.status(400).json({ success: false, message: "Channel type and PIN cannot be changed after creation" });
    if (!channelId) return res.status(400).json({ success: false, message: "Invalid id" });
    const channel = await getChannelById(channelId);
    if (!channel) return res.status(404).json({ success: false, message: "Not found" });
    const mem = await getMembership({ channelId, userId: uid });
    if (!mem || (Number(channel.created_by_user_id)!==uid && mem.member_role!=="owner")) return res.status(403).json({ success: false, message: "Only owner can update" });
    if (name && name.length<3) return res.status(400).json({ success: false, message: "Name min 3 chars" });
    const sets=[]; const vals=[];
    if (name) { vals.push(name); sets.push(`channel_name=$${vals.length}`); }
    if (Object.prototype.hasOwnProperty.call(req.body,"channel_description") || Object.prototype.hasOwnProperty.call(req.body,"description")) { vals.push(desc||null); sets.push(`channel_description=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: "No valid fields - only Logo/Name/Desc allowed" });
    vals.push(channelId);
    const up = await db.query(`UPDATE telegramlogin_channellist SET ${sets.join(", ")} WHERE channel_id=$${vals.length} RETURNING *`, vals);
    return res.json({ success: true, message: "Channel updated - type & PIN unchanged", channel: up.rows[0] });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: "Update failed" }); }
});

// ================= 6) NOTES ALL WITH TRUST CHECK (fixes notes API) =================
// GET /api/telegramlogin-allmiss/notes/:channelId/all
router.get("/notes/:channelId/all", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = toInt(req.params.channelId); const uid = getCurrentUserId(req);
    const deviceId = getClientDeviceId(req);
    if (!channelId) return res.status(400).json({ success: false, message: "Invalid channel" });
    const channel = await getChannelById(channelId);
    if (!channel) return res.status(404).json({ success: false, message: "Channel not found" });
    const mem = await getMembership({ channelId, userId: uid });
    if (!mem || mem.member_status!=="active") return res.status(403).json({ success: false, message: "No access" });
    if (channel.channel_type==="private") {
      const trusted = await hasTrustedPrivateDevice({ channelId, userId: uid, deviceId });
      if (!trusted &&!mem.pin_verified_at) return res.status(403).json({ success: false, pin_required:true, message: "PIN required before opening notes" });
    }
    const r = await db.query(`SELECT n.*, u.full_name AS created_by_name FROM telegramlogin_notes n JOIN telegram_users u ON u.telegram_user_id=n.created_by_user_id WHERE n.channel_id=$1 AND n.is_deleted=FALSE ORDER BY n.created_at ASC`, [channelId]);
    return res.json({ success: true, notes: r.rows });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, message: "Load failed" }); }
});

module.exports = router;