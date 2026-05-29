
const { getUserDeviceId, getSubscriptionDetailsDB } = require("../services/auth.service");
const {
  getPlansDB,
  getPlanByIdDB,
  createPlanDB,
  deletePlanByIdDB,
  updatePlanDB,
  fetchDetailsOfUserByIp,
  createManageSubscriptionLink,
  getAllNonTrialPlan,
  createPortalConfig,
  getSubscriptionHistory,
  getUserCountry,
  createPaystackPlanDB,
  createPaystackPaymentLink,
  updatePaystackPlanDB,
  getPaystackManageSubscriptionLink,
  deletePaystackPlanByIdDB,
} = require("../services/plans.service");


exports.getPlans = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 10;

    const result = await getPlansDB(page, perPage);

    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later")
    });
  }
};

exports.getUserCountry = async (req, res) => {
  try {

    const result = await getUserCountry();
    return res.status(200).json({
      success: true,
      result
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later")
    });
  }
};

exports.getPlanById = async (req, res) => {
  try {
    const id = req.params.id;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request") // Translate message
      });
    }

    const result = await getPlanByIdDB(id);
    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

exports.getSubscriptionHistory = async (req, res) => {
  try {
    const id = req.params.id;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request") // Translate message
      });
    }

    const result = await getSubscriptionHistory(id);
    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const {
      title,
      features_description,
      features,
      trial_days,
      is_trial,
      is_recommended,
      discount,
      yearlyDiscount,
      currencies,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: req.__("title_required"),
      });
    }

    if (!features_description?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("feature_description_required"),
      });
    }

    if (!features?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("features_required"),
      });
    }

    if (!currencies?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("pricing_required"),
      });
    }

    const defaultPrices = currencies.filter(p => p.is_default);

    if (defaultPrices.length !== 1) {
      return res.status(400).json({
        success: false,
        message: "Exactly one default price is required",
      });
    }


    const result = await createPlanDB(
      title,
      features_description,
      features,
      trial_days,
      is_trial,
      is_recommended,
      discount,
      yearlyDiscount,
      currencies
    );

    createPortalConfig().catch(err => console.error("Portal sync failed:", err));

    return res.status(201).json({
      success: true,
      message: "Plan created successfully",
      data: result,
    });

  } catch (error) {
    console.error("Create Plan Controller Error:", error);

    if (error.type == "StripeAuthenticationError") {
      return res.status(401).json({
        success: false,
        message: req.__("invalid_credentials") // Translate message
      });
    }

    if (error.message?.includes("UNSUPPORTED_PAYMENT_GATEWAY")) {
      return res.status(400).json({
        success: false,
        message: "Unsupported payment gateway."
      });
    }

    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const {
      title,
      features_description,
      features,
      is_recommended,
    } = req.body;
    const planId = req.params.id;

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request") // Translate message
      });
    }

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: req.__("title_required"),
      });
    }

    if (!features_description?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("feature_description_required"),
      });
    }

    if (!features?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("features_required"),
      });
    }

    const result = await updatePlanDB(
      planId,
      title,
      features_description,
      features,
      is_recommended,
    );

    return res.status(201).json({
      success: true,
      message: "Plan created successfully",
      data: result,
    });

  } catch (error) {
    console.error("Update Plan Controller Error:", error);
    if (error.type == "StripeAuthenticationError") {
      return res.status(401).json({
        success: false,
        message: req.__("invalid_credentials") // Translate message
      });
    }

    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

exports.deletePlanById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request") // Translate message
      });
    }

    const result = await deletePlanByIdDB(id);

    createPortalConfig().catch(err => console.error("Portal sync failed:", err));

    return res.status(200).json({
      success: true,
      message: result.message,
    });

  } catch (error) {
    console.error("Delete Plan Controller Error:", error)
    if (error.type == "StripeAuthenticationError") {
      return res.status(401).json({
        success: false,
        message: req.__("invalid_credentials") // Translate message
      });
    }
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

exports.fetchDetailsOfUserByIp = async (req, res) => {
  try {
    const result = await fetchDetailsOfUserByIp();
    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

exports.createManageSubscriptionLink = async (req, res) => {
  try {
    const { stripeCustomerId } = req.body;
    const user = req.user;

    let userDeviceId;
    if (user?.username) {
      userDeviceId = await getUserDeviceId(user.username)
    }

    const tenantId = user?.tenant_id;


    const result = await createManageSubscriptionLink(stripeCustomerId);
    return res.json({
      success: true,
      url: result,
    });
  } catch (error) {
    console.error(error);
    if (error.type == "StripeAuthenticationError") {
      return res.status(401).json({
        success: false,
        message: req.__("invalid_credentials") // Translate message
      });
    }
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

exports.generatePaystackManageSubscriptionLink = async (req, res) => {
  try {
    const user = req.user;
    const tenantId = user?.tenant_id;

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request"),
      });
    }

    const subscriptionDetails = await getSubscriptionDetailsDB(tenantId);
    const tenant = Array.isArray(subscriptionDetails) ? subscriptionDetails[0] : subscriptionDetails;
    const subscriptionCode = tenant?.subscription_id;

    if (!subscriptionCode?.trim()) {
      return res.status(400).json({
        success: false,
        message: req.__("no_active_paystack_subscription"),
      });
    }

    const result = await getPaystackManageSubscriptionLink(subscriptionCode);
    return res.json({
      success: true,
      url: result.link,
    });
  } catch (error) {
    console.error("generatePaystackManageSubscriptionLink:", error);
    if (error.message === "PAYSTACK_SUBSCRIPTION_CODE_REQUIRED" || error.message === "PAYSTACK_NOT_CONFIGURED" || error.message === "PAYSTACK_SECRET_KEY_MISSING") {
      return res.status(400).json({
        success: false,
        message: error.message === "PAYSTACK_NOT_CONFIGURED" ? req.__("paystack_not_configured") : req.__("invalid_request"),
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || req.__("something_went_wrong_try_later"),
    });
  }
};

// paystack
exports.createPaystackPlan = async (req, res) => {
  try {
    const { title, features_description, features, is_recommended, discount, yearlyDiscount, currencies } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: req.__("title_required"),
      });
    }

    if (!features_description?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("feature_description_required"),
      });
    }

    if (!features?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("features_required"),
      });
    }

    if (!currencies?.length) {
      return res.status(400).json({
        success: false,
        message: req.__("pricing_required"),
      });
    }

    const result = await createPaystackPlanDB(title, features_description, features, is_recommended, discount, yearlyDiscount, currencies);
    return res.status(200).json(result);
  } catch (error) {
    console.error("createPaystackPlan error----------------->", error);

    const message =
      error?.response?.data?.message ||
      error?.message ||
      req.__("something_went_wrong_try_later");

    return res.status(400).json({
      success: false,
      message
    });
  }
};

exports.updatePaystackPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, features_description, features, is_recommended, discount, yearlyDiscount } = req.body;

    if (!id) return res.status(400).json({ success: false, message: req.__("invalid_request") });
    if (!title?.trim()) return res.status(400).json({ success: false, message: req.__("title_required") });
    if (!features_description?.length) return res.status(400).json({ success: false, message: req.__("feature_description_required") });
    if (!features?.length) return res.status(400).json({ success: false, message: req.__("features_required") });

    const result = await updatePaystackPlanDB(id, {
      title,
      features_description,
      features,
      is_recommended,
      discount,
      yearlyDiscount,
    });

    if (!result.success) {
      const errors = {
        PLAN_NOT_FOUND: "Plan not found",
        NOT_PAYSTACK_PLAN: "Not a Paystack plan",
      };

      return res.status(400).json({
        success: false,
        message: errors[result.error] || req.__("something_went_wrong_try_later"),
      });
    }

    res.json({ success: true, message: "Paystack plan updated successfully" });
  } catch (err) {
    console.error("updatePaystackPlan:", err);
    res.status(500).json({ success: false, message: req.__("something_went_wrong_try_later") });
  }
};

exports.createPaystackPaymentLink = async (req, res) => {
  try {
    const productId = req.body.id;
    const user = req.user;

    if (!productId || typeof productId !== "string") {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request"),
      });
    }

    let userDeviceId;
    if (user?.username) {
      userDeviceId = await getUserDeviceId(user.username);
    }

    const result = await createPaystackPaymentLink({
      priceId: productId,
      email: user.username,
      tenantId: user.tenant_id,
      deviceId: userDeviceId,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later") // Translate message
    });
  }
};

// paystack: soft delete by local plan id (plans.id)
exports.deletePaystackPlan = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: req.__("invalid_request"),
      });
    }

    const result = await deletePaystackPlanByIdDB(id);

    if (!result?.success) {
      const errors = {
        PLAN_NOT_FOUND: "Plan not found",
        NOT_PAYSTACK_PLAN: "Not a Paystack plan",
      };

      return res.status(400).json({
        success: false,
        message: errors[result?.error] || req.__("something_went_wrong_try_later"),
      });
    }

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    console.error("Delete Paystack Plan Controller Error:", error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"),
    });
  }
};
