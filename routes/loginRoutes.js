const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const db = require("../db");

const authenticateAndAuthorize = require("../middleware/authMiddleware");
const JWT_SECRET = process.env.JWT_SECRET;

// ================= LOGIN API =================
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  const query = "SELECT * FROM users WHERE email = ?";

  db.query(query, [email], (err, result) => {
    if (err) return res.json({ success: false, message: "DB Error" });

    if (result.length === 0) {
      return res.json({ success: false, message: "User not found" });
    }

    const user = result[0];

    // ✅ STATUS CHECK ADD
    if (user.status === 0) {
      return res.json({
        success: false,
        message: "Your account is inactive. Contact admin.",
      });
    }

    // Password check
    if (user.password !== password) {
      return res.json({ success: false, message: "Invalid password" });
    }

    // Token generate
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: "7h" },
    );

    res.json({
      success: true,
      message: "Login successful",
      token: token,
    });
  });
});

// ================= FORGOT PASSWORD =================
router.post("/forgot-password", (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: false, message: "Email is required" });

  const query = "SELECT * FROM users WHERE email = ?";
  db.query(query, [email], (err, result) => {
    if (err) return res.json({ success: false, message: "DB Error" });
    if (result.length === 0)
      return res.json({ success: false, message: "User not found" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const updateQuery =
      "UPDATE users SET reset_otp = ?, reset_otp_expires = DATE_ADD(NOW(), INTERVAL 3 MINUTE) WHERE email = ?";
    db.query(updateQuery, [otp, email], (err) => {
      if (err)
        return res.json({ success: false, message: "Failed to generate OTP" });

      const brevoData = {
        sender: { name: "Micara IMS", email: "bhuvakrish75@gmail.com" },
        replyTo: { name: "No Reply", email: "noreply@micaraims.com" },
        to: [{ email: email }],
        subject: "🔒 Password Reset OTP - Micara IMS",
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f4f7f6; border-radius: 10px;">
            <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); text-align: center;">
              <h2 style="color: #2c3e50; margin-bottom: 20px;">Password Reset Request</h2>
              <p style="color: #555; font-size: 16px; margin-bottom: 30px;">
                You recently requested to reset your password for your Micara IMS account. Here is your One-Time Password (OTP):
              </p>
              <div style="margin: 20px 0;">
                <span style="background-color: #f0f4f8; border: 2px dashed #4a90e2; color: #4a90e2; font-size: 32px; font-weight: bold; padding: 15px 30px; border-radius: 8px; letter-spacing: 5px; display: inline-block;">
                  ${otp}
                </span>
              </div>
              <p style="color: #e74c3c; font-size: 14px; margin-top: 30px;">
                <em>This OTP is valid for <strong>3 minutes</strong>.</em>
              </p>
              <p style="color: #7f8c8d; font-size: 14px; margin-top: 20px;">
                If you did not request a password reset, please ignore this email.
              </p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
              <p style="color: #aaa; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Micara IMS. All rights reserved.<br>
                Please do not reply to this automated message.
              </p>
            </div>
          </div>
        `,
      };

      fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          accept: "application/json",
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify(brevoData),
      })
        .then(async (response) => {
          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            console.error("Brevo API error:", errData);
            throw new Error("API failed");
          }
          res.json({ success: true, message: "OTP sent to your email" });
        })
        .catch((error) => {
          console.error("Email error:", error);
          res.json({ success: false, message: "Failed to send email" });
        });
    });
  });
});

// ================= VERIFY OTP =================
router.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.json({ success: false, message: "Email and OTP are required" });

  const query =
    "SELECT reset_otp, IF(reset_otp_expires > NOW(), 1, 0) as isValid FROM users WHERE email = ?";
  db.query(query, [email], (err, result) => {
    if (err) return res.json({ success: false, message: "DB Error" });
    if (result.length === 0)
      return res.json({ success: false, message: "User not found" });

    const user = result[0];
    if (!user.reset_otp || user.reset_otp !== otp) {
      return res.json({ success: false, message: "Invalid OTP" });
    }

    if (user.isValid === 0) {
      return res.json({ success: false, message: "OTP has expired" });
    }

    res.json({ success: true, message: "OTP verified successfully" });
  });
});

// ================= RESET PASSWORD =================
router.post("/reset-password", (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.json({ success: false, message: "All fields are required" });

  const query =
    "SELECT reset_otp, IF(reset_otp_expires > NOW(), 1, 0) as isValid FROM users WHERE email = ?";
  db.query(query, [email], (err, result) => {
    if (err) return res.json({ success: false, message: "DB Error" });
    if (result.length === 0)
      return res.json({ success: false, message: "User not found" });

    const user = result[0];
    if (!user.reset_otp || user.reset_otp !== otp) {
      return res.json({ success: false, message: "Invalid or expired OTP" });
    }

    if (user.isValid === 0) {
      return res.json({ success: false, message: "OTP has expired" });
    }

    const updateQuery =
      "UPDATE users SET password = ?, reset_otp = NULL, reset_otp_expires = NULL WHERE email = ?";
    console.log(
      `[DEBUG] Executing password reset for ${email}. New Password length: ${newPassword.length}`,
    );
    db.query(updateQuery, [newPassword, email], (err, updateResult) => {
      if (err) {
        console.error("[DEBUG] DB Update Error:", err);
        return res.json({
          success: false,
          message: "Failed to reset password",
        });
      }

      console.log(
        "[DEBUG] DB Update Success. Affected Rows:",
        updateResult.affectedRows,
        "Changed Rows:",
        updateResult.changedRows,
      );
      res.json({ success: true, message: "Password reset successful" });
    });
  });
});

module.exports = router;
