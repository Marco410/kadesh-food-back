const { CONFIG } = require("../config");
const { mailTransport } = require("../config/mailTransport");
const {
  signInDB,
  removeRefreshTokenDB,
  addRefreshTokenDB,
  verifyRefreshTokenDB,
  removeRefreshTokenByDeviceIdDB,
  getDevicesDB,
  checkEmailExistsDB,
  signUpDB,
  updateTenantSubscriptionAccess,
  getSubscriptionDetailsDB,
  getUserDB,
  forgotPasswordDB,
  checkForgotPasswordTokenDB,
  deleteForgotPasswordTokenDB,
  updateSubscriptionHistory,
  getTenantIdFromCustomerEmail,
  updateTenantTrialStatus,
  getTenantById,
  addTenantSubsctiptionDetails,
  updateTenantIsTrailRunningStatus,
  getUserDeviceId,
  rotateRefreshTokenDB,
  removeRefreshTokenByTenanatId,
} = require("../services/auth.service");
const {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
} = require("../utils/jwt");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const {
  deleteUserRefreshTokensDB,
  updateUserPasswordDB,
} = require("../services/user.service");
const {
  updateTenantPlan,
  resetQRMenuSettings,
  updateTokenVersion,
  getProductIdFromPriceId,
} = require("../services/plans.service");
const { getQRMenuCodeDB } = require("../services/settings.service");
const { getGatewayDB } = require("../services/superadmin.service");
const { ref } = require("process");
const Stripe = require("stripe");
const { decryptCredentials } = require("../utils/encryptCredentials");

exports.signIn = async (req, res) => {
  try {
    const username = req.body.username;
    const password = req.body.password;

    if (!(username && password)) {
      return res.status(400).json({
        success: false,
        message: req.__("please_provide_required_details"), // Translate message
      });
    }

    const result = await signInDB(username, password);

    if (result) {
      // set cookie
      const cookieOptions = {
        expires: new Date(Date.now() + parseInt(CONFIG.COOKIE_EXPIRY)),
        httpOnly: true,
        domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
        sameSite: false,
        secure: process.env.NODE_ENV == "production",
        path: "/",
      };

      const refreshTokenExpiry = new Date(
        Date.now() + parseInt(CONFIG.COOKIE_EXPIRY_REFRESH)
      );
      const cookieRefreshTokenOptions = {
        expires: refreshTokenExpiry,
        httpOnly: true,
        domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
        sameSite: false,
        secure: process.env.NODE_ENV == "production",
        path: "/",
      };

      result.password = undefined;

      const payload = {
        tenant_id: result.tenant_id,
        username: result.username,
        name: result.name,
        role: result.role,
        tokenVersion: result.token_version,
        // scope: result.scope,
        is_active: result.is_active,
        // planFeautures: JSON.parse(result.features || "[]")
      };
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(payload);

      res.cookie("accessToken", accessToken, cookieOptions);
      res.cookie("refreshToken", refreshToken, cookieRefreshTokenOptions);
      res.cookie("kadeshfood__authenticated", true, {
        expires: new Date(Date.now() + parseInt(CONFIG.COOKIE_EXPIRY_REFRESH)),
        domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
        sameSite: false,
        secure: process.env.NODE_ENV == "production",
        path: "/",
      });

      // set refresh token in DB.
      const deviceDetails = req.useragent;

      const deviceIP = req.connection.remoteAddress;
      const deviceName = `${deviceDetails.platform}\nBrowser: ${deviceDetails.browser}`;
      const deviceLocation = "";
      await addRefreshTokenDB(
        username,
        refreshToken,
        refreshTokenExpiry,
        deviceIP,
        deviceName,
        deviceLocation,
        result.tenant_id
      );

      return res.status(200).json({
        success: true,
        message: req.__("login_successful"), // Translate message
        accessToken,
        refreshToken,
        user: result,
      });
    } else {
      return res.status(401).json({
        success: false,
        message: req.__("email_or_password_invalid"), // Translate message
      });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("facing_issues_try_later"), // Translate message
    });
  }
};

exports.signUp = async (req, res) => {
  try {
    const biz_name = req.body.biz_name;
    const username = req.body.username;
    const password = req.body.password;

    if (!(biz_name && username && password)) {
      return res.status(400).json({
        success: false,
        message: req.__("please_provide_required_details"), // Translate message
      });
    }

    // check if email exists
    const isEmailExists = await checkEmailExistsDB(username);

    if (isEmailExists) {
      return res.status(400).json({
        success: false,
        message: req.__("account_exists_try_login"), // Translate message
      });
    }

    // encrypt the password
    const encryptedPassword = await bcrypt.hash(password, CONFIG.PASSWORD_SALT);

    await signUpDB(biz_name, username, encryptedPassword);

    return res.status(200).json({
      success: true,
      message: req.__("account_created_login_now"), // Translate message
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("cant_register_try_later"), // Translate message
    });
  }
};

exports.signOut = async (req, res) => {
  try {
    const user = req.user;
    const refreshToken =
      req.cookies.refreshToken ||
      req.headers["x-refresh-token"] ||
      req.body?.refreshToken;

    res.clearCookie("accessToken", {
      expires: new Date(Date.now()),
      httpOnly: true,
      domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
      sameSite: false,
      secure: process.env.NODE_ENV == "production",
      path: "/",
    });
    res.clearCookie("refreshToken", {
      expires: new Date(Date.now()),
      httpOnly: true,
      domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
      sameSite: false,
      secure: process.env.NODE_ENV == "production",
      path: "/",
    });
    res.clearCookie("kadeshfood__authenticated", {
      expires: new Date(Date.now()),
      domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
      sameSite: false,
      secure: process.env.NODE_ENV == "production",
      path: "/",
    });

    // remove refreshToken in DB.
    await removeRefreshTokenDB(user.username, refreshToken);

    return res.status(200).json({
      success: true,
      message: req.__("logout_successful"), // Translate message
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"), // Translate message
    });
  }
};

// exports.getNewAccessToken = async (req, res) => {
//     try {
//         const user = req.user;
//         const refreshToken = req.cookies.refreshToken;

//         console.log("cookies",refreshToken);

//         // verify the refresh token with the DB
//         const isExist = await verifyRefreshTokenDB(refreshToken);
//         console.log("isExist",isExist);
//         if(isExist) {
//             // generate new access token
//             // set cookie
//             const cookieOptions = {
//                 expires: new Date(Date.now() + parseInt(CONFIG.COOKIE_EXPIRY)),
//                 httpOnly: true,
//                 domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
//                 sameSite: false,
//                 secure: process.env.NODE_ENV == "production",
//                 path: "/"
//             };
//             const u = await getUserDB(user.username, user.tenant_id);
//             const payload = {
//                 tenant_id: u.tenant_id,
//                 is_active: u.is_active,
//                 username: u.username,
//                 name: u.name,
//                 role: u.role,
//                 tokenVersion: u.token_version,
//                 // scope: u.scope,
//                 // planFeautures: JSON.parse(u.features || "[]")
//             }
//             const accessToken = generateAccessToken(payload);

//             res.cookie('accessToken', accessToken, cookieOptions);

//             return res.status(200).json({
//                 success: true,
//                 message: req.__("new_token_created_successfully"), // Translate message
//                 accessToken
//             });
//         } else {
//             res.clearCookie('accessToken', {
//                 expires: new Date(Date.now() ),
//                 httpOnly: true,
//                 domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
//                 sameSite: false,
//                 secure: process.env.NODE_ENV == "production",
//                 path: "/"
//             });
//             res.clearCookie('refreshToken', {
//                 expires: new Date(Date.now()),
//                 httpOnly: true,
//                 domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
//                 sameSite: false,
//                 secure: process.env.NODE_ENV == "production",
//                 path: "/"
//             });
//             res.clearCookie('kadeshfood__authenticated', {
//                 expires: new Date(Date.now()),
//                 domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
//                 sameSite: false,
//                 secure: process.env.NODE_ENV == "production",
//                 path: "/"
//             });
//             return res.status(401).json({
//                 success: false,
//                 loginNeeded: true,
//                 message: req.__("login_again_to_access") // Translate message
//             });
//         }

//     } catch (error) {
//         console.error(error);
//         return res.status(500).json({
//             success: false,
//             message: req.__("something_went_wrong_try_later") // Translate message
//         });
//     }
// };

exports.getNewAccessToken = async (req, res) => {
  try {
    const refreshToken =
      req.refreshToken ||
      req.cookies.refreshToken ||
      req.headers["x-refresh-token"] ||
      req.body?.refreshToken;
    if (!refreshToken) throw new Error("No refresh token");

    // 1️⃣ Verify refresh token JWT
    const decoded = verifyToken(refreshToken);

    // 2️⃣ Check refresh token exists in DB
    const isExist = await verifyRefreshTokenDB(refreshToken);
    if (!isExist) throw new Error("Refresh token revoked");

    // 3️⃣ Validate tenant + token version
    // const tenant = await getTenantById(decoded.tenant_id);
    // if (!tenant) throw new Error("Tenant not found");

    // if (decoded.tokenVersion !== tenant.token_version) {
    //     throw new Error("Token version mismatch");
    // }

    // 4️⃣ Get fresh user data
    const user = await getUserDB(decoded.username, decoded.tenant_id);

    const userDetails = {
      ...user,
      planFeautures: JSON.parse(user.planFeatures || "[]"),
    };

    const payload = {
      tenant_id: user.tenant_id,
      username: user.username,
      name: user.name,
      role: user.role,
      is_active: user.is_active,
      tokenVersion: user.token_version,
      scope: user.scope,
      planFeautures: JSON.parse(user.planFeatures || "[]"),
    };

    // 5️⃣ Generate new tokens
    const newAccessToken = generateAccessToken(payload);

    const cookieOptions = {
      expires: new Date(Date.now() + parseInt(CONFIG.COOKIE_EXPIRY)),
      httpOnly: true,
      domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
      sameSite: false,
      secure: process.env.NODE_ENV == "production",
      path: "/",
    };

    res.cookie("accessToken", newAccessToken, cookieOptions);

    return res.status(200).json({
      success: true,
      message: req.__("new_token_created_successfully"),
      newAccessToken,
      userDetails,
    });
  } catch (error) {
    // 🔥 Logout safely
    res.clearCookie("accessToken", {
      expires: new Date(Date.now()),
      httpOnly: true,
      domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
      sameSite: false,
      secure: process.env.NODE_ENV == "production",
      path: "/",
    });
    res.clearCookie("refreshToken", {
      expires: new Date(Date.now()),
      httpOnly: true,
      domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
      sameSite: false,
      secure: process.env.NODE_ENV == "production",
      path: "/",
    });
    res.clearCookie("kadeshfood__authenticated", {
      expires: new Date(Date.now()),
      domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
      sameSite: false,
      secure: process.env.NODE_ENV == "production",
      path: "/",
    });

    console.log(error);

    return res.status(401).json({
      success: false,
      loginNeeded: true,
      message: req.__("login_again_to_access"),
    });
  }
};

exports.removeDeviceAccessToken = async (req, res) => {
  try {
    const user = req.user;
    const myRefreshToken = req.cookies.refreshToken;
    const deviceId = req.body.device_id;

    if (myRefreshToken == deviceId) {
      return res.status(400).json({
        success: false,
        message: req.__("operation_not_allowed"), // Translate message
      });
    }

    await removeRefreshTokenByDeviceIdDB(user.username, deviceId);

    return res.status(200).json({
      success: true,
      message: req.__("device_removed_successfully"), // Translate message
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"), // Translate message
    });
  }
};

exports.getDevices = async (req, res) => {
  try {
    const user = req.user;
    const myRefreshToken = req.cookies.refreshToken;

    const devices = await getDevicesDB(user.username);

    const modifiedDevices = devices.map((device) => {
      const newDevice = new Object({
        ...device,
        isMyDevice: device.refresh_token == myRefreshToken,
      });
      return newDevice;
    });

    return res.status(200).json(modifiedDevices);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"), // Translate message
    });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const username = req.body.username;

    if (!username) {
      return res.status(400).json({
        success: false,
        message: req.__("please_provide_email_address"), // Translate message
      });
    }

    const doesEmailExists = await checkEmailExistsDB(username);

    if (doesEmailExists) {
      const token = crypto.randomBytes(20).toString("hex");

      const encryptedToken = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const tokenValidity = new Date(Date.now() + 20 * 60 * 1000); // valid till next 20 mins

      const resetPasswordURL = `${CONFIG.FRONTEND_DOMAIN}/reset-password?token=${token}`;

      await forgotPasswordDB(username, encryptedToken, tokenValidity);

      await mailTransport({
        to: username,
        subject: "Reset Your Password",
        html: `Here is link to reset your profile password, open link to setup new password. the link is only valid till next 20 minutes, don't share this link with anyone.<br/><br/>${resetPasswordURL}`,
      });
    }

    return res.status(200).json({
      success: true,
      message: req.__("email_with_instructions_to_reset_password"), // Translate message
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      message: req.__("error_processing_request_try_later"), // Translate message
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const token = req.params.token;
    const password = req.body.password;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: req.__("please_provide_required_details"), // Translate message
      });
    }

    const encryptedToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const user = await checkForgotPasswordTokenDB(
      encryptedToken,
      new Date(Date.now())
    );
    if (user) {
      const username = user.username;
      const tenantId = user.tenant_id;

      const encryptedPassword = await bcrypt.hash(
        password,
        CONFIG.PASSWORD_SALT
      );

      await deleteUserRefreshTokensDB(username, tenantId);
      await updateUserPasswordDB(username, encryptedPassword, tenantId);

      await deleteForgotPasswordTokenDB(encryptedPassword);

      return res.status(200).json({
        success: true,
        message: req.__("password_changed_successfully"), // Translate message
      });
    } else {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request_or_link_expired"), // Translate message
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: req.__("error_processing_request_try_later"), // Translate message
    });
  }
};

exports.getSubscriptionDetails = async (req, res) => {
  try {
    const user = req.user;
    const result = await getSubscriptionDetailsDB(user.tenant_id);
    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"), // Translate message
    });
  }
};

exports.cancelSubscription = async (req, res) => {
  try {
    const user = req.user;
    const id = req.body.id;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request"), // Translate message
      });
    }

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

    const subscription = await stripe.subscriptions.retrieve(id);
    // const subscription = await stripe.subscriptions.cancel(
    //     id
    // );

    const isTrial = subscription?.status === "trialing";
    let result;

    // 2️⃣ Logic
    if (isTrial) {
      // Immediately cancel
      result = await stripe.subscriptions.cancel(id);
    } else {
      // Stay until trial end
      result = await stripe.subscriptions.update(id, {
        cancel_at_period_end: true,
      });
    }

    // generate new access token
    // set cookie
    // const cookieOptions = {
    //     expires: new Date(Date.now() + parseInt(CONFIG.COOKIE_EXPIRY)),
    //     httpOnly: true,
    //     domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
    //     sameSite: false,
    //     secure: process.env.NODE_ENV == "production",
    //     path: "/"
    // };
    // const payload = {
    //     tenant_id: user.tenant_id,
    //     is_active: isTrial ? 0 : 1,
    //     username: user.username,
    //     name: user.name,
    //     role: user.role,
    //     scope: user.scope,
    // }
    // const accessToken = generateAccessToken(payload);

    // res.cookie('accessToken', accessToken, cookieOptions);

    return res.status(200).json({
      success: true,
      message: req.__("subscription_cancelled_no_longer_charged"), // Translate message
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"), // Translate message
    });
  }
};

exports.stripeProductSubscriptionLookup = async (req, res) => {
  try {
    const productId = req.body.id;
    const user = req.user;
    let { is_trial, trial_days } = req.body;

    if (!productId || typeof productId !== "string") {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing Stripe price",
      });
    }

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
    if (!creds?.secret_key) {
      throw new Error("Stripe secret key not configured");
    }
    const stripe = new Stripe(creds?.secret_key);

    // 1️⃣ Check if tenant already consumed trial
    const alreadyTookTrial = await getTenantById(user.tenant_id);

    if (alreadyTookTrial?.hasTrial === 1 && is_trial == 1) {
      return res.status(400).json({
        success: true,
        message: "You have already taken a Free trial",
      });
    }

    if (is_trial && (!trial_days || Number(trial_days) <= 0)) {
      return res.status(400).json({ message: "Invalid trial days" });
    }

    // const prices = await stripe.prices.list({
    //     lookup_keys: [productId],
    //     expand: ['data.product'],
    // });

    // console.log(prices);

    let userDeviceId;
    if (user?.username) {
      userDeviceId = await getUserDeviceId(user.username);
    }

    const session = await stripe.checkout.sessions.create({
      billing_address_collection: "auto",
      customer_email: user.username,
      metadata: {
        tenant_id: user.tenant_id,
        device_id: userDeviceId || "",
      },
      line_items: [
        {
          price: productId,
          // price: prices.data[0].id,
          quantity: 1,
        },
      ],
      mode: "subscription",

      ...(is_trial && {
        subscription_data: {
          trial_period_days: trial_days || 7,
        },
      }),

      success_url: `${CONFIG.FRONTEND_DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CONFIG.FRONTEND_DOMAIN}/cancelled-payment`,
    });

    return res.status(200).json({
      success: true,
      url: session.url,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      message: req.__("cant_retrieve_product_subscription_try_later"), // Translate message
    });
  }
};

function hasPriceChanged(event) {
  const prev = event.data.previous_attributes;
  if (!prev) return false;

  const prevItems = prev.items?.data;
  if (!prevItems || !prevItems.length) return false;

  const prevPriceId = prevItems[0]?.price?.id;
  const newPriceId = event.data.object.items.data[0]?.price?.id;

  return prevPriceId && newPriceId && prevPriceId !== newPriceId;
}

exports.stripeWebhook = async (request, response) => {
  let event = request.body;
  // get stripe key from DB
  console.log("Stripe webhook called event", event);
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

  // Replace this endpoint secret with your endpoint's unique secret
  // If you are testing with the CLI, find the secret by running 'stripe listen'
  // If you are using an endpoint defined with the API or dashboard, look in your webhook settings
  // at https://dashboard.stripe.com/webhooks

  const endpointSecret = creds?.webhook_secret;
  // Only verify the event if you have an endpoint secret defined.
  // Otherwise use the basic event deserialized with JSON.parse
  if (endpointSecret) {
    // Get the signature sent by Stripe
    const signature = request.headers["stripe-signature"];
    try {
      event = stripe.webhooks.constructEvent(
        request.body,
        signature,
        endpointSecret
      );
    } catch (err) {
      console.log(`⚠️  Webhook signature verification failed.`, err.message);
      return response.sendStatus(400);
    }
  }

  let subscription;
  let status;
  let customerEmail;

  subscription = event?.data?.object;

  if (!subscription) {
    console.log("No subscription data in the event. Skipping processing.");
    return response.sendStatus(200); // still return 200 so Stripe doesn't retry
  }

  status = subscription?.status;

  const stripeCustomerId = subscription?.customer;
  const subscriptionId = subscription?.id;
  const subscriptionStart = subscription?.current_period_start;
  const subscriptionEnd = subscription?.current_period_end;
  const items = subscription?.items?.data || [];
  const firstItem = items[0];
  const priceId = firstItem?.price?.id; // e.g. price_123
  const productId = firstItem?.price?.product; // e.g. prod_abc

  let startDateStr = null;
  let endDateStr = null;

  if (subscriptionStart && subscriptionEnd) {
    const startDate = new Date(subscriptionStart * 1000);
    const endDate = new Date(subscriptionEnd * 1000);

    startDateStr = `${startDate.getFullYear()}-${(startDate.getMonth() + 1)
      .toString()
      .padStart(2, "0")}-${startDate.getDate().toString().padStart(2, "0")}`;
    endDateStr = `${endDate.getFullYear()}-${(endDate.getMonth() + 1)
      .toString()
      .padStart(2, "0")}-${endDate.getDate().toString().padStart(2, "0")}`;
  }

  // get customer email
  try {
    if (stripeCustomerId) {
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      customerEmail = customer?.email;
    }
  } catch (error) {
    console.error("Error getting customer from stripe =>");
    console.error(error);
  }

  const tenantId = customerEmail
    ? await getTenantIdFromCustomerEmail(customerEmail)
    : null;

  // Handle the event
  try {
    switch (event.type) {
      case "customer.subscription.created":
        console.log(`Subscription status is ${status}.`);
        // Then define and call a method to handle the subscription created.
        // handleSubscriptionCreated(subscription);
        let hasTrial = status === "trialing" ? 1 : 0;
        let isTrailPlanRuning = status === "trialing" ? 1 : 0;
        //   const enable = status === "trialing" || status === "active" ? 1 : 0;

        await updateTenantSubscriptionAccess(
          customerEmail,
          1,
          subscriptionId,
          stripeCustomerId,
          startDateStr,
          endDateStr
        );
        // await updateTokenVersion(tenantId);
        // await removeRefreshTokenByTenanatId(tenantId);
        await addTenantSubsctiptionDetails(customerEmail, productId, priceId);
        if (status === "trialing") {
          //TODO: remove isTrialPlan field
          await updateTenantTrialStatus(customerEmail, hasTrial);
          await updateTenantIsTrailRunningStatus(
            customerEmail,
            isTrailPlanRuning
          );
        }
        await updateSubscriptionHistory(
          tenantId,
          startDateStr,
          endDateStr,
          "created"
        );
        break;
      case "customer.subscription.deleted":
        console.log(`Subscription status is ${status}.`);
        // Then define and call a method to handle the subscription deleted.
        // handleSubscriptionDeleted(subscriptionDeleted);
        // const endedAt = subscription?.ended_at || subscription?.canceled_at || subscription?.current_period_end;

        await updateTenantSubscriptionAccess(
          customerEmail,
          0,
          subscriptionId,
          stripeCustomerId,
          startDateStr,
          endDateStr
        );
        //   await updateTokenVersion(tenantId);
        //   await removeRefreshTokenByTenanatId(tenantId);
        await updateSubscriptionHistory(
          tenantId,
          startDateStr,
          endDateStr,
          "cancelled"
        );
        await updateTenantIsTrailRunningStatus(customerEmail, 0);
        break;
      case "customer.subscription.updated":
        console.log(`Subscription status is ${status}.`);

        // TODO: for initial creation dose not run updated event
        // const isInitialCreationUpdate =
        //   event.data.previous_attributes?.status === undefined;

        // if (isInitialCreationUpdate) {
        //   console.log("Skipping initial update after creation");
        //   return;
        // }

        // Then define and call a method to handle the subscription update.
        // handleSubscriptionUpdated(subscription);

        const newItem = subscription.items.data[0];
        const activePriceId = newItem.price.id;
        const periodEnd = subscription.current_period_end;
        const newEndDateStr = new Date(periodEnd * 1000);
        const pendingUpdate = subscription.pending_update;
        const newPlanId = newItem.price.product;

        //updagrade & downgrade apply
        if (!pendingUpdate && hasPriceChanged(event)) {
          console.log("🔥 Plan upgraded / downgraded");

          await updateTenantPlan({
            subscriptionId: subscription.id,
            currentPlanPriceId: activePriceId,
            nextPlanPriceId: null,
            newPlanId,
            newEndDateStr,
          });

          //reset qrmenu settings
          const qrCodeExists = await getQRMenuCodeDB(tenantId);
          if (qrCodeExists) {
            await resetQRMenuSettings(tenantId);
          }
          // await updateTokenVersion(tenantId);
          // await removeRefreshTokenByTenanatId(tenantId);
          await updateSubscriptionHistory(
            tenantId,
            startDateStr,
            newEndDateStr,
            "plan_changed"
          );
          return;
        }

        // TODO:  🔽 CASE 2: Downgrade scheduled -- Dose not run this when scheduled
        if (
          pendingUpdate &&
          pendingUpdate.subscription_items &&
          pendingUpdate.subscription_items.length > 0
        ) {
          const nextPriceId = pendingUpdate.subscription_items[0].price;

          await updateTenantPlan({
            subscriptionId: subscription.id,
            currentPlanPriceId: activePriceId,
            nextPlanPriceId: nextPriceId,
            newPlanId,
            newEndDateStr,
          });

          await updateSubscriptionHistory(
            tenantId,
            startDateStr,
            newEndDateStr,
            "downgrade_scheduled"
          );

          return;
        }

        const enableStatuses = ["active", "trialing"];
        const disableStatuses = [
          "past_due",
          "unpaid",
          "incomplete_expired",
          "incomplete",
        ];

        const cancelAtPeriodEnd = subscription?.cancel_at_period_end;
        const currentPeriodEnd = subscription?.current_period_end * 1000; // ms
        const now = Date.now();

        if (status === "trialing") {
          // Trial still running
          await updateTenantIsTrailRunningStatus(customerEmail, 1);
        } else {
          // Trial finished (active / past_due / unpaid etc.)
          await updateTenantIsTrailRunningStatus(customerEmail, 0);
        }

        // ================= 1️⃣ ENABLE ACCESS =================
        if (enableStatuses.includes(status)) {
          // Active + Cancel Scheduled → keep access till expiry
          if (
            status === "active" &&
            cancelAtPeriodEnd &&
            now < currentPeriodEnd
          ) {
            await updateTenantSubscriptionAccess(
              customerEmail,
              1,
              subscriptionId,
              stripeCustomerId,
              startDateStr,
              endDateStr
            );
            await updateSubscriptionHistory(
              tenantId,
              startDateStr,
              endDateStr,
              "cancelAtPeriodEnd"
            );
          }

          // Normal active / trial
          else {
            console.log("Normal Active / Trial Subscription — enabling access");
            await updateTenantSubscriptionAccess(
              customerEmail,
              1,
              subscriptionId,
              stripeCustomerId,
              startDateStr,
              endDateStr
            );

            await updateSubscriptionHistory(
              tenantId,
              startDateStr,
              endDateStr,
              "updated"
            );
          }
        }
        // ================= 2️⃣ DISABLE ACCESS =================
        if (disableStatuses.includes(status)) {
          await updateTenantSubscriptionAccess(
            customerEmail,
            0,
            subscriptionId,
            stripeCustomerId,
            startDateStr,
            endDateStr
          );
          // await updateTokenVersion(tenantId);
          // await removeRefreshTokenByTenanatId(tenantId);
          await updateSubscriptionHistory(
            tenantId,
            startDateStr,
            endDateStr,
            "canceled"
          );
        }

        // ===== Cancellation Handling =====
        if (status === "canceled") {
          // 1️⃣ If it was TRIAL → disable immediately
          // Paid plan finally ended → disable
          // 3️⃣ Final termination → disable
          await updateTenantSubscriptionAccess(
            customerEmail,
            0,
            subscriptionId,
            stripeCustomerId,
            startDateStr,
            endDateStr
          );
          // await updateTokenVersion(tenantId);
          // await removeRefreshTokenByTenanatId(tenantId);
          await updateSubscriptionHistory(
            tenantId,
            startDateStr,
            endDateStr,
            "canceled"
          );

          // if (subscription?.trial_start && subscription?.trial_end && subscription?.status !== "active") {
          //   await updateTenantSubscriptionAccess(customerEmail, 0, subscriptionId, stripeCustomerId, startDateStr, endDateStr);
          // }
          // else if (!cancelAtPeriodEnd || now >= currentPeriodEnd) {
          //   await updateTenantSubscriptionAccess(
          //     customerEmail, 0, subscriptionId, stripeCustomerId, startDateStr, endDateStr
          //   );
          // }
        }
        break;
      case "entitlements.active_entitlement_summary.updated":
        console.log(`Active entitlement summary updated for ${subscription}.`);
        // Then define and call a method to handle active entitlement summary updated
        // handleEntitlementUpdated(subscription);
        break;
      case "customer.subscription.trial_will_end":
        console.log(`Subscription status is ${status}.`);
        // Then define and call a method to handle the subscription trial ending.
        // handleSubscriptionTrialEnding(subscription);
        break;
      default:
        // Unexpected event type
        console.log(`Unhandled event type ${event.type}.`);
    }
  } catch (error) {
    console.error(error);
  }

  // Return a 200 response to acknowledge receipt of the event
  response.send();
};

exports.paystackWebhook = async (req, res) => {
  try {
    const row = await getGatewayDB("paystack");
    if (!row?.credentials) {
      console.error("Paystack credentials not configured");
      return res.sendStatus(200);
    }

    const creds = decryptCredentials(row?.credentials);

    const signature = req.headers["x-paystack-signature"];
    const computedHash = crypto
      .createHmac("sha512", creds?.secret_key)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (!signature || computedHash !== signature) {
      console.warn("Invalid Paystack webhook signature");
      return res.sendStatus(401);
    }

    const event = req.body;
    const eventType = event?.event;
    const data = event?.data || {};
    console.log("-------EVENT-------  ", eventType);
    console.log("-------DATA-------  ", data);

    if (!eventType || !data) {
      console.warn("Paystack webhook: missing event or data");
      return res.sendStatus(200);
    }

    const toDateString = (value) => {
      if (!value) return null;
      const d =
        typeof value === "string" || typeof value === "number"
          ? new Date(value)
          : value instanceof Date
            ? value
            : null;

      if (!d || Number.isNaN(d.getTime())) return null;

      const year = d.getFullYear();
      const month = (d.getMonth() + 1).toString().padStart(2, "0");
      const day = d.getDate().toString().padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    const subscriptionCode = data?.subscription_code || data?.code || null;
    const customerCode = data?.customer?.customer_code || null;

    const productId = data?.metadata?.product_id || null;
    const priceId = data?.metadata?.price_id || null;

    const customerEmail = data?.customer?.email || null;

    if (!customerEmail) {
      console.warn("Paystack subscription.create without customer email");
      return res.sendStatus(200);
    }

    const tenantId = await getTenantIdFromCustomerEmail(customerEmail);

    switch (eventType) {
      case "subscription.create": {
        const startRaw =
          data?.start ||
          data?.createdAt ||
          data?.created_at ||
          new Date();
        const startDateStr = toDateString(startRaw);

        const endedRaw =
          data?.next_payment_date ||
          data?.disabledAt ||
          data?.end ||
          data?.createdAt ||
          data?.created_at ||
          new Date();
        const endDateStr = toDateString(endedRaw);

        await updateTenantSubscriptionAccess(
          customerEmail,
          1,
          subscriptionCode,
          customerCode,
          startDateStr,
          endDateStr
        );

        // await addTenantSubsctiptionDetails(customerEmail, productId, priceId);

        if (tenantId) {
          await updateSubscriptionHistory(
            tenantId,
            startDateStr,
            endDateStr,
            "created"
          );
        }

        break;
      }

      case "subscription.disable": {
        const startRaw =
          data?.start ||
          data?.createdAt ||
          data?.created_at ||
          new Date();
        const startDateStr = toDateString(startRaw);

        const endedRaw =
          data?.next_payment_date ||
          data?.disabledAt ||
          data?.end ||
          data?.createdAt ||
          data?.created_at ||
          new Date();
        const endDateStr = toDateString(endedRaw);

        await updateTenantSubscriptionAccess(
          customerEmail,
          0,
          subscriptionCode,
          customerCode,
          startDateStr,
          endDateStr
        );

        if (tenantId) {
          await updateSubscriptionHistory(
            tenantId,
            startDateStr,
            endDateStr,
            "cancelled"
          );
        }

        break;
      }

      case "subscription.not_renew": {
        const endedRaw =
          data?.next_payment_date ||
          data?.disabledAt ||
          data?.end ||
          data?.createdAt ||
          data?.created_at ||
          new Date();
        const endDateStr = toDateString(endedRaw);

        if (tenantId) {
          await updateSubscriptionHistory(
            tenantId,
            null,
            endDateStr,
            "cancelAtPeriodEnd"
          );
        }

        break;
      }

      case "charge.success": {
        // For Paystack subscriptions, the authoritative subscription details
        // (subscription_code, next_payment_date, etc.) arrive in the
        // subsequent `subscription.create` event. Avoid overwriting the
        // tenant's subscription with incomplete data here.

        // Still store product / price mapping from the metadata, since that
        // is reliably present on `charge.success`.
        if (productId || priceId) {
          await addTenantSubsctiptionDetails(customerEmail, productId, priceId);
        }

        break;
      }

      default:
        console.log(`Unhandled Paystack event type ${eventType}.`);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Paystack webhook error:", error);
    return res.sendStatus(200);
  }
};
