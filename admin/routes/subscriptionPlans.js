const express = require("express");
const router = express.Router();
const pool = require("../../db/connection.js");
const { v4: uuidv4 } = require('uuid');

// ==================== HELPER FUNCTIONS ====================

// Get total statistics dynamically
async function calculatePlanStatistics(conn) {
    try {
        // Get total plans count
        const [plansCount] = await conn.query(`
            SELECT 
                COUNT(*) as total_plans,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_plans
            FROM subscription_plans
        `);

        // Get total tenants count (assuming tenants table exists)
        const [tenantsCount] = await conn.query(`
            SELECT COUNT(*) as total_tenants FROM tenants WHERE status = 'active'
        `);

        // Calculate MRR (Monthly Recurring Revenue)
        const [mrrStats] = await conn.query(`
            SELECT 
                COALESCE(SUM(CASE 
                    WHEN t.plan = 'Starter' THEN 49.00
                    WHEN t.plan = 'Professional' THEN 149.00
                    WHEN t.plan = 'Enterprise' THEN 499.00
                    ELSE 0
                END), 0) as total_mrr,
                COUNT(*) as total_subscriptions
            FROM tenants t
            WHERE t.status = 'active'
        `);

        return {
            total_plans: parseInt(plansCount[0]?.total_plans || 0),
            active_plans: parseInt(plansCount[0]?.active_plans || 0),
            total_subscriptions: parseInt(tenantsCount[0]?.total_tenants || 0),
            total_mrr: parseFloat(mrrStats[0]?.total_mrr || 0)
        };
    } catch (err) {
        console.error("Statistics calculation error:", err);
        throw err;
    }
}

// Format plan data with features
// async function formatPlanWithFeatures(conn, plan) {
//     try {
//         // Get plan features
//         const [features] = await conn.query(`
//             SELECT 
//                 feature_key,
//                 feature_name,
//                 is_enabled
//             FROM plan_features
//             WHERE plan_id = ?
//             ORDER BY sort_order
//         `, [plan.id]);

//         // Get active tenants count for this plan
//         const [tenantStats] = await conn.query(`
//             SELECT 
//                 COUNT(*) as active_tenants,
//                 COALESCE(SUM(
//                     CASE 
//                         WHEN plan = ? THEN monthly_price
//                         ELSE 0
//                     END
//                 ), 0) as plan_revenue
//             FROM tenants
//             WHERE status = 'active' AND plan = ?
//         `, [plan.plan_name, plan.plan_name]);

//         return {
//             ...plan,
//             features: features.reduce((acc, feature) => {
//                 acc[feature.feature_key] = {
//                     name: feature.feature_name,
//                     enabled: feature.is_enabled === 1
//                 };
//                 return acc;
//             }, {}),
//             active_tenants: parseInt(tenantStats[0]?.active_tenants || 0),
//             plan_revenue: parseFloat(tenantStats[0]?.plan_revenue || 0),
//             formatted_monthly_price: `SAR ${plan.monthly_price.toFixed(2)}`,
//             formatted_yearly_price: `SAR ${plan.yearly_price.toFixed(2)}`,
//             formatted_plan_revenue: `SAR ${parseFloat(tenantStats[0]?.plan_revenue || 0).toFixed(2)}`
//         };
//     } catch (err) {
//         console.error("Format plan error:", err);
//         return plan;
//     }
// }
async function formatPlanWithFeatures(conn, plan) {
    try {
        // Get all features for this plan
        const [features] = await conn.query(`
            SELECT * FROM plan_features 
            WHERE plan_id = ? 
            ORDER BY sort_order ASC
        `, [plan.id]);

        // Calculate monthly and yearly revenue
        // Assuming you have a tenants table with plan_name and subscription_interval
        const [revenueData] = await conn.query(`
            SELECT 
                SUM(CASE WHEN t.subscription_interval = 'monthly' THEN 1 ELSE 0 END) as monthly_subscribers,
                SUM(CASE WHEN t.subscription_interval = 'yearly' THEN 1 ELSE 0 END) as yearly_subscribers
            FROM tenants t 
            WHERE t.plan = ? AND t.status = 'active'
        `, [plan.plan_name]);

        const monthlyRevenue = (revenueData[0]?.monthly_subscribers || 0) * plan.monthly_price;
        const yearlyRevenue = (revenueData[0]?.yearly_subscribers || 0) * plan.yearly_price;
        const totalRevenue = monthlyRevenue + yearlyRevenue;

        // Format features into object
        const formattedFeatures = {};
        features.forEach(feature => {
            formattedFeatures[feature.feature_key] = {
                id: feature.id,
                name: feature.feature_name,
                enabled: feature.is_enabled === 1,
                sort_order: feature.sort_order,
                created_at: feature.created_at,
                updated_at: feature.updated_at
            };
        });

        return {
            id: plan.id,
            plan_id: plan.plan_id,
            plan_name: plan.plan_name,
            description: plan.description,
            monthly_price: plan.monthly_price,
            yearly_price: plan.yearly_price,
            max_users: plan.max_users,
            max_customers: plan.max_customers,
            max_visits: plan.max_visits,
            max_storage_gb: plan.max_storage_gb,
            status: plan.status,
            sort_order: plan.sort_order,
            is_default: plan.is_default,
            created_at: plan.created_at,
            updated_at: plan.updated_at,
            
            // All features as object
            features: formattedFeatures,
            
            // Additional calculated fields
            active_tenants: plan.active_tenants || 0,
            enabled_features_count: plan.enabled_features_count || 0,
            
            // Revenue data
            revenue: {
                monthly: monthlyRevenue,
                yearly: yearlyRevenue,
                total: totalRevenue,
                monthly_subscribers: revenueData[0]?.monthly_subscribers || 0,
                yearly_subscribers: revenueData[0]?.yearly_subscribers || 0,
                total_subscribers: (revenueData[0]?.monthly_subscribers || 0) + 
                                 (revenueData[0]?.yearly_subscribers || 0)
            }
        };
    } catch (err) {
        console.error("Error formatting plan:", err);
        // Return plan without features if there's an error
        return {
            ...plan,
            features: {},
            revenue: {
                monthly: 0,
                yearly: 0,
                total: 0,
                monthly_subscribers: 0,
                yearly_subscribers: 0,
                total_subscribers: 0
            }
        };
    }
}
// ==================== SUBSCRIPTION PLANS API ====================

// 1. Get all plans with filters
router.get("/", async (req, res) => {
    try {
        const {
            status,
            search,
            page = 1,
            limit = 10
        } = req.query;

        const conn = await pool.getConnection();
        let query = `
            SELECT 
                sp.*,
                (SELECT COUNT(*) FROM tenants t WHERE t.plan = sp.plan_name AND t.status = 'active') as active_tenants,
                (SELECT COUNT(*) FROM plan_features pf WHERE pf.plan_id = sp.id AND pf.is_enabled = 1) as enabled_features_count
            FROM subscription_plans sp
            WHERE 1=1
        `;
        
        const params = [];

        if (status && status !== 'all') {
            query += " AND sp.status = ?";
            params.push(status);
        }

        if (search) {
            query += " AND (sp.plan_name LIKE ? OR sp.description LIKE ?)";
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        // Get total count
        const countQuery = query.replace('SELECT sp.*, (SELECT COUNT(*) FROM tenants t WHERE t.plan = sp.plan_name AND t.status = \'active\') as active_tenants, (SELECT COUNT(*) FROM plan_features pf WHERE pf.plan_id = sp.id AND pf.is_enabled = 1) as enabled_features_count', 'SELECT COUNT(*) as total');
        const [countResult] = await conn.query(countQuery.split('ORDER BY')[0], params);
        const total = countResult[0]?.total || 0;

        // Apply sorting and pagination
        query += " ORDER BY sp.sort_order ASC, sp.created_at DESC LIMIT ? OFFSET ?";
        const offset = (page - 1) * limit;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await conn.query(query, params);
        
        // Format each plan with features and revenue
        const formattedPlans = [];
        for (const plan of rows) {
            const formattedPlan = await formatPlanWithFeatures(conn, plan);
            formattedPlans.push(formattedPlan);
        }

        conn.release();

        return res.json({
            success: true,
            data: formattedPlans,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                total_pages: Math.ceil(total / limit)
            }
        });

    } catch (err) {
        console.error("Plans fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch subscription plans",
            error: err.message
        });
    }
});

// 2. Get single plan by ID
router.get("/:id", async (req, res) => {
    try {
        const planId = req.params.id;
        const conn = await pool.getConnection();

        const [rows] = await conn.query(`
            SELECT 
                sp.*,
                (SELECT COUNT(*) FROM tenants t WHERE t.plan = sp.plan_name AND t.status = 'active') as active_tenants,
                (SELECT COUNT(*) FROM plan_features pf WHERE pf.plan_id = sp.id AND pf.is_enabled = 1) as enabled_features_count
            FROM subscription_plans sp
            WHERE sp.id = ? OR sp.plan_id = ? OR sp.plan_name LIKE ?
        `, [planId, planId, `%${planId}%`]);

        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subscription plan not found"
            });
        }

        const plan = rows[0];
        const formattedPlan = await formatPlanWithFeatures(conn, plan);
        
        conn.release();

        return res.json({
            success: true,
            data: formattedPlan
        });

    } catch (err) {
        console.error("Plan fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch subscription plan",
            error: err.message
        });
    }
});
// 3. Create new plan
router.post("/", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const {
            plan_name,
            description,
            monthly_price,
            yearly_price,
            max_users = 0,
            max_customers = 0,
            max_visits = 0,
            max_storage_gb = 0,
            status = 'active',
            features = {},
            is_default = false
        } = req.body;

        // Validation
        if (!plan_name || !monthly_price || !yearly_price) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Plan name, monthly price, and yearly price are required"
            });
        }

        // Generate plan ID
        const planUuid = uuidv4();

        // If setting as default, unset other defaults
        if (is_default) {
            await conn.query(
                "UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE"
            );
        }

        // Get next sort order
        const [maxOrder] = await conn.query(
            "SELECT MAX(sort_order) as max_order FROM subscription_plans"
        );
        const nextSortOrder = (maxOrder[0]?.max_order || 0) + 1;

        // Create plan
        const [result] = await conn.query(`
            INSERT INTO subscription_plans (
                plan_id,
                plan_name,
                description,
                monthly_price,
                yearly_price,
                max_users,
                max_customers,
                max_visits,
                max_storage_gb,
                status,
                sort_order,
                is_default
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            planUuid,
            plan_name,
            description || '',
            parseFloat(monthly_price),
            parseFloat(yearly_price),
            parseInt(max_users),
            parseInt(max_customers),
            parseInt(max_visits),
            parseInt(max_storage_gb),
            status,
            nextSortOrder,
            is_default
        ]);

        const planId = result.insertId;

        // Add features if provided
        if (features && typeof features === 'object') {
            const featureEntries = Object.entries(features);
            let sortOrder = 1;
            
            for (const [key, value] of featureEntries) {
                if (value && typeof value === 'object' && value.name) {
                    await conn.query(`
                        INSERT INTO plan_features (
                            plan_id,
                            feature_key,
                            feature_name,
                            is_enabled,
                            sort_order
                        ) VALUES (?, ?, ?, ?, ?)
                    `, [
                        planId,
                        key,
                        value.name,
                        value.enabled ? 1 : 0,
                        sortOrder++
                    ]);
                }
            }
        }

        await conn.commit();
        
        // Get the created plan
        const [planRows] = await conn.query(
            "SELECT * FROM subscription_plans WHERE id = ?",
            [planId]
        );
        
        const formattedPlan = await formatPlanWithFeatures(conn, planRows[0]);
        conn.release();

        return res.status(201).json({
            success: true,
            message: "Subscription plan created successfully",
            data: formattedPlan
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Plan creation error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create subscription plan",
            error: err.message
        });
    }
});

// 4. Update plan
router.put("/:id", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const planId = req.params.id;
        const {
            plan_name,
            description,
            monthly_price,
            yearly_price,
            max_users,
            max_customers,
            max_visits,
            max_storage_gb,
            status,
            sort_order,
            is_default,
            features
        } = req.body;

        // Check if plan exists
        const [planRows] = await conn.query(
            'SELECT id FROM subscription_plans WHERE id = ? OR plan_id = ?',
            [planId, planId]
        );

        if (planRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subscription plan not found"
            });
        }

        const plan = planRows[0];

        // If setting as default, unset other defaults
        if (is_default === true) {
            await conn.query(
                "UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE AND id != ?",
                [plan.id]
            );
        }

        // Build update query
        const updateFields = [];
        const updateValues = [];

        if (plan_name !== undefined) {
            updateFields.push("plan_name = ?");
            updateValues.push(plan_name);
        }

        if (description !== undefined) {
            updateFields.push("description = ?");
            updateValues.push(description);
        }

        if (monthly_price !== undefined) {
            updateFields.push("monthly_price = ?");
            updateValues.push(parseFloat(monthly_price));
        }

        if (yearly_price !== undefined) {
            updateFields.push("yearly_price = ?");
            updateValues.push(parseFloat(yearly_price));
        }

        if (max_users !== undefined) {
            updateFields.push("max_users = ?");
            updateValues.push(parseInt(max_users));
        }

        if (max_customers !== undefined) {
            updateFields.push("max_customers = ?");
            updateValues.push(parseInt(max_customers));
        }

        if (max_visits !== undefined) {
            updateFields.push("max_visits = ?");
            updateValues.push(parseInt(max_visits));
        }

        if (max_storage_gb !== undefined) {
            updateFields.push("max_storage_gb = ?");
            updateValues.push(parseInt(max_storage_gb));
        }

        if (status !== undefined) {
            updateFields.push("status = ?");
            updateValues.push(status);
        }

        if (sort_order !== undefined) {
            updateFields.push("sort_order = ?");
            updateValues.push(parseInt(sort_order));
        }

        if (is_default !== undefined) {
            updateFields.push("is_default = ?");
            updateValues.push(is_default);
        }

        if (updateFields.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "No fields to update"
            });
        }

        updateValues.push(plan.id);

        // Update plan - FIXED: removed extra comma
        await conn.query(`
            UPDATE subscription_plans 
            SET ${updateFields.join(', ')}
            WHERE id = ?
        `, updateValues);

        // Update features if provided
        if (features && typeof features === 'object') {
            // Delete existing features
            await conn.query(
                "DELETE FROM plan_features WHERE plan_id = ?",
                [plan.id]
            );

            // Insert new features
            const featureEntries = Object.entries(features);
            let sortOrder = 1;
            
            for (const [key, value] of featureEntries) {
                if (value && typeof value === 'object' && value.name) {
                    await conn.query(`
                        INSERT INTO plan_features (
                            plan_id,
                            feature_key,
                            feature_name,
                            is_enabled,
                            sort_order
                        ) VALUES (?, ?, ?, ?, ?)
                    `, [
                        plan.id,
                        key,
                        value.name,
                        value.enabled ? 1 : 0,
                        sortOrder++
                    ]);
                }
            }
        }

        await conn.commit();
        
        // Get updated plan
        const [updatedPlanRows] = await conn.query(
            "SELECT * FROM subscription_plans WHERE id = ?",
            [plan.id]
        );
        
        const formattedPlan = await formatPlanWithFeatures(conn, updatedPlanRows[0]);
        conn.release();

        return res.json({
            success: true,
            message: "Subscription plan updated successfully",
            data: formattedPlan
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Plan update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update subscription plan",
            error: err.message
        });
    }
});

// 5. Update plan status
router.patch("/:id/status", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const planId = req.params.id;
        const { status } = req.body;

        // Validate status
        const validStatuses = ['active', 'inactive', 'archived'];
        if (!status || !validStatuses.includes(status)) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Valid status is required (active, inactive, archived)"
            });
        }

        // Check if plan exists
        const [planRows] = await conn.query(
            'SELECT id, plan_name, status FROM subscription_plans WHERE id = ? OR plan_id = ?',
            [planId, planId]
        );

        if (planRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subscription plan not found"
            });
        }

        const plan = planRows[0];

        // Don't update if status is the same
        if (plan.status === status) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: `Plan is already ${status}`
            });
        }

        // Update plan status - FIXED: removed extra comma
        await conn.query(
            `UPDATE subscription_plans 
             SET status = ?
             WHERE id = ?`,
            [status, plan.id]
        );

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: `Plan status updated from ${plan.status} to ${status}`,
            data: {
                id: plan.id,
                plan_name: plan.plan_name,
                old_status: plan.status,
                new_status: status
            }
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Plan status update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update plan status",
            error: err.message
        });
    }
});

// 6. Delete plan
router.delete("/:id", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const planId = req.params.id;

        // Check if plan exists
        const [planRows] = await conn.query(
            'SELECT id, plan_name, is_default FROM subscription_plans WHERE id = ? OR plan_id = ?',
            [planId, planId]
        );

        if (planRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subscription plan not found"
            });
        }

        const plan = planRows[0];

        // Check if plan is default
        if (plan.is_default) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Cannot delete default plan. Set another plan as default first."
            });
        }

        // Check if any tenants are using this plan
        const [tenantCount] = await conn.query(
            'SELECT COUNT(*) as tenant_count FROM tenants WHERE plan = ?',
            [plan.plan_name]
        );

        if (parseInt(tenantCount[0]?.tenant_count || 0) > 0) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Cannot delete plan. There are tenants using this plan."
            });
        }

        // Delete plan (cascade will delete features)
        const [result] = await conn.query(
            'DELETE FROM subscription_plans WHERE id = ?',
            [plan.id]
        );

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: "Subscription plan deleted successfully",
            data: {
                id: plan.id,
                plan_name: plan.plan_name,
                deleted_count: result.affectedRows
            }
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Plan deletion error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete subscription plan",
            error: err.message
        });
    }
});

// 7. Duplicate plan
router.post("/:id/duplicate", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const planId = req.params.id;
        const { new_plan_name } = req.body;

        // Check if plan exists
        const [planRows] = await conn.query(
            'SELECT * FROM subscription_plans WHERE id = ? OR plan_id = ?',
            [planId, planId]
        );

        if (planRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subscription plan not found"
            });
        }

        const originalPlan = planRows[0];

        // Check if new plan name already exists
        if (new_plan_name) {
            const [existingPlan] = await conn.query(
                'SELECT id FROM subscription_plans WHERE plan_name = ?',
                [new_plan_name]
            );

            if (existingPlan.length > 0) {
                await conn.rollback();
                conn.release();
                return res.status(400).json({
                    success: false,
                    message: "A plan with this name already exists"
                });
            }
        }

        // Get next sort order
        const [maxOrder] = await conn.query(
            "SELECT MAX(sort_order) as max_order FROM subscription_plans"
        );
        const nextSortOrder = (maxOrder[0]?.max_order || 0) + 1;

        // Create duplicated plan
        const planUuid = uuidv4();
        const [result] = await conn.query(`
            INSERT INTO subscription_plans (
                plan_id,
                plan_name,
                description,
                monthly_price,
                yearly_price,
                max_users,
                max_customers,
                max_visits,
                max_storage_gb,
                status,
                sort_order,
                is_default
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            planUuid,
            new_plan_name || `${originalPlan.plan_name} (Copy)`,
            originalPlan.description,
            originalPlan.monthly_price,
            originalPlan.yearly_price,
            originalPlan.max_users,
            originalPlan.max_customers,
            originalPlan.max_visits,
            originalPlan.max_storage_gb,
            'active',
            nextSortOrder,
            false
        ]);

        const newPlanId = result.insertId;

        // Duplicate features
        const [features] = await conn.query(
            'SELECT feature_key, feature_name, is_enabled FROM plan_features WHERE plan_id = ?',
            [originalPlan.id]
        );

        let sortOrder = 1;
        for (const feature of features) {
            await conn.query(`
                INSERT INTO plan_features (
                    plan_id,
                    feature_key,
                    feature_name,
                    is_enabled,
                    sort_order
                ) VALUES (?, ?, ?, ?, ?)
            `, [
                newPlanId,
                feature.feature_key,
                feature.feature_name,
                feature.is_enabled,
                sortOrder++
            ]);
        }

        await conn.commit();
        
        // Get the duplicated plan
        const [newPlanRows] = await conn.query(
            "SELECT * FROM subscription_plans WHERE id = ?",
            [newPlanId]
        );
        
        const formattedPlan = await formatPlanWithFeatures(conn, newPlanRows[0]);
        conn.release();

        return res.status(201).json({
            success: true,
            message: "Plan duplicated successfully",
            data: formattedPlan
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Plan duplication error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to duplicate plan",
            error: err.message
        });
    }
});

// 8. Set default plan
router.post("/:id/set-default", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const planId = req.params.id;

        // Check if plan exists
        const [planRows] = await conn.query(
            'SELECT id, plan_name FROM subscription_plans WHERE id = ? OR plan_id = ?',
            [planId, planId]
        );

        if (planRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subscription plan not found"
            });
        }

        const plan = planRows[0];

        // Unset current default
        await conn.query(
            "UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE"
        );

        // Set new default - FIXED: removed extra comma
        await conn.query(
            "UPDATE subscription_plans SET is_default = TRUE WHERE id = ?",
            [plan.id]
        );

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: "Default plan updated successfully",
            data: {
                id: plan.id,
                plan_name: plan.plan_name,
                is_default: true
            }
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Set default plan error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to set default plan",
            error: err.message
        });
    }
});

// ==================== DASHBOARD ENDPOINTS ====================

// 9. Get dashboard statistics
router.get("/stats/dashboard", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Calculate statistics
        const stats = await calculatePlanStatistics(conn);

        // Get all plans with their stats
        const [plans] = await conn.query(`
            SELECT 
                sp.*,
                (SELECT COUNT(*) FROM tenants t WHERE t.plan = sp.plan_name AND t.status = 'active') as active_tenants,
                COALESCE((SELECT SUM(
                    CASE 
                        WHEN t.plan = 'Starter' THEN 49.00
                        WHEN t.plan = 'Professional' THEN 149.00
                        WHEN t.plan = 'Enterprise' THEN 499.00
                        ELSE 0
                    END
                ) FROM tenants t WHERE t.plan = sp.plan_name AND t.status = 'active'), 0) as plan_revenue
            FROM subscription_plans sp
            WHERE sp.status = 'active'
            ORDER BY sp.sort_order
        `);

        // Format plans
        const formattedPlans = await Promise.all(
            plans.map(async (plan) => {
                return await formatPlanWithFeatures(conn, plan);
            })
        );

        conn.release();

        return res.json({
            success: true,
            data: {
                summary: {
                    total_plans: {
                        value: stats.total_plans,
                        change: 0, // Fixed for demo
                        isPositive: true
                    },
                    active_plans: {
                        value: stats.active_plans,
                        change: 0, // Fixed for demo
                        isPositive: true
                    },
                    total_subscriptions: {
                        value: stats.total_subscriptions,
                        change: 12, // Fixed for demo
                        isPositive: true
                    },
                    total_mrr: {
                        value: stats.total_mrr,
                        formatted: `SAR ${stats.total_mrr.toFixed(2)}`,
                        change: 18, // Fixed for demo
                        isPositive: true
                    }
                },
                plans: formattedPlans,
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

// 10. Get quick stats
router.get("/stats/quick", async (req, res) => {
    try {
        const conn = await pool.getConnection();
        
        const stats = await calculatePlanStatistics(conn);
        
        conn.release();

        return res.json({
            success: true,
            data: {
                total_plans: stats.total_plans,
                active_plans: stats.active_plans,
                total_subscriptions: stats.total_subscriptions,
                total_mrr: stats.total_mrr,
                formatted_mrr: `SAR ${stats.total_mrr.toFixed(2)}`
            }
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

// 11. Get plan comparison
router.get("/comparison", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        // Get all active plans
        const [plans] = await conn.query(`
            SELECT * FROM subscription_plans 
            WHERE status = 'active'
            ORDER BY sort_order
        `);

        // Get all unique features across all plans
        const [allFeatures] = await conn.query(`
            SELECT DISTINCT pf.feature_key, pf.feature_name
            FROM plan_features pf
            JOIN subscription_plans sp ON pf.plan_id = sp.id
            WHERE sp.status = 'active'
            ORDER BY MIN(pf.sort_order)
        `);

        // Get features for each plan
        const planComparison = await Promise.all(
            plans.map(async (plan) => {
                const [features] = await conn.query(`
                    SELECT feature_key, is_enabled 
                    FROM plan_features 
                    WHERE plan_id = ?
                    ORDER BY sort_order
                `, [plan.id]);

                const featureMap = {};
                features.forEach(feature => {
                    featureMap[feature.feature_key] = feature.is_enabled === 1;
                });

                return {
                    id: plan.id,
                    plan_id: plan.plan_id,
                    plan_name: plan.plan_name,
                    description: plan.description,
                    monthly_price: plan.monthly_price,
                    yearly_price: plan.yearly_price,
                    max_users: plan.max_users,
                    max_customers: plan.max_customers,
                    max_visits: plan.max_visits,
                    max_storage_gb: plan.max_storage_gb,
                    is_default: plan.is_default,
                    features: featureMap,
                    formatted_monthly: `SAR ${plan.monthly_price.toFixed(2)}`,
                    formatted_yearly: `SAR ${plan.yearly_price.toFixed(2)}`
                };
            })
        );

        conn.release();

        return res.json({
            success: true,
            data: {
                plans: planComparison,
                all_features: allFeatures.map(f => ({
                    key: f.feature_key,
                    name: f.feature_name
                })),
                generated_at: new Date().toISOString()
            }
        });

    } catch (err) {
        console.error("Plan comparison error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch plan comparison",
            error: err.message
        });
    }
});

// 12. Get available features list
router.get("/features/available", async (req, res) => {
    try {
        const conn = await pool.getConnection();

        const [features] = await conn.query(`
            SELECT DISTINCT 
                feature_key,
                feature_name
            FROM plan_features
            ORDER BY feature_name
        `);

        conn.release();

        return res.json({
            success: true,
            data: features,
            count: features.length
        });

    } catch (err) {
        console.error("Features fetch error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch available features",
            error: err.message
        });
    }
});

// 13. Update plan features
router.put("/:id/features", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const planId = req.params.id;
        const { features } = req.body;

        if (!features || typeof features !== 'object') {
            await conn.rollback();
            conn.release();
            return res.status(400).json({
                success: false,
                message: "Features object is required"
            });
        }

        // Check if plan exists
        const [planRows] = await conn.query(
            'SELECT id FROM subscription_plans WHERE id = ? OR plan_id = ?',
            [planId, planId]
        );

        if (planRows.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({
                success: false,
                message: "Subscription plan not found"
            });
        }

        const plan = planRows[0];

        // Update features
        const featureEntries = Object.entries(features);
        
        for (const [key, value] of featureEntries) {
            if (value && typeof value === 'object' && value.name !== undefined) {
                // Check if feature exists
                const [existing] = await conn.query(
                    'SELECT id FROM plan_features WHERE plan_id = ? AND feature_key = ?',
                    [plan.id, key]
                );

                if (existing.length > 0) {
                    // Update existing feature - FIXED: removed extra comma
                    await conn.query(`
                        UPDATE plan_features 
                        SET feature_name = ?, is_enabled = ?
                        WHERE plan_id = ? AND feature_key = ?
                    `, [
                        value.name,
                        value.enabled ? 1 : 0,
                        plan.id,
                        key
                    ]);
                } else {
                    // Get next sort order
                    const [maxOrder] = await conn.query(
                        "SELECT MAX(sort_order) as max_order FROM plan_features WHERE plan_id = ?",
                        [plan.id]
                    );
                    const nextSortOrder = (maxOrder[0]?.max_order || 0) + 1;

                    // Insert new feature
                    await conn.query(`
                        INSERT INTO plan_features (
                            plan_id,
                            feature_key,
                            feature_name,
                            is_enabled,
                            sort_order
                        ) VALUES (?, ?, ?, ?, ?)
                    `, [
                        plan.id,
                        key,
                        value.name,
                        value.enabled ? 1 : 0,
                        nextSortOrder
                    ]);
                }
            }
        }

        await conn.commit();
        
        // Get updated features
        const [updatedFeatures] = await conn.query(`
            SELECT feature_key, feature_name, is_enabled
            FROM plan_features
            WHERE plan_id = ?
            ORDER BY sort_order
        `, [plan.id]);

        conn.release();

        return res.json({
            success: true,
            message: "Plan features updated successfully",
            data: {
                plan_id: plan.id,
                features: updatedFeatures.reduce((acc, feature) => {
                    acc[feature.feature_key] = {
                        name: feature.feature_name,
                        enabled: feature.is_enabled === 1
                    };
                    return acc;
                }, {})
            }
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Plan features update error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update plan features",
            error: err.message
        });
    }
});

// 14. Insert sample data
router.post("/sample-data", async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Clear existing data
        await conn.query("DELETE FROM plan_features");
        await conn.query("DELETE FROM subscription_plans");

        // Insert sample plans
        const samplePlans = [
            {
                plan_id: uuidv4(),
                plan_name: 'Starter',
                description: 'Perfect for small teams getting started',
                monthly_price: 49.00,
                yearly_price: 490.00,
                max_users: 5,
                max_customers: 100,
                max_visits: 500,
                max_storage_gb: 10,
                status: 'active',
                sort_order: 1,
                is_default: true
            },
            {
                plan_id: uuidv4(),
                plan_name: 'Professional',
                description: 'For growing businesses with advanced needs',
                monthly_price: 149.00,
                yearly_price: 1490.00,
                max_users: 25,
                max_customers: 1000,
                max_visits: 5000,
                max_storage_gb: 50,
                status: 'active',
                sort_order: 2,
                is_default: false
            },
            {
                plan_id: uuidv4(),
                plan_name: 'Enterprise',
                description: 'Unlimited power for large organizations',
                monthly_price: 499.00,
                yearly_price: 4990.00,
                max_users: 100,
                max_customers: 0,
                max_visits: 0,
                max_storage_gb: 100,
                status: 'active',
                sort_order: 3,
                is_default: false
            }
        ];

        const insertedPlans = [];

        for (const plan of samplePlans) {
            const [result] = await conn.query(`
                INSERT INTO subscription_plans (
                    plan_id, plan_name, description, monthly_price, yearly_price,
                    max_users, max_customers, max_visits, max_storage_gb,
                    status, sort_order, is_default
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, Object.values(plan));

            insertedPlans.push({
                id: result.insertId,
                ...plan
            });
        }

        // Insert sample features
        const featuresData = [
            // Starter features
            { plan_name: 'Starter', key: 'overview', name: 'Overview', enabled: true },
            { plan_name: 'Starter', key: 'customers', name: 'Customers', enabled: true },
            { plan_name: 'Starter', key: 'team', name: 'Team', enabled: true },
            { plan_name: 'Starter', key: 'my_tasks', name: 'My Tasks', enabled: true },
            { plan_name: 'Starter', key: 'visits', name: 'Visits', enabled: true },
            { plan_name: 'Starter', key: 'reminders', name: 'Reminders', enabled: true },
            { plan_name: 'Starter', key: 'support', name: 'Support', enabled: true },
            { plan_name: 'Starter', key: 'reports', name: 'Reports', enabled: true },
            { plan_name: 'Starter', key: 'tracking', name: 'Tracking', enabled: true },
            { plan_name: 'Starter', key: 'users', name: 'Users', enabled: true },
            { plan_name: 'Starter', key: 'assignments', name: 'Assignments', enabled: true },

            // Professional features (all enabled)
            { plan_name: 'Professional', key: 'overview', name: 'Overview', enabled: true },
            { plan_name: 'Professional', key: 'customers', name: 'Customers', enabled: true },
            { plan_name: 'Professional', key: 'team', name: 'Team', enabled: true },
            { plan_name: 'Professional', key: 'my_tasks', name: 'My Tasks', enabled: true },
            { plan_name: 'Professional', key: 'visits', name: 'Visits', enabled: true },
            { plan_name: 'Professional', key: 'reminders', name: 'Reminders', enabled: true },
            { plan_name: 'Professional', key: 'support', name: 'Support', enabled: true },
            { plan_name: 'Professional', key: 'reports', name: 'Reports', enabled: true },
            { plan_name: 'Professional', key: 'tracking', name: 'Tracking', enabled: true },
            { plan_name: 'Professional', key: 'users', name: 'Users', enabled: true },
            { plan_name: 'Professional', key: 'assignments', name: 'Assignments', enabled: true },
            { plan_name: 'Professional', key: 'all_tasks', name: 'All Tasks', enabled: true },
            { plan_name: 'Professional', key: 'feedback', name: 'Feedback', enabled: true },
            { plan_name: 'Professional', key: 'resources', name: 'Resources', enabled: true },
            { plan_name: 'Professional', key: 'activity', name: 'Activity', enabled: true },

            // Enterprise features (all enabled)
            { plan_name: 'Enterprise', key: 'overview', name: 'Overview', enabled: true },
            { plan_name: 'Enterprise', key: 'customers', name: 'Customers', enabled: true },
            { plan_name: 'Enterprise', key: 'team', name: 'Team', enabled: true },
            { plan_name: 'Enterprise', key: 'my_tasks', name: 'My Tasks', enabled: true },
            { plan_name: 'Enterprise', key: 'visits', name: 'Visits', enabled: true },
            { plan_name: 'Enterprise', key: 'reminders', name: 'Reminders', enabled: true },
            { plan_name: 'Enterprise', key: 'support', name: 'Support', enabled: true },
            { plan_name: 'Enterprise', key: 'reports', name: 'Reports', enabled: true },
            { plan_name: 'Enterprise', key: 'tracking', name: 'Tracking', enabled: true },
            { plan_name: 'Enterprise', key: 'users', name: 'Users', enabled: true },
            { plan_name: 'Enterprise', key: 'assignments', name: 'Assignments', enabled: true },
            { plan_name: 'Enterprise', key: 'all_tasks', name: 'All Tasks', enabled: true },
            { plan_name: 'Enterprise', key: 'feedback', name: 'Feedback', enabled: true },
            { plan_name: 'Enterprise', key: 'resources', name: 'Resources', enabled: true },
            { plan_name: 'Enterprise', key: 'activity', name: 'Activity', enabled: true }
        ];

        let sortOrder = 1;
        let currentPlan = '';

        for (const feature of featuresData) {
            if (currentPlan !== feature.plan_name) {
                currentPlan = feature.plan_name;
                sortOrder = 1;
            }

            const plan = insertedPlans.find(p => p.plan_name === feature.plan_name);
            if (plan) {
                await conn.query(`
                    INSERT INTO plan_features (
                        plan_id,
                        feature_key,
                        feature_name,
                        is_enabled,
                        sort_order
                    ) VALUES (?, ?, ?, ?, ?)
                `, [
                    plan.id,
                    feature.key,
                    feature.name,
                    feature.enabled ? 1 : 0,
                    sortOrder++
                ]);
            }
        }

        await conn.commit();
        conn.release();

        return res.json({
            success: true,
            message: "Sample data inserted successfully",
            data: {
                plans_count: insertedPlans.length,
                features_count: featuresData.length,
                inserted_at: new Date()
            }
        });

    } catch (err) {
        if (conn) {
            await conn.rollback();
            conn.release();
        }
        console.error("Sample data error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to insert sample data",
            error: err.message
        });
    }
});

module.exports = router;