const { getMySqlPromiseConnection } = require("../config/mysql.db")

exports.getTodaysOrdersCountDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {

        const sql = `
        SELECT
            count(*) AS todays_orders
        FROM
            orders
        WHERE
            DATE(\`date\`) = CURDATE() AND tenant_id = ?
        `;
    
        const [result] = await conn.query(sql, [tenantId]);
        return result[0].todays_orders;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getTodaysNewCustomerCountDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            count(*) AS new_customers_count
        FROM
            customers
        WHERE
            DATE(created_at) = CURDATE() AND tenant_id = ?
        `;
    
        const [result] = await conn.query(sql, [tenantId]);
        return result[0].new_customers_count;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getTodaysRepeatCustomerCountDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {

        const sql = `
        SELECT
            COUNT(distinct customer_id) as todays_repeat_customers
        FROM
            orders
        WHERE
            DATE(\`date\`) = CURDATE()
            AND customer_type = 'CUSTOMER' AND tenant_id = ?;
        `;
    
        const [result] = await conn.query(sql, [tenantId]);

        return result[0].todays_repeat_customers;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getTodaysTopSellingItemsDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {

        const sql = `
        SELECT
            mi.*,
            oi_c.orders_count
        FROM
            menu_items mi
            INNER JOIN (
                SELECT
                    item_id,
                    SUM(quantity) AS orders_count
                FROM
                    order_items
                WHERE
                    status <> 'cancelled'
                    AND DATE(\`date\`) = CURDATE()
                    AND tenant_id = ?
                GROUP BY
                    item_id
                LIMIT 50) oi_c ON mi.id = oi_c.item_id
        WHERE tenant_id = ?
        ORDER BY
            oi_c.orders_count DESC;
        `;
    
        const [result] = await conn.query(sql, [tenantId, tenantId]);
        return result;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

// ─── NEW: Advanced Analytics Queries ─────────────────────────────

exports.getTodaysRevenueDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            COALESCE(SUM(total), 0) AS total_revenue,
            COALESCE(SUM(sub_total), 0) AS net_sales,
            COALESCE(SUM(tax_total), 0) AS tax_total,
            COALESCE(SUM(service_charge_total), 0) AS service_charge_total,
            COALESCE(AVG(total), 0) AS average_order_value,
            COUNT(*) AS invoice_count
        FROM invoices
        WHERE DATE(created_at) = CURDATE() AND tenant_id = ?
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result[0];
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getYesterdaysRevenueDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            COALESCE(SUM(total), 0) AS total_revenue,
            COALESCE(AVG(total), 0) AS average_order_value,
            COUNT(*) AS invoice_count
        FROM invoices
        WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND tenant_id = ?
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result[0];
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getYesterdaysOrdersCountDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT COUNT(*) AS orders_count
        FROM orders
        WHERE DATE(\`date\`) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND tenant_id = ?
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result[0].orders_count;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getYesterdaysNewCustomerCountDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT COUNT(*) AS new_customers_count
        FROM customers
        WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND tenant_id = ?
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result[0].new_customers_count;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getRevenueTrendDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            DATE(created_at) AS date,
            COALESCE(SUM(total), 0) AS revenue,
            COUNT(*) AS invoice_count
        FROM invoices
        WHERE tenant_id = ? AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        GROUP BY DATE(created_at)
        ORDER BY date ASC
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getSalesByHourDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            HOUR(created_at) AS hour,
            COALESCE(SUM(total), 0) AS revenue,
            COUNT(*) AS orders
        FROM invoices
        WHERE tenant_id = ? AND DATE(created_at) = CURDATE()
        GROUP BY HOUR(created_at)
        ORDER BY hour ASC
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getOrdersByTypeDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            COALESCE(NULLIF(delivery_type, ''), 'Unassigned') AS order_type,
            COUNT(*) AS count
        FROM orders
        WHERE tenant_id = ? AND DATE(\`date\`) = CURDATE()
        GROUP BY COALESCE(NULLIF(delivery_type, ''), 'Unassigned')
        ORDER BY count DESC
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getPaymentMixDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            COALESCE(pt.title, 'Unassigned') AS payment_type,
            COUNT(i.id) AS count,
            COALESCE(SUM(i.total), 0) AS total
        FROM invoices i
        LEFT JOIN payment_types pt ON pt.id = i.payment_type_id AND pt.tenant_id = i.tenant_id
        WHERE i.tenant_id = ? AND DATE(i.created_at) = CURDATE()
        GROUP BY i.payment_type_id, pt.title
        ORDER BY total DESC
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getLowStockAlertsDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            id, title, quantity, unit, min_quantity_threshold, status
        FROM inventory_items
        WHERE tenant_id = ?
            AND quantity <= min_quantity_threshold
        ORDER BY
            CASE status WHEN 'out' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
            quantity ASC
        LIMIT 6
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getRecentFeedbackDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT
            f.id,
            f.average_rating,
            f.food_quality_rating,
            f.service_rating,
            f.staff_behavior_rating,
            f.ambiance_rating,
            f.recommend_rating,
            f.remarks,
            f.date,
            COALESCE(c.name, f.phone, 'Guest') AS customer_name
        FROM feedbacks f
        LEFT JOIN customers c ON c.phone = f.phone AND c.tenant_id = f.tenant_id
        WHERE f.tenant_id = ?
        ORDER BY f.date DESC
        LIMIT 5
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getCancelledOrdersCountDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();
    try {
        const sql = `
        SELECT COUNT(*) AS cancelled_count
        FROM orders
        WHERE tenant_id = ? AND status = 'cancelled' AND DATE(\`date\`) = CURDATE()
        `;
        const [result] = await conn.query(sql, [tenantId]);
        return result[0].cancelled_count;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};
