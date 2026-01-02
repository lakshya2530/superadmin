const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const profileUpload = require('./profileMulter');
const path = require('path');
const fs = require('fs');

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || '8f4a7d2c9b1e6a3f0d5c8b2a9e4f7d1c6b3a0e9f8d7c2b5a1e4f6c9b2d8a7e3f0';

router.use('/uploads/profiles', express.static(path.join(__dirname, '../uploads/profiles')));

// ==================== LOGIN FLOW API ====================

// Step 1: Send OTP to email (Without actual email sending)
router.post("/login/initiate", async (req, res) => {
  let conn;
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    conn = await pool.getConnection();

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

    // Generate OTP
    const otp = "123456";
    const otpExpire = new Date(Date.now() + 10 * 60000);

    // Store OTP
    await conn.query(
      'UPDATE admin_users SET otp = ?, otp_expire = ? WHERE id = ?',
      [otp, otpExpire.toISOString(), user.id]
    );

    console.log(`OTP for ${email}: ${otp}`);

    // Get email settings (all columns)
    const [emailSettingsRows] = await conn.query(
      'SELECT * FROM system_email_settings LIMIT 1'
    );
    
    let emailSettings = emailSettingsRows.length > 0 ? emailSettingsRows[0] : null;
    
    // Mask sensitive data in email settings
    if (emailSettings) {
      if (emailSettings.smtp_password) emailSettings.smtp_password = '••••••••';
      if (emailSettings.api_secret) emailSettings.api_secret = '••••••••';
      if (emailSettings.api_key) emailSettings.api_key = '••••••••';
    }

    // Get system service settings (all columns)
    const [systemSettingsRows] = await conn.query(
      'SELECT * FROM system_service_settings'
    );
    
    // Process system settings - parse JSON and mask sensitive data
    const systemSettings = systemSettingsRows.map(row => {
      const processedRow = { ...row };
      
      // Parse config_json if it exists
      if (processedRow.config_json) {
        try {
          // Parse the JSON string to object
          const configData = JSON.parse(processedRow.config_json);
          
          // Mask sensitive fields in the parsed JSON
          const maskSensitiveFields = (obj) => {
            if (!obj || typeof obj !== 'object') return obj;
            
            const maskedObj = { ...obj };
            Object.keys(maskedObj).forEach(key => {
              const lowerKey = key.toLowerCase();
              if (lowerKey.includes('password') || 
                  lowerKey.includes('secret') || 
                  lowerKey.includes('key') ||
                  lowerKey.includes('token') ||
                  lowerKey.includes('auth')) {
                if (maskedObj[key] && typeof maskedObj[key] === 'string' && maskedObj[key].length > 0) {
                  maskedObj[key] = '••••••••';
                }
              }
            });
            return maskedObj;
          };
          
          // Replace the config_json string with parsed and masked object
          processedRow.config_json = maskSensitiveFields(configData);
        } catch (parseError) {
          console.error(`Error parsing config_json for row ${row.id}:`, parseError);
          // If parsing fails, keep the original string
          processedRow.config_json = processedRow.config_json;
        }
      }
      
      return processedRow;
    });

    conn.release();

    // Return all data
    return res.json({
      success: true,
      message: "OTP generated successfully",
      data: {
        login: {
          email: email,
          user_id: user.id,
          otp: otp,
          otp_expires: otpExpire
        },
        email_settings: emailSettings,
        system_settings: systemSettings
      }
    });

  } catch (err) {
    console.error("Login initiation error:", err);
    if (conn) conn.release();
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

router.get('/admin-users', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const [users] = await conn.query(`
        SELECT 
            id, username, email, role, full_name, job_title,
            phone_number, location, timezone, bio, department,
            preferred_language, profile_picture, is_active,
            is_2fa_enabled, security_score, account_age_months,
            email_notifications, sms_notifications, push_notifications,
            system_alerts, security_alerts, weekly_reports,
            monthly_reports, new_tenant_signup, payment_received,
            support_tickets, last_login, created_at
        FROM admin_users
        WHERE is_active = 1
        ORDER BY created_at DESC
    `);
    
    conn.release();
    
    res.json({
        success: true,
        data: users
    });
  } catch (error) {
    console.error("Get admin users error:", error);
    if (conn) conn.release();
    res.status(500).json({
        success: false,
        message: 'Error fetching users',
        error: error.message
    });
  }
});

// Get single user by ID
router.get('/admin-users/:id', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const [user] = await conn.query(`
        SELECT 
            id, username, email, role, full_name, job_title,
            phone_number, location, timezone, bio, department,
            preferred_language, profile_picture, is_active,
            is_2fa_enabled, security_score, account_age_months,
            email_notifications, sms_notifications, push_notifications,
            system_alerts, security_alerts, weekly_reports,
            monthly_reports, new_tenant_signup, payment_received,
            support_tickets, last_login, created_at
        FROM admin_users
        WHERE id = ?
    `, [req.params.id]);
    
    conn.release();
    
    if (user.length === 0) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }
    
    res.json({
        success: true,
        data: user[0]
    });
  } catch (error) {
    console.error("Get admin user by ID error:", error);
    if (conn) conn.release();
    res.status(500).json({
        success: false,
        message: 'Error fetching user',
        error: error.message
    });
  }
});

router.put('/admin-users/:id', profileUpload.single('profile_picture'), async (req, res) => {
  let conn;
  try {
    const userId = parseInt(req.params.id);
    
    const {
        full_name, job_title, phone_number, location, timezone,
        bio, department, preferred_language
    } = req.body;
    
    conn = await pool.getConnection();
    
    // FIRST: Check if user exists
    const [userCheck] = await conn.query(
      'SELECT id, profile_picture FROM admin_users WHERE id = ?',
      [userId]
    );
    
    if (userCheck.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Get current profile picture for deletion
    const currentProfilePicture = userCheck[0].profile_picture;
    
    let profilePicture = null;
    
    // Handle profile picture upload
    if (req.file) {
      // Generate full URL for the uploaded file
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const relativePath = `/uploads/profiles/${req.file.filename}`;
      profilePicture = `${baseUrl}${relativePath}`;
      
      // Delete old profile picture if exists
      if (currentProfilePicture) {
        const oldFilename = currentProfilePicture.split('/').pop();
        const oldFilePath = path.join(__dirname, '../uploads/profiles', oldFilename);
        
        if (fs.existsSync(oldFilePath)) {
          fs.unlink(oldFilePath, (err) => {
            if (err) console.error('Error deleting old profile picture:', err);
          });
        }
      }
    }
    
    // Update user profile
    await conn.query(`
        UPDATE admin_users SET
            full_name = COALESCE(?, full_name),
            job_title = COALESCE(?, job_title),
            phone_number = COALESCE(?, phone_number),
            location = COALESCE(?, location),
            timezone = COALESCE(?, timezone),
            bio = COALESCE(?, bio),
            department = COALESCE(?, department),
            preferred_language = COALESCE(?, preferred_language),
            profile_picture = COALESCE(?, profile_picture)
        WHERE id = ?
    `, [
        full_name, job_title, phone_number, location, timezone,
        bio, department, preferred_language, profilePicture,
        userId
    ]);
    
    // Log the activity - ONLY AFTER confirming user exists
    await conn.query(`
        INSERT INTO admin_activity_log (admin_user_id, activity_type, description)
        VALUES (?, ?, ?)
    `, [userId, 'profile_update', 'Updated personal profile information']);
    
    conn.release();
    
    res.json({
        success: true,
        message: 'Profile updated successfully',
        data: {
            profile_picture: profilePicture,
            user_id: userId
        }
    });
  } catch (error) {
    console.error("Update admin user error:", error);
    if (conn) conn.release();
    
    // Handle foreign key constraint error specifically
    if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID. User does not exist.',
        error: error.message
      });
    }
    
    // Handle multer errors
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 5MB'
      });
    }
    
    if (error.message && error.message.includes('Only image files')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file type. Only JPG, PNG, GIF, and WebP images are allowed'
      });
    }
    
    res.status(500).json({
        success: false,
        message: 'Error updating profile',
        error: error.message
    });
  }
});
router.post('/admin-users/:id/upload-profile', profileUpload.single('profile_picture'), async (req, res) => {
  let conn;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }
    
    conn = await pool.getConnection();
    
    // Get current user to check existing profile picture
    const [currentUserRows] = await conn.query(
      'SELECT profile_picture FROM admin_users WHERE id = ?',
      [req.params.id]
    );
    
    // Generate full URL for the uploaded file
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const relativePath = `/uploads/profiles/${req.file.filename}`;
    const profilePictureUrl = `${baseUrl}${relativePath}`;
    
    // Delete old profile picture if exists
    if (currentUserRows.length > 0 && currentUserRows[0].profile_picture) {
      const oldPicturePath = currentUserRows[0].profile_picture;
      const oldFilename = oldPicturePath.split('/').pop();
      const oldFilePath = path.join(__dirname, '../uploads/profiles', oldFilename);
      
      if (fs.existsSync(oldFilePath)) {
        fs.unlink(oldFilePath, (err) => {
          if (err) console.error('Error deleting old profile picture:', err);
        });
      }
    }
    
    // Update profile picture in database
    await conn.query(
      'UPDATE admin_users SET profile_picture = ? WHERE id = ?',
      [profilePictureUrl, req.params.id]
    );
    
    // Log the activity
    await conn.query(`
        INSERT INTO admin_activity_log (admin_user_id, activity_type, description)
        VALUES (?, ?, ?)
    `, [req.params.id, 'profile_picture_update', 'Updated profile picture']);
    
    conn.release();
    
    res.json({
      success: true,
      message: 'Profile picture uploaded successfully',
      data: {
        profile_picture: profilePictureUrl,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype
      }
    });
    
  } catch (error) {
    console.error("Profile upload error:", error);
    if (conn) conn.release();
    
    // Handle multer errors
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 5MB'
      });
    }
    
    if (error.message && error.message.includes('Only image files')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file type. Only JPG, PNG, GIF, and WebP images are allowed'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Error uploading profile picture',
      error: error.message
    });
  }
});

// Delete profile picture
router.delete('/admin-users/:id/profile-picture', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    
    // Get current profile picture
    const [userRows] = await conn.query(
      'SELECT profile_picture FROM admin_users WHERE id = ?',
      [req.params.id]
    );
    
    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const profilePicture = userRows[0].profile_picture;
    
    if (!profilePicture) {
      conn.release();
      return res.json({
        success: true,
        message: 'No profile picture to delete'
      });
    }
    
    // Extract filename from URL
    const filename = profilePicture.split('/').pop();
    const filePath = path.join(__dirname, '../uploads/profiles', filename);
    
    // Delete file from filesystem
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting profile picture:', err);
      });
    }
    
    // Update database to remove profile picture
    await conn.query(
      'UPDATE admin_users SET profile_picture = NULL WHERE id = ?',
      [req.params.id]
    );
    
    // Log the activity
    await conn.query(`
        INSERT INTO admin_activity_log (admin_user_id, activity_type, description)
        VALUES (?, ?, ?)
    `, [req.params.id, 'profile_picture_delete', 'Deleted profile picture']);
    
    conn.release();
    
    res.json({
      success: true,
      message: 'Profile picture deleted successfully'
    });
    
  } catch (error) {
    console.error("Delete profile picture error:", error);
    if (conn) conn.release();
    res.status(500).json({
      success: false,
      message: 'Error deleting profile picture',
      error: error.message
    });
  }
});

// Update notification preferences
router.put('/admin-users/:id/notifications', async (req, res) => {
  let conn;
  try {
    const {
        email_notifications, sms_notifications, push_notifications,
        system_alerts, security_alerts, weekly_reports,
        monthly_reports, new_tenant_signup, payment_received,
        support_tickets
    } = req.body;
    
    conn = await pool.getConnection();
    
    await conn.query(`
        UPDATE admin_users SET
            email_notifications = COALESCE(?, email_notifications),
            sms_notifications = COALESCE(?, sms_notifications),
            push_notifications = COALESCE(?, push_notifications),
            system_alerts = COALESCE(?, system_alerts),
            security_alerts = COALESCE(?, security_alerts),
            weekly_reports = COALESCE(?, weekly_reports),
            monthly_reports = COALESCE(?, monthly_reports),
            new_tenant_signup = COALESCE(?, new_tenant_signup),
            payment_received = COALESCE(?, payment_received),
            support_tickets = COALESCE(?, support_tickets)
        WHERE id = ?
    `, [
        email_notifications, sms_notifications, push_notifications,
        system_alerts, security_alerts, weekly_reports,
        monthly_reports, new_tenant_signup, payment_received,
        support_tickets, req.params.id
    ]);
    
    conn.release();
    
    res.json({
        success: true,
        message: 'Notification preferences updated'
    });
  } catch (error) {
    console.error("Update notifications error:", error);
    if (conn) conn.release();
    res.status(500).json({
        success: false,
        message: 'Error updating notifications',
        error: error.message
    });
  }
});

// Update security settings
router.put('/admin-users/:id/security', async (req, res) => {
  let conn;
  try {
    const { is_2fa_enabled, security_score } = req.body;
    
    conn = await pool.getConnection();
    
    await conn.query(`
        UPDATE admin_users SET
            is_2fa_enabled = COALESCE(?, is_2fa_enabled),
            security_score = COALESCE(?, security_score)
        WHERE id = ?
    `, [is_2fa_enabled, security_score, req.params.id]);
    
    conn.release();
    
    res.json({
        success: true,
        message: 'Security settings updated'
    });
  } catch (error) {
    console.error("Update security settings error:", error);
    if (conn) conn.release();
    res.status(500).json({
        success: false,
        message: 'Error updating security settings',
        error: error.message
    });
  }
});

router.get('/admin-users/:id/activity-log', async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const [activities] = await conn.query(`
        SELECT activity_type, description, created_at
        FROM admin_activity_log
        WHERE admin_user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
    `, [req.params.id]);
    
    conn.release();
    
    res.json({
        success: true,
        data: activities
    });
  } catch (error) {
    console.error("Get activity log error:", error);
    if (conn) conn.release();
    res.status(500).json({
        success: false,
        message: 'Error fetching activity log',
        error: error.message
    });
  }
});

// Add activity log
router.post('/admin-users/:id/activity-log', async (req, res) => {
  let conn;
  try {
    const { activity_type, description } = req.body;
    
    conn = await pool.getConnection();
    
    await conn.query(`
        INSERT INTO admin_activity_log (admin_user_id, activity_type, description)
        VALUES (?, ?, ?)
    `, [req.params.id, activity_type, description]);
    
    conn.release();
    
    res.json({
        success: true,
        message: 'Activity logged successfully'
    });
  } catch (error) {
    console.error("Add activity log error:", error);
    if (conn) conn.release();
    res.status(500).json({
        success: false,
        message: 'Error logging activity',
        error: error.message
    });
  }
});

// Get user stats/dashboard data
router.get('/admin-users/:id/stats', async (req, res) => {
  let conn;
  try {
    const userId = req.params.id;
    
    conn = await pool.getConnection();
    
    // Get basic user info
    const [userRows] = await conn.query(`
        SELECT 
            id, username, email, role, full_name, job_title,
            phone_number, location, timezone, bio, department,
            preferred_language, profile_picture, is_active,
            is_2fa_enabled, security_score, account_age_months,
            email_notifications, sms_notifications, push_notifications,
            system_alerts, security_alerts, weekly_reports,
            monthly_reports, new_tenant_signup, payment_received,
            support_tickets, last_login, created_at
        FROM admin_users 
        WHERE id = ? AND is_active = 1
    `, [userId]);
    
    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found or inactive"
      });
    }
    
    const user = userRows[0];
    
    // Get activity count for last month
    const [activityCountRows] = await conn.query(`
        SELECT COUNT(*) as activity_count
        FROM admin_activity_log 
        WHERE admin_user_id = ? 
        AND created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
    `, [userId]);
    
    // Get recent activities (last 5)
    const [recentActivitiesRows] = await conn.query(`
        SELECT activity_type, description, created_at
        FROM admin_activity_log
        WHERE admin_user_id = ?
        ORDER BY created_at DESC
        LIMIT 5
    `, [userId]);
    
    // Calculate active sessions (example - you might have a separate sessions table)
    const activeSessions = 3; // Default value or calculate from sessions table
    
    conn.release();
    
    res.json({
      success: true,
      data: {
        user_profile: user,
        stats: {
          active_sessions: activeSessions,
          account_age: user.account_age_months,
          last_login: user.last_login,
          security_score: user.security_score,
          recent_activities_count: activityCountRows[0]?.activity_count || 0
        },
        recent_activities: recentActivitiesRows
      }
    });
    
  } catch (error) {
    console.error("Get user stats error:", error);
    if (conn) conn.release();
    res.status(500).json({
      success: false,
      message: 'Error fetching user stats',
      error: error.message
    });
  }
});

// Update password
router.put('/admin-users/:id/password', async (req, res) => {
  let conn;
  try {
    const { current_password, new_password } = req.body;
    
    if (!current_password || !new_password) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required"
      });
    }
    
    conn = await pool.getConnection();
    
    // First verify current password
    const [userRows] = await conn.query(
      'SELECT password FROM admin_users WHERE id = ?',
      [req.params.id]
    );
    
    if (userRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }
    
    const user = userRows[0];
    // Verify current password using bcrypt (example)
    // const isPasswordValid = await bcrypt.compare(current_password, user.password);
    
    // For now, using a simple comparison (replace with bcrypt in production)
    if (current_password !== "valid_password_check") {
      conn.release();
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect"
      });
    }
    
    // Hash new password (using bcrypt in production)
    // const hashedPassword = await bcrypt.hash(new_password, 10);
    const hashedPassword = new_password; // Replace with actual hash
    
    // Update password
    await conn.query(
      'UPDATE admin_users SET password = ? WHERE id = ?',
      [hashedPassword, req.params.id]
    );
    
    conn.release();
    
    res.json({
      success: true,
      message: 'Password updated successfully'
    });
    
  } catch (error) {
    console.error("Update password error:", error);
    if (conn) conn.release();
    res.status(500).json({
      success: false,
      message: 'Error updating password',
      error: error.message
    });
  }
});

// Update 2FA status
router.put('/admin-users/:id/2fa', async (req, res) => {
  let conn;
  try {
    const { is_2fa_enabled } = req.body;
    
    if (is_2fa_enabled === undefined) {
      return res.status(400).json({
        success: false,
        message: "2FA status is required"
      });
    }
    
    conn = await pool.getConnection();
    
    await conn.query(
      'UPDATE admin_users SET is_2fa_enabled = ? WHERE id = ?',
      [is_2fa_enabled ? 1 : 0, req.params.id]
    );
    
    conn.release();
    
    res.json({
      success: true,
      message: `2FA ${is_2fa_enabled ? 'enabled' : 'disabled'} successfully`
    });
    
  } catch (error) {
    console.error("Update 2FA error:", error);
    if (conn) conn.release();
    res.status(500).json({
      success: false,
      message: 'Error updating 2FA settings',
      error: error.message
    });
  }
});
module.exports = {
  router,
  authenticateToken
};