const bcrypt = require("bcrypt");
const { CONFIG } = require("../config/index")
const { getMySqlPromiseConnection } = require("../config/mysql.db")
exports.signInDB = async (username, password) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
            SELECT 
            u.username,
            u.password,
            u.name,
            u.role,
            u.photo,
            u.designation,
            u.phone,
            u.email,
            u.scope,
            u.tenant_id,
            t.is_active,
            t.payment_gateway_product_id,
            t.token_version,
            
            p.title AS plan_title,
            p.is_trial,
            p.trial_days,
            p.features_description,
            p.features
        FROM users u
        LEFT JOIN tenants t 
            ON u.tenant_id = t.id
        LEFT JOIN plans p
            ON t.payment_gateway_product_id = p.payment_gateway_product_id
        WHERE u.username = ?
        LIMIT 1`;

        const [result] = await conn.query(sql, [username]);
        const user = result[0];

        if (!user) {
            return null;
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (passwordMatch) {
            return user;
        } else {
            return null;
        }

    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getUserDB = async (username, tenantId) => {
  const conn = await getMySqlPromiseConnection();

  try {
    const sql = `
      SELECT 
        u.username,
        u.name,
        u.role,
        u.designation,
        u.photo,
        u.phone,
        u.email,
        u.scope,
        u.tenant_id,

        t.token_version,
        t.is_active,
        t.isTrialPlan,
        t.subscription_start,
        t.subscription_end,
        t.payment_gateway_product_id,

        p.features AS planFeatures,
        p.features_description,
        p.title AS plan_title,
        p.is_trial,
        p.trial_days

      FROM users u
      LEFT JOIN tenants t 
        ON u.tenant_id = t.id
      LEFT JOIN plans p
        ON t.payment_gateway_product_id = p.payment_gateway_product_id
        AND p.is_deleted = 0

      WHERE u.username = ? 
        AND u.tenant_id = ?
      LIMIT 1;
    `;

    const [rows] = await conn.query(sql, [username, tenantId]);
    return rows[0] || null;

  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.checkEmailExistsDB = async (email) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        SELECT username FROM users
        WHERE username = ?
        LIMIT 1;
        `;

        const [result] = await conn.query(sql, [email]);
        const user = result[0];

        if (!user) {
            return false;
        } else {
            return true;
        }
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.checkEmailExistsSuperadminDB = async (email, tenantId) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        SELECT username FROM users
        WHERE username = ? AND tenant_id != ?
        LIMIT 1;
        `;

        const [result] = await conn.query(sql, [email, tenantId]);
        const user = result[0];

        if (!user) {
            return false;
        } else {
            return true;
        }
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.signUpDB = async (bizName, username, password) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const [result] = await conn.query(`INSERT INTO tenants (name, is_active, subscription_id) VALUES (?, 0, null)`, [bizName])

        const sql = `
        INSERT INTO users (username, password, name, role, tenant_id) VALUES (?, ?, ?, 'admin', ?);
        `;

        await conn.query(sql, [username, password, bizName, result.insertId]);
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.addRefreshTokenDB = async (username, refreshToken, expiry, deviceIP, deviceName, deviceLocation, tenantId) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        INSERT INTO refresh_tokens (username, refresh_token, device_ip, device_name, device_location, expiry, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?);
        `;

        const [result] = await conn.query(sql, [username, refreshToken, deviceIP, deviceName, deviceLocation, expiry, tenantId]);
        return result.insertId;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.removeRefreshTokenDB = async (username, refreshToken) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        DELETE FROM refresh_tokens
        WHERE username = ? AND refresh_token = ?;
        DELETE FROM refresh_tokens
        WHERE username = ? AND expiry < CURDATE();
        `;

        await conn.query(sql, [username, refreshToken, username]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.removeRefreshTokenByDeviceIdDB = async (username, deviceId) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        DELETE FROM refresh_tokens
        WHERE username = ? AND device_id = ?;
        DELETE FROM refresh_tokens
        WHERE username = ? AND expiry < CURDATE();
        `;

        await conn.query(sql, [username, deviceId, username]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};


exports.getDevicesDB = async (username) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        SELECT device_id, refresh_token, device_ip, device_name, device_location, created_at FROM refresh_tokens
        WHERE username = ?;
        `;

        const [results] = await conn.query(sql, [username]);
        return results;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.verifyRefreshTokenDB = async (refreshToken) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        SELECT username, refresh_token FROM refresh_tokens
        WHERE refresh_token = ?
        LIMIT 1;
        `;

        const [result] = await conn.query(sql, [refreshToken]);
        return result[0];
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.forgotPasswordDB = async (email, token, tokenValidity) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        INSERT INTO reset_password_tokens
        (username, reset_token, expires_at)
        VALUES
        (?, ?, ?)
        ON DUPLICATE KEY UPDATE
        reset_token = VALUES(reset_token),
        expires_at = VALUES(expires_at);
        `;

        await conn.query(sql, [email, token, tokenValidity]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.deleteForgotPasswordTokenDB = async (token) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        DELETE FROM reset_password_tokens
        WHERE reset_token = ?;
        `;

        await conn.query(sql, [token]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.checkForgotPasswordTokenDB = async (token, date) => {

    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        SELECT rt.username, u.tenant_id, reset_token, expires_at FROM reset_password_tokens rt
        LEFT JOIN users u
        ON rt.username = u.username
        WHERE reset_token = ? AND expires_at > ?
        LIMIT 1;
        `;

        const [result] = await conn.query(sql, [token, date]);
        return result[0];
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getSubscriptionDetailsDB = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
            SELECT 
            t.id,
            t.name,
            t.is_active,
            t.subscription_id,
            t.payment_customer_id,
            t.subscription_start,
            t.subscription_end,
            t.isTrialPlan,
            sh.status,
            sh.starts_on,
            sh.expires_on
        FROM tenants t
        LEFT JOIN subscription_history sh 
            ON sh.tenant_id = t.id
            AND sh.created_at = (
                SELECT MAX(created_at)
                FROM subscription_history
                WHERE tenant_id = t.id
            )
        WHERE t.id = ?
        LIMIT 1;
        `;

        const [gateway] = await conn.query(`SELECT gateway_name FROM payment_gateways WHERE status = 1`);
        const gatewayName = gateway[0]?.gateway_name;

        const [results] = await conn.query(sql, [tenantId]);
        return { ...results[0], payment_gateway: gatewayName };
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.updateTenantSubscriptionAccess = async (email, status, subscriptionId, paymentCustomerId, subscriptionStartTimestamp, subscriptionEndTimestamp) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        UPDATE tenants
        SET is_active = ?, subscription_id = ?, payment_customer_id = ?, subscription_start = ?, subscription_end = ?
        WHERE id = (
            SELECT tenant_id FROM users
            WHERE username = ?
        )
        `;

        await conn.query(sql, [status, subscriptionId, paymentCustomerId, subscriptionStartTimestamp, subscriptionEndTimestamp, email]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.addTenantSubsctiptionDetails = async (email, productId, priceId) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        UPDATE tenants
        SET payment_gateway_product_id = ?, payment_gateway_price_id = ?
        WHERE id = (
            SELECT tenant_id FROM users
            WHERE username = ?
        )
        `;

        await conn.query(sql, [productId, priceId, email]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.updateTenantTrialStatus = async (email, hasTrial) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        UPDATE tenants
        SET hasTrial = ?
        WHERE id = (
            SELECT tenant_id FROM users
            WHERE username = ?
        )
        `;

        await conn.query(sql, [hasTrial, email]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.updateTenantIsTrailRunningStatus = async (email, isTrailPlanRuning) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        UPDATE tenants
        SET isTrialPlan = ?
        WHERE id = (
            SELECT tenant_id FROM users
            WHERE username = ?
        )
        `;

        await conn.query(sql, [isTrailPlanRuning, email]);
        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.updateSubscriptionHistory = async (tenantId, starts_on, expires_on, status) => {
    const conn = await getMySqlPromiseConnection();
    try {
        await conn.query(`INSERT INTO subscription_history (tenant_id, created_at, starts_on, expires_on , status) VALUES (?, NOW() , ? , ? , ?)`, [tenantId, starts_on, expires_on, status])

        return;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
}

exports.getTenantIdFromCustomerEmail = async (customerEmail) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        SELECT tenant_id from users where username = ?
        `;


        const [results] = await conn.query(sql, [customerEmail]);
        return results[0]?.tenant_id; 
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
}

exports.getTenantById = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `
        SELECT hasTrial, is_active, token_version from tenants where id = ?
        `;

        const [rows] = await conn.query(sql, [tenantId]);
        return rows[0];
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
}

// exports.getTenantById = async (tenantId, deviceId) => {
//     const conn = await getMySqlPromiseConnection();

//     try {
//         const sql = `DELETE FROM refresh_tokens WHERE tenant_id = ? AND device_id != ?
//         `;

//         const [rows] = await conn.query(sql, [tenantId, deviceId]);
//         return rows[0];
//     } catch (error) {
//         console.error(error);
//         throw error;
//     } finally {
//         conn.release();
//     }
// }

exports.getUserDeviceId = async (username) => {
    const conn = await getMySqlPromiseConnection();

    try {
        const sql = `SELECT device_id from refresh_tokens WHERE username = ? LIMIT 1`;
        const [rows] = await conn.query(sql, [username]);
        return rows[0]?.device_id
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
}

exports.rotateRefreshTokenDB = async (
    username,
    deviceIP,
    deviceName,
    deviceLocation,
    newRefreshToken,
    tenantId
) => {
    const conn = await getMySqlPromiseConnection();

    try {
        await conn.beginTransaction();

        // 1️⃣ Revoke old refresh token
    //     await conn.query(
    //         `
    //   DELETE FROM refresh_tokens WHERE tenant_id = ?`,
    //         [tenantId]
    //     );

        // 2️⃣ Insert new refresh token
        await conn.query(
            `
      INSERT INTO refresh_tokens (
        username,
        tenant_id,
        refresh_token,
        expiry,
        device_ip,
        device_name,
        device_location
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
            [
                username,
                tenantId,
                newRefreshToken,
                new Date(Date.now() + Number(CONFIG.COOKIE_EXPIRY_REFRESH)),
                deviceIP,
                deviceName,
                deviceLocation
            ]
        );

        await conn.commit();
        return true;
    } catch (error) {
        await conn.rollback();
        console.error("Rotate Refresh Token Error:", error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.removeRefreshTokenByTenanatId = async (tenantId) => {
    const conn = await getMySqlPromiseConnection();

    try {
        await conn.beginTransaction();

        // 1️⃣ Revoke old refresh token
        await conn.query(
            `DELETE FROM refresh_tokens WHERE tenant_id = ?`,
            [tenantId]
        );

        await conn.commit();
        return true;
    } catch (error) {
        await conn.rollback();
        console.error("Rotate Refresh Token Error:", error);
        throw error;
    } finally {
        conn.release();
    }
};

