const express = require("express");
const multer = require("multer");
const path = require("path");
const sanitizeHtml = require("sanitize-html");
const db = require("../../db");

const router = express.Router();

/* ===============================
   Multer Image Upload Config
   Store image in memory, then save buffer in DB
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
    path.extname(file.originalname).toLowerCase()
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
    fileSize: 20 * 1024 * 1024,
  },
});

const uploadImage = (req, res, next) => {
  upload.single("image")(req, res, function (error) {
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message || "Image upload failed",
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

const getSafeFileName = (value) => {
  if (!value) return "image.jpg";

  return path
    .basename(String(value))
    .replace(/[/\\?%*:|"<>]/g, "-")
    .trim();
};

const getImageViewUrl = (req, noteId, updatedAt) => {
  const version = updatedAt ? new Date(updatedAt).getTime() : Date.now();

  return `${getBaseUrl(req)}/api/telegram-notes/image/${noteId}?v=${version}`;
};

const getImageDownloadUrl = (req, noteId) => {
  return `${getBaseUrl(req)}/api/telegram-notes/image/download/${noteId}`;
};

const normalizeNoteImage = (req, note) => {
  if (!note) return note;

  const hasImage = Boolean(note.has_image);

  return {
    ...note,
    image_url: hasImage
      ? getImageViewUrl(req, note.note_id, note.updated_at)
      : null,
    image_path: null,
    download_url: hasImage ? getImageDownloadUrl(req, note.note_id) : null,
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
    allowedTags: ["b", "strong", "u", "span", "font", "div", "p", "br"],
    allowedAttributes: {
      span: ["style"],
      div: ["style"],
      p: ["style"],
      font: ["color", "style"],
    },
    allowedStyles: {
      "*": {
        color: [
          /^#[0-9a-fA-F]{3,6}$/,
          /^rgb\((\d{1,3},\s*){2}\d{1,3}\)$/,
        ],
      },
    },
    transformTags: {
      font: function (tagName, attribs) {
        const color = attribs.color;

        if (
          color &&
          (/^#[0-9a-fA-F]{3,6}$/.test(color) ||
            /^rgb\((\d{1,3},\s*){2}\d{1,3}\)$/.test(color))
        ) {
          return {
            tagName: "span",
            attribs: {
              style: `color:${color}`,
            },
          };
        }

        return {
          tagName: "span",
          attribs: {},
        };
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

const getLastMessageText = (contentHtml, hasImage) => {
  const text = getPlainText(contentHtml);

  if (text) {
    return text.slice(0, 100);
  }

  if (hasImage) {
    return "Image message";
  }

  return "No messages yet";
};

const updateChannelLastMessage = async (channelId, contentHtml, hasImage) => {
  if (!channelId) return;

  const lastMessage = getLastMessageText(contentHtml, hasImage);

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
        (image_data IS NOT NULL) AS has_image
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
    latestNote.has_image
  );
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
          (image_data IS NOT NULL) AS has_image,
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

    const notes = result.rows.map((note) => normalizeNoteImage(req, note));

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
   Image View + Download From DB

   GET /api/telegram-notes/image/:note_id
   GET /api/telegram-notes/image/download/:note_id
================================ */
router.get("/image/download/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;

    const result = await db.query(
      `SELECT image_data, image_mime, image_name
       FROM telegram_notes
       WHERE note_id = $1`,
      [note_id]
    );

    if (result.rows.length === 0 || !result.rows[0].image_data) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    const image = result.rows[0];

    const imageBuffer = Buffer.isBuffer(image.image_data)
      ? image.image_data
      : Buffer.from(image.image_data);

    const fileName = getSafeFileName(image.image_name || `note-${note_id}.jpg`);

    res.setHeader("Content-Type", image.image_mime || "image/jpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );
    res.setHeader("Cache-Control", "no-store");

    return res.end(imageBuffer);
  } catch (error) {
    console.error("Image download error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while downloading image",
    });
  }
});

router.get("/image/:note_id", async (req, res) => {
  try {
    const { note_id } = req.params;

    const result = await db.query(
      `SELECT image_data, image_mime
       FROM telegram_notes
       WHERE note_id = $1`,
      [note_id]
    );

    if (result.rows.length === 0 || !result.rows[0].image_data) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    const image = result.rows[0];

    const imageBuffer = Buffer.isBuffer(image.image_data)
      ? image.image_data
      : Buffer.from(image.image_data);

    res.setHeader("Content-Type", image.image_mime || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");

    return res.end(imageBuffer);
  } catch (error) {
    console.error("Image fetch error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error while fetching image",
    });
  }
});

/* ===============================
   2. Get Single Note
   GET /api/telegram-notes/:note_id
================================ */
router.get("/:note_id", async (req, res) => {
  try {
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
          (image_data IS NOT NULL) AS has_image,
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
      note: normalizeNoteImage(req, note),
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

   FormData field name for image:
   image
================================ */
router.post("/", uploadImage, async (req, res) => {
  try {
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

    let imageData = null;
    let imageMime = null;
    let imageName = null;

    if (req.file) {
      imageData = req.file.buffer;
      imageMime = req.file.mimetype;
      imageName = getSafeFileName(req.file.originalname);
    }

    if (!finalTitle && !finalPlainText && !imageData) {
      return res.status(400).json({
        success: false,
        message: "Please add text or image",
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
          image_url,
          image_path,
          created_at,
          updated_at
        )
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          (image_data IS NOT NULL) AS has_image,
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
      ]
    );

    await updateChannelLastMessage(channel_id, finalContent, Boolean(imageData));

    return res.status(201).json({
      success: true,
      message: "Message added successfully",
      note: normalizeNoteImage(req, result.rows[0]),
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
================================ */
router.put("/:note_id", uploadImage, async (req, res) => {
  try {
    const { note_id } = req.params;
    const { title, content_html, text_color, remove_image } = req.body;

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

    if (remove_image === "true" || remove_image === true) {
      imageData = null;
      imageMime = null;
      imageName = null;
    }

    if (req.file) {
      imageData = req.file.buffer;
      imageMime = req.file.mimetype;
      imageName = getSafeFileName(req.file.originalname);
    }

    if (!finalTitle && !finalPlainText && !imageData) {
      return res.status(400).json({
        success: false,
        message: "Please add text or image",
      });
    }

    const result = await db.query(
      `UPDATE telegram_notes
       SET
          title = $1,
          content_html = $2,
          text_color = $3,
          image_data = $4,
          image_mime = $5,
          image_name = $6,
          image_url = NULL,
          image_path = NULL,
          updated_at = CURRENT_TIMESTAMP
       WHERE note_id = $7
       RETURNING
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          (image_data IS NOT NULL) AS has_image,
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
        note_id,
      ]
    );

    await updateChannelLastMessage(
      oldNote.channel_id,
      finalContent,
      Boolean(imageData)
    );

    return res.status(200).json({
      success: true,
      message: "Message updated successfully",
      note: normalizeNoteImage(req, result.rows[0]),
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