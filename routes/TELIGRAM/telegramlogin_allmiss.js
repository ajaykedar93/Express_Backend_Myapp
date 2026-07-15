const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../../db");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://react-myapp-omega.vercel.app").replace(/\/$/, "");
const BACKEND_URL = (process.env.BACKEND_URL || "https://express-backend-myapp.onrender.com").replace(/\/$/, "");

const cleanText = (v) => String(v || "").trim();
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0? n : 0; };
const getClientDeviceId = (req) => cleanText(req.body?.device_id || req.headers["x-device-id"] || "");
const isPinFormatValid = (pin) => /^\d{4,8}$/.test(String(pin || ""));
const getCurrentUserId = (req) => Number(req.telegramUserId || 0);
const buildShareLink = (code) => `${FRONTEND_URL}/#/channel/join/${code}`;

let columnPatched = false;
const ensurePrivatePinColumn = async () => {
  if (columnPatched) return;
  try { await db.query(`ALTER TABLE telegramlogin_channel_invitations ADD COLUMN IF NOT EXISTS private_pin_plain VARCHAR(8)`); columnPatched = true; } catch {}
};
ensurePrivatePinColumn();

const authenticateTelegramUser = async (req, res, next) => {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ")? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Authorization token required" });
    const d = jwt.verify(token, JWT_SECRET);
    const uid = Number(d.telegram_user_id);
    if (!uid) return res.status(401).json({ success: false, message: "Invalid token" });
    const r = await db.query(`SELECT telegram_user_id FROM telegram_users WHERE telegram_user_id=$1 AND is_active=TRUE LIMIT 1`, [uid]);
    if (!r.rows.length) return res.status(401).json({ success: false, message: "User not found" });
    req.telegramUserId = uid; return next();
  } catch { return res.status(401).json({ success: false, message: "Invalid token" }); }
};

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
  if (!isPinFormatValid(pin) ||!channel.security_pin_hash) return false;
  return bcrypt.compare(String(pin), channel.security_pin_hash);
};

// 1) SEND-LINK - ORIGINAL PIN STORE
router.post("/send-link", authenticateTelegramUser, async (req, res) => {
  try {
    const senderId = getCurrentUserId(req);
    const channelId = toInt(req.body.channel_id);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    let receiverIds = Array.isArray(req.body.receiver_ids)? req.body.receiver_ids.map(toInt).filter(Boolean) : [];
    if (!channelId) return res.status(400).json({ success: false, message: "Channel id required" });
    const channel = await getChannelById(channelId);
    if (!channel) return res.status(404).json({ success: false, message: "Channel not found" });
    const mem = await getMembership({ channelId, userId: senderId });
    if (!mem || mem.member_status!== "active") return res.status(403).json({ success: false, message: "You cannot share" });
    let plainPinToStore = null;
    if (channel.channel_type === "private") {
      const ok = await verifyPrivatePin({ channel, pin });
      if (!ok) return res.status(403).json({ success: false, message: "Correct Original PIN required" });
      plainPinToStore = String(pin);
    }
    receiverIds = [...new Set(receiverIds)].filter(id => id!== senderId);
    if (!receiverIds.length) return res.status(400).json({ success: false, message: "Select user" });
    const shareLink = buildShareLink(channel.share_code);
    const created = [];
    await db.query("BEGIN");
    for (const rid of receiverIds) {
      const dup = await db.query(`SELECT invitation_id FROM telegramlogin_channel_invitations WHERE channel_id=$1 AND receiver_user_id=$2 AND invitation_status='pending' LIMIT 1`, [channelId, rid]);
      if (dup.rows.length) continue;
      const ins = await db.query(`INSERT INTO telegramlogin_channel_invitations (channel_id, sender_user_id, receiver_user_id, share_code, share_link, private_pin_plain, invitation_status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`, [channelId, senderId, rid, channel.share_code, shareLink, plainPinToStore]);
      created.push(ins.rows[0]);
    }
    await db.query("COMMIT");
    return res.status(201).json({ success: true, sent_count: created.length, share_link: shareLink, invitations: created });
  } catch (e) { await db.query("ROLLBACK").catch(()=>{}); console.error("send-link error", e); return res.status(500).json({ success: false, message: "Server error" }); }
});

// 2) RECEIVED-LINKS - FAKT RECEIVER LA
router.get("/received-links", authenticateTelegramUser, async (req, res) => {
  try {
    const uid = getCurrentUserId(req);
    const r = await db.query(`
      SELECT i.invitation_id, i.channel_id, i.share_code, i.share_link, i.private_pin_plain, i.invitation_status,
             c.channel_name, c.channel_type, (c.channel_logo_data IS NOT NULL) AS has_logo, s.full_name AS sender_name
      FROM telegramlogin_channel_invitations i
      JOIN telegramlogin_channellist c ON c.channel_id=i.channel_id AND c.is_active=TRUE AND c.is_deleted=FALSE
      JOIN telegram_users s ON s.telegram_user_id=i.sender_user_id
      WHERE i.receiver_user_id=$1 AND i.invitation_status='pending' ORDER BY i.created_at DESC`, [uid]);
    const links = r.rows.map(row=>({
      invitation_id: row.invitation_id, channel_id: row.channel_id, channel_name: row.channel_name, channel_type: row.channel_type,
      channel_logo_url: row.has_logo? `${BACKEND_URL}/api/telegramlogin-channels/logo/${row.channel_id}` : "",
      share_code: row.share_code, share_link: row.share_link || buildShareLink(row.share_code),
      private_pin: row.private_pin_plain || "", private_pin_plain: row.private_pin_plain || "", sender_name: row.sender_name
    }));
    return res.json({ success: true, links, invitations: links });
  } catch (e) { return res.status(500).json({ success: false, message: "Load failed" }); }
});

// 3) JOIN - PIN NAKO, FAKT JOIN, PRIVATE TRUST OPEN LA
router.post("/join", authenticateTelegramUser, async (req, res) => {
  try {
    const uid = getCurrentUserId(req);
    const shareCode = cleanText(req.body.share_code || req.body.code || req.body.invite_code || "");
    const channelId = toInt(req.body.channel_id);
    const deviceId = getClientDeviceId(req);

    let channel = null;

    // 1) invitation ne shodh - tula pathavlela code
    if (shareCode) {
      const inv = await db.query(`SELECT channel_id FROM telegramlogin_channel_invitations WHERE share_code=$1 AND receiver_user_id=$2 AND invitation_status='pending' LIMIT 1`, [shareCode, uid]);
      if (inv.rows.length) {
        channel = await getChannelById(inv.rows[0].channel_id);
      }
    }
    // 2) channel share_code ne shodh
    if (!channel && shareCode) {
      const rr = await db.query(`SELECT * FROM telegramlogin_channellist WHERE share_code=$1 AND is_active=TRUE AND is_deleted=FALSE LIMIT 1`, [shareCode]);
      channel = rr.rows[0] || null;
    }
    // 3) channel_id ne shodh
    if (!channel && channelId) channel = await getChannelById(channelId);

    if (!channel) return res.status(404).json({ success: false, message: "Invalid link - code not found" });

    // ✅ PRIVATE LA JOIN LA PIN CHECK NAHI - PIN FAKT OPEN LA LAGEL
    const mem = await getMembership({ channelId: channel.channel_id, userId: uid });
    if (!mem) {
      await db.query(`INSERT INTO telegramlogin_channel_members (channel_id, telegram_user_id, member_role, member_status, pin_verified_at) VALUES ($1,$2,'member','active',NULL)`, [channel.channel_id, uid]);
    } else if (mem.member_status!== "active") {
      await db.query(`UPDATE telegramlogin_channel_members SET member_status='active' WHERE channel_id=$1 AND telegram_user_id=$2`, [channel.channel_id, uid]);
    }

    // invitation accept mark - private la open hoi paryant pending rahu de? pan join jhala ki accept kara
    await db.query(`UPDATE telegramlogin_channel_invitations SET invitation_status='accepted', accepted_at=NOW() WHERE channel_id=$1 AND receiver_user_id=$2 AND invitation_status='pending'`, [channel.channel_id, uid]);

    return res.json({ success: true, message: "Channel joined", channel: { channel_id: channel.channel_id, channel_name: channel.channel_name, channel_type: channel.channel_type, share_code: channel.share_code } });
  } catch (e) { console.error("join error", e); return res.status(500).json({ success: false, message: "Join failed" }); }
});

// 4) ACCEPT / REJECT - PUBLIC ACCEPT = DELETE, PRIVATE ACCEPT = COPY (frontend handle)
router.post("/received-links/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const invId = toInt(req.params.id); const uid = getCurrentUserId(req);
    const action = cleanText(req.body.action).toLowerCase();
    const r = await db.query(`SELECT * FROM telegramlogin_channel_invitations WHERE invitation_id=$1 AND receiver_user_id=$2 LIMIT 1`, [invId, uid]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: "Not found" });
    if (r.rows[0].invitation_status!== "pending") return res.status(400).json({ success: false, message: `Already ${r.rows[0].invitation_status}` });
    const status = ["accept","accepted"].includes(action)? "accepted" : "rejected";
    const up = await db.query(`UPDATE telegramlogin_channel_invitations SET invitation_status=$1, accepted_at=CASE WHEN $1='accepted' THEN NOW() ELSE accepted_at END, rejected_at=CASE WHEN $1='rejected' THEN NOW() ELSE rejected_at END WHERE invitation_id=$2 RETURNING *`, [status, invId]);
    return res.json({ success: true, accepted: status==="accepted", share_link: up.rows[0].share_link, private_pin: up.rows[0].private_pin_plain||"" });
  } catch (e) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// 5) REMOVE - PRIVATE LA PIN LAGEL
router.post("/remove/:id", authenticateTelegramUser, async (req, res) => {
  try {
    const channelId = toInt(req.params.id); const uid = getCurrentUserId(req);
    const pin = cleanText(req.body.security_pin || req.body.pin || "");
    const channel = await getChannelById(channelId);
    if (!channel) return res.status(404).json({ success: false, message: "Not found" });
    const mem = await getMembership({ channelId, userId: uid });
    if (!mem || mem.member_status!=="active") return res.status(403).json({ success: false, message: "No access" });
    if (Number(channel.created_by_user_id)===uid) return res.status(400).json({ success: false, message: "Owner use DELETE" });
    if (channel.channel_type==="private") {
      const ok = await verifyPrivatePin({ channel, pin });
      if (!ok) return res.status(403).json({ success: false, message: "Wrong Original PIN" });
    }
    await db.query(`UPDATE telegramlogin_channel_members SET member_status='left', removed_from_dashboard_at=NOW() WHERE channel_id=$1 AND telegram_user_id=$2`, [channelId, uid]);
    return res.json({ success: true, message: "Removed" });
  } catch (e) { return res.status(500).json({ success: false, message: "Server error" }); }
});

module.exports = router;