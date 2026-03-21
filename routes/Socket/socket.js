// backend/socket/socket.js

const onlineUsers = new Map(); // userId -> socketId
const socketToUser = new Map(); // socketId -> userId

function emitOnlineUsers(io) {
  io.emit("online_users", Array.from(onlineUsers.keys()));
}

function initializeSocket(io) {
  io.on("connection", (socket) => {
    console.log("✅ Socket connected:", socket.id);

    /* ---------------- JOIN ---------------- */
    socket.on("join", (userId) => {
      if (!userId) return;

      const safeUserId = String(userId);

      // If this socket was already mapped to another user, remove old mapping
      const oldUserId = socketToUser.get(socket.id);
      if (oldUserId && oldUserId !== safeUserId) {
        onlineUsers.delete(oldUserId);
      }

      // If same user is already connected from another socket, remove old socket mapping
      const existingSocketId = onlineUsers.get(safeUserId);
      if (existingSocketId && existingSocketId !== socket.id) {
        socketToUser.delete(existingSocketId);
      }

      onlineUsers.set(safeUserId, socket.id);
      socketToUser.set(socket.id, safeUserId);

      console.log(`👤 User joined: ${safeUserId} -> ${socket.id}`);
      emitOnlineUsers(io);
    });

    /* ---------------- SEND MESSAGE ---------------- */
    socket.on("send_message", (data) => {
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

        const messageData = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          senderId: safeSenderId,
          receiverId: safeReceiverId,
          text: safeText,
          imageUrl: safeImageUrl,
          fileUrl: safeFileUrl,
          fileName: safeFileName,
          messageType,
          delivered: false,
          seen: false,
          createdAt: new Date().toISOString(),
        };

        const receiverSocketId = onlineUsers.get(safeReceiverId);

        // send to receiver
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("receive_message", messageData);
          messageData.delivered = true;
        }

        // send back to sender
        socket.emit("message_sent", messageData);

        console.log(
          `📩 Message: ${safeSenderId} -> ${safeReceiverId} | ${
            safeText || safeImageUrl || safeFileUrl
          }`
        );
      } catch (error) {
        console.error("send_message error:", error);
        socket.emit("socket_error", {
          message: "Failed to send message",
        });
      }
    });

    /* ---------------- TYPING ---------------- */
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

    /* ---------------- MESSAGE SEEN ---------------- */
    socket.on("message_seen", ({ senderId, receiverId, messageId } = {}) => {
      if (!senderId || !receiverId || !messageId) return;

      // senderId = original sender of message
      const senderSocketId = onlineUsers.get(String(senderId));
      if (senderSocketId) {
        io.to(senderSocketId).emit("message_seen", {
          senderId: String(senderId),
          receiverId: String(receiverId),
          messageId: String(messageId),
          seen: true,
        });
      }
    });

    /* ---------------- GET ONLINE USERS ---------------- */
    socket.on("get_online_users", () => {
      socket.emit("online_users", Array.from(onlineUsers.keys()));
    });

    /* ---------------- DISCONNECT ---------------- */
    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected:", socket.id);

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

module.exports = initializeSocket;