const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const { v4: uuidv4 } = require('uuid');

// Helper function to generate IDs
function generateId(prefix = "rep") {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 6);
    return `${prefix}-${timestamp}-${random}`;
}

// Helper function to format date
function formatDate(date) {
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

// Helper function to format file size
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to parse JSON
function parseJSON(data) {
    if (!data) return {};
    if (typeof data === 'string') {
        try {
            return JSON.parse(data);
        } catch (e) {
            return {};
        }
    }
    return data || {};
}

// ==================== REPORTS API ====================

// Get all reports with filters
router.get("/", async (req, res) => {
    try {
        const {
            report_type,
            status,
            period,
            search,
            start_date,
            end_date,
            page = 1,
            limit = 10,
            sort_by = 'generated_at',
            sort_order = 'DESC'
        } = req.query;

        const conn = await pool.getConnection();
        let query = `SELECT * FROM reports WHERE 1=1`;
        const params = [];

        // Apply filters
        if (report_type && report_type !== 'all') {
            query += " AND report_type = ?";
            params.push(report_type);
        }

        if (status && status !== 'all') {
            query += " AND status = ?";
            params.push(status);
        }

        if (period) {
            query += " AND period LIKE ?";
            params.push(`%${period}%`);
        }

        if (search) {
            query += " AND (report_name LIKE ? OR report_type LIKE ? OR generated_by LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        if (start_date) {
            query += " AND DATE(generated_at) >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND DATE(generated_at) <= ?";
            params.push(end_date);
        }

        // Get total count
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [countResult] = await conn.query(countQuery, params);
        const total = countResult[0].total;

        // Apply sorting and pagination
        const validSortColumns = ['id', 'report_name', 'report_type', 'status', 'generated_at', 'download_count'];
        const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'generated_at';
        const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        query += ` ORDER BY ${sortColumn} ${sortDirection} LIMIT ? OFFSET ?`;
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        conn.release();

        // Format the response
        const formattedRows = rows.map(row => ({
            ...row,
            formatted_generated_at: formatDate(row.generated_at),
            formatted_completed_at: row.completed_at ? formatDate(row.completed_at) : null,
            parameters: parseJSON(row.parameters),
            file_size_formatted: row.file_size
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
        console.error("Reports fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch reports",
            error: err.message
        });
    }
});

// Get report statistics
router.get("/stats", async (req, res) => {
    try {
        const { period = 'month' } = req.query;
        const conn = await pool.getConnection();

        let dateFilter = '';
        switch (period) {
            case 'today':
                dateFilter = "DATE(generated_at) = CURDATE()";
                break;
            case 'week':
                dateFilter = "generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)";
                break;
            case 'month':
                dateFilter = "generated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)";
                break;
            case 'year':
                dateFilter = "generated_at >= DATE_SUB(NOW(), INTERVAL 365 DAY)";
                break;
        }

        const whereClause = dateFilter ? `WHERE ${dateFilter}` : '';

        // Get total reports count
        const [totalResult] = await conn.query(
            `SELECT COUNT(*) as total FROM reports ${whereClause}`
        );

        // Get this month's count
        const [monthResult] = await conn.query(
            `SELECT COUNT(*) as count FROM reports WHERE MONTH(generated_at) = MONTH(CURDATE()) AND YEAR(generated_at) = YEAR(CURDATE())`
        );

        // Get scheduled active count
        const [scheduledResult] = await conn.query(
            `SELECT COUNT(*) as count FROM scheduled_reports WHERE is_active = true`
        );

        // Get total downloads
        const [downloadsResult] = await conn.query(
            `SELECT SUM(download_count) as total FROM reports`
        );

        // Get reports by type
        const [typeStats] = await conn.query(`
            SELECT 
                report_type,
                COUNT(*) as count
            FROM reports
            ${whereClause}
            GROUP BY report_type
            ORDER BY count DESC
        `);

        // Get recent reports
        const [recentReports] = await conn.query(`
            SELECT 
                report_id,
                report_name,
                report_type,
                status,
                generated_at,
                file_size
            FROM reports
            ORDER BY generated_at DESC
            LIMIT 5
        `);

        // Calculate percentage changes (simplified - you might want to compare with previous period)
        const percentageFromLastMonth = '+12%';
        const percentageThisMonth = '+8%';
        const percentageScheduled = '+2%';
        const percentageDownloads = '+15%';

        conn.release();

        return res.json({
            success: true,
            data: {
                total_reports: totalResult[0].total || 0,
                this_month: monthResult[0].count || 0,
                scheduled_active: scheduledResult[0].count || 0,
                total_downloads: downloadsResult[0].total || 0,
                type_stats: typeStats,
                recent_reports: recentReports.map(report => ({
                    ...report,
                    formatted_generated_at: formatDate(report.generated_at)
                })),
                percentages: {
                    total_reports_change: percentageFromLastMonth,
                    this_month_change: percentageThisMonth,
                    scheduled_active_change: percentageScheduled,
                    total_downloads_change: percentageDownloads
                },
                period: period
            }
        });

    } catch (err) {
        console.error("Reports stats error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch report statistics",
            error: err.message
        });
    }
});

// Get report by ID
router.get("/:id", async (req, res) => {
    try {
        const reportId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            'SELECT * FROM reports WHERE report_id = ? OR id = ?',
            [reportId, reportId]
        );

        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        // Increment view count
        await conn.query(
            'UPDATE reports SET view_count = view_count + 1 WHERE id = ?',
            [rows[0].id]
        );

        // Log view in analytics
        await conn.query(
            'INSERT INTO report_analytics (report_id, action, user_id, user_role) VALUES (?, ?, ?, ?)',
            [rows[0].report_id, 'view', 'admin', 'super_admin']
        );

        const report = rows[0];
        report.formatted_generated_at = formatDate(report.generated_at);
        report.formatted_completed_at = report.completed_at ? formatDate(report.completed_at) : null;
        report.parameters = parseJSON(report.parameters);

        conn.release();

        return res.json({
            success: true,
            data: report
        });

    } catch (err) {
        console.error("Report fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch report",
            error: err.message
        });
    }
});

// Generate new report
router.post("/generate", async (req, res) => {
    try {
        const {
            report_name,
            report_type,
            period,
            format = 'PDF',
            parameters = {},
            generated_by = 'Super Admin'
        } = req.body;

        // Validate required fields
        if (!report_name || !report_type) {
            return res.status(400).json({
                success: false,
                message: "Report name and type are required"
            });
        }

        const conn = await pool.getConnection();
        const reportId = generateId('rep');

        // Start report generation
        const [result] = await conn.query(`
            INSERT INTO reports (
                report_id,
                report_name,
                report_type,
                period,
                format,
                parameters,
                generated_by,
                status,
                generated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', NOW())
        `, [
            reportId,
            report_name,
            report_type,
            period || null,
            format,
            JSON.stringify(parameters),
            generated_by
        ]);

        // Log generation history
        await conn.query(`
            INSERT INTO report_generation_history (report_id, status, started_at)
            VALUES (?, 'started', NOW())
        `, [reportId]);

        conn.release();

        // Simulate report generation (in real app, this would be async job)
        setTimeout(async () => {
            const conn2 = await pool.getConnection();
            const fileSize = Math.floor(Math.random() * 5000) + 100; // Random size between 100KB and 5MB
            
            await conn2.query(`
                UPDATE reports 
                SET 
                    status = 'completed',
                    completed_at = NOW(),
                    file_size = ?,
                    file_path = ?
                WHERE report_id = ?
            `, [
                `${fileSize} KB`,
                `/reports/${reportId}.${format.toLowerCase()}`,
                reportId
            ]);

            await conn2.query(`
                UPDATE report_generation_history 
                SET 
                    status = 'completed',
                    completed_at = NOW(),
                    file_path = ?,
                    file_size = ?
                WHERE report_id = ?
            `, [
                `/reports/${reportId}.${format.toLowerCase()}`,
                `${fileSize} KB`,
                reportId
            ]);

            conn2.release();
        }, 2000); // Simulate 2 second processing time

        return res.status(201).json({
            success: true,
            message: "Report generation started",
            data: {
                report_id: reportId,
                report_name,
                report_type,
                status: 'processing',
                generated_at: new Date().toISOString()
            }
        });

    } catch (err) {
        console.error("Report generation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to generate report",
            error: err.message
        });
    }
});

// Download report
router.get("/:id/download", async (req, res) => {
    try {
        const reportId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            'SELECT * FROM reports WHERE report_id = ? OR id = ?',
            [reportId, reportId]
        );

        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        const report = rows[0];
        
        if (report.status !== 'completed') {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Report is not ready for download"
            });
        }

        // Increment download count
        await conn.query(
            'UPDATE reports SET download_count = download_count + 1 WHERE id = ?',
            [report.id]
        );

        // Log download in analytics
        await conn.query(
            'INSERT INTO report_analytics (report_id, action, user_id, user_role) VALUES (?, ?, ?, ?)',
            [report.report_id, 'download', 'admin', 'super_admin']
        );

        conn.release();

        // In a real app, you would serve the actual file
        // For now, return file info
        return res.json({
            success: true,
            message: "Report ready for download",
            data: {
                report_id: report.report_id,
                report_name: report.report_name,
                file_path: report.file_path,
                file_size: report.file_size,
                format: report.format,
                download_url: `/api/reports/${report.report_id}/file`
            }
        });

    } catch (err) {
        console.error("Report download error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to prepare report download",
            error: err.message
        });
    }
});

// Delete report
router.delete("/:id", async (req, res) => {
    try {
        const reportId = req.params.id;
        const conn = await pool.getConnection();

        // Check if report exists
        const [checkResult] = await conn.query(
            'SELECT * FROM reports WHERE report_id = ? OR id = ?',
            [reportId, reportId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        // Delete report
        const [result] = await conn.query(
            'DELETE FROM reports WHERE report_id = ? OR id = ?',
            [reportId, reportId]
        );

        // Also delete analytics and history for this report
        await conn.query(
            'DELETE FROM report_analytics WHERE report_id = ?',
            [checkResult[0].report_id]
        );

        await conn.query(
            'DELETE FROM report_generation_history WHERE report_id = ?',
            [checkResult[0].report_id]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Report deleted successfully",
            data: {
                deleted_id: reportId,
                report_name: checkResult[0].report_name
            }
        });

    } catch (err) {
        console.error("Report delete error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete report",
            error: err.message
        });
    }
});

// ==================== SCHEDULED REPORTS API ====================

// Get all scheduled reports
router.get("/scheduled/list", async (req, res) => {
    try {
        const {
            is_active,
            report_type,
            search,
            page = 1,
            limit = 10
        } = req.query;

        const conn = await pool.getConnection();
        
        // Make sure you're querying the correct table
        let query = `SELECT * FROM scheduled_reports WHERE 1=1`;
        const params = [];

        // Add debug logging
        console.log("Query parameters:", { is_active, report_type, search, page, limit });

        if (is_active !== undefined) {
            query += " AND is_active = ?";
            params.push(is_active === 'true');
        }

        if (report_type && report_type !== 'all') {
            query += " AND report_type = ?";
            params.push(report_type);
        }

        if (search) {
            query += " AND (schedule_name LIKE ? OR report_type LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        console.log("Final query:", query);
        console.log("Query params:", params);

        // Get total count
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [countResult] = await conn.query(countQuery, params);
        const total = countResult[0].total;

        console.log("Total records found:", total);

        // Apply pagination
        query += " ORDER BY next_run ASC LIMIT ? OFFSET ?";
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        
        console.log("Rows returned:", rows.length);
        console.log("Sample row:", rows[0]);

        conn.release();

        // Helper functions
        const formatDate = (date) => {
            if (!date) return null;
            return new Date(date).toLocaleString();
        };

        const parseJSON = (jsonString) => {
            if (!jsonString) return {};
            try {
                return JSON.parse(jsonString);
            } catch (e) {
                console.error("JSON parse error:", e);
                return {};
            }
        };

        const formattedRows = rows.map(row => ({
            ...row,
            formatted_next_run: formatDate(row.next_run),
            formatted_last_run: row.last_run ? formatDate(row.last_run) : null,
            recipients_list: row.recipients ? row.recipients.split(',').map(email => email.trim()) : [],
            frequency_config: parseJSON(row.frequency_config),
            parameters: parseJSON(row.parameters)
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
        console.error("Scheduled reports fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch scheduled reports",
            error: err.message
        });
    }
});
// Create scheduled report
router.post("/scheduled", async (req, res) => {
    try {
        const {
            schedule_name,
            report_type,
            frequency,
            frequency_config = {},
            recipients,
            format = 'PDF',
            time = '09:00:00',
            parameters = {},
            created_by = 'Super Admin',
            is_active = true
        } = req.body;

        // Validate required fields
        if (!schedule_name || !report_type || !frequency || !recipients) {
            return res.status(400).json({
                success: false,
                message: "Schedule name, report type, frequency, and recipients are required"
            });
        }

        // Calculate next run based on frequency
        let nextRun = new Date();
        const scheduleTime = time.split(':');
        nextRun.setHours(parseInt(scheduleTime[0]), parseInt(scheduleTime[1]), 0);

        switch (frequency) {
            case 'daily':
                nextRun.setDate(nextRun.getDate() + 1);
                break;
            case 'weekly':
                const dayOfWeek = frequency_config.day_of_week || 1; // Monday
                const daysUntilNext = (dayOfWeek + 7 - nextRun.getDay()) % 7 || 7;
                nextRun.setDate(nextRun.getDate() + daysUntilNext);
                break;
            case 'monthly':
                const dayOfMonth = frequency_config.day_of_month || 1;
                nextRun.setDate(dayOfMonth);
                if (nextRun <= new Date()) {
                    nextRun.setMonth(nextRun.getMonth() + 1);
                }
                break;
        }

        const conn = await pool.getConnection();
        const scheduleId = generateId('sch');

        const [result] = await conn.query(`
            INSERT INTO scheduled_reports (
                schedule_id,
                schedule_name,
                report_type,
                frequency,
                frequency_config,
                recipients,
                format,
                time,
                next_run,
                created_by,
                is_active,
                parameters
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            scheduleId,
            schedule_name,
            report_type,
            frequency,
            JSON.stringify(frequency_config),
            recipients,
            format,
            time,
            nextRun,
            created_by,
            is_active,
            JSON.stringify(parameters)
        ]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Report schedule created successfully",
            data: {
                schedule_id: scheduleId,
                schedule_name,
                report_type,
                frequency,
                next_run: nextRun.toISOString(),
                is_active
            }
        });

    } catch (err) {
        console.error("Schedule creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create report schedule",
            error: err.message
        });
    }
});

// Update scheduled report
router.put("/scheduled/:id", async (req, res) => {
    try {
        const scheduleId = req.params.id;
        const updates = req.body;

        const conn = await pool.getConnection();

        // Check if schedule exists
        const [checkResult] = await conn.query(
            'SELECT * FROM scheduled_reports WHERE schedule_id = ? OR id = ?',
            [scheduleId, scheduleId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Schedule not found"
            });
        }

        // Build update query
        const updateFields = [];
        const updateParams = [];

        const allowedFields = [
            'schedule_name', 'report_type', 'frequency', 'frequency_config',
            'recipients', 'format', 'time', 'is_active', 'parameters'
        ];

        allowedFields.forEach(field => {
            if (updates[field] !== undefined) {
                updateFields.push(`${field} = ?`);
                updateParams.push(
                    field === 'frequency_config' || field === 'parameters' 
                    ? JSON.stringify(updates[field]) 
                    : updates[field]
                );
            }
        });

        if (updateFields.length === 0) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No fields to update"
            });
        }

        // If frequency or time changed, recalculate next_run
        if (updates.frequency || updates.time) {
            const schedule = checkResult[0];
            const frequency = updates.frequency || schedule.frequency;
            const time = updates.time || schedule.time;
            const frequencyConfig = updates.frequency_config || parseJSON(schedule.frequency_config);

            let nextRun = new Date();
            const scheduleTime = time.split(':');
            nextRun.setHours(parseInt(scheduleTime[0]), parseInt(scheduleTime[1]), 0);

            switch (frequency) {
                case 'daily':
                    nextRun.setDate(nextRun.getDate() + 1);
                    break;
                case 'weekly':
                    const dayOfWeek = frequencyConfig.day_of_week || 1;
                    const daysUntilNext = (dayOfWeek + 7 - nextRun.getDay()) % 7 || 7;
                    nextRun.setDate(nextRun.getDate() + daysUntilNext);
                    break;
                case 'monthly':
                    const dayOfMonth = frequencyConfig.day_of_month || 1;
                    nextRun.setDate(dayOfMonth);
                    if (nextRun <= new Date()) {
                        nextRun.setMonth(nextRun.getMonth() + 1);
                    }
                    break;
            }

            updateFields.push('next_run = ?');
            updateParams.push(nextRun);
        }

        updateFields.push('updated_at = NOW()');
        updateParams.push(scheduleId, scheduleId);

        const query = `
            UPDATE scheduled_reports 
            SET ${updateFields.join(', ')}
            WHERE schedule_id = ? OR id = ?
        `;

        const [result] = await conn.query(query, updateParams);
        conn.release();

        return res.json({
            success: true,
            message: "Schedule updated successfully"
        });

    } catch (err) {
        console.error("Schedule update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update schedule",
            error: err.message
        });
    }
});

// Delete scheduled report
router.delete("/scheduled/:id", async (req, res) => {
    try {
        const scheduleId = req.params.id;
        const conn = await pool.getConnection();

        // Check if schedule exists
        const [checkResult] = await conn.query(
            'SELECT * FROM scheduled_reports WHERE schedule_id = ? OR id = ?',
            [scheduleId, scheduleId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Schedule not found"
            });
        }

        // Delete schedule
        const [result] = await conn.query(
            'DELETE FROM scheduled_reports WHERE schedule_id = ? OR id = ?',
            [scheduleId, scheduleId]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Schedule deleted successfully",
            data: {
                deleted_id: scheduleId,
                schedule_name: checkResult[0].schedule_name
            }
        });

    } catch (err) {
        console.error("Schedule delete error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete schedule",
            error: err.message
        });
    }
});

// Trigger scheduled report manually
router.post("/scheduled/:id/trigger", async (req, res) => {
    try {
        const scheduleId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            'SELECT * FROM scheduled_reports WHERE schedule_id = ? OR id = ?',
            [scheduleId, scheduleId]
        );

        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Schedule not found"
            });
        }

        const schedule = rows[0];

        // Generate report based on schedule
        const reportId = generateId('rep');
        const period = `${new Date().toLocaleString('default', { month: 'long' })} ${new Date().getFullYear()}`;
        
        await conn.query(`
            INSERT INTO reports (
                report_id,
                report_name,
                report_type,
                period,
                format,
                parameters,
                generated_by,
                status,
                generated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'System (Scheduled)', 'processing', NOW())
        `, [
            reportId,
            `${schedule.schedule_name} - ${new Date().toLocaleDateString()}`,
            schedule.report_type,
            period,
            schedule.format,
            schedule.parameters
        ]);

        // Update schedule last run
        await conn.query(`
            UPDATE scheduled_reports 
            SET last_run = NOW(), last_run_status = 'triggered'
            WHERE id = ?
        `, [schedule.id]);

        conn.release();

        // Simulate processing
        setTimeout(async () => {
            const conn2 = await pool.getConnection();
            const fileSize = Math.floor(Math.random() * 5000) + 100;
            
            await conn2.query(`
                UPDATE reports 
                SET 
                    status = 'completed',
                    completed_at = NOW(),
                    file_size = ?,
                    file_path = ?
                WHERE report_id = ?
            `, [
                `${fileSize} KB`,
                `/reports/${reportId}.${schedule.format.toLowerCase()}`,
                reportId
            ]);

            // Here you would also send emails to recipients
            console.log(`Report ${reportId} generated. Would send to: ${schedule.recipients}`);

            conn2.release();
        }, 2000);

        return res.json({
            success: true,
            message: "Scheduled report triggered successfully",
            data: {
                schedule_id: schedule.schedule_id,
                report_id: reportId,
                status: 'processing'
            }
        });

    } catch (err) {
        console.error("Schedule trigger error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to trigger scheduled report",
            error: err.message
        });
    }
});

// ==================== TEMPLATES API ====================

// Get all report templates
router.get("/templates/list", async (req, res) => {
    try {
        const { report_type, is_default, search } = req.query;
        const conn = await pool.getConnection();

        let query = `SELECT * FROM report_templates WHERE 1=1`;
        const params = [];

        if (report_type && report_type !== 'all') {
            query += " AND report_type = ?";
            params.push(report_type);
        }

        if (is_default !== undefined) {
            query += " AND is_default = ?";
            params.push(is_default === 'true');
        }

        if (search) {
            query += " AND (template_name LIKE ? OR report_type LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        query += " ORDER BY created_at DESC";

        const [rows] = await conn.query(query, params);
        conn.release();

        const formattedRows = rows.map(row => ({
            ...row,
            parameters: parseJSON(row.parameters),
            formatted_created_at: formatDate(row.created_at)
        }));

        return res.json({
            success: true,
            data: formattedRows,
            count: formattedRows.length
        });

    } catch (err) {
        console.error("Templates fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch templates",
            error: err.message
        });
    }
});

// Create report template
router.post("/templates/add", async (req, res) => {
    try {
        const {
            template_name,
            report_type,
            description,
            parameters = {},
            is_default = false,
            created_by = 'Super Admin'
        } = req.body;

        if (!template_name || !report_type) {
            return res.status(400).json({
                success: false,
                message: "Template name and report type are required"
            });
        }

        const conn = await pool.getConnection();
        const templateId = generateId('tpl');

        const [result] = await conn.query(`
            INSERT INTO report_templates (
                template_id,
                template_name,
                report_type,
                description,
                parameters,
                is_default,
                created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            templateId,
            template_name,
            report_type,
            description || null,
            JSON.stringify(parameters),
            is_default,
            created_by
        ]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Template created successfully",
            data: {
                template_id: templateId,
                template_name,
                report_type,
                is_default
            }
        });

    } catch (err) {
        console.error("Template creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create template",
            error: err.message
        });
    }
});

// ==================== ANALYTICS API ====================

// Get report analytics
router.get("/analytics/summary", async (req, res) => {
    try {
        const { period = 'month' } = req.query;
        const conn = await pool.getConnection();

        let dateFilter = '';
        switch (period) {
            case 'today':
                dateFilter = "DATE(accessed_at) = CURDATE()";
                break;
            case 'week':
                dateFilter = "accessed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)";
                break;
            case 'month':
                dateFilter = "accessed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)";
                break;
            case 'year':
                dateFilter = "accessed_at >= DATE_SUB(NOW(), INTERVAL 365 DAY)";
                break;
        }

        const whereClause = dateFilter ? `WHERE ${dateFilter}` : '';

        // Get top reports by views
        const [topViews] = await conn.query(`
            SELECT 
                r.report_id,
                r.report_name,
                r.report_type,
                COUNT(CASE WHEN ra.action = 'view' THEN 1 END) as views,
                COUNT(CASE WHEN ra.action = 'download' THEN 1 END) as downloads
            FROM reports r
            LEFT JOIN report_analytics ra ON r.report_id = ra.report_id
            ${whereClause ? 'WHERE ' + dateFilter.replace('accessed_at', 'ra.accessed_at') : ''}
            GROUP BY r.id
            ORDER BY views DESC
            LIMIT 10
        `);

        // Get actions by type
        const [actionsByType] = await conn.query(`
            SELECT 
                r.report_type,
                COUNT(CASE WHEN ra.action = 'view' THEN 1 END) as views,
                COUNT(CASE WHEN ra.action = 'download' THEN 1 END) as downloads
            FROM report_analytics ra
            JOIN reports r ON ra.report_id = r.report_id
            ${whereClause}
            GROUP BY r.report_type
            ORDER BY views DESC
        `);

        // Get daily trends
        const [dailyTrends] = await conn.query(`
            SELECT 
                DATE(accessed_at) as date,
                COUNT(CASE WHEN action = 'view' THEN 1 END) as views,
                COUNT(CASE WHEN action = 'download' THEN 1 END) as downloads
            FROM report_analytics
            WHERE accessed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY DATE(accessed_at)
            ORDER BY date DESC
        `);

        conn.release();

        return res.json({
            success: true,
            data: {
                top_reports: topViews,
                actions_by_type: actionsByType,
                daily_trends: dailyTrends.map(trend => ({
                    ...trend,
                    formatted_date: formatDate(trend.date)
                })),
                period: period
            }
        });

    } catch (err) {
        console.error("Analytics fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch analytics",
            error: err.message
        });
    }
});

// Get generation trends
router.get("/analytics/trends", async (req, res) => {
    try {
        const { group_by = 'month', limit = 12 } = req.query;
        const conn = await pool.getConnection();

        let groupClause, dateFormat;
        switch (group_by) {
            case 'day':
                groupClause = "DATE(generated_at)";
                dateFormat = "%Y-%m-%d";
                break;
            case 'week':
                groupClause = "YEARWEEK(generated_at)";
                dateFormat = "%Y Week %v";
                break;
            case 'month':
            default:
                groupClause = "DATE_FORMAT(generated_at, '%Y-%m')";
                dateFormat = "%Y-%m";
                break;
        }

        const [trends] = await conn.query(`
            SELECT 
                ${groupClause} as period_group,
                DATE_FORMAT(MIN(generated_at), '${dateFormat}') as period_label,
                COUNT(*) as report_count,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
                SUM(download_count) as total_downloads
            FROM reports
            WHERE generated_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
            GROUP BY ${groupClause}
            ORDER BY period_group DESC
            LIMIT ?
        `, [limit, parseInt(limit)]);

        conn.release();

        return res.json({
            success: true,
            data: {
                trends: trends.reverse(), // Show oldest first
                group_by: group_by
            }
        });

    } catch (err) {
        console.error("Trends fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch generation trends",
            error: err.message
        });
    }
});

// ==================== DASHBOARD SUMMARY ====================

// Get dashboard overview
router.get("/dashboard/overview", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Get quick stats
        const [stats] = await conn.query(`
            SELECT 
                COUNT(*) as total_reports,
                COUNT(CASE WHEN MONTH(generated_at) = MONTH(CURDATE()) THEN 1 END) as this_month,
                COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
                COALESCE(SUM(download_count), 0) as total_downloads
            FROM reports
        `);

        // Get report types distribution
        const [typeDistribution] = await conn.query(`
            SELECT 
                report_type,
                COUNT(*) as count
            FROM reports
            GROUP BY report_type
            ORDER BY count DESC
            LIMIT 5
        `);

        // Get recent reports
        const [recentReports] = await conn.query(`
            SELECT 
                report_id,
                report_name,
                report_type,
                status,
                generated_at,
                file_size,
                download_count
            FROM reports
            ORDER BY generated_at DESC
            LIMIT 5
        `);

        // Get active schedules
        const [activeSchedules] = await conn.query(`
            SELECT 
                schedule_id,
                schedule_name,
                report_type,
                frequency,
                next_run
            FROM scheduled_reports
            WHERE is_active = true
            ORDER BY next_run ASC
            LIMIT 5
        `);

        // Get top performers
        const [topPerformers] = await conn.query(`
            SELECT 
                report_id,
                report_name,
                report_type,
                download_count,
                view_count
            FROM reports
            ORDER BY download_count DESC
            LIMIT 5
        `);

        conn.release();

        return res.json({
            success: true,
            data: {
                stats: {
                    total_reports: stats[0].total_reports || 0,
                    this_month: stats[0].this_month || 0,
                    processing: stats[0].processing || 0,
                    total_downloads: stats[0].total_downloads || 0
                },
                type_distribution: typeDistribution,
                recent_reports: recentReports.map(report => ({
                    ...report,
                    formatted_generated_at: formatDate(report.generated_at)
                })),
                active_schedules: activeSchedules.map(schedule => ({
                    ...schedule,
                    formatted_next_run: formatDate(schedule.next_run)
                })),
                top_performers: topPerformers
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

// ==================== BULK OPERATIONS ====================

// Bulk delete reports - using only 'id' column
router.delete("/bulk/delete", async (req, res) => {
    try {
        const { report_ids } = req.body;
        
        if (!report_ids || !Array.isArray(report_ids) || report_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "report_ids array is required"
            });
        }

        const conn = await pool.getConnection();

        // Get existing reports using 'id' column
        const placeholders = report_ids.map(() => '?').join(',');
        const [existingReports] = await conn.query(
            `SELECT id FROM reports WHERE id IN (${placeholders})`,
            report_ids
        );

        if (existingReports.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "No reports found with the provided IDs"
            });
        }

        const existingIds = existingReports.map(r => r.id);

        // Delete reports using 'id' column
        const [result] = await conn.query(
            `DELETE FROM reports WHERE id IN (${placeholders})`,
            existingIds
        );

        // Delete related analytics - assuming analytics table has 'id' as foreign key
        // If analytics table uses a different column name, adjust accordingly
        await conn.query(
            `DELETE FROM report_analytics WHERE report_id IN (${placeholders})`,
            existingIds
        );

        // Delete related generation history
        await conn.query(
            `DELETE FROM report_generation_history WHERE report_id IN (${placeholders})`,
            existingIds
        );

        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} report(s) deleted successfully`,
            data: {
                deleted_count: result.affectedRows,
                deleted_ids: existingIds
            }
        });

    } catch (err) {
        console.error("Bulk delete error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete reports",
            error: err.message
        });
    }
});
// Update report status
router.patch("/:id/status", async (req, res) => {
    try {
        const reportId = req.params.id;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                message: "Status is required"
            });
        }

        const validStatuses = ['processing', 'completed', 'failed', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const conn = await pool.getConnection();

        // Check if report exists
        const [checkResult] = await conn.query(
            'SELECT * FROM reports WHERE id = ? OR id = ?',
            [reportId, reportId]
        );

        if (checkResult.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        const updateData = { status };
        if (status === 'completed') {
            updateData.completed_at = new Date();
        }

        const [result] = await conn.query(
            'UPDATE reports SET status = ?, completed_at = ? WHERE id = ?',
            [status, updateData.completed_at || null, checkResult[0].id]
        );

        // Update generation history
        await conn.query(`
            UPDATE report_generation_history 
            SET status = ?, completed_at = ?
            WHERE id = ?
        `, [status, updateData.completed_at || null, checkResult[0].id]);

        conn.release();

        return res.json({
            success: true,
            message: "Report status updated successfully",
            data: {
                report_id: checkResult[0].id,
                new_status: status
            }
        });

    } catch (err) {
        console.error("Status update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update report status",
            error: err.message
        });
    }
});

// Search reports
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

        // Search in reports
        const [reports] = await conn.query(`
            SELECT 
                report_id,
                report_name,
                report_type,
                status,
                generated_at,
                'report' as type
            FROM reports
            WHERE 
                report_name LIKE ? OR 
                report_type LIKE ? OR
                period LIKE ?
            ORDER BY generated_at DESC
            LIMIT ?
        `, [searchTerm, searchTerm, searchTerm, parseInt(limit)]);

        // Search in scheduled reports
        const [schedules] = await conn.query(`
            SELECT 
                schedule_id,
                schedule_name,
                report_type,
                frequency,
                next_run,
                'schedule' as type
            FROM scheduled_reports
            WHERE schedule_name LIKE ? OR report_type LIKE ?
            ORDER BY next_run ASC
            LIMIT ?
        `, [searchTerm, searchTerm, parseInt(limit)]);

        conn.release();

        const formattedResults = [
            ...reports.map(r => ({
                ...r,
                formatted_generated_at: formatDate(r.generated_at)
            })),
            ...schedules.map(s => ({
                ...s,
                formatted_next_run: formatDate(s.next_run)
            }))
        ];

        return res.json({
            success: true,
            data: formattedResults,
            counts: {
                reports: reports.length,
                schedules: schedules.length,
                total: formattedResults.length
            },
            query: query
        });

    } catch (err) {
        console.error("Search error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to search reports",
            error: err.message
        });
    }
});

module.exports = router;