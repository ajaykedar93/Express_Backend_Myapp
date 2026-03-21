const express = require("express");
const router = express.Router();
const Message = require("../models/Message");

// Get chat between 2 users
router.get("/messages/:user1/:user2", async (req, res) => {
  try {
    const { user1, user2 } = req.params;

    const messages = await Message.find({
      $or: [
        { senderId: user1, receiverId: user2 },
        { senderId: user2, receiverId: user1 },
      ],
    }).sort({ createdAt: 1 });

    res.json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch messages",
    });
  }
});

// Get chat list for one user
router.get("/conversations/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const messages = await Message.find({
      $or: [{ senderId: userId }, { receiverId: userId }],
    }).sort({ createdAt: -1 });

    const map = new Map();

    for (const msg of messages) {
      const otherUser =
        msg.senderId === userId ? msg.receiverId : msg.senderId;

      if (!map.has(otherUser)) {
        map.set(otherUser, {
          userId: otherUser,
          lastMessage: msg,
        });
      }
    }

    res.json({
      success: true,
      conversations: Array.from(map.values()),
    });
  } catch (error) {
    console.error("Get conversations error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch conversations",
    });
  }
});

// Mark messages seen
router.put("/seen", async (req, res) => {
  try {
    const { senderId, receiverId } = req.body;

    if (!senderId || !receiverId) {
      return res.status(400).json({
        success: false,
        message: "senderId and receiverId are required",
      });
    }

    await Message.updateMany(
      {
        senderId,
        receiverId,
        seen: false,
      },
      {
        $set: {
          seen: true,
          seenAt: new Date(),
        },
      }
    );

    res.json({
      success: true,
      message: "Messages marked as seen",
    });
  } catch (error) {
    console.error("Seen update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update seen status",
    });
  }
});

module.exports = router;