const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const { v4: uuidv4 } = require('uuid');

// Helper function to generate Ticket ID
function generateTicketId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 6);
    return `TKT-${timestamp}-${random}`;
}

// Helper function to format date
function formatDate(date) {
    if (!date) return '';
    const options = { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric'
    };
    return new Date(date).toLocaleDateString('en-US', options);
}

// Parse JSON helper
function parseJSON(data) {
    if (!data) return [];
    if (typeof data === 'string') {
        try {
            return JSON.parse(data);
        } catch (e) {
            return [];
        }
    }
    return data || [];
}

// ==================== TICKETS API ====================

// Get all tickets with filters
router.get("/", async (req, res) => {
    try {
        const {
            status,
            priority,
            category,
            search,
            tenant,
            page = 1,
            limit = 10,
            sort_by = 'created_at',
            sort_order = 'DESC'
        } = req.query;

        const conn = await pool.getConnection();
        let query = `SELECT * FROM support_tickets WHERE 1=1`;
        const params = [];

        // Apply filters
        if (status && status !== 'all') {
            query += " AND status = ?";
            params.push(status);
        }

        if (priority && priority !== 'all') {
            query += " AND priority = ?";
            params.push(priority);
        }

        if (category && category !== 'all') {
            query += " AND category = ?";
            params.push(category);
        }

        if (tenant) {
            query += " AND tenant_name LIKE ?";
            params.push(`%${tenant}%`);
        }

        if (search) {
            query += " AND (subject LIKE ? OR description LIKE ? OR tenant_name LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        // Get total count
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [countResult] = await conn.query(countQuery, params);
        const total = countResult[0].total;

        // Apply sorting and pagination
        const validSortColumns = ['created_at', 'updated_at', 'priority', 'status', 'tenant_name'];
        const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'created_at';
        const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        query += ` ORDER BY ${sortColumn} ${sortDirection} LIMIT ? OFFSET ?`;
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        conn.release();

        // Format the response
        const formattedRows = rows.map(ticket => ({
            ...ticket,
            formatted_created_at: formatDate(ticket.created_at),
            formatted_updated_at: formatDate(ticket.updated_at),
            attachments: parseJSON(ticket.attachments)
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
        console.error("Tickets fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch tickets",
            error: err.message
        });
    }
});

// Get ticket statistics
router.get("/stats", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Get current statistics
        const [totalResult] = await conn.query('SELECT COUNT(*) as total FROM support_tickets');
        const [openResult] = await conn.query("SELECT COUNT(*) as count FROM support_tickets WHERE status = 'open'");
        const [inProgressResult] = await conn.query("SELECT COUNT(*) as count FROM support_tickets WHERE status = 'in_progress'");
        const [resolvedResult] = await conn.query("SELECT COUNT(*) as count FROM support_tickets WHERE status = 'resolved'");
        const [urgentResult] = await conn.query("SELECT COUNT(*) as count FROM support_tickets WHERE priority = 'urgent'");
        const [slaBreachedResult] = await conn.query("SELECT COUNT(*) as count FROM support_tickets WHERE sla_status = 'breached'");

        // Get last month statistics for comparison
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        
        const [lastMonthTotal] = await conn.query(
            'SELECT COUNT(*) as count FROM support_tickets WHERE created_at >= ? AND created_at <= ?',
            [lastMonth, new Date()]
        );

        // Calculate percentages (simplified)
        const percentageFromLastMonth = '+0%';
        const openPercentage = '+0%';
        const inProgressPercentage = '+0%';
        const resolvedPercentage = '+0%';
        const urgentPercentage = '+0%';

        conn.release();

        return res.json({
            success: true,
            data: {
                total_tickets: totalResult[0].total || 0,
                open_tickets: openResult[0].count || 0,
                in_progress_tickets: inProgressResult[0].count || 0,
                resolved_tickets: resolvedResult[0].count || 0,
                urgent_tickets: urgentResult[0].count || 0,
                sla_breached: slaBreachedResult[0].count || 0,
                percentages: {
                    total_change: percentageFromLastMonth,
                    open_change: openPercentage,
                    in_progress_change: inProgressPercentage,
                    resolved_change: resolvedPercentage,
                    urgent_change: urgentPercentage
                }
            }
        });

    } catch (err) {
        console.error("Ticket stats error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch ticket statistics",
            error: err.message
        });
    }
});

// Get ticket by ID
router.get("/:id", async (req, res) => {
    try {
        const ticketId = req.params.id;
        const conn = await pool.getConnection();

        // Get ticket details
        const [ticketRows] = await conn.query(
            'SELECT * FROM support_tickets WHERE ticket_id = ? OR id = ?',
            [ticketId, ticketId]
        );

        if (ticketRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Ticket not found"
            });
        }

        // Get ticket conversations
        const [conversationRows] = await conn.query(
            'SELECT * FROM ticket_conversations WHERE ticket_id = ? ORDER BY created_at ASC',
            [ticketRows[0].ticket_id]
        );

        const ticket = ticketRows[0];
        ticket.formatted_created_at = formatDate(ticket.created_at);
        ticket.formatted_updated_at = formatDate(ticket.updated_at);
        ticket.attachments = parseJSON(ticket.attachments);
        ticket.conversations = conversationRows.map(conv => ({
            ...conv,
            formatted_created_at: formatDate(conv.created_at),
            attachments: parseJSON(conv.attachments)
        }));

        conn.release();

        return res.json({
            success: true,
            data: ticket
        });

    } catch (err) {
        console.error("Ticket fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch ticket",
            error: err.message
        });
    }
});

// Create new ticket
router.post("/", async (req, res) => {
    try {
        const {
            subject,
            description,
            tenant_name,
            tenant_email,
            category,
            priority = 'medium',
            attachments = []
        } = req.body;

        // Validate required fields
        if (!subject || !description || !tenant_name || !tenant_email || !category) {
            return res.status(400).json({
                success: false,
                message: "Subject, description, tenant name, tenant email, and category are required"
            });
        }

        const conn = await pool.getConnection();
        const ticketId = generateTicketId();

        // Create ticket
        const [result] = await conn.query(`
            INSERT INTO support_tickets (
                ticket_id,
                subject,
                description,
                tenant_name,
                tenant_email,
                category,
                priority,
                status,
                sla_status,
                attachments,
                created_by,
                reply_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'within_sla', ?, ?, 0)
        `, [
            ticketId,
            subject,
            description,
            tenant_name,
            tenant_email,
            category,
            priority,
            JSON.stringify(attachments),
            tenant_email
        ]);

        // Create initial conversation
        await conn.query(`
            INSERT INTO ticket_conversations (
                ticket_id,
                message,
                sender_name,
                sender_email,
                sender_type
            ) VALUES (?, ?, ?, ?, 'customer')
        `, [
            ticketId,
            description,
            tenant_name,
            tenant_email
        ]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Ticket created successfully",
            data: {
                ticket_id: ticketId,
                subject,
                tenant_name,
                category,
                priority,
                status: 'open'
            }
        });

    } catch (err) {
        console.error("Ticket creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create ticket",
            error: err.message
        });
    }
});

// Update ticket status
router.patch("/:id/status", async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                message: "Status is required"
            });
        }

        const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const conn = await pool.getConnection();

        // Check if ticket exists
        const [checkResult] = await conn.query(
            'SELECT * FROM support_tickets WHERE ticket_id = ? OR id = ?',
            [ticketId, ticketId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Ticket not found"
            });
        }

        const updateData = { status };
        if (status === 'resolved' || status === 'closed') {
            updateData.resolved_at = new Date();
        }

        const [result] = await conn.query(
            'UPDATE support_tickets SET status = ?, resolved_at = ? WHERE id = ?',
            [status, updateData.resolved_at || null, checkResult[0].id]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Ticket status updated successfully",
            data: {
                ticket_id: checkResult[0].ticket_id,
                new_status: status
            }
        });

    } catch (err) {
        console.error("Status update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update ticket status",
            error: err.message
        });
    }
});

// Update ticket priority
router.patch("/:id/priority", async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { priority } = req.body;

        if (!priority) {
            return res.status(400).json({
                success: false,
                message: "Priority is required"
            });
        }

        const validPriorities = ['low', 'medium', 'high', 'urgent'];
        if (!validPriorities.includes(priority)) {
            return res.status(400).json({
                success: false,
                message: `Invalid priority. Must be one of: ${validPriorities.join(', ')}`
            });
        }

        const conn = await pool.getConnection();

        // Check if ticket exists
        const [checkResult] = await conn.query(
            'SELECT * FROM support_tickets WHERE ticket_id = ? OR id = ?',
            [ticketId, ticketId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Ticket not found"
            });
        }

        const [result] = await conn.query(
            'UPDATE support_tickets SET priority = ? WHERE id = ?',
            [priority, checkResult[0].id]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Ticket priority updated successfully",
            data: {
                ticket_id: checkResult[0].ticket_id,
                new_priority: priority
            }
        });

    } catch (err) {
        console.error("Priority update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update ticket priority",
            error: err.message
        });
    }
});

// Assign ticket
router.patch("/:id/assign", async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { assigned_to } = req.body;

        if (!assigned_to) {
            return res.status(400).json({
                success: false,
                message: "Assigned to is required"
            });
        }

        const conn = await pool.getConnection();

        // Check if ticket exists
        const [checkResult] = await conn.query(
            'SELECT * FROM support_tickets WHERE ticket_id = ? OR id = ?',
            [ticketId, ticketId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Ticket not found"
            });
        }

        const [result] = await conn.query(
            'UPDATE support_tickets SET assigned_to = ? WHERE id = ?',
            [assigned_to, checkResult[0].id]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Ticket assigned successfully",
            data: {
                ticket_id: checkResult[0].ticket_id,
                assigned_to: assigned_to
            }
        });

    } catch (err) {
        console.error("Assign ticket error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to assign ticket",
            error: err.message
        });
    }
});

// Add reply to ticket
router.post("/:id/reply", async (req, res) => {
    try {
        const ticketId = req.params.id;
        const {
            message,
            sender_name,
            sender_email,
            sender_type = 'admin',
            attachments = []
        } = req.body;

        if (!message || !sender_name || !sender_email) {
            return res.status(400).json({
                success: false,
                message: "Message, sender name, and sender email are required"
            });
        }

        const conn = await pool.getConnection();

        // Check if ticket exists
        const [checkResult] = await conn.query(
            'SELECT * FROM support_tickets WHERE ticket_id = ? OR id = ?',
            [ticketId, ticketId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Ticket not found"
            });
        }

        // Add conversation
        const [convResult] = await conn.query(`
            INSERT INTO ticket_conversations (
                ticket_id,
                message,
                sender_name,
                sender_email,
                sender_type,
                attachments
            ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
            checkResult[0].ticket_id,
            message,
            sender_name,
            sender_email,
            sender_type,
            JSON.stringify(attachments)
        ]);

        // Update reply count
        await conn.query(
            'UPDATE support_tickets SET reply_count = reply_count + 1 WHERE id = ?',
            [checkResult[0].id]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Reply added successfully",
            data: {
                ticket_id: checkResult[0].ticket_id,
                reply_id: convResult.insertId,
                reply_count: checkResult[0].reply_count + 1
            }
        });

    } catch (err) {
        console.error("Add reply error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to add reply",
            error: err.message
        });
    }
});

// Bulk update ticket status
router.patch("/bulk/list/status", async (req, res) => {
    try {
        const { ticket_ids, status, performed_by = 'admin' } = req.body;
        
        if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "ticket_ids array is required"
            });
        }

        if (!status) {
            return res.status(400).json({
                success: false,
                message: "Status is required"
            });
        }

        const conn = await pool.getConnection();

        // Get existing tickets by ticket_id (not id)
        const placeholders = ticket_ids.map(() => '?').join(',');
        const [existingTickets] = await conn.query(
            `SELECT * FROM support_tickets WHERE id IN (${placeholders})`,
            ticket_ids
        );

        if (existingTickets.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "No tickets found with the provided ticket IDs"
            });
        }

        // Get the actual database IDs from the found tickets
        const dbIds = existingTickets.map(t => t.id);
        const idPlaceholders = dbIds.map(() => '?').join(',');

        // Update tickets using database IDs
        const [result] = await conn.query(
            `UPDATE support_tickets SET status = ? WHERE id IN (${idPlaceholders})`,
            [status, ...dbIds]
        );

        // Log bulk action
        await conn.query(`
            INSERT INTO bulk_actions_log (
                action_type,
                ticket_ids,
                old_value,
                new_value,
                performed_by
            ) VALUES (?, ?, ?, ?, ?)
        `, [
            'status_change',
            JSON.stringify(ticket_ids),
            JSON.stringify(existingTickets.map(t => t.status)),
            status,
            performed_by
        ]);

        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} ticket(s) status updated successfully`,
            data: {
                updated_count: result.affectedRows,
                ticket_ids: ticket_ids,
                new_status: status
            }
        });

    } catch (err) {
        console.error("Bulk status update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update ticket statuses",
            error: err.message
        });
    }
});
// Bulk assign tickets
router.patch("/bulk/assign", async (req, res) => {
    try {
        const { ticket_ids, assigned_to, performed_by = 'admin' } = req.body;
        
        if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "ticket_ids array is required"
            });
        }

        if (!assigned_to) {
            return res.status(400).json({
                success: false,
                message: "Assigned to is required"
            });
        }

        const conn = await pool.getConnection();

        // Get existing tickets
        const placeholders = ticket_ids.map(() => '?').join(',');
        const [existingTickets] = await conn.query(
            `SELECT * FROM support_tickets WHERE ticket_id IN (${placeholders})`,
            ticket_ids
        );

        if (existingTickets.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "No tickets found with the provided IDs"
            });
        }

        const existingIds = existingTickets.map(t => t.id);
        const idPlaceholders = existingIds.map(() => '?').join(',');

        // Update tickets
        const [result] = await conn.query(
            `UPDATE support_tickets SET assigned_to = ? WHERE id IN (${idPlaceholders})`,
            [assigned_to, ...existingIds]
        );

        // Log bulk action
        await conn.query(`
            INSERT INTO bulk_actions_log (
                action_type,
                ticket_ids,
                old_value,
                new_value,
                performed_by
            ) VALUES (?, ?, ?, ?, ?)
        `, [
            'assign',
            JSON.stringify(ticket_ids),
            JSON.stringify(existingTickets.map(t => t.assigned_to)),
            assigned_to,
            performed_by
        ]);

        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} ticket(s) assigned successfully`,
            data: {
                assigned_count: result.affectedRows,
                ticket_ids: ticket_ids,
                assigned_to: assigned_to
            }
        });

    } catch (err) {
        console.error("Bulk assign error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to assign tickets",
            error: err.message
        });
    }
});

// Delete ticket
router.delete("/:id", async (req, res) => {
    try {
        const ticketId = req.params.id;
        const conn = await pool.getConnection();

        // Check if ticket exists
        const [checkResult] = await conn.query(
            'SELECT * FROM support_tickets WHERE ticket_id = ? OR id = ?',
            [ticketId, ticketId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Ticket not found"
            });
        }

        // Delete conversations first
        await conn.query(
            'DELETE FROM ticket_conversations WHERE ticket_id = ?',
            [checkResult[0].ticket_id]
        );

        // Delete ticket
        const [result] = await conn.query(
            'DELETE FROM support_tickets WHERE id = ?',
            [checkResult[0].id]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Ticket deleted successfully",
            data: {
                deleted_id: ticketId,
                subject: checkResult[0].subject
            }
        });

    } catch (err) {
        console.error("Ticket delete error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete ticket",
            error: err.message
        });
    }
});

// Bulk delete tickets
router.delete("/bulk/delete", async (req, res) => {
    try {
        const { ticket_ids, performed_by = 'admin' } = req.body;
        
        if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "ticket_ids array is required"
            });
        }

        const conn = await pool.getConnection();

        // Get existing tickets
        const placeholders = ticket_ids.map(() => '?').join(',');
        const [existingTickets] = await conn.query(
            `SELECT * FROM support_tickets WHERE ticket_id IN (${placeholders})`,
            ticket_ids
        );

        if (existingTickets.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "No tickets found with the provided IDs"
            });
        }

        const existingTicketIds = existingTickets.map(t => t.ticket_id);

        // Delete conversations first
        await conn.query(
            `DELETE FROM ticket_conversations WHERE ticket_id IN (${placeholders})`,
            existingTicketIds
        );

        // Delete tickets
        const [result] = await conn.query(
            `DELETE FROM support_tickets WHERE ticket_id IN (${placeholders})`,
            existingTicketIds
        );

        // Log bulk action
        await conn.query(`
            INSERT INTO bulk_actions_log (
                action_type,
                ticket_ids,
                performed_by
            ) VALUES (?, ?, ?)
        `, [
            'delete',
            JSON.stringify(ticket_ids),
            performed_by
        ]);

        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} ticket(s) deleted successfully`,
            data: {
                deleted_count: result.affectedRows,
                deleted_ids: ticket_ids
            }
        });

    } catch (err) {
        console.error("Bulk delete error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete tickets",
            error: err.message
        });
    }
});

// Get categories
router.get("/categories/list", async (req, res) => {
    try {
        const conn = await pool.getConnection();
        
        const [rows] = await conn.query(
            'SELECT * FROM ticket_categories WHERE is_active = true ORDER BY category_name'
        );

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

// Get priorities
router.get("/priorities/list", async (req, res) => {
    try {
        const conn = await pool.getConnection();
        
        const [rows] = await conn.query(
            'SELECT * FROM ticket_priorities WHERE is_active = true ORDER BY sla_hours ASC'
        );

        conn.release();

        return res.json({
            success: true,
            data: rows,
            count: rows.length
        });

    } catch (err) {
        console.error("Priorities fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch priorities",
            error: err.message
        });
    }
});

// Search tickets
router.get("/search/all", async (req, res) => {
    try {
        const { query, limit = 20 } = req.query;
        
        if (!query || query.trim().length < 2) {
            return res.status(400).json({
                success: false,
                message: "Search query must be at least 2 characters"
            });
        }

        const conn = await pool.getConnection();
        const searchTerm = `%${query}%`;

        const [tickets] = await conn.query(`
            SELECT 
                ticket_id,
                subject,
                tenant_name,
                category,
                status,
                priority,
                created_at
            FROM support_tickets
            WHERE 
                subject LIKE ? OR 
                description LIKE ? OR
                tenant_name LIKE ?
            ORDER BY created_at DESC
            LIMIT ?
        `, [searchTerm, searchTerm, searchTerm, parseInt(limit)]);

        conn.release();

        const formattedResults = tickets.map(ticket => ({
            ...ticket,
            formatted_created_at: formatDate(ticket.created_at)
        }));

        return res.json({
            success: true,
            data: formattedResults,
            count: formattedResults.length,
            query: query
        });

    } catch (err) {
        console.error("Search error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to search tickets",
            error: err.message
        });
    }
});

module.exports = router;