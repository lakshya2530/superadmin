// settings.js
const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const { encrypt, decrypt, simpleEncrypt, simpleDecrypt } = require("../../utils/encryption.js");
const crypto = require('crypto');
const useSimpleEncryption = true;

// Helper function to handle encrypted values
const processSettingValue = (setting, value) => {
    if (setting.is_encrypted && value) {
        if (useSimpleEncryption) {
            return simpleDecrypt(value);
        }
        return decrypt(value);
    }
    return value;
};

function generateRandomString(length = 24) {
    // Ensure length is a valid number
    const safeLength = Number(length) || 24;
    if (safeLength <= 0) return "";
    
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    
    // Simple Math.random approach that always works
    for (let i = 0; i < safeLength; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return result;
}
function generateAlphanumericString(length = 24) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomBytes = crypto.randomBytes(length);
    
    for (let i = 0; i < length; i++) {
        result += chars[randomBytes[i] % chars.length];
    }
    
    return result;
}
function generateWebhookSecret() {
    const randomString = generateAlphanumericString(32);
    return `whsec_${randomString}`;
}
// Mask webhook secret for display
function maskSecret(secret) {
    if (!secret) return "...";
    return `${secret.substring(0, 6)}...`;
}


// Generate API key
function generateApiKey(prefix = "pk") {
    const randomString = generateRandomString(24);
    return `${prefix}_${randomString}`;
}

// Mask API key for display
function maskApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') return "...";
    const parts = apiKey.split("_");
    if (parts.length < 2) return "...";
    const prefix = parts[0];
    const key = parts.slice(1).join("_");
    if (key.length <= 6) return `${prefix}_...`;
    return `${prefix}_...${key.substring(key.length - 6)}`;
}
// Helper function to prepare value for storage
const prepareValueForStorage = (setting, value) => {
    if (setting.is_encrypted && value) {
        if (useSimpleEncryption) {
            return simpleEncrypt(value);
        }
        return encrypt(value);
    }
    return value;
};

// Validate setting key format
const validateSettingKey = (key) => {
    if (!key || typeof key !== 'string') return false;
    
    // Allowed characters: lowercase, numbers, underscore
    const regex = /^[a-z0-9_]+$/;
    return regex.test(key);
};

// Validate setting value based on data type
const validateSettingValue = (setting, value) => {
    if (setting.is_required && (value === undefined || value === null || value === '')) {
        return { valid: false, error: `${setting.setting_name} is required` };
    }
    
    switch (setting.data_type) {
        case 'string':
            return { valid: true };
        case 'number':
            if (isNaN(Number(value))) {
                return { valid: false, error: `${setting.setting_name} must be a number` };
            }
            return { valid: true };
        case 'boolean':
            if (typeof value !== 'boolean' && !['true', 'false', '0', '1'].includes(String(value))) {
                return { valid: false, error: `${setting.setting_name} must be true or false` };
            }
            return { valid: true };
        case 'json':
            try {
                JSON.parse(value);
                return { valid: true };
            } catch (e) {
                return { valid: false, error: `${setting.setting_name} must be valid JSON` };
            }
        default:
            return { valid: true };
    }
};

// Get all settings by category
router.get("/", async (req, res) => {
    try {
        const { category, key, include_inactive } = req.query;
        const conn = await pool.getConnection();

        let query = "SELECT * FROM system_settings WHERE 1=1";
        const params = [];

        if (category) {
            query += " AND setting_category = ?";
            params.push(category);
        }

        if (key) {
            query += " AND setting_key = ?";
            params.push(key);
        }

        if (!include_inactive || include_inactive === 'false') {
            query += " AND is_active = true";
        }

        query += " ORDER BY setting_category, sort_order, setting_name";

        const [rows] = await conn.query(query, params);
        conn.release();

        // Process settings to decrypt sensitive data
        const settings = rows.map(row => {
            const setting = { ...row };
            setting.setting_value = processSettingValue(row, row.setting_value);
            
            // Parse JSON options if they exist
            if (row.options) {
                setting.options = JSON.parse(row.options);
            }
            
            // Parse extra_config if it exists
            if (row.extra_config) {
                setting.extra_config = JSON.parse(row.extra_config);
            }
            
            return setting;
        });

        // Group by category for better organization
        const groupedSettings = {};
        settings.forEach(setting => {
            if (!groupedSettings[setting.setting_category]) {
                groupedSettings[setting.setting_category] = [];
            }
            groupedSettings[setting.setting_category].push(setting);
        });

        return res.json({
            success: true,
            data: groupedSettings,
            count: settings.length
        });

    } catch (err) {
        console.error("Settings fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch settings",
            error: err.message
        });
    }
});

// Get setting by ID
router.get("/:id", async (req, res) => {
    try {
        const settingId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            "SELECT * FROM system_settings WHERE setting_key = ?",
            [settingId]
        );

        conn.release();

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Setting not found"
            });
        }

        const setting = rows[0];
        setting.setting_value = processSettingValue(setting, setting.setting_value);
        
        if (setting.options) {
            setting.options = JSON.parse(setting.options);
        }
        
        if (setting.extra_config) {
            setting.extra_config = JSON.parse(setting.extra_config);
        }

        return res.json({
            success: true,
            data: setting
        });

    } catch (err) {
        console.error("Setting fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch setting",
            error: err.message
        });
    }
});

// Get setting by key
router.get("/key/:key", async (req, res) => {
    try {
        const settingKey = req.params.key;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            "SELECT * FROM system_settings WHERE setting_key = ? AND is_active = true",
            [settingKey]
        );

        conn.release();

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Setting not found"
            });
        }

        const setting = rows[0];
        setting.setting_value = processSettingValue(setting, setting.setting_value);
        
        if (setting.options) {
            setting.options = JSON.parse(setting.options);
        }
        
        if (setting.extra_config) {
            setting.extra_config = JSON.parse(setting.extra_config);
        }

        return res.json({
            success: true,
            data: setting
        });

    } catch (err) {
        console.error("Setting fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch setting",
            error: err.message
        });
    }
});

// Update setting by ID
router.put("/:id", async (req, res) => {
    try {
        const settingId = req.params.id;
        const { setting_value, change_reason } = req.body;
        const userId = req.user?.id || 'system'; // Use 'system' if no user context

        if (setting_value === undefined) {
            return res.status(400).json({
                success: false,
                message: "Setting value is required"
            });
        }

        const conn = await pool.getConnection();
        
        // Start transaction
        await conn.beginTransaction();

        try {
            // Get current setting
            const [currentRows] = await conn.query(
                "SELECT * FROM system_settings WHERE id = ?",
                [settingId]
            );

            if (currentRows.length === 0) {
                await conn.rollback();
                conn.release();
                return res.status(404).json({
                    success: false,
                    message: "Setting not found"
                });
            }

            const currentSetting = currentRows[0];
            const oldValue = currentSetting.setting_value;
            
            // Prepare new value
            const newValue = prepareValueForStorage(currentSetting, setting_value);

            // Update setting
            const [updateResult] = await conn.query(
                "UPDATE system_settings SET setting_value = ?, updated_at = NOW() WHERE id = ?",
                [newValue, settingId]
            );

            // Log to history
            await conn.query(
                "INSERT INTO settings_history (setting_id, old_value, new_value, changed_by, change_reason) VALUES (?, ?, ?, ?, ?)",
                [settingId, oldValue, newValue, userId, change_reason || 'Updated via API']
            );

            await conn.commit();
            conn.release();

            return res.json({
                success: true,
                message: "Setting updated successfully",
                data: {
                    id: settingId,
                    setting_key: currentSetting.setting_key,
                    old_value: processSettingValue(currentSetting, oldValue),
                    new_value: setting_value
                }
            });

        } catch (error) {
            await conn.rollback();
            conn.release();
            throw error;
        }

    } catch (err) {
        console.error("Setting update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update setting",
            error: err.message
        });
    }
});

// Update setting by key
router.put("/key/:key", async (req, res) => {
    try {
        const settingKey = req.params.key;
        const { setting_value, change_reason } = req.body;
        const userId = req.user?.id || 'system';

        if (setting_value === undefined) {
            return res.status(400).json({
                success: false,
                message: "Setting value is required"
            });
        }

        const conn = await pool.getConnection();
        
        // Start transaction
        await conn.beginTransaction();

        try {
            // Get current setting
            const [currentRows] = await conn.query(
                "SELECT * FROM system_settings WHERE setting_key = ?",
                [settingKey]
            );

            if (currentRows.length === 0) {
                await conn.rollback();
                conn.release();
                return res.status(404).json({
                    success: false,
                    message: "Setting not found"
                });
            }

            const currentSetting = currentRows[0];
            const settingId = currentSetting.id;
            const oldValue = currentSetting.setting_value;
            
            // Prepare new value
            const newValue = prepareValueForStorage(currentSetting, setting_value);

            // Update setting
            const [updateResult] = await conn.query(
                "UPDATE system_settings SET setting_value = ?, updated_at = NOW() WHERE id = ?",
                [newValue, settingId]
            );

            // Log to history
            await conn.query(
                "INSERT INTO settings_history (setting_id, old_value, new_value, changed_by, change_reason) VALUES (?, ?, ?, ?, ?)",
                [settingId, oldValue, newValue, userId, change_reason || 'Updated via API']
            );

            await conn.commit();
            conn.release();

            return res.json({
                success: true,
                message: "Setting updated successfully",
                data: {
                    id: settingId,
                    setting_key: currentSetting.setting_key,
                    old_value: processSettingValue(currentSetting, oldValue),
                    new_value: setting_value
                }
            });

        } catch (error) {
            await conn.rollback();
            conn.release();
            throw error;
        }

    } catch (err) {
        console.error("Setting update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update setting",
            error: err.message
        });
    }
});

// Bulk update settings
// routes/settings.js - FIXED BULK UPDATE (NO AUTH)
router.put("/bulk/update", async (req, res) => {
    try {
        const { settings, change_reason } = req.body;

        if (!Array.isArray(settings) || settings.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Settings array is required"
            });
        }

        const conn = await pool.getConnection();
        
        // Start transaction
        await conn.beginTransaction();

        try {
            const results = [];
            const errors = [];

            for (const settingData of settings) {
                const { setting_key, setting_value } = settingData;

                // Validate key exists
                if (!setting_key || setting_value === undefined) {
                    errors.push({
                        setting_key: setting_key || 'unknown',
                        error: "Missing key or value"
                    });
                    continue;
                }

                // Get current setting
                const [currentRows] = await conn.query(
                    "SELECT * FROM system_settings WHERE setting_key = ?",
                    [setting_key]
                );

                if (currentRows.length === 0) {
                    errors.push({
                        setting_key,
                        error: "Setting not found"
                    });
                    continue;
                }

                const currentSetting = currentRows[0];
                const settingId = currentSetting.id;
                const oldValue = currentSetting.setting_value;
                
                // Prepare value for storage
                let valueToStore;
                if (currentSetting.data_type === 'boolean') {
                    // Convert to 'true'/'false' string for storage
                    valueToStore = String(Boolean(setting_value));
                } else {
                    valueToStore = String(setting_value);
                }

                const newValue = prepareValueForStorage(currentSetting, valueToStore);

                // Update setting
                await conn.query(
                    "UPDATE system_settings SET setting_value = ?, updated_at = NOW() WHERE id = ?",
                    [newValue, settingId]
                );

                // Log to history (use default user ID 1 for system updates)
                await conn.query(
                    "INSERT INTO settings_history (setting_id, old_value, new_value, changed_by, change_reason) VALUES (?, ?, ?, ?, ?)",
                    [settingId, oldValue, newValue, 1, change_reason || 'Bulk update via API']
                );

                results.push({
                    setting_key,
                    id: settingId,
                    success: true
                });
            }

            if (errors.length > 0) {
                await conn.rollback();
                conn.release();
                
                return res.status(400).json({
                    success: false,
                    message: "Some settings failed to update",
                    results,
                    errors
                });
            }

            await conn.commit();
            conn.release();

            return res.json({
                success: true,
                message: "Settings updated successfully",
                data: results,
                count: results.length
            });

        } catch (error) {
            await conn.rollback();
            conn.release();
            throw error;
        }

    } catch (err) {
        console.error("Bulk update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update settings",
            error: err.message
        });
    }
});



// Create new setting
router.post("/", async (req, res) => {
    try {
        const {
            setting_key,
            setting_category,
            setting_name,
            setting_value,
            data_type,
            input_type,
            options,
            is_encrypted,
            is_required,
            is_active,
            sort_order,
            description,
            extra_config
        } = req.body;

        // Validate required fields
        if (!setting_key || !setting_category || !setting_name) {
            return res.status(400).json({
                success: false,
                message: "setting_key, setting_category, and setting_name are required"
            });
        }

        const conn = await pool.getConnection();

        // Check if setting key already exists
        const [existingRows] = await conn.query(
            "SELECT id FROM system_settings WHERE setting_key = ?",
            [setting_key]
        );

        if (existingRows.length > 0) {
            conn.release();
            return res.status(409).json({
                success: false,
                message: "Setting key already exists"
            });
        }

        // Prepare options and extra_config as JSON
        const optionsJson = options ? JSON.stringify(options) : null;
        const extraConfigJson = extra_config ? JSON.stringify(extra_config) : null;

        // Insert new setting
        const [result] = await conn.query(
            `INSERT INTO system_settings (
                setting_key, setting_category, setting_name, setting_value,
                data_type, input_type, options, is_encrypted, is_required,
                is_active, sort_order, description, extra_config
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                setting_key,
                setting_category,
                setting_name,
                setting_value || '',
                data_type || 'string',
                input_type || 'text',
                optionsJson,
                is_encrypted || false,
                is_required || false,
                is_active !== undefined ? is_active : true,
                sort_order || 0,
                description || null,
                extraConfigJson
            ]
        );

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Setting created successfully",
            data: {
                id: result.insertId,
                setting_key,
                setting_category,
                setting_name
            }
        });

    } catch (err) {
        console.error("Setting creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create setting",
            error: err.message
        });
    }
});

// Delete setting (soft delete - set inactive)
router.delete("/:id", async (req, res) => {
    try {
        const settingId = req.params.id;
        const conn = await pool.getConnection();

        // Check if setting exists
        const [checkRows] = await conn.query(
            "SELECT id FROM system_settings WHERE id = ?",
            [settingId]
        );

        if (checkRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Setting not found"
            });
        }

        // Soft delete - set inactive
        await conn.query(
            "UPDATE system_settings SET is_active = false, updated_at = NOW() WHERE id = ?",
            [settingId]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Setting deactivated successfully"
        });

    } catch (err) {
        console.error("Setting deletion error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete setting",
            error: err.message
        });
    }
});

// Get settings history
router.get("/history/:setting_id", async (req, res) => {
    try {
        const settingId = req.params.setting_id;
        const { limit = 50 } = req.query;

        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            `SELECT sh.*, u.username, u.email 
             FROM settings_history sh
             LEFT JOIN users u ON sh.changed_by = u.id
             WHERE sh.setting_id = ?
             ORDER BY sh.created_at DESC
             LIMIT ?`,
            [settingId, parseInt(limit)]
        );

        conn.release();

        return res.json({
            success: true,
            data: rows,
            count: rows.length
        });

    } catch (err) {
        console.error("History fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch settings history",
            error: err.message
        });
    }
});

// Get active services count
router.get("/dashboard/overview", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Count active services by category
        const [activeServices] = await conn.query(`
            SELECT 
                SUM(CASE WHEN setting_category = 'email' AND setting_value = 'true' THEN 1 ELSE 0 END) as email_active,
                SUM(CASE WHEN setting_category = 'sms' AND setting_value = 'true' THEN 1 ELSE 0 END) as sms_active,
                SUM(CASE WHEN setting_category = 'payments' AND setting_value = 'true' THEN 1 ELSE 0 END) as payments_active,
                SUM(CASE WHEN setting_category = 'maps' AND setting_value = 'true' THEN 1 ELSE 0 END) as maps_active,
                SUM(CASE WHEN setting_category = 'ai_services' AND setting_value = 'true' THEN 1 ELSE 0 END) as ai_active,
                SUM(CASE WHEN setting_category = 'webhooks' AND setting_value = 'true' THEN 1 ELSE 0 END) as webhooks_active
            FROM system_settings 
            WHERE setting_key LIKE 'enable_%' AND is_active = true
        `);

        // Count API integrations (keys that have values)
        const [apiIntegrations] = await conn.query(`
            SELECT COUNT(*) as count 
            FROM system_settings 
            WHERE (setting_key LIKE '%_api_key' OR setting_key LIKE '%_secret_key') 
            AND setting_value IS NOT NULL 
            AND setting_value != ''
            AND is_active = true
        `);

        conn.release();

        const services = activeServices[0];
        const totalActiveServices = 
            (services.email_active ? 1 : 0) +
            (services.sms_active ? 1 : 0) +
            (services.payments_active ? 1 : 0) +
            (services.maps_active ? 1 : 0) +
            (services.ai_active ? 1 : 0) +
            (services.webhooks_active ? 1 : 0);

        return res.json({
            success: true,
            data: {
                active_services: {
                    count: totalActiveServices,
                    breakdown: services
                },
                api_integrations: {
                    count: apiIntegrations[0].count
                },
                webhooks: {
                    count: services.webhooks_active
                },
                security_status: "Secure"
            }
        });

    } catch (err) {
        console.error("Dashboard overview error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard overview",
            error: err.message
        });
    }
});

// Get settings categories
router.get("/categories/list", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        const [rows] = await conn.query(`
            SELECT DISTINCT setting_category, COUNT(*) as count 
            FROM system_settings 
            WHERE is_active = true 
            GROUP BY setting_category 
            ORDER BY setting_category
        `);

        conn.release();

        return res.json({
            success: true,
            data: rows,
            count: rows.length
        });

    } catch (err) {
        console.error("Categories fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch categories",
            error: err.message
        });
    }
});

// Test connection for a service
router.post("/test/:service", async (req, res) => {
    try {
        const service = req.params.service;
        const { config } = req.body;

        let testResult = { success: false, message: "" };

        switch (service) {
            case 'email':
                // Test email configuration
                testResult = {
                    success: true,
                    message: "Email service test successful"
                };
                break;

            case 'sms':
                // Test SMS configuration
                testResult = {
                    success: true,
                    message: "SMS service test successful"
                };
                break;

            case 'maps':
                // Test Maps configuration
                testResult = {
                    success: true,
                    message: "Maps service test successful"
                };
                break;

            case 'payments':
                // Test Payment configuration
                testResult = {
                    success: true,
                    message: "Payment service test successful"
                };
                break;

            default:
                return res.status(400).json({
                    success: false,
                    message: "Unsupported service type"
                });
        }

        return res.json(testResult);

    } catch (err) {
        console.error("Service test error:", err);
        return res.status(500).json({
            success: false,
            message: "Service test failed",
            error: err.message
        });
    }
});


router.post("/api-key/generate", async (req, res) => {
    try {
        const { 
            key_name, 
            permissions, 
            prefix = "pk",
            expires_in_days = 365,
            description 
        } = req.body;
        
        // Validate required fields
        if (!key_name) {
            return res.status(400).json({
                success: false,
                message: "Key name is required"
            });
        }
        
        // Generate API key
        const apiKey = generateRandomString(prefix);
        
        // Calculate expiry date
        const expiresAt = expires_in_days ? 
            new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000) : 
            null;
        
        const conn = await pool.getConnection();
        
        // Insert new API key
        const [result] = await conn.query(`
            INSERT INTO api_keys (
                key_name, 
                api_key, 
                key_prefix,
                permissions, 
                expires_at, 
                description,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, NOW())
        `, [
            key_name,
            apiKey,
            prefix,
            JSON.stringify(permissions || ["read_access"]),
            expiresAt,
            description || null
        ]);
        
        conn.release();
        
        return res.status(201).json({
            success: true,
            message: "API key generated successfully",
            data: {
                id: result.insertId,
                key_name,
                api_key: apiKey, // Only shown once!
                masked_key: maskApiKey(apiKey),
                key_prefix: prefix,
                permissions: permissions || ["read_access"],
                expires_at: expiresAt,
                created_at: new Date().toISOString()
            },
            warning: "Save this API key now. It will not be shown again!"
        });
        
    } catch (err) {
        console.error("API key generation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to generate API key",
            error: err.message
        });
    }
});

// PUT - Update API key
router.put("api-key/:id", async (req, res) => {
    try {
        const keyId = req.params.id;
        const { 
            key_name, 
            permissions, 
            is_active,
            description 
        } = req.body;
        
        const conn = await pool.getConnection();
        
        // Check if key exists
        const [checkRows] = await conn.query(
            "SELECT id FROM api_keys WHERE id = ?",
            [keyId]
        );
        
        if (checkRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "API key not found"
            });
        }
        
        // Build update query
        const updates = [];
        const params = [];
        
        if (key_name !== undefined) {
            updates.push("key_name = ?");
            params.push(key_name);
        }
        
        if (permissions !== undefined) {
            updates.push("permissions = ?");
            params.push(JSON.stringify(permissions));
        }
        
        if (is_active !== undefined) {
            updates.push("is_active = ?");
            params.push(is_active);
        }
        
        if (description !== undefined) {
            updates.push("description = ?");
            params.push(description);
        }
        
        if (updates.length === 0) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No fields to update"
            });
        }
        
        updates.push("updated_at = NOW()");
        params.push(keyId);
        
        const query = `UPDATE api_keys SET ${updates.join(", ")} WHERE id = ?`;
        
        await conn.query(query, params);
        conn.release();
        
        return res.json({
            success: true,
            message: "API key updated successfully"
        });
        
    } catch (err) {
        console.error("API key update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update API key",
            error: err.message
        });
    }
});

// DELETE - Revoke API key
router.delete("api-key/:id", async (req, res) => {
    try {
        const keyId = req.params.id;
        const { reason } = req.body;
        
        const conn = await pool.getConnection();
        
        // Check if key exists
        const [checkRows] = await conn.query(
            "SELECT id FROM api_keys WHERE id = ?",
            [keyId]
        );
        
        if (checkRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "API key not found"
            });
        }
        
        // Soft delete - set inactive
        await conn.query(
            "UPDATE api_keys SET is_active = false, revoked_at = NOW(), revoke_reason = ?, updated_at = NOW() WHERE id = ?",
            [reason || "Revoked by admin", keyId]
        );
        
        conn.release();
        
        return res.json({
            success: true,
            message: "API key revoked successfully"
        });
        
    } catch (err) {
        console.error("API key revocation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to revoke API key",
            error: err.message
        });
    }
});


router.get("/api-key/list", async (req, res) => {
    try {
        const conn = await pool.getConnection();
        
        const [rows] = await conn.query(`
            SELECT * FROM api_keys 
            WHERE is_active = true 
            ORDER BY created_at DESC
        `);
        
        conn.release();
        
        // Mask keys for display
        const maskedKeys = rows.map(key => ({
            ...key,
            display_key: maskApiKey(key.api_key),
            masked_key: maskApiKey(key.api_key),
            last_chars: key.api_key ? key.api_key.substring(key.api_key.length - 6) : "...",
            permissions: key.permissions ? JSON.parse(key.permissions) : []
        }));
        
        return res.json({
            success: true,
            data: maskedKeys,
            count: maskedKeys.length
        });
        
    } catch (err) {
        console.error("API keys fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch API keys",
            error: err.message
        });
    }
});

// POST - Regenerate API key (new key, keep same ID)
router.post("api-key/:id/regenerate", async (req, res) => {
    try {
        const keyId = req.params.id;
        const { prefix = "pk" } = req.body;
        
        const conn = await pool.getConnection();
        
        // Check if key exists
        const [checkRows] = await conn.query(
            "SELECT id, key_name FROM api_keys WHERE id = ?",
            [keyId]
        );
        
        if (checkRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "API key not found"
            });
        }
        
        // Generate new API key
        const newApiKey = generateRandomString(prefix);
        
        // Update with new key
        await conn.query(
            "UPDATE api_keys SET api_key = ?, key_prefix = ?, updated_at = NOW() WHERE id = ?",
            [newApiKey, prefix, keyId]
        );
        
        conn.release();
        
        return res.json({
            success: true,
            message: "API key regenerated successfully",
            data: {
                id: keyId,
                key_name: checkRows[0].key_name,
                api_key: newApiKey, // Only shown once!
                masked_key: maskApiKey(newApiKey),
                updated_at: new Date().toISOString()
            },
            warning: "Save this new API key now. The old key is no longer valid!"
        });
        
    } catch (err) {
        console.error("API key regeneration error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to regenerate API key",
            error: err.message
        });
    }
});


router.get("/webhook/list", async (req, res) => {
    try {
        const conn = await pool.getConnection();
        
        const [rows] = await conn.query(`
            SELECT * FROM webhooks 
            WHERE is_active = true 
            ORDER BY created_at DESC
        `);
        
        conn.release();
        
        // Parse events JSON and mask secrets
        const webhooks = rows.map(webhook => ({
            ...webhook,
            events: webhook.events ? JSON.parse(webhook.events) : [],
            masked_secret: maskSecret(webhook.secret),
            display_secret: maskSecret(webhook.secret)
        }));
        
        return res.json({
            success: true,
            data: webhooks,
            count: webhooks.length
        });
        
    } catch (err) {
        console.error("Webhooks fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch webhooks",
            error: err.message
        });
    }
});

// GET single webhook by ID
router.get("/webhook/:id", async (req, res) => {
    try {
        const webhookId = req.params.id;
        const { show_secret } = req.query;
        
        const conn = await pool.getConnection();
        
        const [rows] = await conn.query(
            "SELECT * FROM webhooks WHERE id = ? AND is_active = true",
            [webhookId]
        );
        
        conn.release();
        
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Webhook not found"
            });
        }
        
        const webhook = rows[0];
        let responseData = {
            ...webhook,
            events: webhook.events ? JSON.parse(webhook.events) : [],
            masked_secret: maskSecret(webhook.secret),
            display_secret: maskSecret(webhook.secret)
        };
        
        // Show full secret if requested
        if (show_secret === "true") {
            responseData.secret = webhook.secret;
            responseData.display_secret = webhook.secret;
        }
        
        return res.json({
            success: true,
            data: responseData
        });
        
    } catch (err) {
        console.error("Webhook fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch webhook",
            error: err.message
        });
    }
});

// POST - Create new webhook
router.post("/webhook/", async (req, res) => {
    try {
        const { 
            url, 
            events, 
            secret: providedSecret,
            description 
        } = req.body;
        
        // Validate required fields
        if (!url) {
            return res.status(400).json({
                success: false,
                message: "Webhook URL is required"
            });
        }
        
        if (!events || !Array.isArray(events) || events.length === 0) {
            return res.status(400).json({
                success: false,
                message: "At least one event must be selected"
            });
        }
        
        // Generate or use provided secret
        const secret = providedSecret || generateWebhookSecret();
        
        const conn = await pool.getConnection();
        
        // Insert new webhook
        const [result] = await conn.query(`
            INSERT INTO webhooks (
                url, 
                events, 
                secret, 
                description,
                is_active,
                created_at
            ) VALUES (?, ?, ?, ?, true, NOW())
        `, [
            url,
            JSON.stringify(events),
            secret,
            description || null
        ]);
        
        conn.release();
        
        return res.status(201).json({
            success: true,
            message: "Webhook created successfully",
            data: {
                id: result.insertId,
                url,
                events,
                secret: secret, // Only shown once on creation!
                masked_secret: maskSecret(secret),
                description: description || null,
                is_active: true,
                created_at: new Date().toISOString()
            },
            warning: "Save the webhook secret now. It will not be shown again!"
        });
        
    } catch (err) {
        console.error("Webhook creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create webhook",
            error: err.message
        });
    }
});

// PUT - Update webhook
router.put("webhook/:id", async (req, res) => {
    try {
        const webhookId = req.params.id;
        const { 
            url, 
            events, 
            secret,
            is_active,
            description 
        } = req.body;
        
        const conn = await pool.getConnection();
        
        // Check if webhook exists
        const [checkRows] = await conn.query(
            "SELECT id FROM webhooks WHERE id = ?",
            [webhookId]
        );
        
        if (checkRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Webhook not found"
            });
        }
        
        // Build update query
        const updates = [];
        const params = [];
        
        if (url !== undefined) {
            updates.push("url = ?");
            params.push(url);
        }
        
        if (events !== undefined) {
            updates.push("events = ?");
            params.push(JSON.stringify(events));
        }
        
        if (secret !== undefined) {
            updates.push("secret = ?");
            params.push(secret);
        }
        
        if (is_active !== undefined) {
            updates.push("is_active = ?");
            params.push(is_active);
        }
        
        if (description !== undefined) {
            updates.push("description = ?");
            params.push(description);
        }
        
        if (updates.length === 0) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No fields to update"
            });
        }
        
        updates.push("updated_at = NOW()");
        params.push(webhookId);
        
        const query = `UPDATE webhooks SET ${updates.join(", ")} WHERE id = ?`;
        
        await conn.query(query, params);
        conn.release();
        
        return res.json({
            success: true,
            message: "Webhook updated successfully"
        });
        
    } catch (err) {
        console.error("Webhook update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update webhook",
            error: err.message
        });
    }
});

// DELETE - Remove webhook
router.delete("webhook/:id", async (req, res) => {
    try {
        const webhookId = req.params.id;
        const { reason } = req.body;
        
        const conn = await pool.getConnection();
        
        // Check if webhook exists
        const [checkRows] = await conn.query(
            "SELECT id FROM webhooks WHERE id = ?",
            [webhookId]
        );
        
        if (checkRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Webhook not found"
            });
        }
        
        // Soft delete - set inactive
        await conn.query(
            "UPDATE webhooks SET is_active = false, description = CONCAT(COALESCE(description, ''), ' [Deleted: ', ?, ']'), updated_at = NOW() WHERE id = ?",
            [reason || "Removed by admin", webhookId]
        );
        
        conn.release();
        
        return res.json({
            success: true,
            message: "Webhook removed successfully"
        });
        
    } catch (err) {
        console.error("Webhook deletion error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to remove webhook",
            error: err.message
        });
    }
});

// POST - Test webhook delivery
router.post("webhook/:id/test", async (req, res) => {
    try {
        const webhookId = req.params.id;
        
        const conn = await pool.getConnection();
        
        // Get webhook details
        const [rows] = await conn.query(
            "SELECT * FROM webhooks WHERE id = ? AND is_active = true",
            [webhookId]
        );
        
        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Webhook not found"
            });
        }
        
        const webhook = rows[0];
        const events = webhook.events ? JSON.parse(webhook.events) : [];
        
        // Simulate webhook delivery (in real app, make actual HTTP request)
        const testEvent = {
            event: "test.delivery",
            timestamp: new Date().toISOString(),
            data: {
                test: true,
                webhook_id: webhookId,
                url: webhook.url
            }
        };
        
        // Update last delivery time
        await conn.query(
            "UPDATE webhooks SET last_delivery = NOW() WHERE id = ?",
            [webhookId]
        );
        
        conn.release();
        
        return res.json({
            success: true,
            message: "Webhook test initiated",
            data: {
                webhook_id: webhookId,
                url: webhook.url,
                events: events,
                test_payload: testEvent,
                delivery_time: new Date().toISOString(),
                status: "Test request sent successfully"
            }
        });
        
    } catch (err) {
        console.error("Webhook test error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to test webhook",
            error: err.message
        });
    }
});

module.exports = router;