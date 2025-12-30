const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || '8f4a7d2c9b1e6a3f0d5c8b2a9e4f7d1c6b3a0e9f8d7c2b5a1e4f6c9b2d8a7e3f0';

// ==================== LOGIN FLOW API ====================

// Step 1: Send OTP to email (Without actual email sending)
router.post("/login/initiate", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    const conn = await pool.getConnection();

    // Check if user exists
    const [userRows] = await conn.query(
      'SELECT * FROM admin_users WHERE email = ? AND is_active = 1',
      [email]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found or inactive"
      });
    }

    const user = userRows[0];

    // Generate 6-digit OTP
    const otp = "123456"; // Fixed OTP for development
    // For production: const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    const otpExpire = new Date(Date.now() + 10 * 60000); // 10 minutes expiry

    // Store OTP in database
    await conn.query(
      'UPDATE admin_users SET otp = ?, otp_expire = ? WHERE id = ?',
      [otp, otpExpire.toISOString(), user.id]
    );

    console.log(`OTP for ${email}: ${otp} (Expires: ${otpExpire})`);

    conn.release();

    return res.json({
      success: true,
      message: "OTP generated successfully",
      data: {
        email: email,
        user_id: user.id,
        otp: otp, // Return OTP in response for development
        otp_expires: otpExpire
      }
    });

  } catch (err) {
    console.error("Login initiation error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to initiate login",
      error: err.message
    });
  }
});

// Step 2: Verify OTP
router.post("/login/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required"
      });
    }

    const conn = await pool.getConnection();

    // Check if user exists and OTP is valid
    const [userRows] = await conn.query(
      'SELECT * FROM admin_users WHERE email = ? AND is_active = 1',
      [email]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found or inactive"
      });
    }

    const user = userRows[0];

    // Check if OTP matches and is not expired
    const currentTime = new Date();
    const otpExpire = new Date(user.otp_expire);

    if (!user.otp || user.otp !== otp || currentTime > otpExpire) {
      conn.release();
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP"
      });
    }

    // Clear OTP after successful verification
    await conn.query(
      'UPDATE admin_users SET otp = NULL, otp_expire = NULL WHERE id = ?',
      [user.id]
    );

    conn.release();

    return res.json({
      success: true,
      message: "OTP verified successfully",
      data: {
        email: email,
        user_id: user.id,
        requires_password: true
      }
    });

  } catch (err) {
    console.error("OTP verification error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to verify OTP",
      error: err.message
    });
  }
});

// Step 3: Verify Password and Generate Token
router.post("/login/verify-password", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    const conn = await pool.getConnection();

    // Get user with password
    const [userRows] = await conn.query(
      'SELECT * FROM admin_users WHERE email = ? AND is_active = 1',
      [email]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found or inactive"
      });
    }

    const user = userRows[0];
    
    // DEBUG: Log password info
    console.log('Password attempt for:', email);
    console.log('Password from DB:', user.password ? user.password.substring(0, 20) + '...' : 'NULL');
    console.log('Password length:', user.password ? user.password.length : 0);

    // Check if password is hashed (starts with $2)
    const isHashed = user.password && user.password.startsWith('$2');
    
    let isPasswordValid = false;
    
    if (isHashed) {
      // Compare with bcrypt
      isPasswordValid = await bcrypt.compare(password, user.password);
      console.log('Using bcrypt comparison');
    } else {
      // Direct comparison (for plain text passwords - NOT RECOMMENDED)
      isPasswordValid = user.password === password;
      console.log('Using direct comparison (plain text)');
    }
    
    if (!isPasswordValid) {
      conn.release();
      return res.status(401).json({
        success: false,
        message: "Invalid password",
        debug: {
          isHashed: isHashed,
          dbPasswordLength: user.password ? user.password.length : 0
        }
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        full_name: user.full_name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Update last login
    await conn.query(
      'UPDATE admin_users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    conn.release();

    return res.json({
      success: true,
      message: "Login successful",
      data: {
        token: token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          full_name: user.full_name,
          role: user.role
        }
      }
    });

  } catch (err) {
    console.error("Password verification error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to verify password",
      error: err.message
    });
  }
});


router.post("/admin/quick-reset", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    // For development only - bypass security
    // if (process.env.NODE_ENV === 'production') {
    //   return res.status(403).json({
    //     success: false,
    //     message: "This endpoint is disabled in production"
    //   });
    // }

    const conn = await pool.getConnection();
    const defaultPassword = "admin123";

    // Generate hash
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    // Update directly
    const [result] = await conn.query(
      'UPDATE admin_users SET password = ? WHERE email = ?',
      [hashedPassword, email]
    );

    if (result.affectedRows === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    console.log(`🚀 QUICK RESET: ${email} → ${defaultPassword}`);

    conn.release();

    return res.json({
      success: true,
      message: "Password reset to 'admin123'",
      data: {
        email: email,
        password: defaultPassword,
        test_command: `curl -X POST http://localhost:3000/api/auth/login/verify-password -H "Content-Type: application/json" -d '{"email":"${email}","password":"${defaultPassword}"}'`
      }
    });

  } catch (err) {
    console.error("Quick reset error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to reset password",
      error: err.message
    });
  }
});

// Combined Login Endpoint (All steps in one)
router.post("/login", async (req, res) => {
  try {
    const { email, otp, password } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    const conn = await pool.getConnection();

    // Check if user exists
    const [userRows] = await conn.query(
      'SELECT * FROM admin_users WHERE email = ? AND is_active = 1',
      [email]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found or inactive"
      });
    }

    const user = userRows[0];
    let response = {};

    // If no OTP provided, send OTP
    if (!otp && !password) {
      // Generate 6-digit OTP
      const otpCode = "123456"; // Fixed OTP for development
      // For production: const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      
      const otpExpire = new Date(Date.now() + 10 * 60000);

      // Store OTP in database
      await conn.query(
        'UPDATE admin_users SET otp = ?, otp_expire = ? WHERE id = ?',
        [otpCode, otpExpire.toISOString(), user.id]
      );

      console.log(`OTP for ${email}: ${otpCode}`);

      response = {
        success: true,
        message: "OTP generated successfully",
        step: "otp_required",
        data: {
          email: email,
          user_id: user.id,
          otp: otpCode // Return OTP for development
        }
      };
    }
    // If OTP provided but no password, verify OTP
    else if (otp && !password) {
      const currentTime = new Date();
      const otpExpire = new Date(user.otp_expire);

      if (!user.otp || user.otp !== otp || currentTime > otpExpire) {
        conn.release();
        return res.status(400).json({
          success: false,
          message: "Invalid or expired OTP"
        });
      }

      // Clear OTP after verification
      await conn.query(
        'UPDATE admin_users SET otp = NULL, otp_expire = NULL WHERE id = ?',
        [user.id]
      );

      response = {
        success: true,
        message: "OTP verified successfully",
        step: "password_required",
        data: {
          email: email,
          user_id: user.id
        }
      };
    }
    // If password provided, verify password and generate token
    else if (password) {
      // If OTP is also provided, verify it first
      if (otp) {
        const currentTime = new Date();
        const otpExpire = new Date(user.otp_expire);

        if (!user.otp || user.otp !== otp || currentTime > otpExpire) {
          conn.release();
          return res.status(400).json({
            success: false,
            message: "Invalid or expired OTP"
          });
        }
      }

      // Verify password
      const isPasswordValid = await bcrypt.compare(password, user.password);
      
      if (!isPasswordValid) {
        conn.release();
        return res.status(401).json({
          success: false,
          message: "Invalid password"
        });
      }

      // Generate JWT token
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          full_name: user.full_name
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      // Update last login and clear OTP
      await conn.query(
        'UPDATE admin_users SET last_login = NOW(), otp = NULL, otp_expire = NULL WHERE id = ?',
        [user.id]
      );

      response = {
        success: true,
        message: "Login successful",
        step: "complete",
        data: {
          token: token,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            full_name: user.full_name,
            role: user.role
          }
        }
      };
    }

    conn.release();
    return res.json(response);

  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({
      success: false,
      message: "Login failed",
      error: err.message
    });
  }
});

// Resend OTP
router.post("/login/resend-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    const conn = await pool.getConnection();

    const [userRows] = await conn.query(
      'SELECT * FROM admin_users WHERE email = ? AND is_active = 1',
      [email]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = userRows[0];

    // Generate new OTP
    const otp = "123456"; // Fixed OTP for development
    const otpExpire = new Date(Date.now() + 10 * 60000);

    // Update OTP in database
    await conn.query(
      'UPDATE admin_users SET otp = ?, otp_expire = ? WHERE id = ?',
      [otp, otpExpire.toISOString(), user.id]
    );

    console.log(`New OTP for ${email}: ${otp}`);

    conn.release();

    return res.json({
      success: true,
      message: "OTP regenerated successfully",
      data: {
        email: email,
        user_id: user.id,
        otp: otp, // Return OTP for development
        otp_expires: otpExpire
      }
    });

  } catch (err) {
    console.error("Resend OTP error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to resend OTP",
      error: err.message
    });
  }
});

// Validate Token
router.post("/validate-token", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Token is required"
      });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if user still exists and is active
    const conn = await pool.getConnection();
    const [userRows] = await conn.query(
      'SELECT id, email, username, role, full_name FROM admin_users WHERE id = ? AND is_active = 1',
      [decoded.id]
    );
    conn.release();

    if (userRows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "User not found or inactive"
      });
    }

    return res.json({
      success: true,
      message: "Token is valid",
      data: {
        user: userRows[0],
        token_exp: decoded.exp
      }
    });

  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: "Token has expired"
      });
    }
    
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: "Invalid token"
      });
    }

    console.error("Token validation error:", err);
    return res.status(500).json({
      success: false,
      message: "Token validation failed",
      error: err.message
    });
  }
});

// Logout (Client-side should discard token)
router.post("/logout", async (req, res) => {
  try {
    return res.json({
      success: true,
      message: "Logout successful"
    });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({
      success: false,
      message: "Logout failed",
      error: err.message
    });
  }
});

// ==================== PASSWORD RESET ====================

// Request password reset (Simplified without email)
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    const conn = await pool.getConnection();

    const [userRows] = await conn.query(
      'SELECT * FROM admin_users WHERE email = ? AND is_active = 1',
      [email]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = userRows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    // Store reset token
    await conn.query(
      'UPDATE admin_users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
      [resetToken, resetTokenExpiry.toISOString(), user.id]
    );

    console.log(`Reset token for ${email}: ${resetToken}`);

    conn.release();

    return res.json({
      success: true,
      message: "Password reset token generated",
      data: {
        email: email,
        reset_token: resetToken, // Return token for development
        expires: resetTokenExpiry
      }
    });

  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to process password reset request",
      error: err.message
    });
  }
});

// Reset password with token
router.post("/reset-password", async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Email, token, and new password are required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    const conn = await pool.getConnection();

    const [userRows] = await conn.query(
      'SELECT * FROM admin_users WHERE email = ? AND reset_token = ? AND reset_token_expiry > NOW()',
      [email, token]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token"
      });
    }

    const user = userRows[0];

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    await conn.query(
      'UPDATE admin_users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );

    conn.release();

    return res.json({
      success: true,
      message: "Password reset successful"
    });

  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to reset password",
      error: err.message
    });
  }
});

// ==================== AUTH MIDDLEWARE ====================

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Access token required"
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: "Invalid or expired token"
      });
    }
    req.user = decoded;
    next();
  });
};

// ==================== USER PROFILE ====================

// Get current user profile
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const conn = await pool.getConnection();

    const [userRows] = await conn.query(
      `SELECT id, username, email, role, full_name, is_active, 
              last_login, created_at 
       FROM admin_users 
       WHERE id = ?`,
      [req.user.id]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = userRows[0];
    conn.release();

    return res.json({
      success: true,
      data: user
    });

  } catch (err) {
    console.error("Profile fetch error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
      error: err.message
    });
  }
});

// Update user profile
router.put("/profile", authenticateToken, async (req, res) => {
  try {
    const { full_name, username } = req.body;
    const conn = await pool.getConnection();

    // Check if username is already taken by another user
    if (username) {
      const [existingRows] = await conn.query(
        'SELECT id FROM admin_users WHERE username = ? AND id != ?',
        [username, req.user.id]
      );

      if (existingRows.length > 0) {
        conn.release();
        return res.status(409).json({
          success: false,
          message: "Username already taken"
        });
      }
    }

    const updateData = {};
    if (full_name) updateData.full_name = full_name;
    if (username) updateData.username = username;

    if (Object.keys(updateData).length === 0) {
      conn.release();
      return res.status(400).json({
        success: false,
        message: "No data to update"
      });
    }

    const [result] = await conn.query(
      'UPDATE admin_users SET ? WHERE id = ?',
      [updateData, req.user.id]
    );

    conn.release();

    return res.json({
      success: true,
      message: "Profile updated successfully",
      data: updateData
    });

  } catch (err) {
    console.error("Profile update error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to update profile",
      error: err.message
    });
  }
});

// Change password (authenticated)
router.post("/change-password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current and new passwords are required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters"
      });
    }

    const conn = await pool.getConnection();

    // Get current password
    const [userRows] = await conn.query(
      'SELECT password FROM admin_users WHERE id = ?',
      [req.user.id]
    );

    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = userRows[0];

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    
    if (!isPasswordValid) {
      conn.release();
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect"
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await conn.query(
      'UPDATE admin_users SET password = ? WHERE id = ?',
      [hashedPassword, req.user.id]
    );

    conn.release();

    return res.json({
      success: true,
      message: "Password changed successfully"
    });

  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to change password",
      error: err.message
    });
  }
});

module.exports = {
  router,
  authenticateToken
};