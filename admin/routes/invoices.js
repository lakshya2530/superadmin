const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const { v4: uuidv4 } = require('uuid');

// ==================== HELPER FUNCTIONS ====================

// Generate invoice number (e.g., INV-00001)
async function generateInvoiceNumber() {
    const conn = await pool.getConnection();
    try {
        const [result] = await conn.query(
            "SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1"
        );
        
        let nextNumber = 1;
        if (result.length > 0) {
            const lastNumber = result[0].invoice_number;
            const match = lastNumber.match(/INV-(\d+)/);
            if (match) {
                nextNumber = parseInt(match[1]) + 1;
            }
        }
        
        return `INV-${nextNumber.toString().padStart(5, '0')}`;
    } finally {
        conn.release();
    }
}

// Calculate dynamic dashboard statistics
async function calculateDashboardStats(conn) {
    try {
        // Current date calculations
        const today = new Date();
        const currentMonth = today.toISOString().slice(0, 7); // YYYY-MM
        const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const prevMonthStr = prevMonth.toISOString().slice(0, 7);
        
        // 1. Calculate current month statistics
        const [currentMonthStats] = await conn.query(`
            SELECT 
                COUNT(*) as total_invoices,
                COALESCE(SUM(amount), 0) as total_revenue,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid_revenue,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
                SUM(CASE WHEN status = 'pending' AND due_date >= CURDATE() THEN 1 ELSE 0 END) as pending_count,
                COALESCE(SUM(CASE WHEN status = 'pending' AND due_date >= CURDATE() THEN amount ELSE 0 END), 0) as pending_amount,
                SUM(CASE WHEN status = 'overdue' OR (status = 'pending' AND due_date < CURDATE()) THEN 1 ELSE 0 END) as overdue_count,
                COALESCE(SUM(CASE WHEN status = 'overdue' OR (status = 'pending' AND due_date < CURDATE()) THEN amount ELSE 0 END), 0) as overdue_amount
            FROM invoices
            WHERE DATE_FORMAT(issue_date, '%Y-%m') = ?
        `, [currentMonth]);
        
        // 2. Calculate previous month statistics for comparison
        const [prevMonthStats] = await conn.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid_revenue,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_amount,
                COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) as overdue_amount
            FROM invoices
            WHERE DATE_FORMAT(issue_date, '%Y-%m') = ?
        `, [prevMonthStr]);
        
        // Parse values to ensure they're numbers
        const parseDecimal = (value) => {
            if (value === null || value === undefined) return 0;
            return parseFloat(value) || 0;
        };
        
        const parseInteger = (value) => {
            if (value === null || value === undefined) return 0;
            return parseInt(value) || 0;
        };
        
        const current = {
            total_invoices: parseInteger(currentMonthStats[0]?.total_invoices),
            total_revenue: parseDecimal(currentMonthStats[0]?.total_revenue),
            paid_revenue: parseDecimal(currentMonthStats[0]?.paid_revenue),
            paid_count: parseInteger(currentMonthStats[0]?.paid_count),
            pending_count: parseInteger(currentMonthStats[0]?.pending_count),
            pending_amount: parseDecimal(currentMonthStats[0]?.pending_amount),
            overdue_count: parseInteger(currentMonthStats[0]?.overdue_count),
            overdue_amount: parseDecimal(currentMonthStats[0]?.overdue_amount)
        };
        
        const previous = {
            paid_revenue: parseDecimal(prevMonthStats[0]?.paid_revenue),
            paid_count: parseInteger(prevMonthStats[0]?.paid_count),
            pending_amount: parseDecimal(prevMonthStats[0]?.pending_amount),
            overdue_amount: parseDecimal(prevMonthStats[0]?.overdue_amount)
        };
        
        // 3. Calculate percentage changes
        const calculateChange = (currentVal, previousVal) => {
            if (!previousVal || previousVal === 0) {
                return currentVal > 0 ? 100 : 0;
            }
            return ((currentVal - previousVal) / previousVal) * 100;
        };
        
        const revenueChange = calculateChange(current.paid_revenue, previous.paid_revenue);
        const paidCountChange = calculateChange(current.paid_count, previous.paid_count);
        const pendingChange = calculateChange(current.pending_amount, previous.pending_amount);
        const overdueChange = calculateChange(current.overdue_amount, previous.overdue_amount);
        
        const stats = {
            total_revenue: {
                value: current.paid_revenue,
                formatted: `SAR ${current.paid_revenue.toFixed(2)}`,
                change: Math.round(revenueChange * 10) / 10, // Round to 1 decimal
                isPositive: revenueChange > 0
            },
            paid_invoices: {
                count: current.paid_count,
                change: Math.round(paidCountChange * 10) / 10,
                isPositive: paidCountChange > 0
            },
            pending: {
                amount: current.pending_amount,
                formatted: `SAR ${current.pending_amount.toFixed(2)}`,
                change: Math.round(pendingChange * 10) / 10,
                isPositive: pendingChange > 0
            },
            overdue: {
                amount: current.overdue_amount,
                count: current.overdue_count,
                formatted: `SAR ${current.overdue_amount.toFixed(2)}`,
                change: Math.round(overdueChange * 10) / 10,
                isPositive: overdueChange < 0 // Negative change is good for overdue
            },
            // Additional statistics
            total_invoices: current.total_invoices,
            total_revenue_all: current.total_revenue,
            collection_rate: current.total_revenue > 0 
                ? (current.paid_revenue / current.total_revenue) * 100 
                : 0
        };
        
        return stats;
        
    } catch (err) {
        console.error("Dashboard stats calculation error:", err);
        throw err;
    }
}

// Also update the calculateMonthlyTrends function to parse values:
async function calculateMonthlyTrends(conn, months = 6) {
    try {
        const today = new Date();
        const trends = [];
        
        for (let i = months - 1; i >= 0; i--) {
            const monthDate = new Date(today.getFullYear(), today.getMonth() - i, 1);
            const yearMonth = monthDate.toISOString().slice(0, 7);
            const monthName = monthDate.toLocaleString('default', { month: 'short' });
            
            const [monthStats] = await conn.query(`
                SELECT 
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as revenue,
                    COUNT(*) as total_invoices,
                    SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
                    SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue_count
                FROM invoices
                WHERE DATE_FORMAT(issue_date, '%Y-%m') = ?
            `, [yearMonth]);
            
            const stats = monthStats[0];
            
            // Parse all values
            const parseDecimal = (value) => parseFloat(value) || 0;
            const parseInteger = (value) => parseInt(value) || 0;
            
            trends.push({
                month: monthName,
                year_month: yearMonth,
                revenue: parseDecimal(stats?.revenue),
                total_invoices: parseInteger(stats?.total_invoices),
                paid_count: parseInteger(stats?.paid_count),
                pending_count: parseInteger(stats?.pending_count),
                overdue_count: parseInteger(stats?.overdue_count)
            });
        }
        
        return trends;
    } catch (err) {
        console.error("Monthly trends calculation error:", err);
        throw err;
    }
}

// Also update the calculateTopTenants function to parse values:
async function calculateTopTenants(conn, limit = 5) {
    try {
        const [topTenants] = await conn.query(`
            SELECT 
                tenant_id,
                tenant_name,
                tenant_plan,
                COUNT(*) as invoice_count,
                COALESCE(SUM(amount), 0) as total_amount,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid_amount,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_amount,
                COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) as overdue_amount
            FROM invoices
            GROUP BY tenant_id, tenant_name, tenant_plan
            ORDER BY total_amount DESC
            LIMIT ?
        `, [limit]);
        
        return topTenants.map(tenant => {
            // Parse all values
            const parseDecimal = (value) => parseFloat(value) || 0;
            const parseInteger = (value) => parseInt(value) || 0;
            
            const total = parseDecimal(tenant.total_amount);
            const paid = parseDecimal(tenant.paid_amount);
            
            return {
                tenant_id: tenant.tenant_id,
                tenant_name: tenant.tenant_name,
                tenant_plan: tenant.tenant_plan,
                invoice_count: parseInteger(tenant.invoice_count),
                total_amount: total,
                paid_amount: paid,
                pending_amount: parseDecimal(tenant.pending_amount),
                overdue_amount: parseDecimal(tenant.overdue_amount),
                formatted_total: `SAR ${total.toFixed(2)}`,
                formatted_paid: `SAR ${paid.toFixed(2)}`,
                collection_rate: total > 0 ? (paid / total) * 100 : 0
            };
        });
    } catch (err) {
        console.error("Top tenants calculation error:", err);
        throw err;
    }
}
// ==================== INVOICES API ====================

// Get all invoices with filters
router.get("/", async (req, res) => {
    try {
        const {
            status,
            tenant_id,
            start_date,
            end_date,
            billing_period,
            search,
            page = 1,
            limit = 10
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                i.id,
                i.invoice_number,
                i.invoice_id,
                i.tenant_id,
                i.tenant_name,
                i.tenant_plan,
                i.amount,
                i.billing_period,
                i.issue_date,
                i.due_date,
                i.paid_date,
                i.status,
                i.notes,
                i.created_at,
                i.updated_at,
                DATE_FORMAT(i.issue_date, '%b %e, %Y') as formatted_issue_date,
                DATE_FORMAT(i.due_date, '%b %e, %Y') as formatted_due_date,
                DATE_FORMAT(i.paid_date, '%b %e, %Y') as formatted_paid_date,
                CASE 
                    WHEN i.status = 'overdue' THEN 'Overdue'
                    WHEN i.status = 'paid' THEN 'Paid'
                    WHEN i.status = 'pending' THEN 'Pending'
                    ELSE i.status
                END as display_status,
                CONCAT('SAR ', FORMAT(i.amount, 2)) as formatted_amount,
                CASE 
                    WHEN i.status = 'overdue' THEN 'danger'
                    WHEN i.status = 'paid' THEN 'success'
                    WHEN i.status = 'pending' THEN 'warning'
                    ELSE 'secondary'
                END as status_color,
                CASE 
                    WHEN i.status = 'overdue' THEN true
                    WHEN i.status = 'pending' AND i.due_date < CURDATE() THEN true
                    ELSE false
                END as is_overdue
            FROM invoices i
            WHERE 1=1
        `;
        
        const params = [];

        // Apply filters
        if (status && status !== 'all') {
            if (status === 'overdue') {
                query += " AND (i.status = 'overdue' OR (i.status = 'pending' AND i.due_date < CURDATE()))";
            } else {
                query += " AND i.status = ?";
                params.push(status);
            }
        }

        if (tenant_id) {
            query += " AND i.tenant_id = ?";
            params.push(tenant_id);
        }

        if (start_date) {
            query += " AND i.issue_date >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND i.issue_date <= ?";
            params.push(end_date);
        }

        if (billing_period) {
            query += " AND i.billing_period LIKE ?";
            params.push(`%${billing_period}%`);
        }

        if (search) {
            query += " AND (i.tenant_name LIKE ? OR i.invoice_number LIKE ? OR i.invoice_id LIKE ? OR i.tenant_plan LIKE ? OR i.billing_period LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        // Get total count
        const countQuery = query.replace(
            /SELECT.*FROM invoices i WHERE 1=1/,
            'SELECT COUNT(*) as total FROM invoices i WHERE 1=1'
        );
        const [countResult] = await conn.query(countQuery, params);
        const total = countResult[0]?.total || 0;

        // Apply sorting and pagination
        query += " ORDER BY i.due_date ASC, i.id DESC LIMIT ? OFFSET ?";
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        conn.release();

        return res.json({
            success: true,
            data: rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                total_pages: Math.ceil(total / limit)
            }
        });

    } catch (err) {
        console.error("Invoices fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch invoices",
            error: err.message
        });
    }
});

// Get invoice by ID
router.get("/:id", async (req, res) => {
    try {
        const invoiceId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(`
            SELECT 
                i.*,
                DATE_FORMAT(i.issue_date, '%b %e, %Y') as formatted_issue_date,
                DATE_FORMAT(i.due_date, '%b %e, %Y') as formatted_due_date,
                DATE_FORMAT(i.paid_date, '%M %e, %Y') as formatted_paid_date_long,
                CONCAT('SAR ', FORMAT(i.amount, 2)) as formatted_amount,
                CASE 
                    WHEN i.status = 'overdue' THEN 'Overdue'
                    WHEN i.status = 'paid' THEN 'Paid'
                    WHEN i.status = 'pending' THEN 'Pending'
                END as display_status
            FROM invoices i
            WHERE i.id = ? OR i.invoice_number = ? OR i.invoice_id = ?
        `, [invoiceId, invoiceId, invoiceId]);

        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Invoice not found"
            });
        }

        conn.release();

        return res.json({
            success: true,
            data: rows[0]
        });

    } catch (err) {
        console.error("Invoice fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch invoice",
            error: err.message
        });
    }
});

// Create new invoice
router.post("/", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const {
            tenant_id,
            tenant_name,
            tenant_plan,
            amount,
            billing_period,
            due_date,
            notes
        } = req.body;

        // Validation
        if (!tenant_id || !tenant_name || !amount || !billing_period || !due_date) {
            return res.status(400).json({
                success: false,
                message: "Tenant ID, tenant name, amount, billing period, and due date are required"
            });
        }

        // Generate invoice number
        let invoiceNumber;
        try {
            invoiceNumber = await generateInvoiceNumber();
        } catch (err) {
            // Fallback if generateInvoiceNumber fails
            const timestamp = Date.now();
            invoiceNumber = `INV-${timestamp.toString().slice(-6)}`;
        }

        const invoiceUuid = uuidv4();
        const issue_date = new Date().toISOString().split('T')[0];

        // Create invoice
        const [result] = await conn.query(`
            INSERT INTO invoices (
                invoice_number,
                invoice_id,
                tenant_id,
                tenant_name,
                tenant_plan,
                amount,
                billing_period,
                issue_date,
                due_date,
                notes,
                status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `, [
            invoiceNumber,
            invoiceUuid,
            tenant_id,
            tenant_name,
            tenant_plan,
            parseFloat(amount),
            billing_period,
            issue_date,
            due_date,
            notes || ''
        ]);

        await conn.commit();
        
        return res.status(201).json({
            success: true,
            message: "Invoice created successfully",
            data: {
                id: result.insertId,
                invoice_number: invoiceNumber,
                invoice_id: invoiceUuid,
                tenant_name,
                amount: parseFloat(amount),
                billing_period,
                status: 'pending'
            }
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Invoice creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create invoice",
            error: err.message
        });
    }
});

// Update invoice
router.put("/:id", async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const invoiceId = req.params.id;
        const {
            amount,
            billing_period,
            due_date,
            notes,
            tenant_plan,
            tenant_name
        } = req.body;

        // Check if invoice exists
        const [invoiceRows] = await conn.query(
            'SELECT * FROM invoices WHERE id = ? OR invoice_number = ? OR invoice_id = ?',
            [invoiceId, invoiceId, invoiceId]
        );

        if (invoiceRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Invoice not found"
            });
        }

        const invoice = invoiceRows[0];

        // Update invoice
        const [result] = await conn.query(`
            UPDATE invoices 
            SET 
                amount = COALESCE(?, amount),
                billing_period = COALESCE(?, billing_period),
                due_date = COALESCE(?, due_date),
                notes = COALESCE(?, notes),
                tenant_plan = COALESCE(?, tenant_plan),
                tenant_name = COALESCE(?, tenant_name),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            amount ? parseFloat(amount) : null,
            billing_period,
            due_date,
            notes,
            tenant_plan,
            tenant_name,
            invoice.id
        ]);

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: "Invoice updated successfully",
            data: {
                id: invoice.id,
                invoice_number: invoice.invoice_number,
                updated_fields: Object.keys(req.body).filter(key => req.body[key] !== undefined)
            }
        });

    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error("Invoice update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update invoice",
            error: err.message
        });
    }
});

// Update invoice status
router.patch("/:id/status", async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const invoiceId = req.params.id;
        const { status } = req.body;

        // Validate status
        const validStatuses = ['paid', 'pending', 'overdue'];
        if (!status || !validStatuses.includes(status)) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Valid status is required (paid, pending, overdue)"
            });
        }

        // Get current invoice
        const [invoiceRows] = await conn.query(
            'SELECT id, invoice_number, status FROM invoices WHERE id = ? OR invoice_number = ? OR invoice_id = ?',
            [invoiceId, invoiceId, invoiceId]
        );

        if (invoiceRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Invoice not found"
            });
        }

        const invoice = invoiceRows[0];
        const oldStatus = invoice.status;

        // Don't update if status is the same
        if (oldStatus === status) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: `Invoice is already ${status}`
            });
        }

        // Update invoice status
        const updateData = {
            status,
            updated_at: new Date()
        };

        if (status === 'paid') {
            updateData.paid_date = new Date();
        } else if (status === 'pending' || status === 'overdue') {
            updateData.paid_date = null;
        }

        const [result] = await conn.query(
            `UPDATE invoices 
             SET 
                status = ?,
                paid_date = ?,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [status, updateData.paid_date, invoice.id]
        );

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: `Invoice status updated from ${oldStatus} to ${status}`,
            data: {
                id: invoice.id,
                invoice_number: invoice.invoice_number,
                old_status: oldStatus,
                new_status: status,
                paid_date: updateData.paid_date
            }
        });

    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error("Invoice status update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update invoice status",
            error: err.message
        });
    }
});

// Delete invoice
router.delete("/:id", async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const invoiceId = req.params.id;

        // Check if invoice exists
        const [invoiceRows] = await conn.query(
            'SELECT id, invoice_number FROM invoices WHERE id = ? OR invoice_number = ? OR invoice_id = ?',
            [invoiceId, invoiceId, invoiceId]
        );

        if (invoiceRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Invoice not found"
            });
        }

        const invoice = invoiceRows[0];

        // Delete invoice
        const [result] = await conn.query(
            'DELETE FROM invoices WHERE id = ?',
            [invoice.id]
        );

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: "Invoice deleted successfully",
            data: {
                id: invoice.id,
                invoice_number: invoice.invoice_number,
                deleted_count: result.affectedRows
            }
        });

    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error("Invoice deletion error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete invoice",
            error: err.message
        });
    }
});

// ==================== DASHBOARD ENDPOINTS ====================

// Get dashboard statistics (dynamic calculation)
// Get dashboard statistics (dynamic calculation) - FIXED
router.get("/stats/dashboard", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Calculate all dashboard metrics dynamically
        const dashboardStats = await calculateDashboardStats(conn);
        
        // Get recent invoices
        const [recentInvoices] = await conn.query(`
            SELECT 
                invoice_number,
                tenant_name,
                tenant_plan,
                amount,
                status,
                billing_period,
                DATE_FORMAT(due_date, '%b %e, %Y') as formatted_due_date,
                DATE_FORMAT(created_at, '%b %e, %Y') as formatted_created_date,
                CASE 
                    WHEN status = 'overdue' THEN 'Overdue'
                    WHEN status = 'paid' THEN 'Paid'
                    WHEN status = 'pending' THEN 'Pending'
                END as display_status,
                CONCAT('SAR ', FORMAT(amount, 2)) as formatted_amount
            FROM invoices 
            ORDER BY created_at DESC 
            LIMIT 5
        `);

        // Get monthly trends
        const monthlyTrends = await calculateMonthlyTrends(conn, 6);
        
        // Get top tenants
        const topTenants = await calculateTopTenants(conn, 5);
        
        // Get status distribution
        const [statusDistribution] = await conn.query(`
            SELECT 
                status,
                COUNT(*) as count,
                COALESCE(SUM(amount), 0) as amount
            FROM invoices
            GROUP BY status
            ORDER BY FIELD(status, 'paid', 'pending', 'overdue')
        `);

        conn.release();

        // Parse status distribution values
        const parsedStatusDistribution = statusDistribution.map(item => ({
            status: item.status,
            count: parseInt(item.count) || 0,
            amount: parseFloat(item.amount) || 0
        }));

        return res.json({
            success: true,
            data: {
                summary: dashboardStats,
                recent_invoices: recentInvoices,
                monthly_trends: monthlyTrends,
                top_tenants: topTenants,
                status_distribution: parsedStatusDistribution,
                total_invoices: dashboardStats.total_invoices,
                collection_rate: typeof dashboardStats.collection_rate === 'number' 
                    ? dashboardStats.collection_rate.toFixed(1) + '%' 
                    : '0.0%',
                calculated_at: new Date().toISOString()
            }
        });

    } catch (err) {
        console.error("Dashboard stats error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to calculate dashboard statistics",
            error: err.message
        });
    }
});

// Get quick stats for header/cards
router.get("/stats/quick", async (req, res) => {
    try {
        const conn = await pool.getConnection();
        
        const [quickStats] = await conn.query(`
            SELECT 
                -- Total Revenue (paid invoices)
                (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status = 'paid') as total_revenue,
                
                -- Paid Invoices Count
                (SELECT COUNT(*) FROM invoices WHERE status = 'paid') as paid_count,
                
                -- Pending Amount (not overdue)
                (SELECT COALESCE(SUM(amount), 0) FROM invoices 
                 WHERE status = 'pending' AND due_date >= CURDATE()) as pending_amount,
                
                -- Overdue Amount (overdue + pending with past due)
                (SELECT COALESCE(SUM(amount), 0) FROM invoices 
                 WHERE status = 'overdue' OR (status = 'pending' AND due_date < CURDATE())) as overdue_amount,
                
                -- Total Invoices
                (SELECT COUNT(*) FROM invoices) as total_invoices,
                
                -- This Month Revenue
                (SELECT COALESCE(SUM(amount), 0) FROM invoices 
                 WHERE status = 'paid' AND MONTH(paid_date) = MONTH(CURDATE()) AND YEAR(paid_date) = YEAR(CURDATE())) as this_month_revenue
        `);

        const stats = quickStats[0];
        
        // For demo, using fixed percentage changes (you can calculate these dynamically if needed)
        const result = {
            total_revenue: {
                value: stats.total_revenue,
                formatted: `SAR ${stats.total_revenue.toFixed(2)}`,
                change: 12, // Fixed for demo, calculate dynamically for production
                isPositive: true
            },
            paid_invoices: {
                count: stats.paid_count,
                change: 8, // Fixed for demo
                isPositive: true
            },
            pending: {
                amount: stats.pending_amount,
                formatted: `SAR ${stats.pending_amount.toFixed(2)}`,
                change: 5, // Fixed for demo
                isPositive: true
            },
            overdue: {
                amount: stats.overdue_amount,
                formatted: `SAR ${stats.overdue_amount.toFixed(2)}`,
                change: 15, // Fixed for demo
                isPositive: false
            }
        };

        conn.release();

        return res.json({
            success: true,
            data: result,
            generated_at: new Date()
        });

    } catch (err) {
        console.error("Quick stats error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to calculate quick statistics",
            error: err.message
        });
    }
});

// Update overdue invoices (cron job or manual trigger)
router.post("/update-overdue", async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Update pending invoices with past due dates to overdue
        const [result] = await conn.query(`
            UPDATE invoices 
            SET status = 'overdue',
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending' 
            AND due_date < CURDATE()
        `);

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} invoice(s) marked as overdue`,
            data: {
                updated_count: result.affectedRows,
                updated_at: new Date()
            }
        });

    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error("Overdue update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update overdue invoices",
            error: err.message
        });
    }
});

// Get analytics data for charts
router.get("/stats/analytics", async (req, res) => {
    try {
        const { period = 'monthly', year } = req.query;
        const conn = await pool.getConnection();

        let analyticsData = {};

        if (period === 'monthly' && year) {
            // Monthly analytics for specific year
            const [monthlyData] = await conn.query(`
                SELECT 
                    DATE_FORMAT(issue_date, '%Y-%m') as month,
                    DATE_FORMAT(issue_date, '%b') as month_name,
                    COUNT(*) as total_invoices,
                    COALESCE(SUM(amount), 0) as total_amount,
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid_amount,
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_amount,
                    COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) as overdue_amount
                FROM invoices
                WHERE YEAR(issue_date) = ?
                GROUP BY DATE_FORMAT(issue_date, '%Y-%m'), DATE_FORMAT(issue_date, '%b')
                ORDER BY month
            `, [year]);

            analyticsData = {
                period: 'monthly',
                year: year,
                data: monthlyData
            };
        } else {
            // Yearly analytics
            const [yearlyData] = await conn.query(`
                SELECT 
                    YEAR(issue_date) as year,
                    COUNT(*) as total_invoices,
                    COALESCE(SUM(amount), 0) as total_amount,
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid_amount,
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_amount,
                    COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) as overdue_amount
                FROM invoices
                GROUP BY YEAR(issue_date)
                ORDER BY year
            `);

            analyticsData = {
                period: 'yearly',
                data: yearlyData
            };
        }

        // Get status summary
        const [statusSummary] = await conn.query(`
            SELECT 
                status,
                COUNT(*) as count,
                COALESCE(SUM(amount), 0) as amount,
                ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM invoices)), 1) as percentage
            FROM invoices
            GROUP BY status
            ORDER BY FIELD(status, 'paid', 'pending', 'overdue')
        `);

        // Get plan distribution
        const [planDistribution] = await conn.query(`
            SELECT 
                tenant_plan,
                COUNT(*) as count,
                COALESCE(SUM(amount), 0) as amount
            FROM invoices
            GROUP BY tenant_plan
            ORDER BY amount DESC
        `);

        conn.release();

        return res.json({
            success: true,
            data: {
                analytics: analyticsData,
                status_summary: statusSummary,
                plan_distribution: planDistribution,
                generated_at: new Date()
            }
        });

    } catch (err) {
        console.error("Analytics error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch analytics data",
            error: err.message
        });
    }
});

// Insert sample data
router.post("/sample-data", async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Clear existing data
        await conn.query("DELETE FROM invoices");

        // Sample data matching your screenshots
        const sampleInvoices = [
            {
                invoice_number: 'INV-00001',
                invoice_id: uuidv4(),
                tenant_id: 'tenant-001',
                tenant_name: 'Acme Corporation',
                tenant_plan: 'Professional',
                amount: 149.00,
                billing_period: 'November 2024',
                issue_date: '2024-11-01',
                due_date: '2024-11-15',
                paid_date: '2024-11-08',
                status: 'paid',
                notes: 'Monthly subscription for Professional plan'
            },
            {
                invoice_number: 'INV-00002',
                invoice_id: uuidv4(),
                tenant_id: 'tenant-002',
                tenant_name: 'TechFlow Solutions',
                tenant_plan: 'Enterprise',
                amount: 499.00,
                billing_period: 'November 2024',
                issue_date: '2024-11-01',
                due_date: '2024-11-15',
                paid_date: '2024-11-10',
                status: 'paid',
                notes: 'Enterprise plan with advanced features'
            },
            {
                invoice_number: 'INV-00003',
                invoice_id: uuidv4(),
                tenant_id: 'tenant-003',
                tenant_name: 'MediCare Services',
                tenant_plan: 'Professional',
                amount: 149.00,
                billing_period: 'November 2024',
                issue_date: '2024-11-01',
                due_date: '2024-11-15',
                paid_date: null,
                status: 'pending',
                notes: 'Monthly professional subscription'
            },
            {
                invoice_number: 'INV-00004',
                invoice_id: uuidv4(),
                tenant_id: 'tenant-004',
                tenant_name: 'FastDelivery Co',
                tenant_plan: 'Professional',
                amount: 149.00,
                billing_period: 'October 2024',
                issue_date: '2024-10-01',
                due_date: '2024-10-16',
                paid_date: null,
                status: 'overdue',
                notes: 'October monthly subscription'
            }
        ];

        // Insert sample invoices
        for (const invoice of sampleInvoices) {
            await conn.query(`
                INSERT INTO invoices (
                    invoice_number, invoice_id, tenant_id, tenant_name, tenant_plan,
                    amount, billing_period, issue_date, due_date, paid_date,
                    status, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, Object.values(invoice));
        }

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: "Sample data inserted successfully",
            data: {
                invoice_count: sampleInvoices.length,
                inserted_at: new Date()
            }
        });

    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error("Sample data error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to insert sample data",
            error: err.message
        });
    }
});

module.exports = router;