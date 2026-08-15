const express = require("express");
const multer = require("multer");
const path = require("path");
const sanitizeHtml = require("sanitize-html");
const db = require("../../db");

const router = express.Router();

// Support up to 3 images per note without changing the existing single-image API contract.
// The extra columns are added automatically when this router initializes.
const multiImageSchemaReady = db.query(`
  ALTER TABLE telegram_notes
    ADD COLUMN IF NOT EXISTS image_data_2 BYTEA,
    ADD COLUMN IF NOT EXISTS image_mime_2 VARCHAR(100),
    ADD COLUMN IF NOT EXISTS image_name_2 TEXT,
    ADD COLUMN IF NOT EXISTS image_data_3 BYTEA,
    ADD COLUMN IF NOT EXISTS image_mime_3 VARCHAR(100),
    ADD COLUMN IF NOT EXISTS image_name_3 TEXT
`).catch((error) => {
  console.error("Multi-image schema initialization failed:", error);
  throw error;
});

/* ===============================
   Multer Any File Upload Config
   Supports:
   - Old frontend field: image
   - New frontend fields: file / attachment

   Store file in memory, then save buffer in DB.
   Images go to existing image_* columns.
   Other files go to attachment_* columns.
================================ */
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
  },
});

const uploadAnyFile = (req, res, next) => {
  upload.fields([
    { name: "image", maxCount: 3 },
    { name: "file", maxCount: 1 },
    { name: "attachment", maxCount: 1 },
  ])(req, res, function (error) {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "File upload failed",
      });
    }

    next();
  });
};

/* ===============================
   Helper Functions
================================ */
const getBaseUrl = (req) => {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
};

const getSafeFileName = (value, fallback = "file") => {
  const safeName = path
    .basename(String(value || fallback))
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return safeName || fallback;
};

const getFileExt = (fileName) => {
  const ext = path.extname(fileName || "").replace(".", "").toLowerCase();
  return ext ? ext.slice(0, 30) : "";
};

const isImageMime = (mime) => {
  return String(mime || "").toLowerCase().startsWith("image/");
};

const isPreviewableMime = (mime) => {
  const safeMime = String(mime || "").toLowerCase();

  return (
    safeMime.startsWith("image/") ||
    safeMime.startsWith("text/") ||
    safeMime === "application/pdf" ||
    safeMime === "application/json" ||
    safeMime === "application/xml" ||
    safeMime === "text/csv"
  );
};

const getUploadedImages = (req) => Array.isArray(req.files?.image) ? req.files.image.slice(0, 3) : [];

const getUploadedFile = (req) => {
  return (
    req.files?.file?.[0] ||
    req.files?.attachment?.[0] ||
    req.files?.image?.[0] ||
    null
  );
};

const getImageViewUrl = (req, noteId, updatedAt) => {
  const version = updatedAt ? new Date(updatedAt).getTime() : Date.now();

  return `${getBaseUrl(req)}/api/telegram-notes/image/${noteId}?v=${version}`;
};

const getImageDownloadUrl = (req, noteId, slot = 1) => {
  const safeSlot = Number(slot);
  if (![1, 2, 3].includes(safeSlot)) return null;

  return `${getBaseUrl(req)}/api/telegram-notes/image/download/${noteId}${safeSlot === 1 ? "" : `/${safeSlot}`}`;
};

const getFileViewUrl = (req, noteId, updatedAt) => {
  const version = updatedAt ? new Date(updatedAt).getTime() : Date.now();

  return `${getBaseUrl(req)}/api/telegram-notes/file/${noteId}?v=${version}`;
};

const getFileDownloadUrl = (req, noteId) => {
  return `${getBaseUrl(req)}/api/telegram-notes/file/download/${noteId}`;
};

const normalizeNoteFile = (req, note) => {
  if (!note) return note;

  const hasImage = Boolean(note.has_image);
  const hasAttachment = Boolean(note.has_attachment);
  const hasFile = hasImage || hasAttachment;

  const imageUrls = [];
  if (hasImage) {
    imageUrls.push(getImageViewUrl(req, note.note_id, note.updated_at));
    if (note.has_image_2) imageUrls.push(`${getBaseUrl(req)}/api/telegram-notes/image/${note.note_id}/2?v=${note.updated_at ? new Date(note.updated_at).getTime() : Date.now()}`);
    if (note.has_image_3) imageUrls.push(`${getBaseUrl(req)}/api/telegram-notes/image/${note.note_id}/3?v=${note.updated_at ? new Date(note.updated_at).getTime() : Date.now()}`);
  }

  const fileName = hasAttachment
    ? note.attachment_name
    : hasImage
      ? note.image_name
      : null;

  const fileMime = hasAttachment
    ? note.attachment_mime
    : hasImage
      ? note.image_mime
      : null;

  const fileSize = hasAttachment
    ? note.attachment_size
    : hasImage
      ? note.image_size || null
      : null;

  const fileExt = hasAttachment
    ? note.attachment_ext
    : fileName
      ? getFileExt(fileName)
      : "";

  const filePreviewable = hasFile && isPreviewableMime(fileMime);

  return {
    ...note,

    // Old image response support
    image_url: hasImage
      ? getImageViewUrl(req, note.note_id, note.updated_at)
      : null,
    image_urls: imageUrls,
    image_path: null,
    download_url: hasImage ? getImageDownloadUrl(req, note.note_id, 1) : null,
    image_download_urls: hasImage
      ? imageUrls.map((_, index) => getImageDownloadUrl(req, note.note_id, index + 1))
      : [],

    // New generic file response support
    has_file: hasFile,
    has_attachment: hasAttachment,
    file_name: fileName,
    file_mime: fileMime,
    file_size: fileSize,
    file_ext: fileExt,
    file_previewable: filePreviewable,
    file_url: hasFile ? getFileViewUrl(req, note.note_id, note.updated_at) : null,
    file_download_url: hasFile ? getFileDownloadUrl(req, note.note_id) : null,

    // Do not expose old path values
    attachment_url: hasAttachment
      ? getFileViewUrl(req, note.note_id, note.updated_at)
      : null,
    attachment_path: null,
  };
};

const isValidColor = (color) => {
  return /^#[0-9A-Fa-f]{6}$/.test(color || "");
};

const cleanPin = (pin) => {
  return String(pin || "").replace(/\D/g, "").slice(0, 4);
};

const getRequestPin = (req) => {
  return cleanPin(
    req.headers["x-channel-pin"] ||
      req.body?.channel_pin ||
      req.query?.channel_pin ||
      ""
  );
};

const cleanHtml = (html) => {
  return sanitizeHtml(html || "", {
    allowedTags: ["a", "b", "strong", "u", "span", "font", "div", "p", "br"],
    allowedAttributes: {
      a: ["href", "target", "rel", "class", "style"],
      span: ["style", "class"],
      div: ["style", "class"],
      p: ["style", "class"],
      font: ["color", "style"],
      b: ["style"],
      strong: ["style"],
      u: ["style"],
    },
    allowedStyles: {
      "*": {
        color: [
          /^#[0-9a-fA-F]{3,8}$/,
          /^rgb\((\d{1,3},\s*){2}\d{1,3}\)$/,
          /^rgba\((\d{1,3},\s*){3}0?(?:\.\d+)?\)$/i,
        ],
        "font-weight": [/^(?:normal|bold|[1-9]00)$/],
        "text-decoration": [/^(?:none|underline)(?:\s+[^;]+)?$/i],
        "text-decoration-line": [/^(?:none|underline)$/i],
        "text-decoration-style": [/^(?:solid|dotted|dashed|double|wavy)$/i],
        "text-decoration-thickness": [/^[0-9.]+(?:px|em|rem|%)$/i],
        "text-underline-offset": [/^[0-9.]+(?:px|em|rem|%)$/i],
        "-webkit-text-fill-color": [
          /^#[0-9a-fA-F]{3,8}$/,
          /^rgb\((\d{1,3},\s*){2}\d{1,3}\)$/i,
        ],
      },
    },
    allowedSchemes: ["http", "https"],
    allowedSchemesByTag: { a: ["http", "https"] },
    allowProtocolRelative: false,
    transformTags: {
      font: function (tagName, attribs) {
        const color = attribs.color;
        if (color && (/^#[0-9a-fA-F]{3,8}$/.test(color) || /^rgb\((\d{1,3},\s*){2}\d{1,3}\)$/.test(color))) {
          return { tagName: "span", attribs: { style: `color:${color};-webkit-text-fill-color:${color}` } };
        }
        return { tagName: "span", attribs: {} };
      },
    },
  });
};

const getPlainText = (html) => {
  return sanitizeHtml(html || "", {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/g, " ")
    .trim();
};

const getLastMessageText = (contentHtml, hasImage, fileName = "") => {
  const text = getPlainText(contentHtml);

  if (text) {
    return text.slice(0, 100);
  }

  if (fileName) {
    return `File: ${String(fileName).slice(0, 90)}`;
  }

  if (hasImage) {
    return "Image message";
  }

  return "No messages yet";
};

const updateChannelLastMessage = async (
  channelId,
  contentHtml,
  hasImage,
  fileName = ""
) => {
  if (!channelId) return;

  const lastMessage = getLastMessageText(contentHtml, hasImage, fileName);

  await db.query(
    `UPDATE telegram_channels
     SET
        last_message = $1,
        last_message_time = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
     WHERE channel_id = $2`,
    [lastMessage, channelId]
  );
};

const updateChannelLastMessageAfterDelete = async (channelId) => {
  if (!channelId) return;

  const latestResult = await db.query(
    `SELECT
        content_html,
        image_name,
        attachment_name,
        (image_data IS NOT NULL) AS has_image,
        (attachment_data IS NOT NULL) AS has_attachment
     FROM telegram_notes
     WHERE channel_id = $1
     ORDER BY created_at DESC, note_id DESC
     LIMIT 1`,
    [channelId]
  );

  if (latestResult.rows.length === 0) {
    await db.query(
      `UPDATE telegram_channels
       SET
          last_message = 'No messages yet',
          last_message_time = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
       WHERE channel_id = $1`,
      [channelId]
    );

    return;
  }

  const latestNote = latestResult.rows[0];

  await updateChannelLastMessage(
    channelId,
    latestNote.content_html,
    latestNote.has_image,
    latestNote.attachment_name || latestNote.image_name || ""
  );
};

const setFileHeaders = (res, fileName, mime, size, dispositionType) => {
  const finalFileName = getSafeFileName(fileName, "file");
  const finalMime = mime || "application/octet-stream";

  res.setHeader("Content-Type", finalMime);
  res.setHeader(
    "Content-Disposition",
    `${dispositionType}; filename="${finalFileName}"; filename*=UTF-8''${encodeURIComponent(finalFileName)}`
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (size) {
    res.setHeader("Content-Length", size);
  }
};

const getNoteFileById = async (noteId) => {
  const result = await db.query(
    `SELECT
        note_id,
        image_data,
        image_mime,
        image_name,
        attachment_data,
        attachment_mime,
        attachment_name,
        attachment_size,
        attachment_ext
     FROM telegram_notes
     WHERE note_id = $1`,
    [noteId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  if (row.attachment_data) {
    const fileBuffer = Buffer.isBuffer(row.attachment_data)
      ? row.attachment_data
      : Buffer.from(row.attachment_data);

    return {
      data: fileBuffer,
      mime: row.attachment_mime || "application/octet-stream",
      name: row.attachment_name || `note-${noteId}.${row.attachment_ext || "file"}`,
      size: row.attachment_size || fileBuffer.length,
      type: "attachment",
    };
  }

  if (row.image_data) {
    const imageBuffer = Buffer.isBuffer(row.image_data)
      ? row.image_data
      : Buffer.from(row.image_data);

    return {
      data: imageBuffer,
      mime: row.image_mime || "image/jpeg",
      name: row.image_name || `note-${noteId}.jpg`,
      size: imageBuffer.length,
      type: "image",
    };
  }

  return null;
};

/* ===============================
   Private Channel Access Check
================================ */
const checkChannelAccess = async (req, res, channelId) => {
  if (!channelId) {
    res.status(400).json({
      success: false,
      message: "channel_id is required",
    });

    return false;
  }

  const channelResult = await db.query(
    `SELECT channel_id, user_id, channel_name, is_private, private_pin
     FROM telegram_channels
     WHERE channel_id = $1`,
    [channelId]
  );

  if (channelResult.rows.length === 0) {
    res.status(404).json({
      success: false,
      message: "Channel not found",
    });

    return false;
  }

  const channel = channelResult.rows[0];

  if (!channel.is_private) {
    return true;
  }

  const enteredPin = getRequestPin(req);

  if (!/^[0-9]{4}$/.test(enteredPin)) {
    res.status(403).json({
      success: false,
      message: "Private channel PIN required",
    });

    return false;
  }

  if (String(channel.private_pin) !== String(enteredPin)) {
    res.status(403).json({
      success: false,
      message: "Wrong PIN",
    });

    return false;
  }

  return true;
};

/* ===============================
   1. Get Notes
   GET /api/telegram-notes?user_id=7&channel_id=1
================================ */
router.get("/", async (req, res) => {
  try {
    await multiImageSchemaReady;
    const { user_id, channel_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    if (!channel_id) {
      return res.status(400).json({
        success: false,
        message: "channel_id is required",
      });
    }

    const allowed = await checkChannelAccess(req, res, channel_id);

    if (!allowed) return;

    const result = await db.query(
      `SELECT
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          image_mime,
          image_name,
          octet_length(image_data) AS image_size,
          (image_data IS NOT NULL) AS has_image,
          (image_data_2 IS NOT NULL) AS has_image_2,
          (image_data_3 IS NOT NULL) AS has_image_3,
          attachment_url,
          attachment_path,
          attachment_mime,
          attachment_name,
          attachment_size,
          attachment_ext,
          attachment_uploaded_at,
          (attachment_data IS NOT NULL) AS has_attachment,
          is_pinned,
          is_private,
          pin_hint,
          created_at,
          updated_at
       FROM telegram_notes
       WHERE user_id = $1
         AND channel_id = $2
       ORDER BY created_at ASC, note_id ASC`,
      [user_id, channel_id]
    );

    const notes = result.rows.map((note) => normalizeNoteFile(req, note));

    return res.status(200).json({
      success: true,
      notes,
    });
  } catch (error) {
    console.error("Get notes error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while fetching notes",
    });
  }
});

/* ===============================
   Generic File View + Download From DB

   Preview:
   GET /api/telegram-notes/file/:note_id

   Download:
   GET /api/telegram-notes/file/download/:note_id

   Rule:
   - Image, PDF, text, CSV, JSON open inline
   - Excel, Word, ZIP, other files download directly
================================ */
// Direct download endpoint: intentionally does NOT call checkChannelAccess().
// This allows browser/mobile downloads without resending a channel PIN.
router.get("/file/download/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;

    const file = await getNoteFileById(note_id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: "File not found",
      });
    }

    setFileHeaders(res, file.name, file.mime, file.size, "attachment");

    return res.end(file.data);
  } catch (error) {
    console.error("File download error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while downloading file",
    });
  }
});

router.get("/file/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;

    const file = await getNoteFileById(note_id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: "File not found",
      });
    }

    const dispositionType = isPreviewableMime(file.mime)
      ? "inline"
      : "attachment";

    setFileHeaders(res, file.name, file.mime, file.size, dispositionType);

    return res.end(file.data);
  } catch (error) {
    console.error("File view error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while opening file",
    });
  }
});

/* ===============================
   Multi-image slot view: /image/:note_id/:slot
================================ */
router.get("/image/:note_id/:slot", async (req, res) => {
  try {
    await multiImageSchemaReady;
    const noteId = Number(req.params.note_id);
    const slot = Number(req.params.slot);
    if (![2, 3].includes(slot)) return res.status(400).json({ success: false, message: "Invalid image slot" });

    const result = await db.query(
      `SELECT image_data_${slot} AS image_data, image_mime_${slot} AS image_mime, image_name_${slot} AS image_name
       FROM telegram_notes WHERE note_id = $1`,
      [noteId]
    );
    if (!result.rows.length || !result.rows[0].image_data) return res.status(404).json({ success: false, message: "Image not found" });
    const row = result.rows[0];
    const buffer = Buffer.isBuffer(row.image_data) ? row.image_data : Buffer.from(row.image_data);
    setFileHeaders(res, row.image_name || `note-${noteId}-${slot}.jpg`, row.image_mime || "image/jpeg", buffer.length, "inline");
    return res.end(buffer);
  } catch (error) {
    console.error("Multi-image fetch error:", error);
    return res.status(500).json({ success: false, message: "Server error while fetching image" });
  }
});

/* ===============================
   Old Image View + Download From DB
   Kept same for old frontend support

   GET /api/telegram-notes/image/:note_id
   GET /api/telegram-notes/image/download/:note_id

   Multi-image downloads:
   GET /api/telegram-notes/image/download/:note_id/2
   GET /api/telegram-notes/image/download/:note_id/3
================================ */

const getImageBySlot = async (noteId, slot) => {
  const safeNoteId = Number(noteId);
  const safeSlot = Number(slot);

  if (!Number.isInteger(safeNoteId) || safeNoteId <= 0) return null;
  if (![1, 2, 3].includes(safeSlot)) return null;

  const column = safeSlot === 1 ? "image_data" : `image_data_${safeSlot}`;
  const mimeColumn = safeSlot === 1 ? "image_mime" : `image_mime_${safeSlot}`;
  const nameColumn = safeSlot === 1 ? "image_name" : `image_name_${safeSlot}`;

  const result = await db.query(
    `SELECT ${column} AS image_data,
            ${mimeColumn} AS image_mime,
            ${nameColumn} AS image_name
     FROM telegram_notes
     WHERE note_id = $1`,
    [safeNoteId]
  );

  if (!result.rows.length || !result.rows[0].image_data) return null;

  const image = result.rows[0];
  const imageBuffer = Buffer.isBuffer(image.image_data)
    ? image.image_data
    : Buffer.from(image.image_data);

  return {
    data: imageBuffer,
    mime: image.image_mime || "application/octet-stream",
    name: getSafeFileName(
      image.image_name || `note-${safeNoteId}${safeSlot === 1 ? "" : `-${safeSlot}`}.jpg`
    ),
    size: imageBuffer.length,
    slot: safeSlot,
  };
};

/* ===============================
   Image download — slot 1
   Browser + Android/iOS compatible
   ================================ */
// Direct image download endpoint: intentionally does NOT call checkChannelAccess().
// This allows browser/mobile downloads without resending a channel PIN.
router.get("/image/download/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;
    const image = await getImageBySlot(note_id, 1);

    if (!image) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    setFileHeaders(
      res,
      image.name,
      image.mime,
      image.size,
      "attachment"
    );

    return res.end(image.data);
  } catch (error) {
    console.error("Image download error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Server error while downloading image",
      });
    }

    return res.end();
  }
});

/* ===============================
   Image download — slots 2 and 3
   ================================ */
// Direct multi-image download endpoint: intentionally does NOT call checkChannelAccess().
router.get("/image/download/:note_id/:slot", async (req, res) => {
  try {
    const { note_id, slot } = req.params;
    const safeSlot = Number(slot);

    if (![2, 3].includes(safeSlot)) {
      return res.status(400).json({
        success: false,
        message: "Invalid image slot",
      });
    }

    const image = await getImageBySlot(note_id, safeSlot);

    if (!image) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    setFileHeaders(
      res,
      image.name,
      image.mime,
      image.size,
      "attachment"
    );

    return res.end(image.data);
  } catch (error) {
    console.error("Multi-image download error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Server error while downloading image",
      });
    }

    return res.end();
  }
});


router.get("/image/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;
    const image = await getImageBySlot(note_id, 1);

    if (!image) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    setFileHeaders(
      res,
      image.name,
      image.mime,
      image.size,
      "inline"
    );

    return res.end(image.data);
  } catch (error) {
    console.error("Image fetch error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Server error while fetching image",
      });
    }

    return res.end();
  }
});

/* ===============================
   2. Get Single Note
   GET /api/telegram-notes/:note_id
================================ */
router.get("/:note_id", async (req, res) => {
  try {
    await multiImageSchemaReady;
    const { note_id } = req.params;

    const result = await db.query(
      `SELECT
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          image_mime,
          image_name,
          octet_length(image_data) AS image_size,
          (image_data IS NOT NULL) AS has_image,
          (image_data_2 IS NOT NULL) AS has_image_2,
          (image_data_3 IS NOT NULL) AS has_image_3,
          attachment_url,
          attachment_path,
          attachment_mime,
          attachment_name,
          attachment_size,
          attachment_ext,
          attachment_uploaded_at,
          (attachment_data IS NOT NULL) AS has_attachment,
          is_pinned,
          is_private,
          pin_hint,
          created_at,
          updated_at
       FROM telegram_notes
       WHERE note_id = $1`,
      [note_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Note not found",
      });
    }

    const note = result.rows[0];

    const allowed = await checkChannelAccess(req, res, note.channel_id);

    if (!allowed) return;

    return res.status(200).json({
      success: true,
      note: normalizeNoteFile(req, note),
    });
  } catch (error) {
    console.error("Get single note error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while fetching note",
    });
  }
});

/* ===============================
   3. Add New Note
   POST /api/telegram-notes

   FormData file field names accepted:
   - image       old frontend support
   - file        new generic upload
   - attachment  new generic upload
================================ */
router.post("/", uploadAnyFile, async (req, res) => {
  try {
    await multiImageSchemaReady;
    const { user_id, channel_id, title, content_html, text_color } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    if (!channel_id) {
      return res.status(400).json({
        success: false,
        message: "channel_id is required",
      });
    }

    const allowed = await checkChannelAccess(req, res, channel_id);

    if (!allowed) return;

    const finalTitle = title ? title.trim() : null;
    const finalContent = cleanHtml(content_html);
    const finalPlainText = getPlainText(finalContent);
    const finalColor = isValidColor(text_color) ? text_color : "#111827";

    const uploadedImages = getUploadedImages(req);
    const uploadedFile = getUploadedFile(req);

    let imageData = null;
    let imageMime = null;
    let imageName = null;
    let imageData2 = null;
    let imageMime2 = null;
    let imageName2 = null;
    let imageData3 = null;
    let imageMime3 = null;
    let imageName3 = null;

    let attachmentData = null;
    let attachmentMime = null;
    let attachmentName = null;
    let attachmentSize = null;
    let attachmentExt = null;

    if (uploadedImages.length) {
      const imageFiles = uploadedImages.slice(0, 3);
      for (let i = 0; i < imageFiles.length; i += 1) {
        const image = imageFiles[i];
        const safeName = getSafeFileName(image.originalname, `image-${i + 1}`);
        const safeMime = image.mimetype || "image/jpeg";
        if (!isImageMime(safeMime)) continue;
        if (i === 0) { imageData = image.buffer; imageMime = safeMime; imageName = safeName; }
        if (i === 1) { imageData2 = image.buffer; imageMime2 = safeMime; imageName2 = safeName; }
        if (i === 2) { imageData3 = image.buffer; imageMime3 = safeMime; imageName3 = safeName; }
      }
    }

    if (uploadedFile && !(req.files?.image?.length)) {
      const safeName = getSafeFileName(uploadedFile.originalname, "file");
      const safeMime = uploadedFile.mimetype || "application/octet-stream";
      if (!isImageMime(safeMime)) {
        attachmentData = uploadedFile.buffer;
        attachmentMime = safeMime;
        attachmentName = safeName;
        attachmentSize = uploadedFile.size || uploadedFile.buffer?.length || 0;
        attachmentExt = getFileExt(safeName);
      }
    }

    if (!finalTitle && !finalPlainText && !imageData && !attachmentData) {
      return res.status(400).json({
        success: false,
        message: "Please add text or file",
      });
    }

    const result = await db.query(
      `INSERT INTO telegram_notes
        (
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_data,
          image_mime,
          image_name,
          image_data_2,
          image_mime_2,
          image_name_2,
          image_data_3,
          image_mime_3,
          image_name_3,
          image_url,
          image_path,
          attachment_data,
          attachment_mime,
          attachment_name,
          attachment_size,
          attachment_ext,
          attachment_url,
          attachment_path,
          attachment_uploaded_at,
          created_at,
          updated_at
        )
       VALUES
        (
          $1::int, $2::int, $3::varchar(255), $4::text, $5::varchar(20),
          $6::bytea, $7::varchar(100), $8::text, $9::bytea, $10::varchar(100), $11::text, $12::bytea, $13::varchar(100), $14::text, NULL, NULL,
          $15::bytea, $16::varchar(150), $17::text, $18::bigint, $19::varchar(30), NULL, NULL,
          CASE WHEN $9::bytea IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
       RETURNING
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          image_mime,
          image_name,
          octet_length(image_data) AS image_size,
          (image_data IS NOT NULL) AS has_image,
          (image_data_2 IS NOT NULL) AS has_image_2,
          (image_data_3 IS NOT NULL) AS has_image_3,
          attachment_url,
          attachment_path,
          attachment_mime,
          attachment_name,
          attachment_size,
          attachment_ext,
          attachment_uploaded_at,
          (attachment_data IS NOT NULL) AS has_attachment,
          is_pinned,
          is_private,
          pin_hint,
          created_at,
          updated_at`,
      [
        user_id,
        channel_id,
        finalTitle,
        finalContent,
        finalColor,
        imageData,
        imageMime,
        imageName,
        imageData2,
        imageMime2,
        imageName2,
        imageData3,
        imageMime3,
        imageName3,
        attachmentData,
        attachmentMime,
        attachmentName,
        attachmentSize,
        attachmentExt,
      ]
    );

    await updateChannelLastMessage(
      channel_id,
      finalContent,
      Boolean(imageData || imageData2 || imageData3),
      attachmentName || imageName || imageName2 || imageName3 || ""
    );

    return res.status(201).json({
      success: true,
      message: "Message added successfully",
      note: normalizeNoteFile(req, result.rows[0]),
    });
  } catch (error) {
    console.error("Add note error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while adding message",
    });
  }
});

/* ===============================
   4. Update Note
   PUT /api/telegram-notes/:note_id

   FormData:
   - image / file / attachment
   - remove_image=true
   - remove_file=true or remove_attachment=true
================================ */
router.put("/:note_id", uploadAnyFile, async (req, res) => {
  try {
    await multiImageSchemaReady;
    const { note_id } = req.params;

    const {
      title,
      content_html,
      text_color,
      remove_image,
      remove_file,
      remove_attachment,
    } = req.body;

    const oldNoteResult = await db.query(
      `SELECT *
       FROM telegram_notes
       WHERE note_id = $1`,
      [note_id]
    );

    if (oldNoteResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    const oldNote = oldNoteResult.rows[0];

    const allowed = await checkChannelAccess(req, res, oldNote.channel_id);

    if (!allowed) return;

    const finalTitle = title ? title.trim() : null;
    const finalContent = cleanHtml(content_html);
    const finalPlainText = getPlainText(finalContent);
    const finalColor = isValidColor(text_color) ? text_color : "#111827";

    let imageData = oldNote.image_data;
    let imageMime = oldNote.image_mime;
    let imageName = oldNote.image_name;
    let imageData2 = oldNote.image_data_2;
    let imageMime2 = oldNote.image_mime_2;
    let imageName2 = oldNote.image_name_2;
    let imageData3 = oldNote.image_data_3;
    let imageMime3 = oldNote.image_mime_3;
    let imageName3 = oldNote.image_name_3;

    let attachmentData = oldNote.attachment_data;
    let attachmentMime = oldNote.attachment_mime;
    let attachmentName = oldNote.attachment_name;
    let attachmentSize = oldNote.attachment_size;
    let attachmentExt = oldNote.attachment_ext;
    let attachmentUploadedAt = oldNote.attachment_uploaded_at;

    if (remove_image === "true" || remove_image === true) {
      imageData = null;
      imageMime = null;
      imageName = null;
      imageData2 = null;
      imageMime2 = null;
      imageName2 = null;
      imageData3 = null;
      imageMime3 = null;
      imageName3 = null;
    }

    if (
      remove_file === "true" ||
      remove_file === true ||
      remove_attachment === "true" ||
      remove_attachment === true
    ) {
      attachmentData = null;
      attachmentMime = null;
      attachmentName = null;
      attachmentSize = null;
      attachmentExt = null;
      attachmentUploadedAt = null;
    }

    const uploadedImages = getUploadedImages(req);
    const uploadedFile = getUploadedFile(req);

    if (uploadedImages.length) {
      imageData = null; imageMime = null; imageName = null;
      imageData2 = null; imageMime2 = null; imageName2 = null;
      imageData3 = null; imageMime3 = null; imageName3 = null;
      uploadedImages.slice(0, 3).forEach((image, index) => {
        const safeName = getSafeFileName(image.originalname, `image-${index + 1}`);
        const safeMime = image.mimetype || "image/jpeg";
        if (!isImageMime(safeMime)) return;
        if (index === 0) { imageData = image.buffer; imageMime = safeMime; imageName = safeName; }
        if (index === 1) { imageData2 = image.buffer; imageMime2 = safeMime; imageName2 = safeName; }
        if (index === 2) { imageData3 = image.buffer; imageMime3 = safeMime; imageName3 = safeName; }
      });
      attachmentData = null;
      attachmentMime = null;
      attachmentName = null;
      attachmentSize = null;
      attachmentExt = null;
      attachmentUploadedAt = null;
    } else if (uploadedFile) {
      const safeName = getSafeFileName(uploadedFile.originalname, "file");
      const safeMime = uploadedFile.mimetype || "application/octet-stream";

      if (!isImageMime(safeMime)) {
        imageData = null;
        imageMime = null;
        imageName = null;
        imageData2 = null;
        imageMime2 = null;
        imageName2 = null;
        imageData3 = null;
        imageMime3 = null;
        imageName3 = null;

        attachmentData = uploadedFile.buffer;
        attachmentMime = safeMime;
        attachmentName = safeName;
        attachmentSize = uploadedFile.size || uploadedFile.buffer?.length || 0;
        attachmentExt = getFileExt(safeName);
        attachmentUploadedAt = new Date();
      }
    }

    if (!finalTitle && !finalPlainText && !imageData && !attachmentData) {
      return res.status(400).json({
        success: false,
        message: "Please add text or file",
      });
    }

    const result = await db.query(
      `UPDATE telegram_notes
       SET
          title = $1::varchar(255),
          content_html = $2::text,
          text_color = $3::varchar(20),
          image_data = $4::bytea,
          image_mime = $5::varchar(100),
          image_name = $6::text,
          image_data_2 = $7::bytea,
          image_mime_2 = $8::varchar(100),
          image_name_2 = $9::text,
          image_data_3 = $10::bytea,
          image_mime_3 = $11::varchar(100),
          image_name_3 = $12::text,
          image_url = NULL,
          image_path = NULL,
          attachment_data = $13::bytea,
          attachment_mime = $14::varchar(150),
          attachment_name = $15::text,
          attachment_size = $16::bigint,
          attachment_ext = $17::varchar(30),
          attachment_url = NULL,
          attachment_path = NULL,
          attachment_uploaded_at = $18::timestamp,
          updated_at = CURRENT_TIMESTAMP
       WHERE note_id = $19::int
       RETURNING
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          image_mime,
          image_name,
          octet_length(image_data) AS image_size,
          (image_data IS NOT NULL) AS has_image,
          (image_data_2 IS NOT NULL) AS has_image_2,
          (image_data_3 IS NOT NULL) AS has_image_3,
          attachment_url,
          attachment_path,
          attachment_mime,
          attachment_name,
          attachment_size,
          attachment_ext,
          attachment_uploaded_at,
          (attachment_data IS NOT NULL) AS has_attachment,
          is_pinned,
          is_private,
          pin_hint,
          created_at,
          updated_at`,
      [
        finalTitle,
        finalContent,
        finalColor,
        imageData,
        imageMime,
        imageName,
        imageData2,
        imageMime2,
        imageName2,
        imageData3,
        imageMime3,
        imageName3,
        attachmentData,
        attachmentMime,
        attachmentName,
        attachmentSize,
        attachmentExt,
        attachmentUploadedAt,
        note_id,
      ]
    );

    await updateChannelLastMessage(
      oldNote.channel_id,
      finalContent,
      Boolean(imageData || imageData2 || imageData3),
      attachmentName || imageName || imageName2 || imageName3 || ""
    );

    return res.status(200).json({
      success: true,
      message: "Message updated successfully",
      note: normalizeNoteFile(req, result.rows[0]),
    });
  } catch (error) {
    console.error("Update note error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while updating message",
    });
  }
});

/* ===============================
   5. Delete Note
   DELETE /api/telegram-notes/:note_id
================================ */
router.delete("/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;

    const oldNoteResult = await db.query(
      `SELECT *
       FROM telegram_notes
       WHERE note_id = $1`,
      [note_id]
    );

    if (oldNoteResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    const oldNote = oldNoteResult.rows[0];

    const allowed = await checkChannelAccess(req, res, oldNote.channel_id);

    if (!allowed) return;

    await db.query(
      `DELETE FROM telegram_notes
       WHERE note_id = $1`,
      [note_id]
    );

    await updateChannelLastMessageAfterDelete(oldNote.channel_id);

    return res.status(200).json({
      success: true,
      message: "Message deleted successfully",
      deleted_note_id: Number(note_id),
      channel_id: oldNote.channel_id,
    });
  } catch (error) {
    console.error("Delete note error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while deleting message",
    });
  }
});

module.exports = router;