const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

// Login Route
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  // Validate request fields
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // Retrieve user by email
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = rows[0];

    // Check if the account is active
    if (!user.active) {
      return res.status(403).json({ error: 'Account has been deactivated. Please contact support.' });
    }

    // Compare passwords (support both plain text and hashed passwords)
    let isMatch = false;
    if (user.password_hash && (user.password_hash.startsWith('$2b$') || user.password_hash.startsWith('$2a$'))) {
      isMatch = await bcrypt.compare(password, user.password_hash);
    } else {
      isMatch = (password === user.password_hash);
    }
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        rep_number: user.rep_number
      },
      process.env.JWT_SECRET || 'lipistry_jwt_secret_key_2026_prod_v1',
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Return user details (excluding password hash) and token
    return res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        rep_number: user.rep_number,
        phone: user.phone
      }
    });

  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Forgot Password Route (Mock Flow for V1.0)
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    // Check if user exists
    const [rows] = await pool.query('SELECT id, name FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      // For security, do not disclose if the email exists or not. Simply return success
      return res.status(200).json({ message: 'If the email exists, a password reset link has been sent.' });
    }

    const user = rows[0];
    console.log(`[Forgot Password] Generating reset token for ${user.name} (${email})...`);

    // In a real implementation, we would create a temporary token, save it to the DB,
    // and send a reset email. For now, we mock the console output.
    return res.status(200).json({
      message: 'If the email exists, a password reset link has been sent.',
      note: 'Demo mode: Check console logs for token generation details.'
    });

  } catch (error) {
    console.error('Error in forgot-password:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Change Password Route
router.put('/change-password', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  try {
    // 1. Fetch user
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = rows[0];

    // 2. Compare current password (support both plain text and hashed passwords)
    let isMatch = false;
    if (user.password_hash && (user.password_hash.startsWith('$2b$') || user.password_hash.startsWith('$2a$'))) {
      isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    } else {
      isMatch = (currentPassword === user.password_hash);
    }

    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect current password.' });
    }

    // 3. Update password in plain-text as requested
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newPassword, userId]);

    return res.status(200).json({ message: 'Password updated successfully.' });

  } catch (error) {
    console.error('Error changing password:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
