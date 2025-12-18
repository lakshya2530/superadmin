const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");

// Helper function to generate notification ID
function generateNotificationId(prefix = "notif") {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 6);
    return `${prefix}-${timestamp}-${random}`;
}

// Helper function to format timestamp
function formatTimestamp(date) {
    if (!date) return '';
    const options = { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
    };
    return new Date(date).toLocaleDateString('en-US', options);
}

// Helper function to parse metadata
function parseMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata === 'string') {
        try {
            return JSON.parse(metadata);
        } catch (e) {
            return {};
        }
    }
    return metadata || {};
}

// Get all notifications with filters
router.get("/", async (req, res) => {
    try {
        const {
            type,
            status,
            tenant_id,
            recipient_id,
            priority,
            start_date,
            end_date,
            search,
            page = 1,
            limit = 10,
            sort_by = 'created_at',
            sort_order = 'DESC'
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                n.*
            FROM notifications n
            WHERE 1=1
        `;
        const params = [];

        // Apply filters
        if (type && type !== 'All Types' && type !== 'all') {
            query += " AND n.type = ?";
            params.push(type);
        }

        if (status && status !== 'All Status' && status !== 'all') {
            query += " AND n.status = ?";
            params.push(status);
        }

        if (tenant_id) {
            query += " AND n.tenant_id = ?";
            params.push(tenant_id);
        }

        if (recipient_id) {
            query += " AND n.recipient_id = ?";
            params.push(recipient_id);
        }

        if (priority) {
            query += " AND n.priority = ?";
            params.push(priority);
        }

        if (start_date) {
            query += " AND DATE(n.created_at) >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND DATE(n.created_at) <= ?";
            params.push(end_date);
        }

        if (search) {
            query += " AND (n.title LIKE ? OR n.message LIKE ? OR n.metadata LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        // Get total count
        const countQuery = query.replace('SELECT n.*', 'SELECT COUNT(*) as total');
        const [countResult] = await conn.query(countQuery, params);
        const total = countResult[0].total;

        // Apply sorting and pagination
        const validSortColumns = ['id', 'notification_id', 'title', 'type', 'status', 'priority', 'created_at', 'read_at'];
        const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'created_at';
        const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        query += ` ORDER BY ${sortColumn} ${sortDirection} LIMIT ? OFFSET ?`;
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        conn.release();

        // Format timestamps and metadata
        const formattedRows = rows.map(row => ({
            ...row,
            formatted_created_at: formatTimestamp(row.created_at),
            formatted_read_at: row.read_at ? formatTimestamp(row.read_at) : null,
            formatted_archived_at: row.archived_at ? formatTimestamp(row.archived_at) : null,
            metadata: parseMetadata(row.metadata),
            is_new: row.status === 'unread' || row.status === 'new'
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
        console.error("Notifications fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch notifications",
            error: err.message
        });
    }
});

// Get notification statistics
router.get("/stats", async (req, res) => {
    try {
        const { period = 'today', recipient_id } = req.query;
        const conn = await pool.getConnection();

        let dateFilter = '';
        const params = [];
        
        if (recipient_id) {
            dateFilter = 'recipient_id = ?';
            params.push(recipient_id);
        }
        
        switch (period) {
            case 'today':
                dateFilter += (dateFilter ? ' AND ' : '') + 'DATE(created_at) = CURDATE()';
                break;
            case 'week':
                dateFilter += (dateFilter ? ' AND ' : '') + 'created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
                break;
            case 'month':
                dateFilter += (dateFilter ? ' AND ' : '') + 'created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
                break;
        }

        const whereClause = dateFilter ? `WHERE ${dateFilter}` : '';

        // Get total notifications count
        const [totalResult] = await conn.query(
            `SELECT COUNT(*) as total FROM notifications ${whereClause}`,
            params
        );

        // Get unread count
        const [unreadResult] = await conn.query(
            `SELECT COUNT(*) as count FROM notifications ${whereClause ? whereClause + ' AND ' : 'WHERE '} status = 'unread'`,
            params
        );

        // Get read count
        const [readResult] = await conn.query(
            `SELECT COUNT(*) as count FROM notifications ${whereClause ? whereClause + ' AND ' : 'WHERE '} status = 'read'`,
            params
        );

        // Get alerts count (high priority notifications)
        const [alertsResult] = await conn.query(
            `SELECT COUNT(*) as count FROM notifications ${whereClause ? whereClause + ' AND ' : 'WHERE '} priority IN ('high', 'critical')`,
            params
        );

        // Get notifications by type
        const [typeStats] = await conn.query(`
            SELECT 
                type,
                COUNT(*) as count
            FROM notifications
            ${whereClause}
            GROUP BY type
            ORDER BY count DESC
        `, params);

        // Get recent notifications
        const [recentNotifications] = await conn.query(`
            SELECT *
            FROM notifications
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT 10
        `);

        // Calculate percentage change from last month (simplified)
        const percentageChange = '0%';

        conn.release();

        return res.json({
            success: true,
            data: {
                total: totalResult[0].total,
                unread: unreadResult[0].count,
                read: readResult[0].count,
                alerts: alertsResult[0].count,
                type_stats: typeStats,
                recent_notifications: recentNotifications.map(notif => ({
                    ...notif,
                    formatted_created_at: formatTimestamp(notif.created_at),
                    metadata: parseMetadata(notif.metadata)
                })),
                percentage_change: percentageChange,
                period: period
            }
        });

    } catch (err) {
        console.error("Notifications stats error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch notification statistics",
            error: err.message
        });
    }
});

// Get notification by ID
router.get("/:id", async (req, res) => {
    try {
        const notificationId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            'SELECT * FROM notifications WHERE notification_id = ? OR id = ?',
            [notificationId, notificationId]
        );

        conn.release();

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Notification not found"
            });
        }

        const notification = rows[0];
        notification.formatted_created_at = formatTimestamp(notification.created_at);
        notification.formatted_read_at = notification.read_at ? formatTimestamp(notification.read_at) : null;
        notification.formatted_archived_at = notification.archived_at ? formatTimestamp(notification.archived_at) : null;
        notification.metadata = parseMetadata(notification.metadata);

        return res.json({
            success: true,
            data: notification
        });

    } catch (err) {
        console.error("Notification fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch notification",
            error: err.message
        });
    }
});

// Get unread notifications count for current user
router.get("/unread/count", async (req, res) => {
    try {
        const { recipient_id } = req.query;
        const conn = await pool.getConnection();

        let query = "SELECT COUNT(*) as count FROM notifications WHERE status = 'unread'";
        const params = [];

        if (recipient_id) {
            query += " AND recipient_id = ?";
            params.push(recipient_id);
        }

        const [result] = await conn.query(query, params);
        conn.release();

        return res.json({
            success: true,
            data: {
                unread_count: result[0].count
            }
        });

    } catch (err) {
        console.error("Unread count error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to get unread count",
            error: err.message
        });
    }
});

// Mark notification as read
router.post("/:id/read", async (req, res) => {
    try {
        const notificationId = req.params.id;
        const conn = await pool.getConnection();

        // Update notification status
        const [result] = await conn.query(`
            UPDATE notifications 
            SET status = 'read', read_at = NOW() 
            WHERE (notification_id = ? OR id = ?) AND (status = 'unread' OR status = 'new')
        `, [notificationId, notificationId]);

        conn.release();

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Notification not found or already read"
            });
        }

        return res.json({
            success: true,
            message: "Notification marked as read"
        });

    } catch (err) {
        console.error("Mark as read error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to mark notification as read",
            error: err.message
        });
    }
});

// Mark all as read
router.post("/read-all", async (req, res) => {
    try {
        const { recipient_id } = req.body;
        const conn = await pool.getConnection();

        let query = "UPDATE notifications SET status = 'read', read_at = NOW() WHERE status IN ('unread', 'new')";
        const params = [];

        if (recipient_id) {
            query += " AND recipient_id = ?";
            params.push(recipient_id);
        }

        const [result] = await conn.query(query, params);
        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} notifications marked as read`,
            affected_rows: result.affectedRows
        });

    } catch (err) {
        console.error("Mark all as read error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to mark all notifications as read",
            error: err.message
        });
    }
});

// Create notification
router.post("/", async (req, res) => {
    try {
        const {
            title,
            message,
            type = 'info',
            priority = 'medium',
            recipient_type = 'admin',
            recipient_id,
            tenant_id,
            sender_id,
            sender_type = 'system',
            sender_name = 'System',
            metadata = {}
        } = req.body;

        // Validate required fields
        if (!title) {
            return res.status(400).json({
                success: false,
                message: "Title is required"
            });
        }

        const conn = await pool.getConnection();
        const notificationId = generateNotificationId();

        const [result] = await conn.query(`
            INSERT INTO notifications (
                notification_id,
                title,
                message,
                type,
                priority,
                recipient_type,
                recipient_id,
                tenant_id,
                sender_id,
                sender_type,
                sender_name,
                metadata,
                status,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', NOW())
        `, [
            notificationId,
            title,
            message || '',
            type,
            priority,
            recipient_type,
            recipient_id || null,
            tenant_id || null,
            sender_id || null,
            sender_type,
            sender_name,
            JSON.stringify(metadata)
        ]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Notification created successfully",
            data: {
                id: result.insertId,
                notification_id: notificationId,
                title,
                type,
                status: 'unread',
                created_at: new Date().toISOString()
            }
        });

    } catch (err) {
        console.error("Notification creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create notification",
            error: err.message
        });
    }
});

// Update notification
router.put("/:id", async (req, res) => {
    try {
        const notificationId = req.params.id;
        const {
            title,
            message,
            type,
            status,
            priority,
            metadata
        } = req.body;

        const conn = await pool.getConnection();
        
        const updateFields = [];
        const updateParams = [];

        if (title !== undefined) {
            updateFields.push('title = ?');
            updateParams.push(title);
        }
        if (message !== undefined) {
            updateFields.push('message = ?');
            updateParams.push(message);
        }
        if (type !== undefined) {
            updateFields.push('type = ?');
            updateParams.push(type);
        }
        if (status !== undefined) {
            updateFields.push('status = ?');
            updateParams.push(status);
            if (status === 'read') {
                updateFields.push('read_at = NOW()');
            }
        }
        if (priority !== undefined) {
            updateFields.push('priority = ?');
            updateParams.push(priority);
        }
        if (metadata !== undefined) {
            updateFields.push('metadata = ?');
            updateParams.push(JSON.stringify(metadata));
        }

        if (updateFields.length === 0) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No fields to update"
            });
        }

        updateParams.push(notificationId, notificationId);

        const query = `
            UPDATE notifications 
            SET ${updateFields.join(', ')}, updated_at = NOW()
            WHERE notification_id = ? OR id = ?
        `;

        const [result] = await conn.query(query, updateParams);
        conn.release();

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Notification not found"
            });
        }

        return res.json({
            success: true,
            message: "Notification updated successfully"
        });

    } catch (err) {
        console.error("Update notification error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update notification",
            error: err.message
        });
    }
});

// Archive notification
router.post("/:id/archive", async (req, res) => {
    try {
        const notificationId = req.params.id;
        const conn = await pool.getConnection();

        const [result] = await conn.query(`
            UPDATE notifications 
            SET status = 'archived', archived_at = NOW() 
            WHERE (notification_id = ? OR id = ?) AND status != 'archived'
        `, [notificationId, notificationId]);

        conn.release();

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Notification not found or already archived"
            });
        }

        return res.json({
            success: true,
            message: "Notification archived"
        });

    } catch (err) {
        console.error("Archive error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to archive notification",
            error: err.message
        });
    }
});

// Delete notification
router.delete("/:id", async (req, res) => {
    try {
        const notificationId = req.params.id;
        const conn = await pool.getConnection();

        const [result] = await conn.query(
            'DELETE FROM notifications WHERE notification_id = ? OR id = ?',
            [notificationId, notificationId]
        );

        conn.release();

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Notification not found"
            });
        }

        return res.json({
            success: true,
            message: "Notification deleted successfully"
        });

    } catch (err) {
        console.error("Delete error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete notification",
            error: err.message
        });
    }
});

// Bulk actions
router.post("/bulk-actions", async (req, res) => {
    try {
        const { action, notification_ids } = req.body;
        
        if (!action || !notification_ids || !Array.isArray(notification_ids)) {
            return res.status(400).json({
                success: false,
                message: "Action and notification_ids array are required"
            });
        }

        const conn = await pool.getConnection();
        let query;
        let message;

        switch (action) {
            case 'mark-read':
                query = "UPDATE notifications SET status = 'read', read_at = NOW() WHERE notification_id IN (?) AND status IN ('unread', 'new')";
                message = "notifications marked as read";
                break;
            case 'mark-unread':
                query = "UPDATE notifications SET status = 'unread', read_at = NULL WHERE notification_id IN (?) AND status = 'read'";
                message = "notifications marked as unread";
                break;
            case 'archive':
                query = "UPDATE notifications SET status = 'archived', archived_at = NOW() WHERE notification_id IN (?) AND status != 'archived'";
                message = "notifications archived";
                break;
            case 'delete':
                query = "DELETE FROM notifications WHERE notification_id IN (?)";
                message = "notifications deleted";
                break;
            default:
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: "Invalid action"
                });
        }

        const [result] = await conn.query(query, [notification_ids]);
        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} ${message}`,
            affected_rows: result.affectedRows
        });

    } catch (err) {
        console.error("Bulk actions error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to perform bulk actions",
            error: err.message
        });
    }
});

// Get notifications for specific tenant
router.get("/tenant/:tenant_id", async (req, res) => {
    try {
        const { tenant_id } = req.params;
        const { status, type, limit = 20, page = 1 } = req.query;
        const conn = await pool.getConnection();

        let query = `
            SELECT *
            FROM notifications
            WHERE tenant_id = ? AND recipient_type IN ('tenant', 'all')
        `;
        const params = [tenant_id];

        if (status) {
            query += " AND status = ?";
            params.push(status);
        }

        if (type) {
            query += " AND type = ?";
            params.push(type);
        }

        // Get total count
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [countResult] = await conn.query(countQuery, params);
        const total = countResult[0].total;

        // Apply pagination
        query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        conn.release();

        const formattedRows = rows.map(row => ({
            ...row,
            formatted_created_at: formatTimestamp(row.created_at),
            metadata: parseMetadata(row.metadata)
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
        console.error("Tenant notifications error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch tenant notifications",
            error: err.message
        });
    }
});

// Send notification to multiple tenants (like in your screenshot)
router.post("/send", async (req, res) => {
    try {
        const {
            recipients,
            type,
            title,
            message,
            sender_id,
            sender_name = 'System',
            metadata = {}
        } = req.body;

        // Validate required fields
        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Recipients array is required"
            });
        }

        if (!title || !type) {
            return res.status(400).json({
                success: false,
                message: "Title and type are required"
            });
        }

        const conn = await pool.getConnection();
        const insertedNotifications = [];

        // Send to each recipient
        for (const recipient of recipients) {
            const notificationId = generateNotificationId();
            
            const [result] = await conn.query(`
                INSERT INTO notifications (
                    notification_id,
                    title,
                    message,
                    type,
                    recipient_type,
                    recipient_id,
                    tenant_id,
                    sender_id,
                    sender_name,
                    metadata,
                    status,
                    created_at
                ) VALUES (?, ?, ?, ?, 'tenant', ?, ?, ?, ?, ?, 'unread', NOW())
            `, [
                notificationId,
                title,
                message || '',
                type,
                recipient.id || recipient.tenant_id,
                recipient.id || recipient.tenant_id,
                recipient.id || recipient.tenant_id,
                sender_id,
                sender_name,
                JSON.stringify({
                    ...metadata,
                    tenant_name: recipient.name || recipient.tenant_name
                })
            ]);

            insertedNotifications.push({
                id: result.insertId,
                notification_id: notificationId,
                tenant_id: recipient.id || recipient.tenant_id,
                tenant_name: recipient.name || recipient.tenant_name
            });
        }

        conn.release();

        return res.status(201).json({
            success: true,
            message: `Notification sent to ${insertedNotifications.length} tenant(s)`,
            data: {
                notifications: insertedNotifications,
                total_sent: insertedNotifications.length
            }
        });

    } catch (err) {
        console.error("Send notification error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to send notifications",
            error: err.message
        });
    }
});

// Export notifications to CSV
router.get("/export/csv", async (req, res) => {
    try {
        const {
            type,
            status,
            start_date,
            end_date,
            recipient_id,
            tenant_id
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                notification_id,
                title,
                message,
                type,
                priority,
                status,
                recipient_type,
                recipient_id,
                tenant_id,
                sender_name,
                created_at,
                read_at
            FROM notifications
            WHERE 1=1
        `;
        const params = [];

        if (type && type !== 'All Types' && type !== 'all') {
            query += " AND type = ?";
            params.push(type);
        }

        if (status && status !== 'All Status' && status !== 'all') {
            query += " AND status = ?";
            params.push(status);
        }

        if (start_date) {
            query += " AND DATE(created_at) >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND DATE(created_at) <= ?";
            params.push(end_date);
        }

        if (recipient_id) {
            query += " AND recipient_id = ?";
            params.push(recipient_id);
        }

        if (tenant_id) {
            query += " AND tenant_id = ?";
            params.push(tenant_id);
        }

        query += " ORDER BY created_at DESC";

        const [rows] = await conn.query(query, params);
        conn.release();

        const headers = [
            'ID', 'Title', 'Message', 'Type', 'Priority', 'Status',
            'Recipient Type', 'Recipient ID', 'Tenant ID', 'Sender',
            'Created At', 'Read At'
        ];

        const csvRows = rows.map(row => [
            row.notification_id,
            row.title,
            row.message || '',
            row.type,
            row.priority,
            row.status,
            row.recipient_type,
            row.recipient_id || '',
            row.tenant_id || '',
            row.sender_name || 'System',
            new Date(row.created_at).toISOString(),
            row.read_at ? new Date(row.read_at).toISOString() : ''
        ]);

        const csvContent = [
            headers.join(','),
            ...csvRows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        ].join('\n');

        res.header('Content-Type', 'text/csv');
        res.header('Content-Disposition', `attachment; filename=notifications_${Date.now()}.csv`);
        res.send(csvContent);

    } catch (err) {
        console.error("Notifications export error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to export notifications",
            error: err.message
        });
    }
});

// Get recent notifications (for sidebar/dashboard)
// Get recent notifications (for sidebar/dashboard)
router.get("/recent/:limit", async (req, res) => {
    try {
        const limit = req.params.limit || 5;
        const { recipient_id, tenant_id, status } = req.query;
        
        const conn = await pool.getConnection();
        let query = 'SELECT * FROM notifications WHERE 1=1';
        const params = [];

        if (recipient_id) {
            query += " AND recipient_id = ?";
            params.push(recipient_id);
        }

        if (tenant_id) {
            query += " AND tenant_id = ?";
            params.push(tenant_id);
        }

        if (status) {
            query += " AND status = ?";
            params.push(status);
        }

        query += " ORDER BY created_at DESC LIMIT ?";
        params.push(parseInt(limit));

        const [rows] = await conn.query(query, params);
        conn.release();

        const formattedRows = rows.map(row => ({
            ...row,
            formatted_created_at: formatTimestamp(row.created_at),
            metadata: parseMetadata(row.metadata),
            is_new: row.status === 'unread' || row.status === 'new'
        }));

        return res.json({
            success: true,
            data: formattedRows,
            count: formattedRows.length
        });

    } catch (err) {
        console.error("Recent notifications error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch recent notifications",
            error: err.message
        });
    }
});

// Add another route without the limit parameter for default behavior
router.get("/recent", async (req, res) => {
    try {
        const { recipient_id, tenant_id, status } = req.query;
        const limit = 5; // Default limit
        
        const conn = await pool.getConnection();
        let query = 'SELECT * FROM notifications WHERE 1=1';
        const params = [];

        if (recipient_id) {
            query += " AND recipient_id = ?";
            params.push(recipient_id);
        }

        if (tenant_id) {
            query += " AND tenant_id = ?";
            params.push(tenant_id);
        }

        if (status) {
            query += " AND status = ?";
            params.push(status);
        }

        query += " ORDER BY created_at DESC LIMIT ?";
        params.push(parseInt(limit));

        const [rows] = await conn.query(query, params);
        conn.release();

        const formattedRows = rows.map(row => ({
            ...row,
            formatted_created_at: formatTimestamp(row.created_at),
            metadata: parseMetadata(row.metadata),
            is_new: row.status === 'unread' || row.status === 'new'
        }));

        return res.json({
            success: true,
            data: formattedRows,
            count: formattedRows.length
        });

    } catch (err) {
        console.error("Recent notifications error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch recent notifications",
            error: err.message
        });
    }
});

// Clear all notifications (admin only)
router.delete("/clear/all", async (req, res) => {
    try {
        const { recipient_id, status, type } = req.query;
        const conn = await pool.getConnection();

        let query = 'DELETE FROM notifications WHERE 1=1';
        const params = [];

        if (recipient_id) {
            query += " AND recipient_id = ?";
            params.push(recipient_id);
        }

        if (status) {
            query += " AND status = ?";
            params.push(status);
        }

        if (type) {
            query += " AND type = ?";
            params.push(type);
        }

        const [result] = await conn.query(query, params);
        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} notifications cleared`,
            affected_rows: result.affectedRows
        });

    } catch (err) {
        console.error("Clear notifications error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to clear notifications",
            error: err.message
        });
    }
});

// Get notification summary for dashboard
router.get("/dashboard/summary", async (req, res) => {
    try {
        const { recipient_id } = req.query;
        const conn = await pool.getConnection();

        let whereClause = '';
        const params = [];

        if (recipient_id) {
            whereClause = 'WHERE recipient_id = ?';
            params.push(recipient_id);
        }

        // Get counts for different types
        const [counts] = await conn.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) as unread,
                SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) as \`read\`,
                SUM(CASE WHEN priority IN ('high', 'critical') THEN 1 ELSE 0 END) as alerts
            FROM notifications
            ${whereClause}
        `, params);

        // Get breakdown by type
        const [types] = await conn.query(`
            SELECT 
                type,
                COUNT(*) as count
            FROM notifications
            ${whereClause}
            GROUP BY type
            ORDER BY count DESC
        `, params);

        // Get today's notifications
        const [today] = await conn.query(`
            SELECT COUNT(*) as count 
            FROM notifications 
            ${whereClause ? whereClause + ' AND ' : 'WHERE '} 
            DATE(created_at) = CURDATE()
        `, params);

        conn.release();

        return res.json({
            success: true,
            data: {
                total: counts[0].total,
                unread: counts[0].unread,
                read: counts[0].read,
                alerts: counts[0].alerts,
                today: today[0].count,
                types: types
            }
        });

    } catch (err) {
        console.error("Dashboard summary error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard summary",
            error: err.message
        });
    }
});


router.delete("/:id", async (req, res) => {
    try {
        const notificationId = req.params.id;
        const conn = await pool.getConnection();

        // First, check if the notification exists
        const [checkResult] = await conn.query(
            'SELECT * FROM notifications WHERE id = ? OR notification_id = ?',
            [notificationId, notificationId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Notification not found"
            });
        }

        // Delete the notification
        const [result] = await conn.query(
            'DELETE FROM notifications WHERE id = ? OR notification_id = ?',
            [notificationId, notificationId]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Notification deleted successfully",
            data: {
                deleted_id: notificationId,
                affected_rows: result.affectedRows
            }
        });

    } catch (err) {
        console.error("Delete notification error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete notification",
            error: err.message
        });
    }
});
module.exports = router;