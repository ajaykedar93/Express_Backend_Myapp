const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sanitizeHtml = require("sanitize-html");
const db = require("../../db");

const router = express.Router();

/* ===============================
   Upload Folder Setup
================================ */
const uploadDir = path.join(__dirname, "../../uploads/telegram-notes");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/* ===============================
   Multer Image Upload Config
================================ */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);

    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, PNG, and WEBP images are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/* ===============================
   Helper Functions
================================ */
const getBaseUrl = (req) => {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
};

const deleteOldImage = (imagePath) => {
  if (!imagePath) return;

  const fileName = path.basename(imagePath);
  const fullPath = path.join(uploadDir, fileName);

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
};

const isValidColor = (color) => {
  return /^#[0-9A-Fa-f]{6}$/.test(color || "");
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

const getLastMessageText = (contentHtml, imageUrl) => {
  const text = getPlainText(contentHtml);

  if (text) {
    return text.slice(0, 100);
  }

  if (imageUrl) {
    return "Image message";
  }

  return "No messages yet";
};

const updateChannelLastMessage = async (channelId, contentHtml, imageUrl) => {
  if (!channelId) return;

  const lastMessage = getLastMessageText(contentHtml, imageUrl);

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
    `SELECT content_html, image_url
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
    latestNote.image_url
  );
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

    let query = `
      SELECT
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          is_pinned,
          created_at,
          updated_at
       FROM telegram_notes
       WHERE user_id = $1
    `;

    const values = [user_id];

    if (channel_id) {
      query += ` AND channel_id = $2`;
      values.push(channel_id);
    }

    query += ` ORDER BY created_at ASC, note_id ASC`;

    const result = await db.query(query, values);

    res.status(200).json({
      success: true,
      notes: result.rows,
    });
  } catch (error) {
    console.error("Get notes error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching notes",
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
          is_pinned,
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

    res.status(200).json({
      success: true,
      note: result.rows[0],
    });
  } catch (error) {
    console.error("Get single note error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching note",
    });
  }
});

/* ===============================
   3. Add New Note
   POST /api/telegram-notes
================================ */
router.post("/", upload.single("image"), async (req, res) => {
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

    const finalTitle = title ? title.trim() : null;
    const finalContent = cleanHtml(content_html);
    const finalPlainText = getPlainText(finalContent);
    const finalColor = isValidColor(text_color) ? text_color : "#111111";

    let imageUrl = null;
    let imagePath = null;

    if (req.file) {
      imagePath = `/uploads/telegram-notes/${req.file.filename}`;
      imageUrl = `${getBaseUrl(req)}${imagePath}`;
    }

    if (!finalTitle && !finalPlainText && !imageUrl) {
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
          image_url,
          image_path,
          created_at,
          updated_at
        )
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          is_pinned,
          created_at,
          updated_at`,
      [
        user_id,
        channel_id,
        finalTitle,
        finalContent,
        finalColor,
        imageUrl,
        imagePath,
      ]
    );

    await updateChannelLastMessage(channel_id, finalContent, imageUrl);

    res.status(201).json({
      success: true,
      message: "Message added successfully",
      note: result.rows[0],
    });
  } catch (error) {
    console.error("Add note error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while adding message",
    });
  }
});

/* ===============================
   4. Update Note
   PUT /api/telegram-notes/:note_id
================================ */
router.put("/:note_id", upload.single("image"), async (req, res) => {
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

    const finalTitle = title ? title.trim() : null;
    const finalContent = cleanHtml(content_html);
    const finalPlainText = getPlainText(finalContent);
    const finalColor = isValidColor(text_color) ? text_color : "#111111";

    let imageUrl = oldNote.image_url;
    let imagePath = oldNote.image_path;

    if (remove_image === "true") {
      deleteOldImage(oldNote.image_path);
      imageUrl = null;
      imagePath = null;
    }

    if (req.file) {
      deleteOldImage(oldNote.image_path);

      imagePath = `/uploads/telegram-notes/${req.file.filename}`;
      imageUrl = `${getBaseUrl(req)}${imagePath}`;
    }

    if (!finalTitle && !finalPlainText && !imageUrl) {
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
          image_url = $4,
          image_path = $5,
          updated_at = CURRENT_TIMESTAMP
       WHERE note_id = $6
       RETURNING
          note_id,
          user_id,
          channel_id,
          title,
          content_html,
          text_color,
          image_url,
          image_path,
          is_pinned,
          created_at,
          updated_at`,
      [
        finalTitle,
        finalContent,
        finalColor,
        imageUrl,
        imagePath,
        note_id,
      ]
    );

    await updateChannelLastMessage(
      oldNote.channel_id,
      finalContent,
      imageUrl
    );

    res.status(200).json({
      success: true,
      message: "Message updated successfully",
      note: result.rows[0],
    });
  } catch (error) {
    console.error("Update note error:", error);
    res.status(500).json({
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

    deleteOldImage(oldNote.image_path);

    await db.query(
      `DELETE FROM telegram_notes
       WHERE note_id = $1`,
      [note_id]
    );

    await updateChannelLastMessageAfterDelete(oldNote.channel_id);

    res.status(200).json({
      success: true,
      message: "Message deleted successfully",
      deleted_note_id: note_id,
      channel_id: oldNote.channel_id,
    });
  } catch (error) {
    console.error("Delete note error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting message",
    });
  }
});

module.exports = router;