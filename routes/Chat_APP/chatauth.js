const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../../models/User");

const JWT_SECRET = "chat_secret_key";

/* ============================
   Register Chat User
============================ */

router.post("/register", async (req, res) => {

  try {

    const { name, email, password } = req.body;

    if (!name || !email || !password) {

      return res.status(400).json({
        message: "All fields required"
      });

    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {

      return res.status(400).json({
        message: "User already exists"
      });

    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await User.create({
      name,
      email,
      password: hashedPassword
    });

    res.status(201).json({

      message: "Chat user registered successfully",

      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email
      }

    });

  }
  catch (error) {

    console.error("Chat Register Error:", error);

    res.status(500).json({
      message: "Server error"
    });

  }

});


/* ============================
   Login Chat User
============================ */

router.post("/login", async (req, res) => {

  try {

    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (!user) {

      return res.status(404).json({
        message: "User not found"
      });

    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {

      return res.status(400).json({
        message: "Invalid password"
      });

    }

    const token = jwt.sign(
      { userId: user._id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({

      message: "Login successful",

      token,

      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }

    });

  }
  catch (error) {

    console.error("Chat Login Error:", error);

    res.status(500).json({
      message: "Server error"
    });

  }

});


/* ============================
   Get All Users
============================ */

router.get("/users", async (req, res) => {

  try {

    const users = await User.find().select("-password");

    res.json({
      users
    });

  }
  catch (error) {

    console.error("Get Users Error:", error);

    res.status(500).json({
      message: "Server error"
    });

  }

});


/* ============================
   Get Single User
============================ */

router.get("/user/:id", async (req, res) => {

  try {

    const user = await User
      .findById(req.params.id)
      .select("-password");

    if (!user) {

      return res.status(404).json({
        message: "User not found"
      });

    }

    res.json(user);

  }
  catch (error) {

    console.error("Get User Error:", error);

    res.status(500).json({
      message: "Server error"
    });

  }

});


/* ============================
   Update User Profile
============================ */

router.put("/update/:id", async (req, res) => {

  try {

    const { name, email } = req.body;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email },
      { new: true }
    ).select("-password");

    res.json({
      message: "Profile updated",
      user
    });

  }
  catch (error) {

    console.error("Update User Error:", error);

    res.status(500).json({
      message: "Server error"
    });

  }

});


/* ============================
   Delete User
============================ */

router.delete("/delete/:id", async (req, res) => {

  try {

    await User.findByIdAndDelete(req.params.id);

    res.json({
      message: "User deleted"
    });

  }
  catch (error) {

    console.error("Delete User Error:", error);

    res.status(500).json({
      message: "Server error"
    });

  }

});


/* ============================
   Verify Token
============================ */

router.get("/verify", async (req, res) => {

  try {

    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {

      return res.status(401).json({
        message: "No token"
      });

    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User
      .findById(decoded.userId)
      .select("-password");

    res.json({
      user
    });

  }
  catch (error) {

    res.status(401).json({
      message: "Invalid token"
    });

  }

});


module.exports = router;