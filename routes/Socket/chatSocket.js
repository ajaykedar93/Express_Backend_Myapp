const Message = require("../../models/Message");

const onlineUsers = new Map();
const socketToUser = new Map();

function emitOnlineUsers(io) {
  io.emit("online_users", Array.from(onlineUsers.keys()));
}

function initializeChatSocket(io) {
  io.on("connection", (socket) => {
    console.log("✅ User connected:", socket.id);

    socket.on("join", (userId) => {
      if (!userId) return;

      const safeUserId = String(userId).trim();
      if (!safeUserId) return;

      const oldUserId = socketToUser.get(socket.id);
      if (oldUserId && oldUserId !== safeUserId) {
        onlineUsers.delete(oldUserId);
      }

      const existingSocketId = onlineUsers.get(safeUserId);
      if (existingSocketId && existingSocketId !== socket.id) {
        socketToUser.delete(existingSocketId);
      }

      onlineUsers.set(safeUserId, socket.id);
      socketToUser.set(socket.id, safeUserId);

      console.log(`👤 User joined: ${safeUserId} -> ${socket.id}`);
      emitOnlineUsers(io);
    });

    socket.on("send_message", async (data) => {
      try {
        const {
          senderId,
          receiverId,
          text = "",
          imageUrl = "",
          fileUrl = "",
          fileName = "",
          messageType = "text",
        } = data || {};

        const safeSenderId = String(senderId || "").trim();
        const safeReceiverId = String(receiverId || "").trim();
        const safeText = String(text || "").trim();
        const safeImageUrl = String(imageUrl || "").trim();
        const safeFileUrl = String(fileUrl || "").trim();
        const safeFileName = String(fileName || "").trim();

        if (!safeSenderId || !safeReceiverId) {
          socket.emit("socket_error", {
            message: "senderId and receiverId are required",
          });
          return;
        }

        if (!safeText && !safeImageUrl && !safeFileUrl) {
          socket.emit("socket_error", {
            message: "Message content is empty",
          });
          return;
        }

        const savedMessage = await Message.create({
          senderId: safeSenderId,
          receiverId: safeReceiverId,
          text: safeText,
          imageUrl: safeImageUrl,
          fileUrl: safeFileUrl,
          fileName: safeFileName,
          messageType,
          delivered: false,
          seen: false,
        });

        const messageData = {
          id: savedMessage._id.toString(),
          senderId: savedMessage.senderId,
          receiverId: savedMessage.receiverId,
          text: savedMessage.text,
          imageUrl: savedMessage.imageUrl,
          fileUrl: savedMessage.fileUrl,
          fileName: savedMessage.fileName,
          messageType: savedMessage.messageType,
          delivered: false,
          seen: false,
          createdAt: savedMessage.createdAt,
          updatedAt: savedMessage.updatedAt,
        };

        const receiverSocketId = onlineUsers.get(safeReceiverId);

        if (receiverSocketId) {
          await Message.findByIdAndUpdate(savedMessage._id, {
            delivered: true,
          });

          messageData.delivered = true;
          io.to(receiverSocketId).emit("receive_message", messageData);
        }

        socket.emit("message_sent", messageData);

        console.log("✅ Message saved in MongoDB:", savedMessage._id.toString());
        console.log(
          `📩 Message: ${safeSenderId} -> ${safeReceiverId} | ${safeText || safeImageUrl || safeFileUrl}`
        );
      } catch (error) {
        console.error("❌ send_message error:", error);
        socket.emit("socket_error", {
          message: error.message || "Failed to send message",
        });
      }
    });

    socket.on("typing", ({ senderId, receiverId } = {}) => {
      if (!senderId || !receiverId) return;

      const receiverSocketId = onlineUsers.get(String(receiverId));
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("typing", {
          senderId: String(senderId),
          receiverId: String(receiverId),
        });
      }
    });

    socket.on("stop_typing", ({ senderId, receiverId } = {}) => {
      if (!senderId || !receiverId) return;

      const receiverSocketId = onlineUsers.get(String(receiverId));
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("stop_typing", {
          senderId: String(senderId),
          receiverId: String(receiverId),
        });
      }
    });

    socket.on("message_seen", async ({ senderId, receiverId, messageId } = {}) => {
      try {
        if (!senderId || !receiverId || !messageId) return;

        await Message.findByIdAndUpdate(messageId, {
          seen: true,
          seenAt: new Date(),
        });

        const senderSocketId = onlineUsers.get(String(senderId));
        if (senderSocketId) {
          io.to(senderSocketId).emit("message_seen", {
            senderId: String(senderId),
            receiverId: String(receiverId),
            messageId: String(messageId),
            seen: true,
          });
        }
      } catch (error) {
        console.error("❌ message_seen error:", error);
      }
    });

    socket.on("get_online_users", () => {
      socket.emit("online_users", Array.from(onlineUsers.keys()));
    });

    socket.on("disconnect", () => {
      console.log("❌ User disconnected:", socket.id);

      const userId = socketToUser.get(socket.id);

      if (userId) {
        onlineUsers.delete(userId);
        socketToUser.delete(socket.id);
        console.log(`🚪 User removed: ${userId}`);
      }

      emitOnlineUsers(io);
    });
  });
}

module.exports = initializeChatSocket;