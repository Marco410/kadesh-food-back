const { getMySqlPromiseConnection } = require("../config/mysql.db")

async function insertOrderWithInventory(conn, {
  tenantId,
  cartItems,
  deliveryType,
  customerType,
  customerId,
  tableId,
  paymentStatus,
  invoiceId,
  username,
  createdAt,
  clientRequestId,
}) {
  let tokenNo = 0;

  const [tokenSequence] = await conn.query(
    "SELECT sequence_no, DATE(last_updated) as last_updated, DATE(NOW()) as todays_date FROM token_sequences WHERE tenant_id = ? LIMIT 1 FOR UPDATE",
    [tenantId]
  );
  tokenNo = tokenSequence[0]?.sequence_no || 0;
  const tokenLastUpdated = tokenSequence[0]?.last_updated
    ? new Date(tokenSequence[0]?.last_updated).toISOString().substring(0, 10)
    : new Date().toISOString().substring(0, 10);
  const today = new Date(tokenSequence[0]?.todays_date || Date.now())
    .toISOString()
    .substring(0, 10);

  if (tokenLastUpdated != today) {
    tokenNo = 0;
  }

  tokenNo += 1;

  const orderColumns = [
    "delivery_type",
    "customer_type",
    "customer_id",
    "table_id",
    "token_no",
    "payment_status",
    "invoice_id",
    "tenant_id",
    "created_by",
  ];
  const orderValues = [
    deliveryType,
    customerType,
    customerId,
    tableId,
    tokenNo,
    paymentStatus || "pending",
    invoiceId || null,
    tenantId,
    username,
  ];

  if (createdAt) {
    orderColumns.unshift("date");
    orderValues.unshift(createdAt);
  }

  if (clientRequestId) {
    orderColumns.push("client_request_id");
    orderValues.push(clientRequestId);
  }

  const placeholders = orderColumns.map(() => "?").join(", ");
  const [orderResult] = await conn.query(
    `INSERT INTO orders (${orderColumns.join(", ")}) VALUES (${placeholders})`,
    orderValues
  );

  const orderId = orderResult.insertId;

  const sqlOrderItems = `
    INSERT INTO order_items
    (order_id, item_id, variant_id, price, quantity, notes, addons, tenant_id)
    VALUES ?
  `;

  await conn.query(sqlOrderItems, [
    cartItems.map((item) => [
      orderId,
      item.id,
      item.variant_id,
      item.price,
      item.quantity,
      item.notes,
      item?.addons_ids?.length > 0 ? JSON.stringify(item.addons_ids) : null,
      tenantId,
    ]),
  ]);

  await conn.query(
    "INSERT INTO token_sequences ( sequence_no, last_updated, tenant_id) VALUES (?, NOW(), ?) ON DUPLICATE KEY UPDATE sequence_no = VALUES(sequence_no), last_updated = VALUES(last_updated) ;",
    [tokenNo, tenantId]
  );

  const inventoryUsage = {};

  cartItems.forEach((item) => {
    item.recipeItems.forEach((recipe) => {
      const { inventory_item_id, recipe_quantity, ingredient_title, unit, variant_id, addon_id } =
        recipe;

      if (variant_id && variant_id != item.variant_id) return;
      if (addon_id && !item.addons_ids?.map(String).includes(String(addon_id))) return;

      const invId = inventory_item_id;
      const qtyNeeded = parseFloat(recipe_quantity) * item.quantity;

      if (!inventoryUsage[invId]) {
        inventoryUsage[invId] = {
          ingredient_title,
          unit,
          total_quantity: 0,
        };
      }

      inventoryUsage[invId].total_quantity += qtyNeeded;
    });
  });

  const updateInventorySql = `
    UPDATE inventory_items
    SET quantity = ?, status = ?
    WHERE id = ? AND tenant_id = ?
  `;

  const insertLogSql = `
    INSERT INTO inventory_logs
    (tenant_id, inventory_item_id, type, quantity_change, previous_quantity, new_quantity, note, created_by)
    VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?)
  `;

  for (const [inventoryItemId, usage] of Object.entries(inventoryUsage)) {
    const invId = parseInt(inventoryItemId);
    const qtyUsed = parseFloat(usage.total_quantity);

    const [[currentItem]] = await conn.query(
      "SELECT quantity, min_quantity_threshold FROM inventory_items WHERE id = ? AND tenant_id = ? FOR UPDATE",
      [invId, tenantId]
    );

    const previousQty = parseFloat(currentItem?.quantity || 0);
    const newQty = previousQty - qtyUsed;
    const minQuantityThreshold = parseFloat(currentItem?.min_quantity_threshold || 0);

    await conn.query(insertLogSql, [
      tenantId,
      invId,
      qtyUsed,
      previousQty,
      newQty,
      invoiceId
        ? `Auto deduction for recipe usage in invoice #${invoiceId}`
        : "Auto deduction for recipe usage in order",
      username,
    ]);

    let status = "out";
    if (newQty > 0 && newQty <= minQuantityThreshold) {
      status = "low";
    } else if (newQty > minQuantityThreshold) {
      status = "in";
    }

    await conn.query(updateInventorySql, [newQty, status, invId, tenantId]);
  }

  return { tokenNo, orderId };
}

exports.createOrderDB = async (
  tenantId,
  cartItems,
  deliveryType,
  customerType,
  customerId,
  tableId,
  paymentStatus = "pending",
  invoiceId = null,
  username = null,
  options = {}
) => {
  const ownsConnection = !options.conn;
  const conn = options.conn || (await getMySqlPromiseConnection());

  try {
    if (ownsConnection) {
      await conn.beginTransaction();
    }

    const result = await insertOrderWithInventory(conn, {
      tenantId,
      cartItems,
      deliveryType,
      customerType,
      customerId,
      tableId,
      paymentStatus,
      invoiceId,
      username,
      createdAt: options.createdAt || null,
      clientRequestId: options.clientRequestId || null,
    });

    if (ownsConnection) {
      await conn.commit();
    }

    return result;
  } catch (error) {
    console.error(error);
    if (ownsConnection) {
      await conn.rollback();
    }
    throw error;
  } finally {
    if (ownsConnection) {
      conn.release();
    }
  }
};

exports.createOrderAndInvoiceDB = async (
  tenantId,
  {
    cartItems,
    deliveryType,
    customerType,
    customerId,
    tableId,
    netTotal,
    taxTotal,
    serviceChargeTotal,
    total,
    selectedPaymentType,
    username,
    createdAt,
    clientRequestId,
  }
) => {
  const conn = await getMySqlPromiseConnection();

  try {
    await conn.beginTransaction();

    let invoiceId = 0;
    const [invoiceSequence] = await conn.query(
      "SELECT sequence_no FROM invoice_sequences WHERE tenant_id = ? LIMIT 1 FOR UPDATE",
      [tenantId]
    );
    invoiceId = (invoiceSequence[0]?.sequence_no || 0) + 1;

    const invoiceDate = createdAt || null;
    const invoiceSql = `
      INSERT INTO invoices
      (id, sub_total, tax_total, service_charge_total, total, created_at, payment_type_id, tenant_id, created_by)
      VALUES
      (?, ?, ?, ?, ?, ${invoiceDate ? "?" : "NOW()"}, ?, ?, ?)
    `;
    const invoiceParams = invoiceDate
      ? [
          invoiceId,
          netTotal,
          taxTotal,
          serviceChargeTotal,
          total,
          invoiceDate,
          selectedPaymentType,
          tenantId,
          username,
        ]
      : [
          invoiceId,
          netTotal,
          taxTotal,
          serviceChargeTotal,
          total,
          selectedPaymentType,
          tenantId,
          username,
        ];

    await conn.query(invoiceSql, invoiceParams);

    await conn.query(
      "INSERT INTO invoice_sequences ( sequence_no, tenant_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE sequence_no = VALUES(sequence_no);",
      [invoiceId, tenantId]
    );

    const result = await insertOrderWithInventory(conn, {
      tenantId,
      cartItems,
      deliveryType,
      customerType,
      customerId,
      tableId,
      paymentStatus: "paid",
      invoiceId,
      username,
      createdAt,
      clientRequestId,
    });

    await conn.commit();

    return {
      ...result,
      invoiceId,
    };
  } catch (error) {
    console.error(error);
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

exports.getPOSQROrdersCountDB = async (tenantId) => {
  const conn = await getMySqlPromiseConnection();

    try {
      const sql = `
        SELECT COUNT(*) AS total_orders FROM qr_orders
        WHERE tenant_id = ? AND status NOT IN('completed', 'cancelled');
      `;

      const [result] = await conn.query(sql, [tenantId]);
      return result[0].total_orders ?? 0;
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.getPOSQROrdersDB = async (tenantId) => {
  const conn = await getMySqlPromiseConnection();

    try {
      const sql = `
       SELECT
        o.id,
        o.date,
        o.delivery_type,
        o.customer_type,
        o.customer_id,
        c.name AS customer_name,
        o.table_id,
        st.table_title,
        st.floor,
        o.status,
        o.payment_status
      FROM
        qr_orders o
        LEFT JOIN customers c ON o.customer_id = c.phone AND c.tenant_id = o.tenant_id
        LEFT JOIN store_tables st ON o.table_id = st.id
      WHERE
        o.status NOT IN('completed', 'cancelled')
        AND o.tenant_id = ?
      `;

      const [kitchenOrders] = await conn.query(sql, [tenantId]);

      let kitchenOrdersItems = [];
      let addons = [];

      if(kitchenOrders.length > 0) {
        const orderIds = kitchenOrders.map(o=>o.id).join(",");
        const sql2 = `
          SELECT
            oi.id,
            oi.order_id,
            oi.item_id,
            mi.title AS item_title,
            mi.tax_id,
            t.title as tax_title,
            t.rate as tax_rate,
            t.type as tax_type,
            oi.variant_id,
            miv.title AS variant_title,
            miv.price AS variant_price,
            oi.price,
            oi.quantity,
            oi.status,
            oi.date,
            oi.addons,
            oi.notes
          FROM
            qr_order_items oi
            LEFT JOIN menu_items mi ON oi.item_id = mi.id
            LEFT JOIN taxes t ON t.id = mi.tax_id
            LEFT JOIN menu_item_variants miv ON oi.item_id = miv.item_id
            AND oi.variant_id = miv.id
          WHERE
            oi.order_id IN (${orderIds})
        `
        const [kitchenOrdersItemsResult] = await conn.query(sql2);
        kitchenOrdersItems = kitchenOrdersItemsResult;

        const addonIds = [...new Set([...kitchenOrdersItems.flatMap((o)=>o.addons?JSON.parse(o?.addons):[])])].join(",");
        const [addonsResult] = addonIds ? await conn.query(`SELECT id, item_id, title FROM menu_item_addons WHERE id IN (${addonIds});`):[]
        addons = addonsResult;
      }

      // Get recipe items for all menu items
      const recipeSql = `
        SELECT
          mir.id,
          mir.menu_item_id,
          mir.variant_id,
          mir.addon_id,
          mir.inventory_item_id,
          mi.title AS menu_item_title,
          v.title AS variant_title,
          a.title AS addon_title,
          ii.title AS ingredient_title,
          ii.unit,
          ii.quantity as current_quantity,
          ii.min_quantity_threshold,
          mir.quantity as recipe_quantity
        FROM
          menu_item_recipes mir
        LEFT JOIN menu_items mi ON mir.menu_item_id = mi.id
        LEFT JOIN menu_item_variants v ON mir.variant_id = v.id
        LEFT JOIN menu_item_addons a ON mir.addon_id = a.id
        LEFT JOIN inventory_items ii ON mir.inventory_item_id = ii.id
        WHERE mir.tenant_id = ?
      `;

      const [recipeItemsResult] = await conn.query(recipeSql, [tenantId]);
      recipeItems = recipeItemsResult;

      // Attach recipeItems to each kitchenOrderItem
      kitchenOrdersItems = kitchenOrdersItems.map(oi => {
        const relevantRecipeItems = recipeItems.filter(ri =>
          ri.menu_item_id === oi.item_id &&
          (ri.variant_id == 0 || ri.variant_id === oi.variant_id) &&
          (ri.addon_id === 0 || oi.addons?.includes(ri.addon_id))
        );
        return {
          ...oi,
          recipeItems: relevantRecipeItems
        };
      });

      return {
        kitchenOrders,
        kitchenOrdersItems,
        addons
      }
    } catch (error) {
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
};

exports.updateQROrderStatusDB = async (tenantId, orderId, status) => {
  const conn = await getMySqlPromiseConnection();

  try {
    const sql = `
      UPDATE qr_orders
      SET status = ?
      WHERE tenant_id = ? AND id = ?;
    `;

    const [result] = await conn.query(sql, [status, tenantId, orderId]);
    return
  } catch (error) {
      console.error(error);
      throw error;
  } finally {
      conn.release();
  }
};


exports.cancelAllQROrdersDB = async (tenantId, status) => {
  const conn = await getMySqlPromiseConnection();

  try {
    const sql = `
      UPDATE qr_orders
      SET status = ?
      WHERE tenant_id = ?;
    `;

    const [result] = await conn.query(sql, [status, tenantId]);
    return;
  } catch (error) {
      console.error(error);
      throw error;
  } finally {
      conn.release();
  }
};
