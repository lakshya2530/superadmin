const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");

// Helper function to generate log ID
function generateLogId(prefix = "audit") {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 6);
    return `${prefix}-${timestamp}-${random}`;
}

// Helper function to format timestamp
function formatTimestamp(date) {
    const options = { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
    };
    return date.toLocaleDateString('en-US', options);
}

// Get all audit logs with filters
router.get("/", async (req, res) => {
    try {
        const {
            entity_type,
            action_type,
            admin_id,
            admin_role,
            start_date,
            end_date,
            search,
            page = 1,
            limit = 10,
            sort_by = 'timestamp',
            sort_order = 'DESC'
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                al.*,
                au.username as admin_username,
                au.email as admin_email,
                au.full_name as admin_full_name
            FROM audit_logs al
            LEFT JOIN admin_users au ON al.admin_id = au.id
            WHERE 1=1
        `;
        const params = [];

        // Apply filters
        if (entity_type) {
            query += " AND al.entity_type = ?";
            params.push(entity_type);
        }

        if (action_type) {
            query += " AND al.action_type = ?";
            params.push(action_type);
        }

        if (admin_id) {
            query += " AND al.admin_id = ?";
            params.push(admin_id);
        }

        if (admin_role) {
            query += " AND al.admin_role = ?";
            params.push(admin_role);
        }

        if (start_date) {
            query += " AND DATE(al.timestamp) >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND DATE(al.timestamp) <= ?";
            params.push(end_date);
        }

        if (search) {
            query += " AND (al.entity_id LIKE ? OR al.details LIKE ? OR au.username LIKE ? OR au.full_name LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        // Get total count
        const countQuery = query.replace(
            'SELECT al.*, au.username as admin_username, au.email as admin_email, au.full_name as admin_full_name',
            'SELECT COUNT(*) as total'
        );
        const [countResult] = await conn.query(countQuery, params);
        const total = countResult[0].total;

        // Apply sorting and pagination
        query += ` ORDER BY al.${sort_by} ${sort_order} LIMIT ? OFFSET ?`;
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        conn.release();

        // Format timestamps
        const formattedRows = rows.map(row => ({
            ...row,
            formatted_timestamp: formatTimestamp(new Date(row.timestamp)),
            formatted_created_at: formatTimestamp(new Date(row.created_at))
        }));

        return res.json({
            success: true,
            data: formattedRows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                total_pages: Math.ceil(total / limit)
            }
        });

    } catch (err) {
        console.error("Audit logs fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch audit logs",
            error: err.message
        });
    }
});

// Get audit log by ID
router.get("/:id", async (req, res) => {
    try {
        const logId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(`
            SELECT 
                al.*,
                au.username as admin_username,
                au.email as admin_email,
                au.full_name as admin_full_name,
                au.role as admin_role
            FROM audit_logs al
            LEFT JOIN admin_users au ON al.admin_id = au.id
            WHERE al.log_id = ? OR al.id = ?
        `, [logId, logId]);

        conn.release();

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Audit log not found"
            });
        }

        const log = rows[0];
        log.formatted_timestamp = formatTimestamp(new Date(log.timestamp));
        log.formatted_created_at = formatTimestamp(new Date(log.created_at));

        return res.json({
            success: true,
            data: log
        });

    } catch (err) {
        console.error("Audit log fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch audit log",
            error: err.message
        });
    }
});

// Create audit log entry
router.post("/", async (req, res) => {
    try {
        const {
            entity_type,
            entity_id,
            action_type,
            admin_id,
            admin_role = 'Administrator',
            admin_name,
            ip_address,
            details
        } = req.body;

        // Validate required fields
        if (!entity_type || !entity_id || !action_type || !admin_id) {
            return res.status(400).json({
                success: false,
                message: "entity_type, entity_id, action_type, and admin_id are required"
            });
        }

        const conn = await pool.getConnection();
        const logId = generateLogId();

        const [result] = await conn.query(`
            INSERT INTO audit_logs (
                log_id,
                entity_type,
                entity_id,
                action_type,
                admin_id,
                admin_role,
                admin_name,
                ip_address,
                details,
                timestamp,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `, [
            logId,
            entity_type,
            entity_id,
            action_type,
            admin_id,
            admin_role,
            admin_name,
            ip_address,
            details
        ]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Audit log created successfully",
            data: {
                id: result.insertId,
                log_id: logId,
                entity_type,
                entity_id,
                action_type,
                timestamp: new Date().toISOString()
            }
        });

    } catch (err) {
        console.error("Audit log creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create audit log",
            error: err.message
        });
    }
});

// Get dashboard statistics
router.get("/dashboard/overview", async (req, res) => {
    try {
        const { period = 'today' } = req.query;
        const conn = await pool.getConnection();

        let dateFilter = '';
        const params = [];
        
        switch (period) {
            case 'today':
                dateFilter = 'DATE(timestamp) = CURDATE()';
                break;
            case 'week':
                dateFilter = 'timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
                break;
            case 'month':
                dateFilter = 'timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
                break;
            case 'year':
                dateFilter = 'timestamp >= DATE_SUB(NOW(), INTERVAL 365 DAY)';
                break;
        }

        // Get total logs count
        const totalQuery = dateFilter ? 
            `SELECT COUNT(*) as total FROM audit_logs WHERE ${dateFilter}` :
            'SELECT COUNT(*) as total FROM audit_logs';
        
        const [totalResult] = await conn.query(totalQuery, params);

        // Get today's activity
        const [todayResult] = await conn.query(
            'SELECT COUNT(*) as count FROM audit_logs WHERE DATE(timestamp) = CURDATE()'
        );

        // Get create/update actions count
        const createUpdateQuery = dateFilter ?
            `SELECT COUNT(*) as count FROM audit_logs WHERE ${dateFilter} AND action_type IN ('Plan Updated', 'Tenant Created', 'Invoice Created', 'User Created', 'User Updated')` :
            `SELECT COUNT(*) as count FROM audit_logs WHERE action_type IN ('Plan Updated', 'Tenant Created', 'Invoice Created', 'User Created', 'User Updated')`;
        
        const [createUpdateResult] = await conn.query(createUpdateQuery, params);

        // Get critical actions count
        const criticalQuery = dateFilter ?
            `SELECT COUNT(*) as count FROM audit_logs WHERE ${dateFilter} AND action_type IN ('Tenant Suspended', 'User Deleted', 'Critical Action')` :
            `SELECT COUNT(*) as count FROM audit_logs WHERE action_type IN ('Tenant Suspended', 'User Deleted', 'Critical Action')`;
        
        const [criticalResult] = await conn.query(criticalQuery, params);

        // Get activity by entity type
        const [entityStats] = await conn.query(`
            SELECT 
                entity_type,
                COUNT(*) as count,
                COUNT(DISTINCT admin_id) as unique_admins
            FROM audit_logs
            ${dateFilter ? `WHERE ${dateFilter}` : ''}
            GROUP BY entity_type
            ORDER BY count DESC
            LIMIT 5
        `, params);

        // Get recent activities
        const [recentActivities] = await conn.query(`
            SELECT 
                al.*,
                au.username as admin_username
            FROM audit_logs al
            LEFT JOIN admin_users au ON al.admin_id = au.id
            ORDER BY al.timestamp DESC
            LIMIT 10
        `);

        conn.release();

        return res.json({
            success: true,
            data: {
                total_logs: totalResult[0].total,
                todays_activity: todayResult[0].count,
                create_update_actions: createUpdateResult[0].count,
                critical_actions: criticalResult[0].count,
                entity_statistics: entityStats,
                recent_activities: recentActivities.map(log => ({
                    ...log,
                    formatted_timestamp: formatTimestamp(new Date(log.timestamp))
                })),
                period: period
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

// Get logs by entity
router.get("/entity/:entity_type/:entity_id", async (req, res) => {
    try {
        const { entity_type, entity_id } = req.params;
        const { limit = 50 } = req.query;

        const conn = await pool.getConnection();

        const [rows] = await conn.query(`
            SELECT 
                al.*,
                au.username as admin_username,
                au.full_name as admin_full_name
            FROM audit_logs al
            LEFT JOIN admin_users au ON al.admin_id = au.id
            WHERE al.entity_type = ? AND al.entity_id = ?
            ORDER BY al.timestamp DESC
            LIMIT ?
        `, [entity_type, entity_id, parseInt(limit)]);

        conn.release();

        const formattedRows = rows.map(row => ({
            ...row,
            formatted_timestamp: formatTimestamp(new Date(row.timestamp))
        }));

        return res.json({
            success: true,
            data: formattedRows,
            count: formattedRows.length
        });

    } catch (err) {
        console.error("Entity logs fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch entity logs",
            error: err.message
        });
    }
});

// Get activity by admin
router.get("/admin/:admin_id/activity", async (req, res) => {
    try {
        const adminId = req.params.admin_id;
        const { start_date, end_date } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                al.*,
                au.username as admin_username
            FROM audit_logs al
            LEFT JOIN admin_users au ON al.admin_id = au.id
            WHERE al.admin_id = ?
        `;
        const params = [adminId];

        if (start_date) {
            query += " AND DATE(al.timestamp) >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND DATE(al.timestamp) <= ?";
            params.push(end_date);
        }

        query += " ORDER BY al.timestamp DESC LIMIT 100";

        const [rows] = await conn.query(query, params);

        // Get admin stats
        const [stats] = await conn.query(`
            SELECT 
                COUNT(*) as total_actions,
                COUNT(DISTINCT entity_type) as entity_types_accessed,
                MIN(timestamp) as first_action,
                MAX(timestamp) as last_action,
                COUNT(DISTINCT DATE(timestamp)) as active_days
            FROM audit_logs
            WHERE admin_id = ?
        `, [adminId]);

        conn.release();

        const formattedRows = rows.map(row => ({
            ...row,
            formatted_timestamp: formatTimestamp(new Date(row.timestamp))
        }));

        return res.json({
            success: true,
            data: formattedRows,
            stats: stats[0],
            count: formattedRows.length
        });

    } catch (err) {
        console.error("Admin activity fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch admin activity",
            error: err.message
        });
    }
});

// Search audit logs
router.get("/search/:query", async (req, res) => {
    try {
        const searchQuery = req.params.query;
        const { limit = 20 } = req.query;

        const conn = await pool.getConnection();

        const [rows] = await conn.query(`
            SELECT 
                al.*,
                au.username as admin_username,
                au.full_name as admin_full_name
            FROM audit_logs al
            LEFT JOIN admin_users au ON al.admin_id = au.id
            WHERE 
                al.details LIKE ? OR
                al.entity_id LIKE ? OR
                au.username LIKE ? OR
                au.full_name LIKE ? OR
                al.action_type LIKE ?
            ORDER BY al.timestamp DESC
            LIMIT ?
        `, [
            `%${searchQuery}%`,
            `%${searchQuery}%`,
            `%${searchQuery}%`,
            `%${searchQuery}%`,
            `%${searchQuery}%`,
            parseInt(limit)
        ]);

        conn.release();

        const formattedRows = rows.map(row => ({
            ...row,
            formatted_timestamp: formatTimestamp(new Date(row.timestamp))
        }));

        return res.json({
            success: true,
            data: formattedRows,
            count: formattedRows.length,
            query: searchQuery
        });

    } catch (err) {
        console.error("Audit log search error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to search audit logs",
            error: err.message
        });
    }
});

router.get("/export/csv", async (req, res) => {
    try {
        const {
            entity_type,
            action_type,
            start_date,
            end_date
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                al.log_id,
                al.entity_type,
                al.entity_id,
                al.action_type,
                al.admin_id,
                al.admin_role,
                al.admin_name,
                al.ip_address,
                al.details,
                al.timestamp,
                au.username as admin_username,
                au.email as admin_email
            FROM audit_logs al
            LEFT JOIN admin_users au ON al.admin_id = au.id
            WHERE 1=1
        `;
        const params = [];

        if (entity_type) {
            query += " AND al.entity_type = ?";
            params.push(entity_type);
        }

        if (action_type) {
            query += " AND al.action_type = ?";
            params.push(action_type);
        }

        if (start_date) {
            query += " AND DATE(al.timestamp) >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND DATE(al.timestamp) <= ?";
            params.push(end_date);
        }

        query += " ORDER BY al.timestamp DESC";

        const [rows] = await conn.query(query, params);
        conn.release();

        const headers = [
            'Log ID', 'Entity Type', 'Entity ID', 'Action Type', 
            'Admin ID', 'Admin Role', 'Admin Name', 'IP Address',
            'Details', 'Timestamp', 'Admin Username', 'Admin Email'
        ];

        const csvRows = rows.map(row => [
            row.log_id,
            row.entity_type,
            row.entity_id,
            row.action_type,
            row.admin_id,
            row.admin_role,
            row.admin_name || '',
            row.ip_address || '',
            row.details || '',
            new Date(row.timestamp).toISOString(),
            row.admin_username || '',
            row.admin_email || ''
        ]);

        const csvContent = [
            headers.join(','),
            ...csvRows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        res.header('Content-Type', 'text/csv');
        res.header('Content-Disposition', `attachment; filename=audit_logs_${Date.now()}.csv`);
        res.send(csvContent);

    } catch (err) {
        console.error("Audit log export error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to export audit logs",
            error: err.message
        });
    }
});

router.post("/filters/save", async (req, res) => {
    try {
        const { filter_name, filters, is_global = false } = req.body;
        const user_id = req.user?.id || 1; 

        if (!filter_name || !filters) {
            return res.status(400).json({
                success: false,
                message: "filter_name and filters are required"
            });
        }

        const conn = await pool.getConnection();

        const [result] = await conn.query(`
            INSERT INTO audit_log_filters (filter_name, user_id, filters, is_global)
            VALUES (?, ?, ?, ?)
        `, [filter_name, user_id, JSON.stringify(filters), is_global]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Filter saved successfully",
            data: {
                id: result.insertId,
                filter_name,
                filters
            }
        });

    } catch (err) {
        console.error("Filter save error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to save filter",
            error: err.message
        });
    }
});

router.get("/filters/list", async (req, res) => {
    try {
        const user_id = req.user?.id || 1;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(`
            SELECT * FROM audit_log_filters 
            WHERE user_id = ? OR is_global = true
            ORDER BY created_at DESC
        `, [user_id]);

        conn.release();

        const filters = rows.map(row => ({
            ...row,
            filters: JSON.parse(row.filters)
        }));

        return res.json({
            success: true,
            data: filters,
            count: filters.length
        });

    } catch (err) {
        console.error("Filters fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch filters",
            error: err.message
        });
    }
});

const logAdminAction = async (req, res, next) => {
    // Skip logging for GET requests
    if (req.method === 'GET') {
        return next();
    }

    try {
        const admin_id = req.user?.id || 1; 
        const admin_role = req.user?.role || 'Super Administrator';
        const admin_name = req.user?.name || 'System';
        const ip_address = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;        
        const entity_type = req.body.entity_type || req.params.entity_type || 'System';
        const entity_id = req.body.entity_id || req.params.id || 'system';        
        let action_type = 'System Action';
        switch (req.method) {
            case 'POST':
                action_type = 'Created';
                break;
            case 'PUT':
            case 'PATCH':
                action_type = 'Updated';
                break;
            case 'DELETE':
                action_type = 'Deleted';
                break;
        }
        let details = `${req.method} ${req.originalUrl}`;
        if (req.body.details) {
            details = req.body.details;
        } else if (req.body.name || req.body.title) {
            details = `${action_type} ${entity_type}: ${req.body.name || req.body.title}`;
        }
        console.log(`Admin Action: ${admin_name} (${admin_role}) - ${action_type} ${entity_type} ${entity_id}`);
        

    } catch (err) {
        console.error("Action logging error:", err);
    }

    next();
};

router.use(logAdminAction);

module.exports = router;