const express = require("express");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../../db");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";
const PRIVATE_TRUST_DAYS = Number(process.env.PRIVATE_TRUST_DAYS || 365);
const CHANNEL_LOGO_LIMIT_MB = 5;
const NOTE_FILE_LIMIT_MB = 12;

const imageStorage = multer.memoryStorage();
const allowedImageMimeTypes = ["image/jpeg","image/jpg","image/png","image/gif","image/webp"];

const channelLogoUpload = multer({
  storage: imageStorage,
  limits: { fileSize: CHANNEL_LOGO_LIMIT_MB * 1024 * 1024 },
  fileFilter: (req,file,cb)=>{
    const extOk=/jpeg|jpg|png|gif|webp/.test(path.extname(file.originalname||"").toLowerCase());
    const mimeOk=allowedImageMimeTypes.includes(file.mimetype);
    if(extOk && mimeOk) return cb(null,true);
    return cb(new Error("Only JPG, PNG, GIF, WEBP allowed"));
  },
});
const noteAttachmentUpload = multer({ storage: multer.memoryStorage(), limits:{ fileSize: NOTE_FILE_LIMIT_MB*1024*1024 } });
const uploadChannelLogo=(req,res,next)=> channelLogoUpload.single("channel_logo")(req,res,(e)=>{ if(e) return res.status(400).json({success:false,message:e.message}); next(); });
const uploadNoteAttachment=(req,res,next)=> noteAttachmentUpload.single("attachment")(req,res,(e)=>{ if(e) return res.status(400).json({success:false,message:e.message}); next(); });

const cleanText=(v)=> String(v||"").trim();
const toInt=(v)=>{ const n=Number(v); return Number.isInteger(n)&&n>0?n:0; };
const getClientDeviceId=(req)=> cleanText(req.body?.device_id||req.body?.deviceId||req.query?.device_id||req.headers["x-device-id"]||"");
const getFrontendOrigin=(req)=> cleanText(process.env.FRONTEND_URL||req.get("origin")||`${req.protocol}://${req.get("host")}`).replace(/\/$/,"");
const buildShareLink=(req,code)=> `${getFrontendOrigin(req)}/channel/join/${code}`;
const extractShareCode=(v)=>{ const t=cleanText(v); if(!t) return ""; try{ const u=new URL(t); const p=u.pathname.split("/").filter(Boolean); const j=p.indexOf("join"); if(j>=0&&p[j+1]) return p[j+1]; return p[p.length-1]||t; }catch{ const p=t.split("/").filter(Boolean); return p[p.length-1]||t; } };
const getAttachmentCategory=(mime="",filename="")=>{ const m=String(mime).toLowerCase(); const n=String(filename).toLowerCase(); if(m.startsWith("image/")) return "image"; if(m.includes("pdf")||n.endsWith(".pdf")) return "pdf"; if(m.includes("spreadsheet")||m.includes("excel")||/\.(xls|xlsx|csv)$/i.test(n)) return "excel"; if(m.includes("word")||/\.(doc|docx)$/i.test(n)) return "word"; return "other"; };
const isPinFormatValid=(pin)=> /^\d{4,8}$/.test(String(pin||""));
const getCurrentUserId=(req)=> Number(req.telegramUserId||0);
const genShareCode=()=> crypto.randomBytes(6).toString("hex");

const normalizeChannel=(row,req)=>{
  if(!row) return null;
  const hasLogo=row.has_channel_logo===true||row.has_channel_logo==="true"||row.channel_logo_data!=null;
  return {
    channel_id: row.channel_id, id: row.channel_id, channel_uuid: row.channel_uuid,
    created_by_user_id: row.created_by_user_id, owner_id: row.created_by_user_id,
    owner_name: row.owner_name||row.created_by_name||"", owner_email: row.owner_email||"",
    channel_name: row.channel_name, channel_description: row.channel_description||"",
    channel_type: row.channel_type, has_channel_logo: hasLogo,
    channel_logo_url: hasLogo? `/api/telegramlogin-channels/logo/${row.channel_id}`:"",
    logo_url: hasLogo? `/api/telegramlogin-channels/logo/${row.channel_id}`:"",
    share_code: row.share_code||"", share_link: row.share_code? buildShareLink(req,row.share_code):"",
    is_active: row.is_active, is_deleted: row.is_deleted, created_device_id: row.created_device_id,
    created_at: row.created_at, updated_at: row.updated_at,
    member_role: row.member_role||null, member_status: row.member_status||null,
    is_owner: Number(row.created_by_user_id)===getCurrentUserId(req) || String(row.member_role).toLowerCase()==="owner",
    can_share: true,
  };
};

const normalizeInvitation=(row,req)=>{
  if(!row) return null;
  return {
    invitation_id: row.invitation_id, id: row.invitation_id, channel_id: row.channel_id,
    channel_name: row.channel_name, channel_type: row.channel_type,
    sender_user_id: row.sender_user_id, sender_name: row.sender_name||"User", sender_email: row.sender_email||"",
    receiver_user_id: row.receiver_user_id, receiver_name: row.receiver_name||"", receiver_email: row.receiver_email||"",
    share_code: row.share_code||"", share_link: row.share_link||(row.share_code? buildShareLink(req,row.share_code):""),
    invitation_status: row.invitation_status, status: row.invitation_status, created_at: row.created_at,
  };
};

const normalizeNote=(row)=>{
  if(!row) return null;
  const hasAttachment=row.has_attachment===true||row.has_attachment==="true";
  return {
    note_id: row.note_id, id: row.note_id, channel_id: row.channel_id, created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name||"User", note_type: row.note_type, note_text: row.note_text||"",
    has_attachment: hasAttachment, attachment_url: hasAttachment? `/api/telegramlogin-notes/attachment/${row.note_id}`:"",
    attachment_mime: row.attachment_mime||"", attachment_name: row.attachment_name||"", attachment_size: row.attachment_size||0,
    attachment_category: row.attachment_category||null, created_at: row.created_at, updated_at: row.updated_at,
  };
};

const authenticateTelegramUser=async(req,res,next)=>{
  try{
    const token=(req.headers.authorization||"").startsWith("Bearer ")? req.headers.authorization.slice(7):"";
    if(!token) return res.status(401).json({success:false,message:"Authorization token required"});
    const decoded=jwt.verify(token,JWT_SECRET); const telegramUserId=Number(decoded.telegram_user_id);
    if(!Number.isInteger(telegramUserId)||telegramUserId<=0) return res.status(401).json({success:false,message:"Invalid token"});
    const r=await db.query(`SELECT telegram_user_id, full_name, email FROM telegram_users WHERE telegram_user_id=$1 AND is_active=TRUE LIMIT 1`,[telegramUserId]);
    if(r.rows.length===0) return res.status(401).json({success:false,message:"User not found"});
    req.telegramUserId=telegramUserId; req.telegramUser=r.rows[0]; next();
  }catch(e){ return res.status(401).json({success:false,message:"Invalid token"}); }
};

const getChannelById=async(channelId)=>{
  const r=await db.query(`SELECT c.*, (c.channel_logo_data IS NOT NULL) AS has_channel_logo, u.full_name AS owner_name, u.email AS owner_email FROM telegramlogin_channellist c INNER JOIN telegram_users u ON u.telegram_user_id=c.created_by_user_id WHERE c.channel_id=$1 AND c.is_active=TRUE AND c.is_deleted=FALSE LIMIT 1`,[channelId]);
  return r.rows[0]||null;
};
const getChannelByShareCode=async(code)=>{
  const r=await db.query(`SELECT c.*, (c.channel_logo_data IS NOT NULL) AS has_channel_logo, u.full_name AS owner_name, u.email AS owner_email FROM telegramlogin_channellist c INNER JOIN telegram_users u ON u.telegram_user_id=c.created_by_user_id WHERE c.share_code=$1 AND c.is_active=TRUE AND c.is_deleted=FALSE LIMIT 1`,[code]);
  return r.rows[0]||null;
};
const getMembership=async({channelId,userId})=>{
  const r=await db.query(`SELECT * FROM telegramlogin_channel_members WHERE channel_id=$1 AND telegram_user_id=$2 LIMIT 1`,[channelId,userId]);
  return r.rows[0]||null;
};

const requireActiveMembership=async(req,res,next)=>{
  try{
    const channelId=toInt(req.params.id||req.params.channelId); const userId=getCurrentUserId(req);
    if(!channelId) return res.status(400).json({success:false,message:"Invalid channel id"});
    const channel=await getChannelById(channelId); if(!channel) return res.status(404).json({success:false,message:"Channel not found"});
    const membership=await getMembership({channelId,userId});
    if(!membership || membership.member_status!=='active'){
      if(Number(channel.created_by_user_id)!==userId) return res.status(403).json({success:false,message:"No access to this channel"});
    }
    req.channel=channel; req.membership=membership||{member_role: Number(channel.created_by_user_id)===userId?'owner':'member', member_status:'active'};
    next();
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
};

const requireOwner=async(req,res,next)=>{
  const channelId=toInt(req.params.id||req.params.channelId); const userId=getCurrentUserId(req);
  const channel=await getChannelById(channelId); if(!channel) return res.status(404).json({success:false,message:"Channel not found"});
  const membership=await getMembership({channelId,userId});
  const isOwner=Number(channel.created_by_user_id)===userId || String(membership?.member_role).toLowerCase()==='owner';
  if(!isOwner) return res.status(403).json({success:false,message:"Only owner can do this"});
  req.channel=channel; req.membership=membership; next();
};

const hasTrustedPrivateDevice=async({channelId,userId,deviceId})=>{
  if(!deviceId) return false;
  const r=await db.query(`SELECT trusted_private_device_id FROM telegramlogin_private_channel_trusted_devices WHERE channel_id=$1 AND telegram_user_id=$2 AND device_id=$3 AND is_active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1`,[channelId,userId,deviceId]);
  if(r.rows.length>0){ await db.query(`UPDATE telegramlogin_private_channel_trusted_devices SET last_used_at=NOW() WHERE trusted_private_device_id=$1`,[r.rows[0].trusted_private_device_id]); return true; }
  return false;
};
const trustPrivateDevice=async({channelId,userId,deviceId})=>{
  if(!deviceId) return; const exp=new Date(Date.now()+PRIVATE_TRUST_DAYS*24*60*60*1000);
  await db.query(`INSERT INTO telegramlogin_private_channel_trusted_devices (channel_id, telegram_user_id, device_id, trusted_at, last_used_at, expires_at, is_active) VALUES($1,$2,$3,NOW(),NOW(),$4,TRUE) ON CONFLICT(channel_id, telegram_user_id, device_id) DO UPDATE SET trusted_at=NOW(), last_used_at=NOW(), expires_at=EXCLUDED.expires_at, is_active=TRUE`,[channelId,userId,deviceId,exp]);
};
const verifyPrivatePin=async({channel,pin})=>{
  if(channel.channel_type!=='private') return true; if(!isPinFormatValid(pin)) return false; if(!channel.security_pin_hash) return false; return bcrypt.compare(cleanText(pin),channel.security_pin_hash);
};
const upsertActiveMember=async({channelId,userId,role="member",deviceId="",joinedViaLink=false,shareCode="",invitationId=null,pinVerified=false})=>{
  const r=await db.query(`INSERT INTO telegramlogin_channel_members (channel_id, telegram_user_id, member_role, member_status, joined_device_id, joined_via_link, share_code_used, invitation_id, pin_verified_at, last_opened_at, joined_at) VALUES($1,$2,$3,'active',$4,$5,$6,$7,${pinVerified?"NOW()":"NULL"},NOW(),NOW()) ON CONFLICT(channel_id, telegram_user_id) DO UPDATE SET member_status='active', joined_device_id=COALESCE(EXCLUDED.joined_device_id, telegramlogin_channel_members.joined_device_id), joined_via_link=telegramlogin_channel_members.joined_via_link OR EXCLUDED.joined_via_link, share_code_used=COALESCE(EXCLUDED.share_code_used, telegramlogin_channel_members.share_code_used), pin_verified_at=CASE WHEN EXCLUDED.pin_verified_at IS NOT NULL THEN EXCLUDED.pin_verified_at ELSE telegramlogin_channel_members.pin_verified_at END, last_opened_at=NOW(), removed_from_dashboard_at=NULL RETURNING *`,[channelId,userId,role,deviceId||null,joinedViaLink,shareCode||null,invitationId]);
  return r.rows[0];
};
const getMyChannelsRows=async(userId)=>{
  const r=await db.query(`SELECT c.*, (c.channel_logo_data IS NOT NULL) AS has_channel_logo, u.full_name AS owner_name, u.email AS owner_email, m.member_role, m.member_status FROM telegramlogin_channellist c INNER JOIN telegramlogin_channel_members m ON m.channel_id=c.channel_id INNER JOIN telegram_users u ON u.telegram_user_id=c.created_by_user_id WHERE m.telegram_user_id=$1 AND m.member_status='active' AND c.is_active=TRUE AND c.is_deleted=FALSE ORDER BY m.last_opened_at DESC, c.created_at DESC`,[userId]);
  return r.rows;
};

router.get("/health",(req,res)=> res.json({success:true,message:"Channels API running"}));
router.get("/logo/:id",async(req,res)=>{
  try{
    const channelId=toInt(req.params.id); const r=await db.query(`SELECT channel_logo_data, channel_logo_mime FROM telegramlogin_channellist WHERE channel_id=$1 AND is_active=TRUE AND is_deleted=FALSE LIMIT 1`,[channelId]);
    if(r.rows.length===0||!r.rows[0].channel_logo_data) return res.status(404).json({success:false,message:"Logo not found"});
    res.setHeader("Content-Type", r.rows[0].channel_logo_mime||"image/jpeg"); res.setHeader("Cache-Control","public, max-age=86400");
    return res.send(r.rows[0].channel_logo_data);
  }catch(e){ return res.status(500).json({success:false,message:"Server error"}); }
});
router.get("/my-channels",authenticateTelegramUser,async(req,res)=>{
  try{ const rows=await getMyChannelsRows(getCurrentUserId(req)); return res.json({success:true,channels:rows.map(r=>normalizeChannel(r,req))}); }
  catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});
router.post("/create",authenticateTelegramUser,uploadChannelLogo,async(req,res)=>{
  try{
    const userId=getCurrentUserId(req); const channelName=cleanText(req.body.channel_name||req.body.name); const channelDescription=cleanText(req.body.channel_description||req.body.description);
    const channelType=cleanText(req.body.channel_type||"public").toLowerCase(); const pin=cleanText(req.body.security_pin||req.body.pin||""); const deviceId=getClientDeviceId(req);
    if(channelName.length<3) return res.status(400).json({success:false,message:"Channel name min 3 chars"});
    if(!["public","private"].includes(channelType)) return res.status(400).json({success:false,message:"Invalid type"});
    let pinHash=null; if(channelType==="private"){ if(!isPinFormatValid(pin)) return res.status(400).json({success:false,message:"PIN 4-8 digits required"}); pinHash=await bcrypt.hash(pin,12); }
    const shareCode=genShareCode();
    const result=await db.query(`INSERT INTO telegramlogin_channellist (created_by_user_id, channel_name, channel_description, channel_type, channel_logo_data, channel_logo_mime, channel_logo_name, channel_logo_size, security_pin_hash, share_code, created_device_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *, (channel_logo_data IS NOT NULL) AS has_channel_logo`,[userId,channelName,channelDescription||null,channelType,req.file?req.file.buffer:null,req.file?req.file.mimetype:null,req.file?req.file.originalname:null,req.file?req.file.size:null,pinHash,shareCode,deviceId||null]);
    const channel=result.rows[0];
    await upsertActiveMember({channelId:channel.channel_id,userId,role:"owner",deviceId,pinVerified:true});
    if(channelType==="private") await trustPrivateDevice({channelId:channel.channel_id,userId,deviceId});
    return res.status(201).json({success:true,channel:normalizeChannel({...channel,member_role:"owner",member_status:"active",is_owner:true},req)});
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});
router.put("/:id/logo",authenticateTelegramUser,requireOwner,uploadChannelLogo,async(req,res)=>{
  try{
    const channel=req.channel; const file=req.file||null;
    if(!file) return res.status(400).json({success:false,message:"Channel logo file required"});
    await db.query(`UPDATE telegramlogin_channellist SET channel_logo_data=$1, channel_logo_mime=$2, channel_logo_name=$3, channel_logo_size=$4, updated_at=NOW() WHERE channel_id=$5`,[file.buffer,file.mimetype,file.originalname,file.size,channel.channel_id]);
    const updatedChannel=await getChannelById(channel.channel_id);
    return res.json({success:true,message:"Channel logo updated",channel:normalizeChannel(updatedChannel,req)});
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});
router.post("/join/:shareCode",authenticateTelegramUser,async(req,res)=>{
  try{
    const userId=getCurrentUserId(req); const shareCode=extractShareCode(req.params.shareCode||req.body.share_code); const deviceId=getClientDeviceId(req); const pin=cleanText(req.body.security_pin||req.body.pin||""); const trustDevice=String(req.body.trust_device).toLowerCase()==="true";
    if(!shareCode) return res.status(400).json({success:false,message:"Share code required"});
    const channel=await getChannelByShareCode(shareCode); if(!channel) return res.status(404).json({success:false,message:"Link expired"});
    let pinVerified=false;
    if(channel.channel_type==="private"){
      const trusted=await hasTrustedPrivateDevice({channelId:channel.channel_id,userId,deviceId});
      if(!trusted){ const ok=await verifyPrivatePin({channel,pin}); if(!ok) return res.status(403).json({success:false,pin_required:true,message:"PIN required",channel:normalizeChannel(channel,req)}); pinVerified=true; if(trustDevice) await trustPrivateDevice({channelId:channel.channel_id,userId,deviceId}); }
    }
    const membership=await upsertActiveMember({channelId:channel.channel_id,userId,role:Number(channel.created_by_user_id)===userId?"owner":"member",deviceId,joinedViaLink:true,shareCode,pinVerified});
    return res.json({success:true,message:"Joined",channel:normalizeChannel({...channel,...membership,has_channel_logo:channel.channel_logo_data!=null,is_owner:Number(channel.created_by_user_id)===userId},req)});
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});
router.post("/:id/verify-pin",authenticateTelegramUser,requireActiveMembership,async(req,res)=>{
  try{
    const channel=req.channel; const userId=getCurrentUserId(req); const deviceId=getClientDeviceId(req); const pin=cleanText(req.body.security_pin||req.body.pin||""); const trustDevice=String(req.body.trust_device).toLowerCase()==="true";
    if(channel.channel_type!=="private"){ await db.query(`UPDATE telegramlogin_channel_members SET last_opened_at=NOW() WHERE channel_id=$1 AND telegram_user_id=$2`,[channel.channel_id,userId]); return res.json({success:true,verified:true}); }
    const trusted=await hasTrustedPrivateDevice({channelId:channel.channel_id,userId,deviceId}); if(trusted){ await db.query(`UPDATE telegramlogin_channel_members SET last_opened_at=NOW() WHERE channel_id=$1 AND telegram_user_id=$2`,[channel.channel_id,userId]); return res.json({success:true,verified:true,trusted:true}); }
    const ok=await verifyPrivatePin({channel,pin}); if(!ok) return res.status(403).json({success:false,message:"Wrong PIN"});
    if(trustDevice) await trustPrivateDevice({channelId:channel.channel_id,userId,deviceId});
    await db.query(`UPDATE telegramlogin_channel_members SET pin_verified_at=NOW(), last_opened_at=NOW() WHERE channel_id=$1 AND telegram_user_id=$2`,[channel.channel_id,userId]);
    return res.json({success:true,verified:true});
  }catch(e){ return res.status(500).json({success:false,message:"Server error"}); }
});
router.get("/:id/members",authenticateTelegramUser,requireActiveMembership,async(req,res)=>{
  try{
    const channel=req.channel;
    const r=await db.query(`SELECT m.channel_id, m.telegram_user_id, m.member_role, m.member_status, m.joined_at, u.full_name, u.email, u.mobile_no FROM telegramlogin_channel_members m INNER JOIN telegram_users u ON u.telegram_user_id=m.telegram_user_id WHERE m.channel_id=$1 AND m.member_status='active' ORDER BY CASE WHEN m.member_role='owner' THEN 0 ELSE 1 END, m.joined_at ASC`,[channel.channel_id]);
    return res.json({success:true,members:r.rows, owner_name: channel.owner_name, owner_id: channel.created_by_user_id});
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});
router.get("/:id/notes",authenticateTelegramUser,requireActiveMembership,async(req,res)=>{
  try{
    const r=await db.query(`SELECT n.note_id, n.channel_id, n.created_by_user_id, n.note_type, n.note_text, (n.attachment_data IS NOT NULL) AS has_attachment, n.attachment_mime, n.attachment_name, n.attachment_size, n.attachment_category, n.created_at, u.full_name AS created_by_name FROM telegramlogin_notes n JOIN telegram_users u ON u.telegram_user_id=n.created_by_user_id WHERE n.channel_id=$1 AND n.is_deleted=FALSE ORDER BY n.created_at ASC`,[req.channel.channel_id]);
    return res.json({success:true,notes:r.rows.map(normalizeNote)});
  }catch(e){ return res.status(500).json({success:false,message:"Server error"}); }
});
router.post("/:id/notes",authenticateTelegramUser,requireActiveMembership,uploadNoteAttachment,async(req,res)=>{
  try{
    const channel=req.channel; const userId=getCurrentUserId(req); const noteText=cleanText(req.body.note_text||req.body.text||""); const deviceId=getClientDeviceId(req); const file=req.file||null;
    if(!noteText &&!file) return res.status(400).json({success:false,message:"Write note or file"});
    const cat=file? getAttachmentCategory(file.mimetype,file.originalname):null; const type=file? (cat==="image"?"image":"file"):"text";
    const result=await db.query(`INSERT INTO telegramlogin_notes (channel_id, created_by_user_id, note_type, note_text, attachment_data, attachment_mime, attachment_name, attachment_size, attachment_category, created_device_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING note_id, channel_id, created_by_user_id, note_type, note_text, (attachment_data IS NOT NULL) AS has_attachment, attachment_mime, attachment_name, attachment_size, attachment_category, created_at, updated_at`,[channel.channel_id,userId,type,noteText||null,file?file.buffer:null,file?file.mimetype:null,file?file.originalname:null,file?file.size:null,cat,deviceId||null]);
    return res.status(201).json({success:true,note:normalizeNote({...result.rows[0],created_by_name:req.telegramUser.full_name})});
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});

// FIXED IMAGE DIRECT - OWNER BYPASS
router.get("/notes/:noteId/attachment",authenticateTelegramUser,async(req,res)=>{
  try{
    const noteId=toInt(req.params.noteId); const userId=getCurrentUserId(req);
    const r=await db.query(`SELECT n.note_id, n.channel_id, n.attachment_data, n.attachment_mime, n.attachment_name, c.created_by_user_id as owner_id FROM telegramlogin_notes n JOIN telegramlogin_channellist c ON c.channel_id=n.channel_id WHERE n.note_id=$1 AND n.is_deleted=FALSE AND n.attachment_data IS NOT NULL LIMIT 1`,[noteId]);
    if(r.rows.length===0) return res.status(404).json({success:false,message:"Attachment not found"});
    const row=r.rows[0];
    const isOwner=String(row.owner_id)===String(userId);
    if(!isOwner){
      const mem=await db.query(`SELECT member_status FROM telegramlogin_channel_members WHERE channel_id=$1 AND telegram_user_id=$2 LIMIT 1`,[row.channel_id, userId]);
      if(!mem.rows[0] || mem.rows[0].member_status!=='active') return res.status(403).json({success:false,message:"No access"});
    }
    res.setHeader("Content-Type", row.attachment_mime||"image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.attachment_name||"file")}"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin","*");
    return res.send(row.attachment_data);
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});

router.get("/:id",authenticateTelegramUser,requireActiveMembership,async(req,res)=>{
  try{
    const row={...req.channel,...req.membership,has_channel_logo:req.channel.channel_logo_data!=null,owner_name:req.channel.owner_name,is_owner:Number(req.channel.created_by_user_id)===getCurrentUserId(req)||req.membership.member_role==='owner'};
    return res.json({success:true,channel:normalizeChannel(row,req)});
  }catch(e){ return res.status(500).json({success:false,message:"Server error"}); }
});
router.delete("/:id",authenticateTelegramUser,async(req,res)=>{
  try{
    const channelId=toInt(req.params.id); const userId=getCurrentUserId(req); const pin=cleanText(req.body?.security_pin||"");
    const channel=await getChannelById(channelId); if(!channel) return res.status(404).json({success:false,message:"Not found"});
    const membership=await getMembership({channelId,userId}); if(!membership) return res.status(403).json({success:false,message:"No access"});
    const isOwner=Number(channel.created_by_user_id)===userId;
    if(!isOwner){
      await db.query(`UPDATE telegramlogin_channel_members SET member_status='left', removed_from_dashboard_at=NOW() WHERE channel_id=$1 AND telegram_user_id=$2`,[channelId,userId]);
      return res.json({success:true,message:"Removed from dashboard"});
    }
    if(channel.channel_type==="private"){ const ok=await verifyPrivatePin({channel,pin}); if(!ok) return res.status(403).json({success:false,message:"PIN required"}); }
    await db.query(`UPDATE telegramlogin_channellist SET is_deleted=TRUE, is_active=FALSE, deleted_at=NOW(), deleted_by_user_id=$2 WHERE channel_id=$1`,[channelId,userId]);
    await db.query(`UPDATE telegramlogin_channel_members SET member_status='left' WHERE channel_id=$1`,[channelId]);
    return res.json({success:true,message:"Deleted"});
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});

module.exports = router;