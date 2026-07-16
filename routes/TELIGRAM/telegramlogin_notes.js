const express = require("express");
const multer = require("multer");
const path = require("path");
const jwt = require("jsonwebtoken");
const db = require("../../db");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
const uploadNoteAttachment = (req, res, next) => {
  upload.fields([{ name: "attachment", maxCount: 1 },{ name: "image", maxCount: 1 },{ name: "file", maxCount: 1 }])
  (req, res, (err) => { if(err) return res.status(400).json({success:false,message:err.message}); next(); });
};

const cleanText = (v) => String(v || "").trim();
const isValidId = (v) => { const id=Number(v); return Number.isInteger(id) && id>0; };
const getDeviceId = (req) => cleanText(req.body.device_id || req.query.device_id || req.headers["x-device-id"] || req.headers["device-id"]);
const getUploadedFile = (req) => req.files?.attachment?.[0] || req.files?.image?.[0] || req.files?.file?.[0] || null;
const getAttachmentCategory = (file) => {
  if(!file) return null; const mime=String(file.mimetype||"").toLowerCase(); const ext=path.extname(file.originalname||"").toLowerCase();
  if(mime.startsWith("image/")) return "image"; if(mime==="application/pdf"||ext===".pdf") return "pdf";
  if(mime.includes("spreadsheet")||mime.includes("excel")||[".xls",".xlsx",".csv"].includes(ext)) return "excel";
  if(mime.includes("word")||ext===".doc"||ext===".docx") return "word"; if(mime.startsWith("text/")||ext===".txt") return "txt"; return "other";
};
const getNoteType = (file) =>!file? "text" : getAttachmentCategory(file)==="image"? "image" : "file";
const normalizeNote = (note) => {
  if(!note) return null;
  return {
    note_id: note.note_id, channel_id: note.channel_id, created_by_user_id: note.created_by_user_id,
    created_by_name: note.created_by_name||"", note_type: note.note_type, note_text: note.note_text||"",
    attachment_available: Boolean(note.has_attachment), attachment_category: note.attachment_category||"",
    attachment_mime: note.attachment_mime||"", attachment_name: note.attachment_name||"", attachment_size: note.attachment_size||null,
    attachment_url: note.has_attachment? `/api/telegramlogin-notes/attachment/${note.note_id}` : "",
    created_device_id: note.created_device_id||"", is_deleted: note.is_deleted, deleted_at: note.deleted_at,
    deleted_by_user_id: note.deleted_by_user_id, created_at: note.created_at, updated_at: note.updated_at,
  };
};

const authenticateTelegramUser = async (req,res,next)=>{
  try{
    const token=(req.headers.authorization||"").startsWith("Bearer ")? req.headers.authorization.slice(7):"";
    if(!token) return res.status(401).json({success:false,message:"Authorization token required"});
    const decoded=jwt.verify(token,JWT_SECRET); const telegramUserId=Number(decoded.telegram_user_id);
    if(!isValidId(telegramUserId)) return res.status(401).json({success:false,message:"Invalid token"});
    const result=await db.query(`SELECT telegram_user_id, full_name FROM telegram_users WHERE telegram_user_id=$1 AND is_active=TRUE LIMIT 1`,[telegramUserId]);
    if(result.rows.length===0) return res.status(401).json({success:false,message:"User not found"});
    req.telegramUser=result.rows[0]; req.telegramUserId=telegramUserId; next();
  }catch(e){ return res.status(401).json({success:false,message:"Invalid token"}); }
};

const checkChannelAccess = async ({channelId,userId,deviceId})=>{
  const result=await db.query(`
    SELECT c.channel_id, c.channel_name, c.channel_type, c.created_by_user_id, c.security_pin_hash, c.is_active, c.is_deleted,
           m.member_role, m.member_status, m.pin_verified_at
    FROM telegramlogin_channellist c
    LEFT JOIN telegramlogin_channel_members m ON m.channel_id=c.channel_id AND m.telegram_user_id=$2
    WHERE c.channel_id=$1 AND c.is_deleted=FALSE AND c.is_active=TRUE LIMIT 1`,[channelId,userId]);
  if(result.rows.length===0) return {ok:false,status:404,message:"Channel not found"};
  const ch=result.rows[0];
  if(ch.channel_type==="public"){
    if(ch.member_status==="blocked") return {ok:false,status:403,message:"You are blocked"};
    await db.query(`INSERT INTO telegramlogin_channel_members(channel_id,telegram_user_id,member_role,member_status,joined_device_id,last_opened_at)
      VALUES($1,$2,'member','active',$3,NOW()) ON CONFLICT(channel_id,telegram_user_id) DO UPDATE SET last_opened_at=NOW(), updated_at=NOW()`,[channelId,userId,deviceId||null]);
    return {ok:true,channel:ch};
  }
  // PRIVATE - FAKT EKDA PIN
  if(!ch.member_status || ch.member_status!=="active") return {ok:false,status:403,message:"You are not added to this private channel"};
  if(ch.security_pin_hash &&!ch.pin_verified_at){
    return {ok:false,status:403,pin_required:true,message:"Please verify channel PIN before opening notes/chat"};
  }
  await db.query(`UPDATE telegramlogin_channel_members SET last_opened_at=NOW(), updated_at=NOW() WHERE channel_id=$1 AND telegram_user_id=$2`,[channelId,userId]);
  return {ok:true,channel:ch};
};

const canEditOrDeleteNote = async ({noteId,userId})=>{
  const r=await db.query(`SELECT n.note_id,n.channel_id,n.created_by_user_id,n.note_text,n.attachment_data IS NOT NULL AS has_attachment,n.is_deleted,c.created_by_user_id AS channel_owner_id,m.member_role
    FROM telegramlogin_notes n JOIN telegramlogin_channellist c ON c.channel_id=n.channel_id
    LEFT JOIN telegramlogin_channel_members m ON m.channel_id=n.channel_id AND m.telegram_user_id=$2 AND m.member_status='active'
    WHERE n.note_id=$1 AND n.is_deleted=FALSE AND c.is_deleted=FALSE LIMIT 1`,[noteId,userId]);
  if(r.rows.length===0) return {ok:false,status:404,message:"Note not found"};
  const note=r.rows[0]; const isCreator=Number(note.created_by_user_id)===Number(userId); const isOwner=Number(note.channel_owner_id)===Number(userId);
  if(!isCreator &&!isOwner && note.member_role!=="admin") return {ok:false,status:403,message:"No permission"};
  return {ok:true,note};
};

router.get("/health",(req,res)=> res.json({success:true,message:"Telegram login notes API is running"}));

router.post("/:channelId/add", authenticateTelegramUser, uploadNoteAttachment, async(req,res)=>{
  try{
    const channelId=Number(req.params.channelId); const noteText=cleanText(req.body.note_text||req.body.text); const deviceId=getDeviceId(req); const file=getUploadedFile(req);
    if(!isValidId(channelId)) return res.status(400).json({success:false,message:"Invalid channel id"});
    if(!noteText &&!file) return res.status(400).json({success:false,message:"Add note text or file"});
    const access=await checkChannelAccess({channelId,userId:req.telegramUserId,deviceId});
    if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    const result=await db.query(`INSERT INTO telegramlogin_notes(channel_id,created_by_user_id,note_type,note_text,attachment_data,attachment_mime,attachment_name,attachment_size,attachment_category,created_device_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING note_id,channel_id,created_by_user_id,note_type,note_text,attachment_data IS NOT NULL AS has_attachment,attachment_mime,attachment_name,attachment_size,attachment_category,created_device_id,is_deleted,deleted_at,deleted_by_user_id,created_at,updated_at`,
      [channelId,req.telegramUserId,getNoteType(file),noteText||null,file?file.buffer:null,file?file.mimetype:null,file?file.originalname:null,file?file.size:null,getAttachmentCategory(file),deviceId||null]);
    const note={...result.rows[0],created_by_name:req.telegramUser.full_name};
    return res.status(201).json({success:true,message:"Note added",note:normalizeNote(note)});
  }catch(e){ console.error("Add note error:",e); return res.status(500).json({success:false,message:"Server error"}); }
});

// ✅ FIX 1 - CHAT HIDE HONAR NAHI - LATEST 500 DESC THEN ASC
router.get("/:channelId/all", authenticateTelegramUser, async(req,res)=>{
  try{
    const channelId=Number(req.params.channelId); const deviceId=getDeviceId(req);
    if(!isValidId(channelId)) return res.status(400).json({success:false,message:"Invalid channel id"});
    const page=Math.max(parseInt(req.query.page||"1",10),1); const limit=Math.min(Math.max(parseInt(req.query.limit||"200",10),1),500); const offset=(page-1)*limit;
    const access=await checkChannelAccess({channelId,userId:req.telegramUserId,deviceId});
    if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    const countResult=await db.query(`SELECT COUNT(*)::INTEGER AS total FROM telegramlogin_notes WHERE channel_id=$1 AND is_deleted=FALSE`,[channelId]);
    // LATEST notes gheun ASC madhe return - mhanun hide honar nahi
    const result=await db.query(`
      SELECT * FROM (
        SELECT n.note_id,n.channel_id,n.created_by_user_id,u.full_name AS created_by_name,n.note_type,n.note_text,
               n.attachment_data IS NOT NULL AS has_attachment,n.attachment_mime,n.attachment_name,n.attachment_size,n.attachment_category,
               n.created_device_id,n.is_deleted,n.deleted_at,n.deleted_by_user_id,n.created_at,n.updated_at
        FROM telegramlogin_notes n JOIN telegram_users u ON u.telegram_user_id=n.created_by_user_id
        WHERE n.channel_id=$1 AND n.is_deleted=FALSE
        ORDER BY n.created_at DESC LIMIT $2 OFFSET $3
      ) t ORDER BY created_at ASC`,[channelId,limit,offset]);
    return res.status(200).json({success:true,total:countResult.rows[0].total,page,limit,notes:result.rows.map(normalizeNote)});
  }catch(e){ console.error("Get notes error:",e); return res.status(500).json({success:false,message:"Server error"}); }
});

router.get("/single/:noteId", authenticateTelegramUser, async(req,res)=>{
  try{
    const noteId=Number(req.params.noteId); const deviceId=getDeviceId(req);
    if(!isValidId(noteId)) return res.status(400).json({success:false,message:"Invalid note id"});
    const noteResult=await db.query(`SELECT n.note_id,n.channel_id,n.created_by_user_id,u.full_name AS created_by_name,n.note_type,n.note_text,n.attachment_data IS NOT NULL AS has_attachment,n.attachment_mime,n.attachment_name,n.attachment_size,n.attachment_category,n.created_device_id,n.is_deleted,n.deleted_at,n.deleted_by_user_id,n.created_at,n.updated_at
      FROM telegramlogin_notes n JOIN telegram_users u ON u.telegram_user_id=n.created_by_user_id WHERE n.note_id=$1 AND n.is_deleted=FALSE LIMIT 1`,[noteId]);
    if(noteResult.rows.length===0) return res.status(404).json({success:false,message:"Note not found"});
    const note=noteResult.rows[0];
    const access=await checkChannelAccess({channelId:note.channel_id,userId:req.telegramUserId,deviceId});
    if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    return res.status(200).json({success:true,note:normalizeNote(note)});
  }catch(e){ return res.status(500).json({success:false,message:"Server error"}); }
});

// ✅ FIX 2 - IMAGE LOAD + DOWNLOAD - PIN check nanter buffer send
router.get("/attachment/:noteId", authenticateTelegramUser, async(req,res)=>{
  try{
    const noteId=Number(req.params.noteId); const deviceId=getDeviceId(req);
    if(!isValidId(noteId)) return res.status(400).json({success:false,message:"Invalid note id"});
    const result=await db.query(`SELECT n.note_id,n.channel_id,n.attachment_data,n.attachment_mime,n.attachment_name FROM telegramlogin_notes n WHERE n.note_id=$1 AND n.is_deleted=FALSE AND n.attachment_data IS NOT NULL LIMIT 1`,[noteId]);
    if(result.rows.length===0) return res.status(404).json({success:false,message:"Attachment not found"});
    const note=result.rows[0];
    const access=await checkChannelAccess({channelId:note.channel_id,userId:req.telegramUserId,deviceId});
    if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    res.setHeader("Content-Type", note.attachment_mime||"application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(note.attachment_name||"file")}"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin","*");
    return res.send(note.attachment_data);
  }catch(e){ console.error("Attachment error:",e); return res.status(500).json({success:false,message:"Server error"}); }
});

router.put("/:noteId", authenticateTelegramUser, uploadNoteAttachment, async(req,res)=>{
  try{
    const noteId=Number(req.params.noteId); const noteText=cleanText(req.body.note_text||req.body.text);
    const hasNoteText=Object.prototype.hasOwnProperty.call(req.body,"note_text")||Object.prototype.hasOwnProperty.call(req.body,"text");
    const removeAttachment=String(req.body.remove_attachment||"").toLowerCase()==="true"; const file=getUploadedFile(req); const deviceId=getDeviceId(req);
    if(!isValidId(noteId)) return res.status(400).json({success:false,message:"Invalid note id"});
    const permission=await canEditOrDeleteNote({noteId,userId:req.telegramUserId}); if(!permission.ok) return res.status(permission.status).json({success:false,message:permission.message});
    const access=await checkChannelAccess({channelId:permission.note.channel_id,userId:req.telegramUserId,deviceId}); if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    const setClauses=[]; const values=[];
    if(hasNoteText){ values.push(noteText||null); setClauses.push(`note_text = $${values.length}`); }
    if(file){
      values.push(getNoteType(file)); setClauses.push(`note_type = $${values.length}`);
      values.push(file.buffer); setClauses.push(`attachment_data = $${values.length}`);
      values.push(file.mimetype); setClauses.push(`attachment_mime = $${values.length}`);
      values.push(file.originalname); setClauses.push(`attachment_name = $${values.length}`);
      values.push(file.size); setClauses.push(`attachment_size = $${values.length}`);
      values.push(getAttachmentCategory(file)); setClauses.push(`attachment_category = $${values.length}`);
    }
    if(removeAttachment &&!file){ setClauses.push(`attachment_data=NULL, attachment_mime=NULL, attachment_name=NULL, attachment_size=NULL, attachment_category=NULL, note_type='text'`); }
    if(setClauses.length===0) return res.status(400).json({success:false,message:"No data for update"});
    values.push(noteId);
    const result=await db.query(`UPDATE telegramlogin_notes SET ${setClauses.join(", ")} WHERE note_id=$${values.length} RETURNING note_id,channel_id,created_by_user_id,note_type,note_text,attachment_data IS NOT NULL AS has_attachment,attachment_mime,attachment_name,attachment_size,attachment_category,created_device_id,is_deleted,deleted_at,deleted_by_user_id,created_at,updated_at`,values);
    const updated={...result.rows[0],created_by_name:req.telegramUser.full_name};
    return res.json({success:true,note:normalizeNote(updated)});
  }catch(e){ return res.status(500).json({success:false,message:"Server error"}); }
});

router.delete("/:noteId", authenticateTelegramUser, async(req,res)=>{
  try{
    const noteId=Number(req.params.noteId); const deviceId=getDeviceId(req);
    if(!isValidId(noteId)) return res.status(400).json({success:false,message:"Invalid note id"});
    const permission=await canEditOrDeleteNote({noteId,userId:req.telegramUserId}); if(!permission.ok) return res.status(permission.status).json({success:false,message:permission.message});
    const access=await checkChannelAccess({channelId:permission.note.channel_id,userId:req.telegramUserId,deviceId}); if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    await db.query(`UPDATE telegramlogin_notes SET is_deleted=TRUE, deleted_at=NOW(), deleted_by_user_id=$2 WHERE note_id=$1`,[noteId,req.telegramUserId]);
    return res.json({success:true,message:"Note deleted"});
  }catch(e){ return res.status(500).json({success:false,message:"Server error"}); }
});

module.exports = router;