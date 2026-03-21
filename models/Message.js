const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    senderId: { type: String, required: true, trim: true },
    receiverId: { type: String, required: true, trim: true },
    text: { type: String, default: "", trim: true },
    imageUrl: { type: String, default: "", trim: true },
    fileUrl: { type: String, default: "", trim: true },
    fileName: { type: String, default: "", trim: true },
    messageType: {
      type: String,
      enum: ["text", "image", "file"],
      default: "text",
    },
    delivered: { type: Boolean, default: false },
    seen: { type: Boolean, default: false },
    seenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);