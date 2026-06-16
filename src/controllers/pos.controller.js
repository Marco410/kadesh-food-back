const {
  getCategoriesDB,
  getPaymentTypesDB,
  getPrintSettingDB,
  getStoreSettingDB,
  getStoreTablesDB,
  getServiceChargeDB,
} = require("../services/settings.service");
const {
  getAllMenuItemsDB,
  getAllAddonsDB,
  getAllVariantsDB,
  getAllRecipeItemsDB,
} = require("../services/menu_item.service");
const {
  createOrderDB,
  createOrderAndInvoiceDB,
  getPOSQROrdersCountDB,
  getPOSQROrdersDB,
  updateQROrderStatusDB,
  cancelAllQROrdersDB,
} = require("../services/pos.service");
const {
  getPosIdempotencyRecordDB,
  savePosIdempotencyRecordDB,
  withIdempotencyLock,
} = require("../services/pos-idempotency.service");
const {
  getSyncHeaders,
  parseOfflineCreatedAt,
  buildOrderResponse,
  validateSyncIdempotencyKey,
  validateOfflineCreatedAt,
  isOfflineSafePaymentType,
  emitPosOrderSocketEvents,
} = require("../utils/pos-sync.helper");
const { getPrinterConfigsDB, addPrinterConfigDB, updatePrinterConfigDB, deletePrinterConfigDB } = require("../services/printer.service");

function canPrepareMenuItem(menuItem, quantity = 1) {
  const selectedVariantId = parseInt(menuItem.variant_id);
  const selectedAddonIds = (menuItem.addons_ids || []).map(String);

  const relevantRecipeItems = menuItem.recipeItems.filter((recipe) => {
    if (recipe.variant_id === 0 && recipe.addon_id === 0) return true;
    if (recipe.variant_id > 0 && recipe.variant_id == selectedVariantId) return true;
    if (recipe.addon_id > 0 && selectedAddonIds.includes(String(recipe.addon_id))) return true;
    return false;
  });

  const insufficientIngredients = [];

  for (const recipe of relevantRecipeItems) {
    const currentQty = parseFloat(recipe.current_quantity);
    const requiredQty = parseFloat(recipe.recipe_quantity) * quantity;
    if (currentQty < requiredQty) {
      insufficientIngredients.push({
        itemTitle: menuItem.title,
        variantTitle: menuItem.variant?.title || "",
        addonTitle: recipe.addon_title || "",
        ingredientTitle: recipe.ingredient_title,
        requiredQty,
        currentQty,
      });
    }
  }

  return insufficientIngredients;
}

function getStockValidationError(cart) {
  let allInsufficientIngredients = [];

  for (const item of cart) {
    const result = canPrepareMenuItem(item, item.quantity);
    if (result.length > 0) {
      allInsufficientIngredients = [...allInsufficientIngredients, ...result];
    }
  }

  if (allInsufficientIngredients.length === 0) {
    return null;
  }

  const messages = allInsufficientIngredients.map(
    (i) =>
      `'${i.itemTitle} ${i.variantTitle ? `(${i.variantTitle})` : ""}${i.addonTitle ? ` + ${i.addonTitle}` : ""}' is missing '${i.ingredientTitle}' (need ${i.requiredQty}, have ${i.currentQty})`
  );

  return {
    success: false,
    message: "Unavailable: Not enough stock.\n" + messages.join("; "),
  };
}

async function resolveIdempotentResponse(req, res, tenantId, idempotencyKey) {
  const existing = await getPosIdempotencyRecordDB(tenantId, idempotencyKey);
  if (!existing?.response_json) {
    return null;
  }

  const cached =
    typeof existing.response_json === "string"
      ? JSON.parse(existing.response_json)
      : existing.response_json;

  return res.status(200).json(cached);
}

async function persistIdempotentResponse(tenantId, idempotencyKey, response) {
  await savePosIdempotencyRecordDB(
    tenantId,
    idempotencyKey,
    response.orderId,
    response.tokenNo,
    response
  );
}

async function finalizeOrder(req, res, tenantId, idempotencyKey, response, { isPaid = false } = {}) {
  if (idempotencyKey) {
    await persistIdempotentResponse(tenantId, idempotencyKey, response);
  }

  await emitPosOrderSocketEvents(req.app.get("io"), tenantId, response.orderId, { isPaid });

  return res.status(200).json(response);
}

exports.getPOSInitData = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    const [categories, paymentTypes, printSettings, storeSettings, storeTables, serviceCharge, printerConfigs] = await Promise.all([
      getCategoriesDB(tenantId),
      getPaymentTypesDB(true, tenantId),
      getPrintSettingDB(tenantId),
      getStoreSettingDB(tenantId),
      getStoreTablesDB(tenantId),
      getServiceChargeDB(tenantId),
      getPrinterConfigsDB(tenantId),
    ]);

    const [menuItems, addons, variants, recipeItems] = await Promise.all([
      getAllMenuItemsDB(tenantId),
      getAllAddonsDB(tenantId),
      getAllVariantsDB(tenantId),
      getAllRecipeItemsDB(tenantId),
    ]);

    const formattedMenuItems = menuItems.map((item) => {
      const itemAddons = addons.filter((addon) => addon.item_id == item.id);
      const itemVariants = variants.filter((variant) => variant.item_id == item.id);
      const itemRecipeItems = recipeItems.filter((recipeItem) => recipeItem.menu_item_id == item.id);

      return {
        ...item,
        addons: [...itemAddons],
        variants: [...itemVariants],
        recipeItems: [...itemRecipeItems],
      };
    });

    return res.status(200).json({
      categories,
      paymentTypes,
      printSettings,
      storeSettings,
      storeTables,
      menuItems: formattedMenuItems,
      serviceCharge,
      printerConfigs,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"),
    });
  }
};

exports.createOrder = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const username = req.user.username;
    const { idempotencyKey, offlineCreatedAt, isSync } = getSyncHeaders(req);
    const { cart, deliveryType, customerType, customerId, tableId, selectedQrOrderItem } = req.body;

    if (cart?.length == 0) {
      return res.status(400).json({
        success: false,
        message: req.__("cart_is_empty"),
      });
    }

    if (isSync) {
      const idempotencyError = validateSyncIdempotencyKey(idempotencyKey);
      if (idempotencyError) {
        return res.status(400).json({ success: false, message: idempotencyError });
      }

      const offlineDateError = validateOfflineCreatedAt(offlineCreatedAt);
      if (offlineDateError) {
        return res.status(400).json({ success: false, message: offlineDateError });
      }

      const cachedResponse = await resolveIdempotentResponse(req, res, tenantId, idempotencyKey);
      if (cachedResponse) {
        return cachedResponse;
      }

      const stockError = getStockValidationError(cart);
      if (stockError) {
        return res.status(400).json(stockError);
      }
    }

    const createdAt = parseOfflineCreatedAt(offlineCreatedAt);
    const createOrder = async () => {
      const result = await createOrderDB(
        tenantId,
        cart,
        deliveryType,
        customerType,
        customerId?.phone || null,
        tableId || null,
        "pending",
        null,
        username,
        {
          createdAt,
          clientRequestId: idempotencyKey,
        }
      );

      if (selectedQrOrderItem) {
        await updateQROrderStatusDB(tenantId, selectedQrOrderItem, "completed");
      }

      return buildOrderResponse(req, result);
    };

    if (idempotencyKey) {
      return await withIdempotencyLock(tenantId, idempotencyKey, async () => {
        const cachedResponse = await resolveIdempotentResponse(req, res, tenantId, idempotencyKey);
        if (cachedResponse) {
          return cachedResponse;
        }

        const response = await createOrder();
        return finalizeOrder(req, res, tenantId, idempotencyKey, response);
      });
    }

    const response = await createOrder();
    return finalizeOrder(req, res, tenantId, null, response);
  } catch (error) {
    console.error(error);
    if (error.message === "IDEMPOTENCY_LOCK_TIMEOUT") {
      return res.status(409).json({
        success: false,
        message: "Order sync is already in progress for this idempotency key.",
      });
    }
    return res.status(500).json({
      success: false,
      message: req.__("error_processing_request_try_later"),
    });
  }
};

exports.createOrderAndInvoice = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const username = req.user.username;
    const { idempotencyKey, offlineCreatedAt, isSync } = getSyncHeaders(req);
    const {
      cart,
      deliveryType,
      customerType,
      customerId,
      tableId,
      netTotal,
      taxTotal,
      serviceChargeTotal,
      total,
      selectedQrOrderItem,
      selectedPaymentType,
    } = req.body;

    if (cart?.length == 0) {
      return res.status(400).json({
        success: false,
        message: req.__("cart_is_empty"),
      });
    }

    if (isSync) {
      const idempotencyError = validateSyncIdempotencyKey(idempotencyKey);
      if (idempotencyError) {
        return res.status(400).json({ success: false, message: idempotencyError });
      }

      const offlineDateError = validateOfflineCreatedAt(offlineCreatedAt);
      if (offlineDateError) {
        return res.status(400).json({ success: false, message: offlineDateError });
      }

      const cachedResponse = await resolveIdempotentResponse(req, res, tenantId, idempotencyKey);
      if (cachedResponse) {
        return cachedResponse;
      }

      const paymentValidation = await isOfflineSafePaymentType(tenantId, selectedPaymentType);
      if (!paymentValidation.ok) {
        return res.status(400).json({
          success: false,
          message: paymentValidation.message,
        });
      }
    }

    const stockError = getStockValidationError(cart);
    if (stockError) {
      return res.status(400).json(stockError);
    }

    const createdAt = parseOfflineCreatedAt(offlineCreatedAt);

    const createPaidOrder = async () => {
      const result = await createOrderAndInvoiceDB(tenantId, {
        cartItems: cart,
        deliveryType,
        customerType,
        customerId: customerId?.phone || null,
        tableId: tableId || null,
        netTotal,
        taxTotal,
        serviceChargeTotal,
        total,
        selectedPaymentType,
        username,
        createdAt,
        clientRequestId: idempotencyKey,
      });

      if (selectedQrOrderItem) {
        await updateQROrderStatusDB(tenantId, selectedQrOrderItem, "completed");
      }

      return buildOrderResponse(req, result);
    };

    if (idempotencyKey) {
      return await withIdempotencyLock(tenantId, idempotencyKey, async () => {
        const cachedResponse = await resolveIdempotentResponse(req, res, tenantId, idempotencyKey);
        if (cachedResponse) {
          return cachedResponse;
        }

        const response = await createPaidOrder();
        return finalizeOrder(req, res, tenantId, idempotencyKey, response, { isPaid: true });
      });
    }

    const now = new Date();
    const date = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;

    const result = await createOrderAndInvoiceDB(tenantId, {
      cartItems: cart,
      deliveryType,
      customerType,
      customerId: customerId?.phone || null,
      tableId: tableId || null,
      netTotal,
      taxTotal,
      serviceChargeTotal,
      total,
      selectedPaymentType,
      username,
      createdAt: createdAt || date,
      clientRequestId: null,
    });

    if (selectedQrOrderItem) {
      await updateQROrderStatusDB(tenantId, selectedQrOrderItem, "completed");
    }

    const response = buildOrderResponse(req, result);
    return finalizeOrder(req, res, tenantId, null, response, { isPaid: true });
  } catch (error) {
    console.error(error);
    if (error.message === "IDEMPOTENCY_LOCK_TIMEOUT") {
      return res.status(409).json({
        success: false,
        message: "Order sync is already in progress for this idempotency key.",
      });
    }
    return res.status(500).json({
      success: false,
      message: req.__("error_processing_request_try_later"),
    });
  }
};

exports.getPOSQROrdersCount = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    const totalQROrders = await getPOSQROrdersCountDB(tenantId);
    return res.status(200).json({
      status: true,
      totalQROrders: totalQROrders,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"),
    });
  }
};

exports.getPOSQROrders = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    const { kitchenOrders, kitchenOrdersItems, addons } = await getPOSQROrdersDB(tenantId);

    const formattedOrders = kitchenOrders.map((order) => {
      const orderItems = kitchenOrdersItems.filter((oi) => oi.order_id == order.id);

      orderItems.forEach((oi, index) => {
        const addonsIds = oi?.addons ? JSON.parse(oi?.addons) : null;

        if (addonsIds) {
          const itemAddons = addonsIds.map((addonId) => {
            const addon = addons.filter((a) => a.id == addonId);
            return addon[0];
          });
          orderItems[index].addons = [...itemAddons];
        }
      });

      return {
        ...order,
        items: orderItems,
      };
    });

    return res.status(200).json(formattedOrders);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"),
    });
  }
};

exports.updatePOSQROrderStatus = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const orderId = req.params.id;
    const status = req.body.status;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: req.__("please_provide_required_details"),
      });
    }

    await updateQROrderStatusDB(tenantId, orderId, status);
    return res.status(200).json({
      status: true,
      message: req.__("qr_order_item_status_updated"),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"),
    });
  }
};

exports.cancelAllQROrders = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const status = "cancelled";

    await cancelAllQROrdersDB(tenantId, status);
    return res.status(200).json({
      status: true,
      message: req.__("all_qr_order_items_cleared"),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: req.__("something_went_wrong_try_later"),
    });
  }
};

exports.addPrinterConfig = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { name, transport, address, paper_size, is_default, is_kot_printer, auto_cut } = req.body;

    if (!name || !transport || !address) {
      return res.status(400).json({ success: false, message: "Name, transport, and address are required." });
    }

    const id = await addPrinterConfigDB(tenantId, { name, transport, address, paper_size, is_default, is_kot_printer, auto_cut });
    const printerConfigs = await getPrinterConfigsDB(tenantId);

    return res.status(200).json({ success: true, id, printerConfigs });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: req.__("something_went_wrong_try_later") });
  }
};

exports.updatePrinterConfig = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const printerId = req.params.id;
    const updates = req.body;

    await updatePrinterConfigDB(tenantId, printerId, updates);

    const printerConfigs = await getPrinterConfigsDB(tenantId);
    return res.status(200).json({ success: true, printerConfigs });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: req.__("something_went_wrong_try_later") });
  }
};

exports.deletePrinterConfig = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const printerId = req.params.id;

    await deletePrinterConfigDB(tenantId, printerId);

    const printerConfigs = await getPrinterConfigsDB(tenantId);
    return res.status(200).json({ success: true, printerConfigs });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: req.__("something_went_wrong_try_later") });
  }
};
