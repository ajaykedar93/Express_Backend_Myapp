const express = require("express");
const multer = require("multer");
const path = require("path");
const jwt = require("jsonwebtoken");
const db = require("../../db");
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change_this_telegram_login_secret";

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
const uploadNoteAttachment = (req,res,next)=>{
  upload.fields([{name:"attachment",maxCount:1},{name:"image",maxCount:1},{name:"file",maxCount:1}])(req,res,(err)=>{
    if(err) return res.status(400).json({success:false,message:err.message});
    next();
  });
};

const cleanText = (v)=> String(v||"").trim();
const isValidId = (v)=> { const id=Number(v); return Number.isInteger(id) && id>0; };
const getDeviceId = (req)=> cleanText(req?.body?.device_id||req?.query?.device_id||req?.headers?.["x-device-id"]||req?.headers?.["device-id"]||"");
const getUploadedFile = (req)=> req.files?.attachment?.[0]||req.files?.image?.[0]||req.files?.file?.[0]||null;
const getAttachmentCategory = (file)=>{
  if(!file) return null; const mime=String(file.mimetype||"").toLowerCase(); const ext=path.extname(file.originalname||"").toLowerCase();
  if(mime.startsWith("image/")) return "image"; if(mime==="application/pdf"||ext===".pdf") return "pdf";
  if(mime.includes("spreadsheet")||mime.includes("excel")||[".xls",".xlsx",".csv"].includes(ext)) return "excel";
  if(mime.includes("word")||ext===".doc"||ext===".docx") return "word"; if(mime.startsWith("text/")||ext===".txt") return "txt"; return "other";
};
const getNoteType = (file)=>!file? "text" : getAttachmentCategory(file)==="image"? "image" : "file";
const normalizeNote = (note)=>{
  if(!note) return null;
  return {
    note_id: note.note_id, channel_id: note.channel_id, created_by_user_id: note.created_by_user_id, created_by_name: note.created_by_name||"",
    note_type: note.note_type, note_text: note.note_text||"", attachment_available: Boolean(note.has_attachment),
    attachment_category: note.attachment_category||"", attachment_mime: note.attachment_mime||"", attachment_name: note.attachment_name||"", attachment_size: note.attachment_size||null,
    attachment_url: note.has_attachment? `/api/telegramlogin-notes/attachment/${note.note_id}` : "", created_at: note.created_at, updated_at: note.updated_at,
  };
};

const authenticateTelegramUser = async(req,res,next)=>{
  try{
    const token=(req.headers.authorization||"").startsWith("Bearer ")? req.headers.authorization.slice(7):"";
    if(!token) return res.status(401).json({success:false,message:"Authorization token required"});
    const decoded=jwt.verify(token,JWT_SECRET); const telegramUserId=Number(decoded.telegram_user_id||decoded.id);
    if(!isValidId(telegramUserId)) return res.status(401).json({success:false,message:"Invalid token"});
    const r=await db.query(`SELECT telegram_user_id, full_name FROM telegram_users WHERE telegram_user_id=$1 AND is_active=TRUE LIMIT 1`,[telegramUserId]);
    if(r.rows.length===0) return res.status(401).json({success:false,message:"User not found"});
    req.telegramUser=r.rows[0]; req.telegramUserId=telegramUserId; next();
  }catch(e){ return res.status(401).json({success:false,message:"Invalid token"}); }
};

const checkChannelAccess = async({channelId,userId,deviceId})=>{
  const r=await db.query(`SELECT c.channel_id,c.channel_type,c.created_by_user_id,c.security_pin_hash,c.is_active,m.member_status,m.pin_verified_at
    FROM telegramlogin_channellist c LEFT JOIN telegramlogin_channel_members m ON m.channel_id=c.channel_id AND m.telegram_user_id=$2
    WHERE c.channel_id=$1 AND c.is_deleted=FALSE AND c.is_active=TRUE LIMIT 1`,[channelId,userId]);
  if(r.rows.length===0) return {ok:false,status:404,message:"Channel not found"};
  const ch=r.rows[0]; const isOwner=String(ch.created_by_user_id)===String(userId);
  if(ch.channel_type==="public"){
    await db.query(`INSERT INTO telegramlogin_channel_members(channel_id,telegram_user_id,member_role,member_status,joined_device_id,last_opened_at) VALUES($1,$2,'member','active',$3,NOW()) ON CONFLICT(channel_id,telegram_user_id) DO UPDATE SET last_opened_at=NOW(), updated_at=NOW()`,[channelId,userId,deviceId||null]);
    return {ok:true,channel:ch,isOwner};
  }
  if(!ch.member_status || ch.member_status!=="active"){
    if(isOwner){ await db.query(`INSERT INTO telegramlogin_channel_members(channel_id,telegram_user_id,member_role,member_status,pin_verified_at,last_opened_at) VALUES($1,$2,'owner','active',NOW(),NOW()) ON CONFLICT(channel_id,telegram_user_id) DO UPDATE SET member_status='active', pin_verified_at=NOW()`,[channelId,userId]); return {ok:true,channel:ch,isOwner:true}; }
    return {ok:false,status:403,message:"You are not added to this private channel"};
  }
  if(!isOwner && ch.security_pin_hash &&!ch.pin_verified_at) return {ok:false,status:403,pin_required:true,message:"PIN required"};
  await db.query(`UPDATE telegramlogin_channel_members SET last_opened_at=NOW() WHERE channel_id=$1 AND telegram_user_id=$2`,[channelId,userId]);
  return {ok:true,channel:ch,isOwner};
};

router.get("/health",(req,res)=> res.json({success:true}));

// ADD
router.post("/:channelId/add", authenticateTelegramUser, uploadNoteAttachment, async(req,res)=>{
  try{
    const channelId=Number(req.params.channelId); const noteText=String(req.body?.note_text||req.body?.text||"").trim(); const deviceId=getDeviceId(req); const file=getUploadedFile(req);
    if(!isValidId(channelId)) return res.status(400).json({success:false,message:"Invalid id"});
    if(!noteText &&!file) return res.status(400).json({success:false,message:"Add text or file"});
    const access=await checkChannelAccess({channelId,userId:req.telegramUserId,deviceId}); if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    const result=await db.query(`INSERT INTO telegramlogin_notes(channel_id,created_by_user_id,note_type,note_text,attachment_data,attachment_mime,attachment_name,attachment_size,attachment_category,created_device_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING note_id,channel_id,created_by_user_id,note_type,note_text,attachment_data IS NOT NULL AS has_attachment,attachment_mime,attachment_name,attachment_size,attachment_category,created_device_id,created_at,updated_at`,[channelId,req.telegramUserId,getNoteType(file),noteText||null,file?file.buffer:null,file?file.mimetype:null,file?file.originalname:null,file?file.size:null,getAttachmentCategory(file),deviceId||null]);
    return res.status(201).json({success:true,note:normalizeNote({...result.rows[0],created_by_name:req.telegramUser.full_name})});
  }catch(e){ console.error("ADD ERROR",e); return res.status(500).json({success:false,message:"Server error"}); }
});

// ALL
router.get("/:channelId/all", authenticateTelegramUser, async(req,res)=>{
  try{
    const channelId=Number(req.params.channelId); const deviceId=getDeviceId(req);
    const access=await checkChannelAccess({channelId,userId:req.telegramUserId,deviceId}); if(!access.ok) return res.status(access.status).json({success:false,pin_required:access.pin_required||false,message:access.message});
    const result=await db.query(`SELECT n.note_id,n.channel_id,n.created_by_user_id,u.full_name AS created_by_name,n.note_type,n.note_text, n.attachment_data IS NOT NULL AS has_attachment,n.attachment_mime,n.attachment_name,n.attachment_size,n.attachment_category, n.created_at,n.updated_at FROM telegramlogin_notes n JOIN telegram_users u ON u.telegram_user_id=n.created_by_user_id WHERE n.channel_id=$1 AND n.is_deleted=FALSE ORDER BY n.created_at ASC`,[channelId]);
    return res.json({success:true,total:result.rows.length,notes:result.rows.map(normalizeNote)});
  }catch(e){ console.error(e); return res.status(500).json({success:false,message:"Server error"}); }
});

// ATTACHMENT - FIXED FOR ALL FILES
router.get("/attachment/:noteId", authenticateTelegramUser, async(req,res)=>{
  try{
    const noteId=Number(req.params.noteId);
    const r=await db.query(`SELECT note_id,channel_id,attachment_data,attachment_mime,attachment_name,created_by_user_id FROM telegramlogin_notes WHERE note_id=$1 AND is_deleted=FALSE LIMIT 1`,[noteId]);
    if(r.rows.length===0 ||!r.rows[0].attachment_data) return res.status(404).json({success:false,message:"Attachment not found"});
    const note=r.rows[0];
    const ch=await db.query(`SELECT created_by_user_id FROM telegramlogin_channellist WHERE channel_id=$1 LIMIT 1`,[note.channel_id]);
    const isOwner = ch.rows[0] && String(ch.rows[0].created_by_user_id)===String(req.telegramUserId);
    if(!isOwner){
      const mem=await db.query(`SELECT member_status FROM telegramlogin_channel_members WHERE channel_id=$1 AND telegram_user_id=$2 AND member_status='active' LIMIT 1`,[note.channel_id, req.telegramUserId]);
      if(mem.rows.length===0) return res.status(403).json({success:false,message:"No access"});
    }
    const mime = note.attachment_mime||"application/octet-stream";
    const isImage = mime.startsWith("image/");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `${isImage?'inline':'attachment'}; filename="${encodeURIComponent(note.attachment_name||"file")}"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin","*");
    return res.send(note.attachment_data);
  }catch(e){ console.error("ATTACH ERR",e); return res.status(500).json({success:false,message:"Server error"}); }
});

// ✅ UPDATE TEXT / IMAGE / FILE - MAIN FIX
router.put("/:noteId", authenticateTelegramUser, uploadNoteAttachment, async(req,res)=>{
  try{
    const noteId=Number(req.params.noteId);
    const noteText=String(req.body?.note_text||req.body?.text||"").trim();
    const deviceId=getDeviceId(req);
    const file=getUploadedFile(req);
    if(!isValidId(noteId)) return res.status(400).json({success:false,message:"Invalid note id"});

    const existing=await db.query(`SELECT note_id,channel_id,created_by_user_id,attachment_data,attachment_mime,attachment_name,attachment_size,attachment_category FROM telegramlogin_notes WHERE note_id=$1 AND is_deleted=FALSE LIMIT 1`,[noteId]);
    if(existing.rows.length===0) return res.status(404).json({success:false,message:"Note not found"});
    const oldNote=existing.rows[0];

    const access=await checkChannelAccess({channelId:oldNote.channel_id,userId:req.telegramUserId,deviceId});
    if(!access.ok) return res.status(access.status).json({success:false,message:access.message});

    const isCreator = String(oldNote.created_by_user_id)===String(req.telegramUserId);
    if(!isCreator &&!access.isOwner) return res.status(403).json({success:false,message:"You can only edit own message"});

    // if new file uploaded replace else keep old
    let newData = oldNote.attachment_data;
    let newMime = oldNote.attachment_mime;
    let newName = oldNote.attachment_name;
    let newSize = oldNote.attachment_size;
    let newCat = oldNote.attachment_category;

    if(file){
      newData=file.buffer; newMime=file.mimetype; newName=file.originalname; newSize=file.size; newCat=getAttachmentCategory(file);
    }

    if(!noteText &&!newData) return res.status(400).json({success:false,message:"Nothing to update"});

    const result=await db.query(`UPDATE telegramlogin_notes SET note_text=$1, attachment_data=$2, attachment_mime=$3, attachment_name=$4, attachment_size=$5, attachment_category=$6, note_type=$7, updated_at=NOW() WHERE note_id=$8 RETURNING note_id,channel_id,created_by_user_id,note_type,note_text,attachment_data IS NOT NULL AS has_attachment,attachment_mime,attachment_name,attachment_size,attachment_category,created_device_id,created_at,updated_at`,
      [noteText||oldNote.note_text||null, newData, newMime, newName, newSize, newCat, file?getNoteType(file):oldNote.note_type||"text", noteId]);

    const userR=await db.query(`SELECT full_name FROM telegram_users WHERE telegram_user_id=$1 LIMIT 1`,[result.rows[0].created_by_user_id]);
    return res.json({success:true,note:normalizeNote({...result.rows[0],created_by_name:userR.rows[0]?.full_name||""})});
  }catch(e){ console.error("UPDATE ERROR",e); return res.status(500).json({success:false,message:"Update failed: "+e.message}); }
});

router.delete("/:noteId", authenticateTelegramUser, async(req,res)=>{
  try{
    const noteId=Number(req.params.noteId);
    const r=await db.query(`SELECT created_by_user_id,channel_id FROM telegramlogin_notes WHERE note_id=$1 AND is_deleted=FALSE LIMIT 1`,[noteId]);
    if(r.rows.length===0) return res.status(404).json({success:false,message:"Not found"});
    // owner or creator can delete
    const ch=await db.query(`SELECT created_by_user_id FROM telegramlogin_channellist WHERE channel_id=$1 LIMIT 1`,[r.rows[0].channel_id]);
    const isChannelOwner = ch.rows[0] && String(ch.rows[0].created_by_user_id)===String(req.telegramUserId);
    const isCreator = String(r.rows[0].created_by_user_id)===String(req.telegramUserId);
    if(!isCreator &&!isChannelOwner) return res.status(403).json({success:false,message:"Not allowed"});
    await db.query(`UPDATE telegramlogin_notes SET is_deleted=TRUE, deleted_at=NOW(), deleted_by_user_id=$2 WHERE note_id=$1`,[noteId,req.telegramUserId]);
    return res.json({success:true});
  }catch(e){ console.error(e); return res.status(500).json({success:false}); }
});

module.exports = router;