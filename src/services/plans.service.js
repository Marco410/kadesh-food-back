const { getMySqlPromiseConnection } = require("../config/mysql.db");
const { CONFIG } = require("../config");
const Stripe = require("stripe");
const Paystack = require("paystack");
const fetch = require("node-fetch");
const { applyDiscount } = require("../utils/applyDiscount");
const { toStripeAmount } = require("../utils/toStripeAmount");
const {
  getGatewayDB,
  activatePaymentGatewayDB,
} = require("./superadmin.service");
const { decryptCredentials } = require("../utils/encryptCredentials");

exports.getPaymentGateway = (key) => {
  switch (key.gateway_name) {
    case "stripe":
      return {
        name: "stripe",
        createProduct: async (title) => {
          const stripe = new Stripe(key.credentials.secret_key);
          const product = await stripe.products.create({ name: title });
          return { productId: product.id, client: stripe };
        },
        createPrice: async ({
          client,
          amount,
          currency,
          interval,
          trial_days,
          productId,
        }) => {
          const price = await client.prices.create({
            unit_amount: toStripeAmount(amount, currency),
            currency,
            recurring: trial_days
              ? { interval, trial_period_days: trial_days }
              : { interval },
            product: productId,
          });
          return price.id;
        },
      };

    default:
      return { error: "UNSUPPORTED_PAYMENT_GATEWAY" };
  }
};

exports.createPlanDB = async (
  title,
  features_description,
  features,
  trial_days,
  is_trial = 0,
  is_recommended = 0,
  discount = 0,
  yearlyDiscount = 0,
  currencies
) => {
  const conn = await getMySqlPromiseConnection();
  const getPaymentGateway = exports.getPaymentGateway;
  try {
    if (!title || !currencies?.length) throw new Error("Invalid data");

    const key = await activatePaymentGatewayDB();
    if (!key?.credentials) {
      throw new Error("Payment gateway not configured");
    }
    const decryptedCredentials = decryptCredentials(key.credentials);
    const keyData = {
      ...key,
      credentials: decryptedCredentials,
    };
    const gateway = getPaymentGateway(keyData);

    if (gateway.error) {
      throw new Error(gateway.error);
    }

    await conn.beginTransaction();

    // create product
    const { productId, client } = await gateway.createProduct(title);

    // insert plan
    const [plan] = await conn.query(
      `INSERT INTO plans
      (payment_gateway_product_id, title, is_recommended, is_trial, trial_days,
       features_description, features, discount, yearly_discount, payment_gateway)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productId,
        title,
        is_recommended,
        is_trial,
        trial_days || null,
        JSON.stringify(features_description || []),
        JSON.stringify(features || []),
        discount,
        yearlyDiscount,
        gateway.name,
      ]
    );

    const plan_id = plan.insertId;

    // prices
    for (const c of currencies) {
      const monthlyAmount = applyDiscount(c.monthly, discount);
      const yearlyAmount = applyDiscount(c.yearly, yearlyDiscount);

      const monthlyPriceId = await gateway.createPrice({
        client,
        amount: monthlyAmount,
        currency: c.currency,
        interval: "month",
        trial_days: is_trial ? trial_days : null,
        productId,
      });

      const yearlyPriceId = await gateway.createPrice({
        client,
        amount: yearlyAmount,
        currency: c.currency,
        interval: "year",
        trial_days: is_trial ? trial_days : null,
        productId,
      });

      await conn.query(
        `INSERT INTO plan_prices
        (plan_id, country, currency, symbol, is_default, frequency, amount, payment_gateway_price_id, is_active)
        VALUES
        (?, ?, ?, ?, ?, 'monthly', ?, ?, 1),
        (?, ?, ?, ?, ?, 'yearly', ?, ?, 1)`,
        [
          plan_id,
          c.country,
          c.currency,
          c.symbol,
          c.is_default,
          monthlyAmount,
          monthlyPriceId,
          plan_id,
          c.country,
          c.currency,
          c.symbol,
          c.is_default,
          yearlyAmount,
          yearlyPriceId,
        ]
      );
    }
    await conn.commit();

    return { success: true, plan_id };
  } catch (error) {
    console.error("Create Plan Error :", error);
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

exports.updatePlanDB = async (
  planId,
  title,
  features_description,
  features,
  is_recommended = 0
) => {
  const conn = await getMySqlPromiseConnection();

  try {
    const [plan] = await conn.query(
      "SELECT payment_gateway_product_id FROM plans WHERE id = ?",
      [planId]
    );

    if (!plan.length) throw new Error("Plan not found");

    // get stripe key from DB
    const row = await getGatewayDB("stripe");

    if (!row?.credentials) {
      console.error("Stripe credentials not configured");
      // Why 200?
      // Stripe event is valid
      // Your system is not ready
      // Retrying won’t fix it
      // So tell Stripe: “Got it, stop retrying”
      return response.status(200).send();
    }

    // 🔓 decrypt here
    const creds = decryptCredentials(row.credentials);
    const stripe = new Stripe(creds?.secret_key);

    await stripe.products.update(plan[0].payment_gateway_product_id, {
      name: title,
    });

    // 2️⃣ update into plans
    const [planResult] = await conn.query(
      `UPDATE plans 
       SET 
         title = ?, 
         is_recommended = ?, 
         features_description = ?, 
         features = ?
       WHERE id = ?`,
      [
        title,
        is_recommended,
        JSON.stringify(features_description || []),
        JSON.stringify(features || []),
        planId,
      ]
    );

    return;
  } catch (error) {
    console.error("Create Plan Error :", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.updateTokenVersion = async (tenantId) => {
  const conn = await getMySqlPromiseConnection();

  try {
    await conn.query(
      `UPDATE tenants 
       SET token_version = token_version + 1 
       WHERE id = ?`,
      [tenantId]
    );
  } catch (error) {
    console.error("Update Token Version Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.updateTenantPlan = async ({
  subscriptionId,
  currentPlanPriceId,
  nextPlanPriceId,
  newPlanId,
  newEndDateStr,
}) => {
  const conn = await getMySqlPromiseConnection();
  try {
    // 2️⃣ update into plans
    await conn.query(
      `UPDATE tenants
      SET
        payment_gateway_price_id = ?,
        subscription_end = ?,
        stripe_next_price_id = ?,
        payment_gateway_product_id = ?
      WHERE subscription_id = ?`,
      [
        currentPlanPriceId,
        newEndDateStr,
        nextPlanPriceId,
        newPlanId,
        subscriptionId,
      ]
    );

    return;
  } catch (error) {
    console.error("Create Plan Error :", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.resetQRMenuSettings = async (tenantId) => {
  const conn = await getMySqlPromiseConnection();

  try {
    // 2️⃣ update into plans
    await conn.query(
      `
      UPDATE store_details
      SET
        is_qr_menu_enabled = ?,
        is_qr_order_enabled = ?,
        is_feedback_enabled = ?
      WHERE tenant_id = ?
      `,
      [false, false, false, tenantId]
    );

    return;
  } catch (error) {
    console.error("Create Plan Error :", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.getPlansDB = async (page = 1, perPage = 10) => {
  const conn = await getMySqlPromiseConnection();

  try {
    // const offset = (page - 1) * perPage;

    // // -------- Count total plans ----------
    // const [[{ total }]] = await conn.query(
    //   `SELECT COUNT(*) as total FROM plans WHERE is_deleted = 0`
    // );

    // -------- Fetch paginated plans ----------
    const [rows] = await conn.query(
      `SELECT 
        p.id,
        p.title,
        p.payment_gateway,
        p.is_recommended,
        p.is_trial,
        p.trial_days,
        p.features_description,
        p.features,
        p.discount,
        p.yearly_discount,
        p.payment_gateway_product_id,
        pp.id AS price_id,
        pp.country,
        pp.currency,
        pp.frequency,
        pp.symbol,
        pp.is_default,
        pp.amount,
        pp.payment_gateway_price_id,
        pp.is_active
      FROM plans p
      LEFT JOIN payment_gateways pg ON p.payment_gateway = pg.gateway_name
      LEFT JOIN plan_prices pp 
        ON p.id = pp.plan_id
      WHERE is_deleted = 0 AND pg.status = 1
      ORDER BY p.id DESC
      `,
      []
    );

    // -------- Group plans ----------
    const plans = Object.values(
      rows.reduce((acc, row) => {
        if (!acc[row.id]) {
          acc[row.id] = {
            id: row.id,
            title: row.title,
            payment_gateway: row.payment_gateway,
            is_recommended: row.is_recommended,
            is_trial: row.is_trial,
            trial_days: row.trial_days,
            features_description: JSON.parse(row.features_description || "[]"),
            features: JSON.parse(row.features || "[]"),
            discount: row.discount,
            yearly_discount: row.yearly_discount,
            payment_gateway_product_id: row.payment_gateway_product_id,
            prices: [],
          };
        }

        if (row.price_id) {
          acc[row.id].prices.push({
            price_id: row.price_id,
            country: row.country,
            currency: row.currency,
            frequency: row.frequency,
            symbol: row.symbol,
            is_default: row.is_default,
            amount: row.amount,
            payment_gateway_price_id: row.payment_gateway_price_id,
            is_active: row.is_active,
          });
        }

        return acc;
      }, {})
    );

    return plans;

    // return {
    //   plans,
    //   currentPage: page,
    //   perPage,
    //   totalItems: total,
    //   totalPages: Math.ceil(total / perPage)
    // };
  } catch (error) {
    console.error("Get Plans Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.getAllNonTrialPlans = async (page = 1, perPage = 10) => {
  const conn = await getMySqlPromiseConnection();

  try {
    // const offset = (page - 1) * perPage;

    // // -------- Count total plans ----------
    // const [[{ total }]] = await conn.query(
    //   `SELECT COUNT(*) as total FROM plans WHERE is_deleted = 0`
    // );

    // -------- Fetch paginated plans ----------
    const [rows] = await conn.query(
      `SELECT 
        p.id,
        p.title,
        p.is_recommended,
        p.is_trial,
        p.trial_days,
        p.features_description,
        p.features,
        p.discount,
        p.yearly_discount,
        p.payment_gateway_product_id,
        pp.id AS price_id,
        pp.country,
        pp.currency,
        pp.symbol,
        pp.is_default,
        pp.frequency,
        pp.amount,
        pp.payment_gateway_price_id,
        pp.is_active
      FROM plans p
      LEFT JOIN plan_prices pp 
        ON p.id = pp.plan_id
      WHERE is_deleted = 0
      AND is_trial = 0
      ORDER BY p.id DESC
      `,
      []
    );

    // -------- Group plans ----------
    const plans = Object.values(
      rows.reduce((acc, row) => {
        if (!acc[row.id]) {
          acc[row.id] = {
            id: row.id,
            title: row.title,
            is_recommended: row.is_recommended,
            is_trial: row.is_trial,
            trial_days: row.trial_days,
            features_description: JSON.parse(row.features_description || "[]"),
            features: JSON.parse(row.features || "[]"),
            discount: row.discount,
            yearly_discount: row.yearly_discount,
            payment_gateway_product_id: row.payment_gateway_product_id,
            prices: [],
          };
        }

        if (row.price_id) {
          acc[row.id].prices.push({
            price_id: row.price_id,
            country: row.country,
            currency: row.currency,
            frequency: row.frequency,
            symbol: row.symbol,
            is_default: row.is_default,
            amount: row.amount,
            payment_gateway_price_id: row.payment_gateway_price_id,
            is_active: row.is_active,
          });
        }

        return acc;
      }, {})
    );

    return plans;

    // return {
    //   plans,
    //   currentPage: page,
    //   perPage,
    //   totalItems: total,
    //   totalPages: Math.ceil(total / perPage)
    // };
  } catch (error) {
    console.error("Get Plans Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.getPlanByIdDB = async (id) => {
  const conn = await getMySqlPromiseConnection();

  try {
    if (!id) throw new Error("Plan id is required");

    const [plan] = await conn.query(
      `SELECT  
        id,
        title,
        is_recommended,
        is_trial,
        trial_days,
        features_description,
        features,
        discount,
        yearly_discount,
        payment_gateway_product_id
        FROM plans WHERE id = ?`,
      [id]
    );

    if (!plan.length) {
      throw new Error("Plan not found");
    }

    const [prices] = await conn.query(
      `SELECT 
        id AS price_id,
        country,
        currency,
        frequency,
        symbol,
        is_default,
        amount,
        payment_gateway_price_id,
        is_active
        FROM plan_prices WHERE plan_id = ?`,
      [id]
    );

    return {
      success: true,
      data: {
        ...plan[0],
        features_description: JSON.parse(plan[0].features_description || "[]"),
        features: JSON.parse(plan[0].features || "[]"),
        prices,
      },
    };
  } catch (error) {
    console.error("Get Plan By ID Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.getSubscriptionHistory = async (id) => {
  const conn = await getMySqlPromiseConnection();

  try {
    const [plan] = await conn.query(
      `SELECT  
        sh.id,
        sh.created_at,
        sh.starts_on,
        sh.expires_on,
        sh.status,

        p.title AS plan_title,
        p.is_trial,

        pp.amount,
        pp.symbol,
        pp.currency,
        pp.frequency
      FROM subscription_history sh
      INNER JOIN tenants t 
        ON t.id = sh.tenant_id
      LEFT JOIN plans p 
        ON p.payment_gateway_product_id = t.payment_gateway_product_id
      LEFT JOIN plan_prices pp
        ON pp.plan_id = p.id
      WHERE sh.tenant_id = ?`,
      [id]
    );
    return plan;
  } catch (error) {
    console.error("Get Plan By ID Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

// Existing users on that plan continue billing normally
// New users cannot subscribe (because you hide it via DB is_deleted)
// Billing, renewals, invoices continue normally from Stripe for soft deleted plan users
exports.deletePlanByIdDB = async (id) => {
  const conn = await getMySqlPromiseConnection();

  try {
    // get active gateway
    const key = await activatePaymentGatewayDB();
    if (!key?.gateway_name) {
      return { success: false, error: "NO_ACTIVE_GATEWAY" };
    }

    const gatewayName = key.gateway_name.toLowerCase();

    // check plan
    const [plans] = await conn.query(
      `SELECT * FROM plans WHERE id = ? AND is_deleted = 0`,
      [id]
    );

    if (!plans.length) {
      return { success: false, error: "PLAN_NOT_FOUND" };
    }

    const plan = plans[0];

    // check linked tenants
    const [linked] = await conn.query(
      `SELECT id FROM tenants WHERE payment_gateway_product_id = ?`,
      [plan.payment_gateway_product_id]
    );

    if (linked.length) {
      return { success: false, error: "PLAN_IN_USE" };
    }

    // soft delete
    await conn.query(`UPDATE plans SET is_deleted = 1 WHERE id = ?`, [id]);
    await conn.query(`UPDATE plan_prices SET is_active = 0 WHERE plan_id = ?`, [
      id,
    ]);

    // gateway specific cleanup
    if (gatewayName === "stripe") {
      const creds = decryptCredentials(key.credentials);
      const stripe = new (require("stripe"))(creds.secret_key);

      await stripe.products.update(plan.payment_gateway_product_id, {
        active: false,
      });

      const prices = await stripe.prices.list({
        product: plan.payment_gateway_product_id,
        limit: 100,
      });

      for (const price of prices.data) {
        await stripe.prices.update(price.id, { active: false });
      }
    }

    if (gatewayName === "paystack") {
      const creds = decryptCredentials(key.credentials);
      const paystack = new Paystack(creds.secret_key);

      const [planPrices] = await conn.query(
        `SELECT payment_gateway_price_id, frequency 
         FROM plan_prices 
         WHERE plan_id = ?`,
        [id]
      );

      for (const price of planPrices) {
        if (!price.payment_gateway_price_id) continue;
        const suffix = price.frequency === "monthly" ? "monthly" : "yearly";
        try {
          await paystack.plan.update(price.payment_gateway_price_id, {
            name: `${plan.title} ${suffix} (inactive)`,
            send_invoices: false,
            send_sms: false,
          });
        } catch (err) {
          console.error(
            `Paystack deactivate failed for ${price.payment_gateway_price_id}:`,
            err
          );
        }
      }
    }

    return {
      success: true,
      message: "Plan deleted successfully",
    };
  } catch (error) {
    console.error("Delete Plan Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.deletePaystackPlanByIdDB = async (id) => {
  const conn = await getMySqlPromiseConnection();
  let transactionStarted = false;

  try {
    const [[plan]] = await conn.query(
      `SELECT id, payment_gateway, payment_gateway_product_id
       FROM plans
       WHERE id = ? AND is_deleted = 0
       LIMIT 1`,
      [id]
    );

    if (!plan) return { success: false, error: "PLAN_NOT_FOUND" };
    if (plan.payment_gateway !== "paystack") {
      return { success: false, error: "NOT_PAYSTACK_PLAN" };
    }

    await conn.beginTransaction();
    transactionStarted = true;
    await conn.query(`UPDATE plans SET is_deleted = 1 WHERE id = ?`, [id]);
    await conn.query(`UPDATE plan_prices SET is_active = 0 WHERE plan_id = ?`, [
      id,
    ]);
    await conn.commit();
    transactionStarted = false;

    return { success: true, message: "Paystack plan deleted successfully" };
  } catch (error) {
    if (transactionStarted) {
      await conn.rollback();
    }
    console.error("Delete Paystack Plan Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.fetchDetailsOfUserByIp = async (id) => {
  const conn = await getMySqlPromiseConnection();

  try {
    const response = await axios.get("https://ipapi.co/json/");
    const userIp = response.data;

    const result = await axios.get(`https://ipapi.co/${userIp}/json/`);
    const userData = result.data;

    return userData;
  } catch (error) {
    console.error("Delete Plan Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.createManageSubscriptionLink = async (
  stripeCustomerId,
  subscriptionId,
  tenantId,
  deviceId
) => {
  const conn = await getMySqlPromiseConnection();
  try {
    // get stripe key from DB
    const row = await getGatewayDB("stripe");

    if (!row?.credentials) {
      console.error("Stripe credentials not configured");
      // Why 200?
      // Stripe event is valid
      // Your system is not ready
      // Retrying won’t fix it
      // So tell Stripe: “Got it, stop retrying”
      return response.status(200).send();
    }

    // 🔓 decrypt here
    const creds = decryptCredentials(row.credentials);
    const stripe = new Stripe(creds?.secret_key);

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.FRONTEND_DOMAIN}/dashboard/home`,
    });

    return session.url;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

exports.getAllPlans = async () => {
  const conn = await getMySqlPromiseConnection();

  const [rows] = await conn.query(`
    SELECT 
      p.id AS plan_id,
      p.title,
      p.is_trial,
      p.trial_days,
      p.payment_gateway_product_id,

      pr.payment_gateway_price_id,
      pr.is_active
    FROM plans p
    LEFT JOIN plan_prices pr ON pr.plan_id = p.id
    ORDER BY p.id;
  `);

  const plansMap = {};

  for (const row of rows) {
    if (!plansMap[row.plan_id]) {
      plansMap[row.plan_id] = {
        id: row.plan_id,
        title: row.title,
        is_trial: row.is_trial,
        trial_days: row.trial_days,
        payment_gateway_product_id: row.payment_gateway_product_id,
        prices: [],
      };
    }

    if (row.payment_gateway_price_id) {
      plansMap[row.plan_id].prices.push({
        payment_gateway_price_id: row.payment_gateway_price_id,
        is_trial: row.price_is_trial,
        is_active: row.price_is_active,
      });
    }
  }

  return Object.values(plansMap);
};

exports.createPortalConfig = async () => {
  const conn = await getMySqlPromiseConnection();
  try {
    const plans = await this.getAllNonTrialPlans(); // DB

    const products = plans.map((plan) => ({
      product: plan.payment_gateway_product_id,
      prices: plan.prices
        //  .filter(p => p.is_trial == 0 )
        .map((p) => p.payment_gateway_price_id),
    }));

    // get stripe key from DB
    const row = await getGatewayDB("stripe");

    if (!row?.credentials) {
      console.error("Stripe credentials not configured");
      // Why 200?
      // Stripe event is valid
      // Your system is not ready
      // Retrying won’t fix it
      // So tell Stripe: “Got it, stop retrying”
      return response.status(200).send();
    }

    // 🔓 decrypt here
    const creds = decryptCredentials(row.credentials);
    const stripe = new Stripe(creds?.secret_key);

    await stripe.billingPortal.configurations.update(creds?.portal_config_id, {
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          products,
        },
        subscription_cancel: { enabled: false },
        payment_method_update: { enabled: true },
      },
    });

    return;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

exports.getUserCountry = async (id) => {
  try {
    const res = await fetch("https://ipwho.is/");
    const data = await res.json();
    return data;
  } catch (error) {
    console.error("Get Plan By ID Error:", error);
    throw error;
  }
};


// paystack
exports.createPaystackPlanDB = async (
  title,
  features_description,
  features,
  is_recommended,
  discount,
  yearlyDiscount,
  currencies
) => {
  const conn = await getMySqlPromiseConnection();

  try {
    const key = await activatePaymentGatewayDB();
    const paystack = new Paystack(
      decryptCredentials(key.credentials).secret_key
    );

    await conn.beginTransaction();

    const [plan] = await conn.query(
      `INSERT INTO plans
      (payment_gateway_product_id, title, features_description, features,
       trial_days, is_trial, is_recommended, discount, yearly_discount, payment_gateway)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `PAYSTACK_${Date.now()}`,
        title,
        JSON.stringify(features_description || []),
        JSON.stringify(features || []),
        null,
        null,
        is_recommended,
        discount,
        yearlyDiscount,
        "paystack",
      ]
    );

    const planId = plan.insertId;
    let productId = null;

    for (const c of currencies) {
      for (const interval of ["month", "year"]) {
        const intervalType = interval === "month" ? "monthly" : "annually";
        const amount =
          interval === "month"
            ? applyDiscount(c.monthly, discount)
            : applyDiscount(c.yearly, yearlyDiscount);

        const psPlan = await paystack.plan.create({
          name: `${title} ${intervalType}`,
          amount: amount * 100,
          currency: c.currency,
          interval: intervalType,
        });

        if (psPlan.code?.includes("invalid_amount")) {
          throw new Error(psPlan.message);
        }

        const planCode = psPlan.data.plan_code;

        await conn.query(
          `INSERT INTO plan_prices
          (plan_id, country, currency, symbol, is_default, frequency,
           amount, payment_gateway_price_id, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            planId,
            c.country,
            c.currency,
            c.symbol,
            c.is_default,
            interval === "month" ? "monthly" : "yearly",
            amount,
            planCode,
          ]
        );
      }
    }

    await conn.commit();
    return { success: true, planId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

exports.updatePaystackPlanDB = async (id, payload) => {
  const conn = await getMySqlPromiseConnection();
  const {
    title,
    features_description = [],
    features = [],
    is_recommended,
    discount,
    yearlyDiscount,
  } = payload;

  try {
    const [[plan]] = await conn.query(
      `SELECT payment_gateway FROM plans WHERE id = ? AND is_deleted = 0`,
      [id]
    );

    if (!plan) return { success: false, error: "PLAN_NOT_FOUND" };
    if (plan.payment_gateway !== "paystack") return { success: false, error: "NOT_PAYSTACK_PLAN" };

    await conn.query(
      `UPDATE plans 
       SET title=?, features_description=?, features=?, is_recommended=?, discount=?, yearly_discount=?
       WHERE id=?`,
      [
        title,
        JSON.stringify(features_description),
        JSON.stringify(features),
        is_recommended,
        discount,
        yearlyDiscount,
        id,
      ]
    );

    const [prices] = await conn.query(
      `SELECT frequency, payment_gateway_price_id 
       FROM plan_prices WHERE plan_id=? AND is_active=1`,
      [id]
    );

    if (!prices.length) return { success: true };

    const gateway = await getGatewayDB("paystack");
    const secretKey = decryptCredentials(gateway?.credentials || "")?.secret_key;

    if (!secretKey) return { success: true };

    await Promise.all(
      prices
        .filter(p => p.payment_gateway_price_id)
        .map(p => {
          const name = `${title} ${p.frequency === "monthly" ? "Monthly" : "Yearly"}`;
          return fetch(`https://api.paystack.co/plan/${p.payment_gateway_price_id}`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${secretKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name }),
          }).catch(err => console.error("Paystack update failed:", err));
        })
    );

    return { success: true };
  } catch (err) {
    console.error("updatePaystackPlanDB:", err);
    throw err;
  } finally {
    conn.release();
  }
};


exports.createPaystackPaymentLink = async ({
  priceId,
  email,
  tenantId,
  deviceId,
}) => {
  const conn = await getMySqlPromiseConnection();
  try {
    if (!priceId) {
      throw new Error("PAYSTACK_PRICE_ID_REQUIRED");
    }

    const [rows] = await conn.query(
      `SELECT 
         pp.amount,
         pp.currency,
         pp.payment_gateway_price_id,
         p.payment_gateway_product_id
       FROM plan_prices pp
       INNER JOIN plans p ON p.id = pp.plan_id
       WHERE pp.payment_gateway_price_id = ?
         AND p.payment_gateway = 'paystack'
         AND pp.is_active = 1
       LIMIT 1`,
      [priceId]
    );

    if (!rows.length) {
      throw new Error("PAYSTACK_PLAN_NOT_FOUND");
    }

    const row = rows[0];

    const key = await activatePaymentGatewayDB();
    const paystack = new Paystack(
      decryptCredentials(key.credentials).secret_key
    );

    const payload = {
      email,
      amount: row.amount * 100,
      currency: row.currency,
      plan: row.payment_gateway_price_id,
      callback_url: `${CONFIG.FRONTEND_DOMAIN}/success`,
      metadata: {
        tenant_id: tenantId,
        device_id: deviceId || "",
        price_id: priceId,
        product_id: row.payment_gateway_product_id || null,
        success_url: `${CONFIG.FRONTEND_DOMAIN}/success`,
        cancel_url: `${CONFIG.FRONTEND_DOMAIN}/cancelled-payment`,
      },
    };

    const paymentLink = await paystack.transaction.initialize(payload);

    return paymentLink.data;
  } catch (error) {
    console.error("Create Paystack Payment Link Error:", error);
    throw error;
  } finally {
    conn.release();
  }
};

exports.getPaystackManageSubscriptionLink = async (subscriptionCode) => {
  if (!subscriptionCode?.trim()) {
    throw new Error("PAYSTACK_SUBSCRIPTION_CODE_REQUIRED");
  }

  const gateway = await getGatewayDB("paystack");
  if (!gateway?.credentials) {
    console.error("Paystack credentials not configured");
    throw new Error("PAYSTACK_NOT_CONFIGURED");
  }

  const creds = decryptCredentials(gateway.credentials);
  const secretKey = creds?.secret_key;
  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY_MISSING");
  }

  const url = `https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode.trim())}/manage/link`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();

  if (!data.status || !data.data?.link) {
    const message = data.message || "Failed to generate Paystack manage link";
    console.error("Paystack manage link error:", message);
    throw new Error(message);
  }

  return { link: data.data.link };
};