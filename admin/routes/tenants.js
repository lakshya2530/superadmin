const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const { v4: uuidv4 } = require('uuid');

// ==================== TENANTS API ====================

// Get all tenants with filters
router.get("/tenants", async (req, res) => {
    try {
        const {
            status,
            health_status,
            deployment_type,
            search,
            page = 1,
            limit = 10
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                t.*,
                tud.avg_usage_percentage,
                tud.current_users,
                tud.max_users,
                tud.current_customers,
                tud.max_customers,
                tud.current_visits,
                tud.max_visits,
                tud.current_storage_gb,
                tud.max_storage_gb,
                tud.api_calls_this_month,
                tud.last_activity_date,
                tud.monthly_recurring_revenue,
                (SELECT COUNT(*) FROM system_alerts sa 
                 WHERE sa.tenant_id = t.id AND sa.is_resolved = FALSE AND sa.alert_type = 'critical') as critical_alerts_count,
                (SELECT COUNT(*) FROM system_alerts sa 
                 WHERE sa.tenant_id = t.id AND sa.is_resolved = FALSE AND sa.alert_type = 'warning') as warning_alerts_count
            FROM tenants t
            LEFT JOIN tenant_usage_details tud ON t.id = tud.tenant_id 
            AND tud.metric_date = (SELECT MAX(metric_date) FROM tenant_usage_details WHERE tenant_id = t.id)
            WHERE 1=1
        `;
        
        const params = [];

        // Apply filters
        if (status && status !== 'all') {
            query += " AND t.status = ?";
            params.push(status);
        }

        if (health_status && health_status !== 'all') {
            query += " AND t.health_status = ?";
            params.push(health_status);
        }

        if (deployment_type && deployment_type !== 'all') {
            query += " AND t.deployment_type = ?";
            params.push(deployment_type);
        }

        if (search) {
            query += " AND (t.name LIKE ? OR t.plan LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        // Get total count
        const countQuery = query.replace('SELECT t.*, tud.avg_usage_percentage,', 'SELECT COUNT(DISTINCT t.id) as total');
        const countQueryClean = countQuery.split('ORDER BY')[0]; // Remove ORDER BY for count
        const [countResult] = await conn.query(countQueryClean, params);
        const total = countResult[0]?.total || 0;

        // Apply pagination
        query += " ORDER BY t.name ASC LIMIT ? OFFSET ?";
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        conn.release();

        // Format the response
        const formattedRows = rows.map(tenant => ({
            ...tenant,
            usage_percentage: tenant.avg_usage_percentage || 0,
            health_status: tenant.health_status || 'unknown',
            formatted_last_activity: tenant.last_activity_date 
                ? new Date(tenant.last_activity_date).toLocaleDateString('en-US', { 
                    month: 'short', 
                    day: 'numeric', 
                    year: 'numeric' 
                })
                : null
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
        console.error("Tenants fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch tenants",
            error: err.message
        });
    }
});

// Get tenant by ID
router.get("/tenants/:id", async (req, res) => {
    try {
        const tenantId = req.params.id;
        const conn = await pool.getConnection();

        // Get tenant details
        const [tenantRows] = await conn.query(
            'SELECT * FROM tenants WHERE id = ?',
            [tenantId]
        );

        if (tenantRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Tenant not found"
            });
        }

        // Get latest usage details
        const [usageRows] = await conn.query(
            `SELECT * FROM tenant_usage_details 
             WHERE tenant_id = ? 
             ORDER BY metric_date DESC 
             LIMIT 1`,
            [tenantId]
        );

        // Get active alerts
        const [alertRows] = await conn.query(
            `SELECT * FROM system_alerts 
             WHERE tenant_id = ? AND is_resolved = FALSE 
             ORDER BY alert_type DESC, created_at DESC`,
            [tenantId]
        );

        // Get software management
        const [softwareRows] = await conn.query(
            `SELECT * FROM software_management 
             WHERE tenant_id = ? 
             ORDER BY software_name`,
            [tenantId]
        );

        const tenant = tenantRows[0];
        tenant.usage_details = usageRows[0] || {};
        tenant.alerts = alertRows;
        tenant.software = softwareRows;

        conn.release();

        return res.json({
            success: true,
            data: tenant
        });

    } catch (err) {
        console.error("Tenant fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch tenant",
            error: err.message
        });
    }
});

// Create new tenant
router.post("/tenants", async (req, res) => {
    try {
        const {
            name,
            status = 'active',
            health_status = 'healthy',
            plan = 'Professional',
            deployment_type = 'centralized',
            is_self_hosted = false,
            is_self_managed = false
        } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: "Tenant name is required"
            });
        }

        const conn = await pool.getConnection();
        const tenantId = uuidv4();

        // Create tenant
        const [result] = await conn.query(`
            INSERT INTO tenants (
                id,
                name,
                status,
                health_status,
                plan,
                deployment_type,
                is_self_hosted,
                is_self_managed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            tenantId,
            name,
            status,
            health_status,
            plan,
            deployment_type,
            is_self_hosted,
            is_self_managed
        ]);

        // Create initial usage details
        await conn.query(`
            INSERT INTO tenant_usage_details (
                tenant_id,
                metric_date
            ) VALUES (?, CURRENT_DATE)
        `, [tenantId]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Tenant created successfully",
            data: {
                id: tenantId,
                name,
                status,
                health_status,
                plan
            }
        });

    } catch (err) {
        console.error("Tenant creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create tenant",
            error: err.message
        });
    }
});

// Update tenant usage details
router.put("/tenants/:id/usage", async (req, res) => {
    try {
        const tenantId = req.params.id;
        const usageData = req.body;

        const conn = await pool.getConnection();

        // Check if tenant exists
        const [tenantRows] = await conn.query(
            'SELECT id FROM tenants WHERE id = ?',
            [tenantId]
        );

        if (tenantRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Tenant not found"
            });
        }

        // Calculate average usage percentage
        const {
            current_users = 0,
            max_users = 25,
            current_customers = 0,
            max_customers = 1000,
            current_visits = 0,
            max_visits = 5000,
            current_storage_gb = 0,
            max_storage_gb = 10,
            ...otherData
        } = usageData;

        const avgUsage = (
            (current_users / max_users) * 100 +
            (current_customers / max_customers) * 100 +
            (current_visits / max_visits) * 100 +
            (current_storage_gb / max_storage_gb) * 100
        ) / 4;

        // Update or insert usage details
        const [existingRows] = await conn.query(
            `SELECT id FROM tenant_usage_details 
             WHERE tenant_id = ? AND metric_date = CURRENT_DATE`,
            [tenantId]
        );

        let result;
        if (existingRows.length > 0) {
            // Update existing record
            [result] = await conn.query(`
                UPDATE tenant_usage_details 
                SET 
                    current_users = ?,
                    max_users = ?,
                    current_customers = ?,
                    max_customers = ?,
                    current_visits = ?,
                    max_visits = ?,
                    current_storage_gb = ?,
                    max_storage_gb = ?,
                    avg_usage_percentage = ?,
                    api_calls_this_month = COALESCE(?, api_calls_this_month),
                    monthly_recurring_revenue = COALESCE(?, monthly_recurring_revenue),
                    last_activity_date = COALESCE(?, last_activity_date, CURRENT_DATE)
                WHERE tenant_id = ? AND metric_date = CURRENT_DATE
            `, [
                current_users,
                max_users,
                current_customers,
                max_customers,
                current_visits,
                max_visits,
                current_storage_gb,
                max_storage_gb,
                avgUsage,
                otherData.api_calls_this_month,
                otherData.monthly_recurring_revenue,
                otherData.last_activity_date,
                tenantId
            ]);
        } else {
            // Insert new record
            [result] = await conn.query(`
                INSERT INTO tenant_usage_details (
                    tenant_id,
                    current_users,
                    max_users,
                    current_customers,
                    max_customers,
                    current_visits,
                    max_visits,
                    current_storage_gb,
                    max_storage_gb,
                    avg_usage_percentage,
                    api_calls_this_month,
                    monthly_recurring_revenue,
                    last_activity_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                tenantId,
                current_users,
                max_users,
                current_customers,
                max_customers,
                current_visits,
                max_visits,
                current_storage_gb,
                max_storage_gb,
                avgUsage,
                otherData.api_calls_this_month || 0,
                otherData.monthly_recurring_revenue || 0,
                otherData.last_activity_date || new Date()
            ]);
        }

        // Update tenant health status based on usage
        let healthStatus = 'healthy';
        if (avgUsage >= 90) {
            healthStatus = 'critical';
        } else if (avgUsage >= 80) {
            healthStatus = 'warning';
        }

        await conn.query(
            'UPDATE tenants SET health_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [healthStatus, tenantId]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Tenant usage updated successfully",
            data: {
                tenant_id: tenantId,
                avg_usage_percentage: avgUsage,
                health_status: healthStatus
            }
        });

    } catch (err) {
        console.error("Tenant usage update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update tenant usage",
            error: err.message
        });
    }
});

// ==================== SYSTEM ALERTS API ====================

// Get all alerts with filters
router.get("/alerts", async (req, res) => {
    try {
        const {
            alert_type,
            is_resolved,
            tenant_id,
            start_date,
            end_date,
            page = 1,
            limit = 20
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                a.*,
                t.name as tenant_name,
                t.plan as tenant_plan
            FROM system_alerts a
            LEFT JOIN tenants t ON a.tenant_id = t.id
            WHERE 1=1
        `;
        
        const params = [];

        // Apply filters
        if (alert_type && alert_type !== 'all') {
            query += " AND a.alert_type = ?";
            params.push(alert_type);
        }

        if (is_resolved !== undefined) {
            query += " AND a.is_resolved = ?";
            params.push(is_resolved === 'true');
        }

        if (tenant_id) {
            query += " AND a.tenant_id = ?";
            params.push(tenant_id);
        }

        if (start_date) {
            query += " AND DATE(a.created_at) >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND DATE(a.created_at) <= ?";
            params.push(end_date);
        }

        // Get total count
        const countQuery = query.replace('SELECT a.*, t.name as tenant_name, t.plan as tenant_plan', 'SELECT COUNT(*) as total');
        const countQueryClean = countQuery.split('ORDER BY')[0];
        const [countResult] = await conn.query(countQueryClean, params);
        const total = countResult[0]?.total || 0;

        // Apply sorting and pagination
        query += " ORDER BY a.alert_type DESC, a.created_at DESC LIMIT ? OFFSET ?";
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
        console.error("Alerts fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch alerts",
            error: err.message
        });
    }
});

// Create alert
router.post("/alerts", async (req, res) => {
    try {
        const {
            tenant_id,
            alert_type = 'warning',
            alert_category,
            alert_message,
            current_value,
            max_value,
            percentage
        } = req.body;

        if (!tenant_id || !alert_category || !alert_message) {
            return res.status(400).json({
                success: false,
                message: "Tenant ID, alert category, and alert message are required"
            });
        }

        const conn = await pool.getConnection();
        const alertId = uuidv4();

        // Check if similar active alert already exists
        const [existingAlerts] = await conn.query(
            `SELECT id FROM system_alerts 
             WHERE tenant_id = ? 
               AND alert_category = ? 
               AND alert_type = ?
               AND is_resolved = FALSE
               AND DATE(created_at) = CURRENT_DATE`,
            [tenant_id, alert_category, alert_type]
        );

        if (existingAlerts.length > 0) {
            conn.release();
            return res.status(409).json({
                success: false,
                message: "Similar active alert already exists for today"
            });
        }

        // Create alert
        const [result] = await conn.query(`
            INSERT INTO system_alerts (
                id,
                tenant_id,
                alert_type,
                alert_category,
                alert_message,
                current_value,
                max_value,
                percentage
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            alertId,
            tenant_id,
            alert_type,
            alert_category,
            alert_message,
            current_value,
            max_value,
            percentage
        ]);

        conn.release();

        return res.status(201).json({
            success: true,
            message: "Alert created successfully",
            data: {
                id: alertId,
                alert_type,
                alert_category,
                tenant_id
            }
        });

    } catch (err) {
        console.error("Alert creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create alert",
            error: err.message
        });
    }
});

// Resolve alert
router.patch("/alerts/:id/resolve", async (req, res) => {
    try {
        const alertId = req.params.id;
        const { resolved_by = 'admin' } = req.body;

        const conn = await pool.getConnection();

        // Check if alert exists
        const [alertRows] = await conn.query(
            'SELECT * FROM system_alerts WHERE id = ?',
            [alertId]
        );

        if (alertRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Alert not found"
            });
        }

        if (alertRows[0].is_resolved) {
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Alert is already resolved"
            });
        }

        // Resolve alert
        const [result] = await conn.query(
            `UPDATE system_alerts 
             SET is_resolved = TRUE, 
                 resolved_at = CURRENT_TIMESTAMP,
                 acknowledged_by = ?,
                 acknowledged_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [resolved_by, alertId]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Alert resolved successfully",
            data: {
                id: alertId,
                resolved_by,
                resolved_at: new Date()
            }
        });

    } catch (err) {
        console.error("Alert resolve error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to resolve alert",
            error: err.message
        });
    }
});

// ==================== SYSTEM PERFORMANCE API ====================

// Get current system performance
router.get("/performance/current", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Get latest performance metrics
        const [metricsRows] = await conn.query(`
            SELECT * FROM system_performance_metrics 
            ORDER BY metric_date DESC, metric_hour DESC 
            LIMIT 1
        `);

        // Get monthly trends
        const [trendsRows] = await conn.query(`
            SELECT * FROM monthly_trends 
            WHERE trend_date >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)
            ORDER BY trend_date DESC
        `);

        // Get alert summary
        const [alertSummary] = await conn.query(`
            SELECT 
                alert_type,
                COUNT(*) as count
            FROM system_alerts 
            WHERE is_resolved = FALSE
            GROUP BY alert_type
        `);

        // Get tenant summary
        const [tenantSummary] = await conn.query(`
            SELECT 
                health_status,
                COUNT(*) as count
            FROM tenants 
            WHERE status = 'active'
            GROUP BY health_status
        `);

        const currentMetrics = metricsRows[0] || {};
        const trends = trendsRows.reduce((acc, trend) => {
            acc[trend.metric_type] = {
                current: trend.current_value,
                change: trend.change_percentage,
                isPositive: trend.is_positive
            };
            return acc;
        }, {});

        const alerts = alertSummary.reduce((acc, alert) => {
            acc[alert.alert_type] = alert.count;
            return acc;
        }, { critical: 0, warning: 0 });

        const tenants = tenantSummary.reduce((acc, tenant) => {
            acc[tenant.health_status] = tenant.count;
            return acc;
        }, { healthy: 0, warning: 0, critical: 0 });

        conn.release();

        return res.json({
            success: true,
            data: {
                metrics: currentMetrics,
                trends,
                alerts,
                tenants,
                last_updated: new Date().toISOString()
            }
        });

    } catch (err) {
        console.error("Performance fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch performance data",
            error: err.message
        });
    }
});

// Record performance metrics
router.post("/performance/record", async (req, res) => {
    try {
        const {
            system_uptime_percentage,
            avg_response_time_ms,
            error_rate_percentage,
            active_connections,
            cpu_usage_percentage,
            total_api_calls
        } = req.body;

        const conn = await pool.getConnection();
        const currentDate = new Date();
        const currentHour = currentDate.getHours();

        // Check if record exists for this hour
        const [existingRows] = await conn.query(
            `SELECT id FROM system_performance_metrics 
             WHERE metric_date = CURRENT_DATE AND metric_hour = ?`,
            [currentHour]
        );

        // Get tenant counts
        const [tenantCounts] = await conn.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) as healthy
            FROM tenants 
            WHERE status = 'active'
        `);

        // Get active alerts count
        const [alertCounts] = await conn.query(
            'SELECT COUNT(*) as count FROM system_alerts WHERE is_resolved = FALSE'
        );

        let result;
        if (existingRows.length > 0) {
            // Update existing record
            [result] = await conn.query(`
                UPDATE system_performance_metrics 
                SET 
                    system_uptime_percentage = ?,
                    avg_response_time_ms = ?,
                    error_rate_percentage = ?,
                    active_connections = ?,
                    cpu_usage_percentage = ?,
                    total_api_calls = ?,
                    healthy_tenants_count = ?,
                    total_tenants_count = ?,
                    active_alerts_count = ?,
                    created_at = CURRENT_TIMESTAMP
                WHERE metric_date = CURRENT_DATE AND metric_hour = ?
            `, [
                system_uptime_percentage,
                avg_response_time_ms,
                error_rate_percentage,
                active_connections,
                cpu_usage_percentage,
                total_api_calls,
                tenantCounts[0]?.healthy || 0,
                tenantCounts[0]?.total || 0,
                alertCounts[0]?.count || 0,
                currentHour
            ]);
        } else {
            // Insert new record
            [result] = await conn.query(`
                INSERT INTO system_performance_metrics (
                    metric_date,
                    metric_hour,
                    system_uptime_percentage,
                    avg_response_time_ms,
                    error_rate_percentage,
                    active_connections,
                    cpu_usage_percentage,
                    total_api_calls,
                    healthy_tenants_count,
                    total_tenants_count,
                    active_alerts_count
                ) VALUES (CURRENT_DATE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                currentHour,
                system_uptime_percentage,
                avg_response_time_ms,
                error_rate_percentage,
                active_connections,
                cpu_usage_percentage,
                total_api_calls,
                tenantCounts[0]?.healthy || 0,
                tenantCounts[0]?.total || 0,
                alertCounts[0]?.count || 0
            ]);
        }

        conn.release();

        return res.json({
            success: true,
            message: "Performance metrics recorded successfully",
            data: {
                recorded_at: currentDate,
                metric_hour: currentHour
            }
        });

    } catch (err) {
        console.error("Performance recording error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to record performance metrics",
            error: err.message
        });
    }
});

// ==================== DASHBOARD SUMMARY API ====================

// Get dashboard summary
router.get("/dashboard/summary", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Get tenant statistics
        const [tenantStats] = await conn.query(`
            SELECT 
                COUNT(*) as total_tenants,
                SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) as healthy_tenants,
                SUM(CASE WHEN health_status = 'warning' THEN 1 ELSE 0 END) as warning_tenants,
                SUM(CASE WHEN health_status = 'critical' THEN 1 ELSE 0 END) as critical_tenants,
                SUM(CASE WHEN deployment_type = 'self-hosted' THEN 1 ELSE 0 END) as self_hosted_tenants
            FROM tenants 
            WHERE status = 'active'
        `);

        // Get alert statistics
        const [alertStats] = await conn.query(`
            SELECT 
                COUNT(*) as total_alerts,
                SUM(CASE WHEN alert_type = 'critical' THEN 1 ELSE 0 END) as critical_alerts,
                SUM(CASE WHEN alert_type = 'warning' THEN 1 ELSE 0 END) as warning_alerts
            FROM system_alerts 
            WHERE is_resolved = FALSE
        `);

        // Get latest performance
        const [performanceRows] = await conn.query(`
            SELECT 
                system_uptime_percentage,
                avg_response_time_ms,
                error_rate_percentage,
                active_connections,
                cpu_usage_percentage,
                total_api_calls,
                healthy_tenants_count,
                total_tenants_count,
                active_alerts_count
            FROM system_performance_metrics 
            ORDER BY metric_date DESC, metric_hour DESC 
            LIMIT 1
        `);

        // Get monthly trends for comparison
        const [trendRows] = await conn.query(`
            SELECT 
                metric_type,
                current_value,
                change_percentage,
                is_positive
            FROM monthly_trends 
            WHERE trend_date = (
                SELECT MAX(trend_date) FROM monthly_trends
            )
        `);

        const trends = trendRows.reduce((acc, row) => {
            acc[row.metric_type] = {
                value: row.current_value,
                change: row.change_percentage,
                isPositive: row.is_positive
            };
            return acc;
        }, {});

        conn.release();

        return res.json({
            success: true,
            data: {
                tenants: tenantStats[0] || {},
                alerts: alertStats[0] || {},
                performance: performanceRows[0] || {},
                trends,
                last_updated: new Date().toISOString()
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

// ==================== SOFTWARE MANAGEMENT API ====================

// Get software by tenant
router.get("/software/:tenant_id", async (req, res) => {
    try {
        const tenantId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(
            `SELECT * FROM software_management 
             WHERE tenant_id = ? 
             ORDER BY software_name`,
            [tenantId]
        );

        conn.release();

        return res.json({
            success: true,
            data: rows,
            count: rows.length
        });

    } catch (err) {
        console.error("Software fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch software data",
            error: err.message
        });
    }
});

// Update software deployment
router.put("/software/:id", async (req, res) => {
    try {
        const softwareId = req.params.id;
        const {
            software_version,
            deployment_status,
            notes
        } = req.body;

        const conn = await pool.getConnection();

        // Check if software exists
        const [checkRows] = await conn.query(
            'SELECT * FROM software_management WHERE id = ?',
            [softwareId]
        );

        if (checkRows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Software not found"
            });
        }

        const [result] = await conn.query(
            `UPDATE software_management 
             SET 
                software_version = COALESCE(?, software_version),
                deployment_status = COALESCE(?, deployment_status),
                notes = COALESCE(?, notes),
                last_updated_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [software_version, deployment_status, notes, softwareId]
        );

        conn.release();

        return res.json({
            success: true,
            message: "Software updated successfully",
            data: {
                id: softwareId,
                updated_fields: Object.keys(req.body)
            }
        });

    } catch (err) {
        console.error("Software update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update software",
            error: err.message
        });
    }
});

// ==================== BULK OPERATIONS ====================

// Bulk resolve alerts
router.patch("/alerts/bulk/resolve", async (req, res) => {
    try {
        const { alert_ids, resolved_by = 'admin' } = req.body;
        
        if (!alert_ids || !Array.isArray(alert_ids) || alert_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "alert_ids array is required"
            });
        }

        const conn = await pool.getConnection();

        const placeholders = alert_ids.map(() => '?').join(',');
        const [result] = await conn.query(
            `UPDATE system_alerts 
             SET is_resolved = TRUE, 
                 resolved_at = CURRENT_TIMESTAMP,
                 acknowledged_by = ?,
                 acknowledged_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders}) AND is_resolved = FALSE`,
            [resolved_by, ...alert_ids]
        );

        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} alert(s) resolved successfully`,
            data: {
                resolved_count: result.affectedRows,
                resolved_by
            }
        });

    } catch (err) {
        console.error("Bulk resolve error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to resolve alerts",
            error: err.message
        });
    }
});

// Bulk update tenant health status
router.patch("/tenants/bulk/health-status", async (req, res) => {
    try {
        const { tenant_ids, health_status, updated_by = 'admin' } = req.body;
        
        if (!tenant_ids || !Array.isArray(tenant_ids) || tenant_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "tenant_ids array is required"
            });
        }

        if (!health_status) {
            return res.status(400).json({
                success: false,
                message: "health_status is required"
            });
        }

        const validStatuses = ['healthy', 'warning', 'critical'];
        if (!validStatuses.includes(health_status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid health status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const conn = await pool.getConnection();

        const placeholders = tenant_ids.map(() => '?').join(',');
        const [result] = await conn.query(
            `UPDATE tenants 
             SET health_status = ?, 
                 updated_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders})`,
            [health_status, ...tenant_ids]
        );

        conn.release();

        return res.json({
            success: true,
            message: `${result.affectedRows} tenant(s) health status updated successfully`,
            data: {
                updated_count: result.affectedRows,
                new_health_status: health_status
            }
        });

    } catch (err) {
        console.error("Bulk health status update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update tenant health status",
            error: err.message
        });
    }
});

// ==================== EXPORT DATA ====================

// Export tenant data
router.get("/export/tenants", async (req, res) => {
    try {
        const { format = 'json', start_date, end_date } = req.query;
        const conn = await pool.getConnection();

        let query = `
            SELECT 
                t.*,
                tud.current_users,
                tud.max_users,
                tud.current_customers,
                tud.max_customers,
                tud.current_visits,
                tud.max_visits,
                tud.current_storage_gb,
                tud.max_storage_gb,
                tud.api_calls_this_month,
                tud.monthly_recurring_revenue,
                tud.last_activity_date,
                tud.avg_usage_percentage,
                (SELECT COUNT(*) FROM system_alerts sa 
                 WHERE sa.tenant_id = t.id AND sa.is_resolved = FALSE) as active_alerts
            FROM tenants t
            LEFT JOIN tenant_usage_details tud ON t.id = tud.tenant_id 
            AND tud.metric_date = (SELECT MAX(metric_date) FROM tenant_usage_details WHERE tenant_id = t.id)
            WHERE 1=1
        `;

        const params = [];

        if (start_date) {
            query += " AND t.created_at >= ?";
            params.push(start_date);
        }

        if (end_date) {
            query += " AND t.created_at <= ?";
            params.push(end_date);
        }

        query += " ORDER BY t.name";

        const [rows] = await conn.query(query, params);
        conn.release();

        if (format === 'csv') {
            // Convert to CSV
            const csvRows = [];
            if (rows.length > 0) {
                const headers = Object.keys(rows[0]);
                csvRows.push(headers.join(','));
                
                rows.forEach(row => {
                    const values = headers.map(header => {
                        const value = row[header];
                        return typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value;
                    });
                    csvRows.push(values.join(','));
                });
            }

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=tenants_export.csv');
            return res.send(csvRows.join('\n'));
        } else {
            // Default to JSON
            return res.json({
                success: true,
                data: rows,
                count: rows.length,
                exported_at: new Date().toISOString()
            });
        }

    } catch (err) {
        console.error("Export error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to export data",
            error: err.message
        });
    }
});

module.exports = router;