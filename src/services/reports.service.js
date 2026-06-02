const { getMySqlPromiseConnection } = require("../config/mysql.db");
const { getCurrencyDB, getStoreSettingDB } = require("./settings.service");

const REPORT_TITLES = {
  "sales-summary": "Sales Summary",
  "gross-sales": "Gross Sales",
  "net-sales": "Net Sales",
  "sales-by-hour": "Sales by Hour",
  "sales-by-day": "Sales by Day",
  "sales-by-month": "Sales by Month",
  "sales-by-order-type": "Sales by Order Type",
  "sales-by-table": "Sales by Table",
  "invoice-detail": "Invoice Detail",
  "voids-cancellations": "Voids & Cancellations",
  "average-order-value": "Average Order Value",
  "payment-summary": "Payment Summary",
  "cash-report": "Cash Report",
  "card-report": "Card Report",
  "unpaid-orders": "Unpaid Orders",
  "payment-type-mix": "Payment Type Mix",
  "top-selling-items": "Top Selling Items",
  "low-selling-items": "Low Selling Items",
  "item-sales": "Item Sales",
  "category-sales": "Category Sales",
  "variant-sales": "Variant Sales",
  "addon-sales": "Addon Sales",
  "menu-price-audit": "Menu Price Audit",
  "customer-summary": "Customer Summary",
  "new-customers": "New Customers",
  "returning-customers": "Returning Customers",
  "top-customers": "Top Customers",
  "customer-birthdays": "Customer Birthdays",
  "member-customers": "Member Customers",
  "order-status": "Order Status",
  "kitchen-performance": "Kitchen Performance",
  "token-report": "Token Report",
  "qr-order-report": "QR Order Report",
  "table-turnover": "Table Turnover",
  "staff-created-orders": "Staff Created Orders",
  "inventory-summary": "Inventory Summary",
  "low-stock": "Low Stock",
  "stock-movements": "Stock Movements",
  "wastage": "Wastage",
  "recipe-usage": "Recipe Usage",
  "stock-reorder": "Reorder List",
  "tax-summary": "Tax Summary",
  "tax-by-item": "Tax by Item",
  "service-charge": "Service Charge",
  "daily-close": "Daily Close",
  "invoice-register": "Invoice Register",
  "reservation-summary": "Reservation Summary",
  "upcoming-reservations": "Upcoming Reservations",
  "reservation-no-show": "Reservation No-Show",
  "feedback-summary": "Feedback Summary",
  "negative-feedback": "Negative Feedback",
  "recommendation-score": "Recommendation Score",
};

const reportTitleKey = (reportId) => `reports_${reportId.replace(/-/g, "_")}`;

const money = (value) => Number(value || 0);

const buildDateRange = (type, from, to) => ({
  type,
  from: type === "custom" ? from : null,
  to: type === "custom" ? to : null,
});

const getFilterCondition = (field, type, from, to) => {
  const params = [];
  let filter = "";

  switch (type) {
    case "custom":
      params.push(from, to);
      filter = `DATE(${field}) >= ? AND DATE(${field}) <= ?`;
      break;
    case "today":
      filter = `DATE(${field}) = CURDATE()`;
      break;
    case "this_month":
      filter = `YEAR(${field}) = YEAR(NOW()) AND MONTH(${field}) = MONTH(NOW())`;
      break;
    case "last_month":
      filter = `MONTH(${field}) = MONTH(DATE_ADD(NOW(), INTERVAL -1 MONTH)) AND YEAR(${field}) = YEAR(DATE_ADD(NOW(), INTERVAL -1 MONTH))`;
      break;
    case "last_7days":
      filter = `DATE(${field}) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND DATE(${field}) <= CURDATE()`;
      break;
    case "yesterday":
      filter = `DATE(${field}) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`;
      break;
    case "tomorrow":
      filter = `DATE(${field}) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;
      break;
    default:
      filter = "1 = 1";
  }

  return { filter, params };
};

const query = async (conn, sql, params = []) => {
  const [rows] = await conn.query(sql, params);
  return rows;
};

const makeReport = ({ reportId, currency, store, type, from, to, summary = [], tables = [], charts = [], title, t }) => ({
  reportId,
  title: title ?? (t ? t(reportTitleKey(reportId)) : REPORT_TITLES[reportId]),
  currency,
  store,
  dateRange: buildDateRange(type, from, to),
  summary,
  tables,
  charts,
});

const getInvoiceTotals = async (conn, type, from, to, tenantId) => {
  const { filter, params } = getFilterCondition("created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      COUNT(*) AS invoice_count,
      COALESCE(SUM(sub_total), 0) AS net_sales,
      COALESCE(SUM(tax_total), 0) AS tax_total,
      COALESCE(SUM(service_charge_total), 0) AS service_charge_total,
      COALESCE(SUM(total), 0) AS total_sales,
      COALESCE(AVG(total), 0) AS average_order_value
    FROM invoices
    WHERE tenant_id = ? AND ${filter}
  `, [tenantId, ...params]);

  return rows[0] || {};
};

const getOrderTotals = async (conn, type, from, to, tenantId) => {
  const { filter, params } = getFilterCondition("date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COUNT(*) AS orders_count,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
      SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END) AS unpaid_orders,
      COUNT(DISTINCT CASE WHEN customer_type = 'CUSTOMER' THEN customer_id END) AS repeat_customers
    FROM orders
    WHERE tenant_id = ? AND ${filter}
  `, [tenantId, ...params]);

  return rows[0] || {};
};

const getTopSellingItems = async (conn, type, from, to, tenantId) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  return query(conn, `
    SELECT
      mi.id,
      mi.title,
      COALESCE(mi.price, 0) AS price,
      COALESCE(mi.net_price, 0) AS net_price,
      COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS gross_sales
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status <> 'cancelled' AND ${filter}
    GROUP BY mi.id, mi.title, mi.price, mi.net_price
    ORDER BY quantity_sold DESC
    LIMIT 20
  `, [tenantId, ...params]);
};

const getPaymentRows = async (conn, type, from, to, tenantId) => {
  const { filter, params } = getFilterCondition("i.created_at", type, from, to);
  return query(conn, `
    SELECT
      COALESCE(pt.title, 'Unassigned') AS payment_type,
      COUNT(i.id) AS invoice_count,
      COALESCE(SUM(i.total), 0) AS total
    FROM invoices i
    LEFT JOIN payment_types pt ON pt.id = i.payment_type_id AND pt.tenant_id = i.tenant_id
    WHERE i.tenant_id = ? AND ${filter}
    GROUP BY i.payment_type_id, pt.title
    ORDER BY total DESC
  `, [tenantId, ...params]);
};

const getSalesSummaryReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const [invoiceTotals, orderTotals, newCustomersRows, totalCustomersRows, topItems, payments] = await Promise.all([
    getInvoiceTotals(conn, type, from, to, tenantId),
    getOrderTotals(conn, type, from, to, tenantId),
    query(conn, `SELECT COUNT(*) AS new_customers FROM customers WHERE tenant_id = ? AND ${getFilterCondition("created_at", type, from, to).filter}`, [tenantId, ...getFilterCondition("created_at", type, from, to).params]),
    query(conn, "SELECT COUNT(*) AS total_customers FROM customers WHERE tenant_id = ?", [tenantId]),
    getTopSellingItems(conn, type, from, to, tenantId),
    getPaymentRows(conn, type, from, to, tenantId),
  ]);

  return makeReport({ t,
    reportId: "sales-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_orders"), value: orderTotals.orders_count || 0, type: "number" },
      { label: t("reports_average_order_value"), value: money(invoiceTotals.average_order_value), type: "money" },
      { label: t("reports_total_customers"), value: totalCustomersRows[0]?.total_customers || 0, type: "number" },
      { label: t("reports_new_customers"), value: newCustomersRows[0]?.new_customers || 0, type: "number" },
      { label: t("reports_repeat_customers"), value: orderTotals.repeat_customers || 0, type: "number" },
      { label: t("reports_revenue"), value: money(invoiceTotals.total_sales), type: "money" },
      { label: t("reports_net_sales"), value: money(invoiceTotals.net_sales), type: "money" },
      { label: t("reports_tax"), value: money(invoiceTotals.tax_total), type: "money" },
      { label: t("reports_service_charge"), value: money(invoiceTotals.service_charge_total), type: "money" },
    ],
    tables: [
      {
        title: t("reports_top_selling_items"),
        columns: [
          { key: "title", label: t("reports_item") },
          { key: "quantity_sold", label: t("reports_qty"), type: "number" },
          { key: "gross_sales", label: t("reports_gross_sales"), type: "money" },
          { key: "price", label: t("reports_price"), type: "money" },
        ],
        rows: topItems,
      },
      {
        title: t("reports_payments_by_method"),
        columns: [
          { key: "payment_type", label: t("reports_payment_type") },
          { key: "invoice_count", label: t("reports_invoices"), type: "number" },
          { key: "total", label: t("reports_total"), type: "money" },
        ],
        rows: payments,
      },
    ],
    charts: [{ type: "pie", title: t("reports_payments_by_method"), data: payments }],
  });
};

const getGrossSalesReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(mi.title, 'Deleted item') AS item,
      COALESCE(c.title, 'Uncategorized') AS category,
      COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS gross_sales
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status <> 'cancelled' AND ${filter}
    GROUP BY mi.id, mi.title, c.title
    ORDER BY gross_sales DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "gross-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_gross_sales"), value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
      { label: t("reports_items_sold"), value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: t("reports_selling_items"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_gross_sales_by_item"),
      columns: [
        { key: "item", label: t("reports_item") },
        { key: "category", label: t("reports_category") },
        { key: "quantity_sold", label: t("reports_qty"), type: "number" },
        { key: "gross_sales", label: t("reports_gross_sales"), type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: t("reports_gross_sales_by_item"), data: rows.slice(0, 10) }],
  });
};

const getNetSalesReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const totals = await getInvoiceTotals(conn, type, from, to, tenantId);
  const { filter, params } = getFilterCondition("created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS invoices,
      COALESCE(SUM(sub_total), 0) AS net_sales,
      COALESCE(SUM(tax_total), 0) AS tax_total,
      COALESCE(SUM(service_charge_total), 0) AS service_charge_total,
      COALESCE(SUM(total), 0) AS total_sales
    FROM invoices
    WHERE tenant_id = ? AND ${filter}
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "net-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_net_sales"), value: money(totals.net_sales), type: "money" },
      { label: t("reports_tax"), value: money(totals.tax_total), type: "money" },
      { label: t("reports_service_charge"), value: money(totals.service_charge_total), type: "money" },
      { label: t("reports_revenue"), value: money(totals.total_sales), type: "money" },
    ],
    tables: [{
      title: t("reports_net_sales_by_date"),
      columns: [
        { key: "date", label: t("reports_date"), type: "date" },
        { key: "invoices", label: t("reports_invoices"), type: "number" },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "tax_total", label: t("reports_tax"), type: "money" },
        { key: "service_charge_total", label: t("reports_service_charge"), type: "money" },
        { key: "total_sales", label: t("reports_revenue"), type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: t("reports_net_sales_trend"), data: [...rows].reverse() }],
  });
};

const getGroupedInvoiceReport = async ({ conn, reportId, type, from, to, tenantId, currency, store, groupSelect, groupBy, orderBy = "revenue DESC", columns, tableTitleKey, summaryLabelKey, t = (key) => key }) => {
  const tableTitle = t(tableTitleKey);
  const summaryLabel = t(summaryLabelKey);
  const { filter, params } = getFilterCondition("i.created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      ${groupSelect},
      COUNT(i.id) AS invoices,
      COALESCE(SUM(i.sub_total), 0) AS net_sales,
      COALESCE(SUM(i.tax_total), 0) AS tax_total,
      COALESCE(SUM(i.service_charge_total), 0) AS service_charge_total,
      COALESCE(SUM(i.total), 0) AS revenue,
      COALESCE(AVG(i.total), 0) AS average_order_value
    FROM invoices i
    WHERE i.tenant_id = ? AND ${filter}
    GROUP BY ${groupBy}
    ORDER BY ${orderBy}
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId,
    title: tableTitle,
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: summaryLabel, value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_invoices"), value: rows.reduce((sum, row) => sum + money(row.invoices), 0), type: "number" },
      { label: t("reports_average_order_value"), value: rows.length ? rows.reduce((sum, row) => sum + money(row.revenue), 0) / rows.reduce((sum, row) => sum + money(row.invoices), 0) : 0, type: "money" },
    ],
    tables: [{ title: tableTitle, columns, rows }],
    charts: [{ type: "bar", title: tableTitle, data: rows }],
  });
};

const getSalesByOrderTypeReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(NULLIF(o.delivery_type, ''), 'Unassigned') AS order_type,
      COUNT(o.id) AS orders,
      COALESCE(SUM(i.sub_total), 0) AS net_sales,
      COALESCE(SUM(i.total), 0) AS revenue,
      COALESCE(AVG(i.total), 0) AS average_order_value
    FROM orders o
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND ${filter}
    GROUP BY COALESCE(NULLIF(o.delivery_type, ''), 'Unassigned')
    ORDER BY revenue DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "sales-by-order-type",
    title: t("reports_sales_by_order_type"),
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_order_types"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_sales_by_order_type"),
      columns: [
        { key: "order_type", label: t("reports_order_type") },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "average_order_value", label: t("reports_aov"), type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: t("reports_revenue_by_order_type"), data: rows }],
  });
};

const getSalesByTableReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(st.table_title, 'No table') AS table_title,
      COALESCE(st.floor, '-') AS floor,
      COUNT(o.id) AS orders,
      COALESCE(SUM(i.sub_total), 0) AS net_sales,
      COALESCE(SUM(i.total), 0) AS revenue,
      COALESCE(AVG(i.total), 0) AS average_order_value
    FROM orders o
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    LEFT JOIN store_tables st ON st.id = o.table_id AND st.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND ${filter}
    GROUP BY st.id, st.table_title, st.floor
    ORDER BY revenue DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "sales-by-table",
    title: t("reports_sales_by_table"),
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_tables"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_sales_by_table"),
      columns: [
        { key: "table_title", label: t("reports_table") },
        { key: "floor", label: t("reports_floor") },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "average_order_value", label: t("reports_aov"), type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: t("reports_revenue_by_table"), data: rows.slice(0, 12) }],
  });
};

const getInvoiceDetailReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("i.created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      i.id AS invoice_id,
      i.created_at,
      COALESCE(c.name, o.customer_id, 'Walk-in') AS customer,
      COALESCE(pt.title, 'Unassigned') AS payment_type,
      COALESCE(o.delivery_type, '-') AS order_type,
      COALESCE(i.sub_total, 0) AS net_sales,
      COALESCE(i.tax_total, 0) AS tax_total,
      COALESCE(i.service_charge_total, 0) AS service_charge_total,
      COALESCE(i.total, 0) AS total
    FROM invoices i
    LEFT JOIN orders o ON o.invoice_id = i.id AND o.tenant_id = i.tenant_id
    LEFT JOIN customers c ON c.phone = o.customer_id AND c.tenant_id = o.tenant_id
    LEFT JOIN payment_types pt ON pt.id = i.payment_type_id AND pt.tenant_id = i.tenant_id
    WHERE i.tenant_id = ? AND ${filter}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 1000
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "invoice-detail",
    title: t("reports_invoice_detail"),
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_invoices"), value: rows.length, type: "number" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
      { label: t("reports_net_sales"), value: rows.reduce((sum, row) => sum + money(row.net_sales), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_invoice_detail"),
      columns: [
        { key: "invoice_id", label: t("reports_invoice") },
        { key: "created_at", label: t("reports_created"), type: "datetime" },
        { key: "customer", label: t("reports_customer") },
        { key: "payment_type", label: t("reports_payment") },
        { key: "order_type", label: t("reports_order_type") },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "tax_total", label: t("reports_tax"), type: "money" },
        { key: "service_charge_total", label: t("reports_service"), type: "money" },
        { key: "total", label: t("reports_total"), type: "money" },
      ],
      rows,
    }],
  });
};

const getVoidsCancellationsReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      oi.id AS order_item_id,
      oi.order_id,
      oi.date,
      COALESCE(mi.title, 'Deleted item') AS item,
      COALESCE(oi.quantity, 0) AS quantity,
      COALESCE(oi.price, 0) AS price,
      COALESCE(oi.price * oi.quantity, 0) AS lost_sales,
      oi.status,
      oi.notes
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status = 'cancelled' AND ${filter}
    ORDER BY oi.date DESC
  `, [tenantId, ...params]);

  const orderFilter = getFilterCondition("date", type, from, to);
  const cancelledOrders = await query(conn, `
    SELECT COUNT(*) AS cancelled_orders
    FROM orders
    WHERE tenant_id = ? AND status = 'cancelled' AND ${orderFilter.filter}
  `, [tenantId, ...orderFilter.params]);

  return makeReport({ t,
    reportId: "voids-cancellations",
    title: t("reports_cancelled_items"),
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_cancelled_orders"), value: cancelledOrders[0]?.cancelled_orders || 0, type: "number" },
      { label: t("reports_cancelled_items"), value: rows.length, type: "number" },
      { label: t("reports_lost_sales"), value: rows.reduce((sum, row) => sum + money(row.lost_sales), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_cancelled_items"),
      columns: [
        { key: "date", label: t("reports_date"), type: "datetime" },
        { key: "order_id", label: t("reports_order") },
        { key: "item", label: t("reports_item") },
        { key: "quantity", label: t("reports_qty"), type: "number" },
        { key: "price", label: t("reports_price"), type: "money" },
        { key: "lost_sales", label: t("reports_lost_sales"), type: "money" },
        { key: "notes", label: t("reports_notes") },
      ],
      rows,
    }],
  });
};

const getAverageOrderValueReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const totals = await getInvoiceTotals(conn, type, from, to, tenantId);
  const { filter, params } = getFilterCondition("created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS invoices,
      COALESCE(SUM(total), 0) AS revenue,
      COALESCE(AVG(total), 0) AS average_order_value
    FROM invoices
    WHERE tenant_id = ? AND ${filter}
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "average-order-value",
    title: t("reports_average_order_value"),
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_average_order_value"), value: money(totals.average_order_value), type: "money" },
      { label: t("reports_invoices"), value: totals.invoice_count || 0, type: "number" },
      { label: t("reports_revenue"), value: money(totals.total_sales), type: "money" },
    ],
    tables: [{
      title: t("reports_average_order_value_by_date"),
      columns: [
        { key: "date", label: t("reports_date"), type: "date" },
        { key: "invoices", label: t("reports_invoices"), type: "number" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "average_order_value", label: t("reports_aov"), type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: t("reports_aov_trend"), data: [...rows].reverse() }],
  });
};

const getPaymentSummaryReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await getPaymentRows(conn, type, from, to, tenantId);
  const total = rows.reduce((sum, row) => sum + money(row.total), 0);

  return makeReport({ t,
    reportId: "payment-summary",
    title: t("reports_payment_summary"),
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_payments"), value: total, type: "money" },
      { label: t("reports_invoices"), value: rows.reduce((sum, row) => sum + money(row.invoice_count), 0), type: "number" },
      { label: t("reports_payment_types"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_payment_summary"),
      columns: [
        { key: "payment_type", label: t("reports_payment_type") },
        { key: "invoice_count", label: t("reports_invoices"), type: "number" },
        { key: "total", label: t("reports_total"), type: "money" },
        { key: "share", label: t("reports_share_percent") },
      ],
      rows: rows.map((row) => ({ ...row, share: total ? `${((money(row.total) / total) * 100).toFixed(2)}%` : "0.00%" })),
    }],
    charts: [{ type: "pie", title: t("reports_payment_mix"), data: rows }],
  });
};

const getPaymentKeywordReport = async (conn, type, from, to, tenantId, currency, store, reportId, titleKey, keywords, t = (key) => key) => {
  const title = t(titleKey);
  const { filter, params } = getFilterCondition("i.created_at", type, from, to);
  const keywordFilter = keywords.map(() => "LOWER(COALESCE(pt.title, '')) LIKE ?").join(" OR ");
  const rows = await query(conn, `
    SELECT
      i.id AS invoice_id,
      i.created_at,
      COALESCE(pt.title, 'Unassigned') AS payment_type,
      COALESCE(i.sub_total, 0) AS net_sales,
      COALESCE(i.tax_total, 0) AS tax_total,
      COALESCE(i.service_charge_total, 0) AS service_charge_total,
      COALESCE(i.total, 0) AS total
    FROM invoices i
    LEFT JOIN payment_types pt ON pt.id = i.payment_type_id AND pt.tenant_id = i.tenant_id
    WHERE i.tenant_id = ? AND ${filter} AND (${keywordFilter})
    ORDER BY i.created_at DESC, i.id DESC
  `, [tenantId, ...params, ...keywords.map((keyword) => `%${keyword}%`)]);

  return makeReport({ t,
    reportId,
    title,
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: title, value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
      { label: t("reports_invoices"), value: rows.length, type: "number" },
      { label: t("reports_average_payment"), value: rows.length ? rows.reduce((sum, row) => sum + money(row.total), 0) / rows.length : 0, type: "money" },
    ],
    tables: [{
      title,
      columns: [
        { key: "invoice_id", label: t("reports_invoice") },
        { key: "created_at", label: t("reports_created"), type: "datetime" },
        { key: "payment_type", label: t("reports_payment_type") },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "tax_total", label: t("reports_tax"), type: "money" },
        { key: "service_charge_total", label: t("reports_service"), type: "money" },
        { key: "total", label: t("reports_total"), type: "money" },
      ],
      rows,
    }],
  });
};

const getUnpaidOrdersReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      o.id AS order_id,
      o.date,
      COALESCE(o.delivery_type, '-') AS order_type,
      COALESCE(st.table_title, '-') AS table_title,
      COALESCE(c.name, o.customer_id, 'Walk-in') AS customer,
      o.status,
      o.payment_status,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS estimated_total
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.tenant_id = o.tenant_id AND oi.status <> 'cancelled'
    LEFT JOIN customers c ON c.phone = o.customer_id AND c.tenant_id = o.tenant_id
    LEFT JOIN store_tables st ON st.id = o.table_id AND st.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND o.payment_status = 'pending' AND ${filter}
    GROUP BY o.id, o.date, o.delivery_type, st.table_title, c.name, o.customer_id, o.status, o.payment_status
    ORDER BY o.date DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "unpaid-orders",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_unpaid_orders"), value: rows.length, type: "number" },
      { label: t("reports_estimated_total"), value: rows.reduce((sum, row) => sum + money(row.estimated_total), 0), type: "money" },
      { label: t("reports_customers"), value: new Set(rows.map((row) => row.customer)).size, type: "number" },
    ],
    tables: [{
      title: t("reports_unpaid_orders"),
      columns: [
        { key: "order_id", label: t("reports_order") },
        { key: "date", label: t("reports_date"), type: "datetime" },
        { key: "order_type", label: t("reports_order_type") },
        { key: "table_title", label: t("reports_table") },
        { key: "customer", label: t("reports_customer") },
        { key: "status", label: t("reports_status") },
        { key: "estimated_total", label: t("reports_estimated_total"), type: "money" },
      ],
      rows,
    }],
  });
};

const getPaymentTypeMixReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await getPaymentRows(conn, type, from, to, tenantId);
  const total = rows.reduce((sum, row) => sum + money(row.total), 0);
  const reportRows = rows.map((row) => ({
    ...row,
    share: total ? `${((money(row.total) / total) * 100).toFixed(2)}%` : "0.00%",
  }));

  return makeReport({ t,
    reportId: "payment-type-mix",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_payment_total"), value: total, type: "money" },
      { label: t("reports_top_payment_type"), value: reportRows[0]?.payment_type || "-", type: "text" },
      { label: t("reports_payment_types"), value: reportRows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_payment_type_mix"),
      columns: [
        { key: "payment_type", label: t("reports_payment_type") },
        { key: "invoice_count", label: t("reports_invoices"), type: "number" },
        { key: "total", label: t("reports_total"), type: "money" },
        { key: "share", label: t("reports_share_percent") },
      ],
      rows: reportRows,
    }],
    charts: [{ type: "pie", title: t("reports_payment_type_mix"), data: reportRows }],
  });
};

const getItemSalesRows = async (conn, type, from, to, tenantId, orderBy = "gross_sales DESC") => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  return query(conn, `
    SELECT
      mi.id AS item_id,
      COALESCE(mi.title, 'Deleted item') AS item,
      COALESCE(c.title, 'Uncategorized') AS category,
      COALESCE(mi.price, 0) AS current_price,
      COALESCE(mi.net_price, 0) AS current_net_price,
      COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS gross_sales,
      COALESCE(AVG(oi.price), 0) AS average_sold_price
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status <> 'cancelled' AND ${filter}
    GROUP BY mi.id, mi.title, c.title, mi.price, mi.net_price
    ORDER BY ${orderBy}
  `, [tenantId, ...params]);
};

const makeItemSalesReport = ({ reportId, titleKey, rows, currency, store, type, from, to, t = (key) => key }) => {
  const title = t(titleKey);
  return makeReport({ t,
  t,
  reportId,
  title,
  currency,
  store,
  type,
  from,
  to,
  summary: [
    { label: t("reports_gross_sales"), value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
    { label: t("reports_quantity_sold"), value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
    { label: t("reports_items"), value: rows.length, type: "number" },
  ],
  tables: [{
    title,
    columns: [
      { key: "item", label: t("reports_item") },
      { key: "category", label: t("reports_category") },
      { key: "quantity_sold", label: t("reports_qty"), type: "number" },
      { key: "gross_sales", label: t("reports_gross_sales"), type: "money" },
      { key: "average_sold_price", label: t("reports_avg_sold_price"), type: "money" },
      { key: "current_price", label: t("reports_current_price"), type: "money" },
    ],
    rows,
  }],
  charts: [{ type: "bar", title, data: rows.slice(0, 12) }],
});
};

const getTopSellingItemsReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await getItemSalesRows(conn, type, from, to, tenantId, "quantity_sold DESC, gross_sales DESC");
  return makeItemSalesReport({ reportId: "top-selling-items", titleKey: "reports_top_selling_items", rows: rows.slice(0, 50), currency, store, type, from, to, t });
};

const getLowSellingItemsReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      mi.id AS item_id,
      COALESCE(mi.title, 'Untitled item') AS item,
      COALESCE(c.title, 'Uncategorized') AS category,
      COALESCE(mi.price, 0) AS current_price,
      COALESCE(mi.net_price, 0) AS current_net_price,
      COALESCE(SUM(CASE WHEN oi.status <> 'cancelled' AND ${filter} THEN oi.quantity ELSE 0 END), 0) AS quantity_sold,
      COALESCE(SUM(CASE WHEN oi.status <> 'cancelled' AND ${filter} THEN oi.price * oi.quantity ELSE 0 END), 0) AS gross_sales,
      COALESCE(AVG(CASE WHEN oi.status <> 'cancelled' AND ${filter} THEN oi.price ELSE NULL END), 0) AS average_sold_price
    FROM menu_items mi
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    LEFT JOIN order_items oi ON oi.item_id = mi.id AND oi.tenant_id = mi.tenant_id
    WHERE mi.tenant_id = ?
    GROUP BY mi.id, mi.title, c.title, mi.price, mi.net_price
    ORDER BY quantity_sold ASC, gross_sales ASC, mi.title ASC
  `, [...params, ...params, ...params, tenantId]);

  return makeItemSalesReport({ reportId: "low-selling-items", titleKey: "reports_low_selling_items", rows: rows.slice(0, 50), currency, store, type, from, to, t });
};

const getItemSalesReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await getItemSalesRows(conn, type, from, to, tenantId);
  return makeItemSalesReport({ reportId: "item-sales", titleKey: "reports_item_sales", rows, currency, store, type, from, to, t });
};

const getCategorySalesReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(c.title, 'Uncategorized') AS category,
      COUNT(DISTINCT oi.item_id) AS items_sold,
      COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS gross_sales,
      COALESCE(AVG(oi.price), 0) AS average_sold_price
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status <> 'cancelled' AND ${filter}
    GROUP BY c.id, c.title
    ORDER BY gross_sales DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "category-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_gross_sales"), value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
      { label: t("reports_quantity_sold"), value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: t("reports_categories"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_category_sales"),
      columns: [
        { key: "category", label: t("reports_category") },
        { key: "items_sold", label: t("reports_items"), type: "number" },
        { key: "quantity_sold", label: t("reports_qty"), type: "number" },
        { key: "gross_sales", label: t("reports_gross_sales"), type: "money" },
        { key: "average_sold_price", label: t("reports_avg_sold_price"), type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: t("reports_category_sales"), data: rows }],
  });
};

const getVariantSalesReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(mi.title, 'Deleted item') AS item,
      COALESCE(miv.title, 'Base item') AS variant,
      COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS gross_sales,
      COALESCE(AVG(oi.price), 0) AS average_sold_price,
      COALESCE(miv.price, mi.price, 0) AS current_price
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    LEFT JOIN menu_item_variants miv ON miv.id = oi.variant_id AND miv.item_id = oi.item_id AND miv.tenant_id = oi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status <> 'cancelled' AND ${filter}
    GROUP BY mi.id, mi.title, miv.id, miv.title, miv.price, mi.price
    ORDER BY gross_sales DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "variant-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_gross_sales"), value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
      { label: t("reports_quantity_sold"), value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: t("reports_variants"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_variant_sales"),
      columns: [
        { key: "item", label: t("reports_item") },
        { key: "variant", label: t("reports_variant") },
        { key: "quantity_sold", label: t("reports_qty"), type: "number" },
        { key: "gross_sales", label: t("reports_gross_sales"), type: "money" },
        { key: "average_sold_price", label: t("reports_avg_sold_price"), type: "money" },
        { key: "current_price", label: t("reports_current_price"), type: "money" },
      ],
      rows,
    }],
  });
};

const getAddonSalesReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(mi.title, 'Deleted item') AS item,
      COALESCE(mia.title, CONCAT('Addon #', addon_ids.addon_id)) AS addon,
      COALESCE(mia.price, 0) AS addon_price,
      COUNT(*) AS order_lines,
      COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
      COALESCE(SUM(mia.price * oi.quantity), 0) AS addon_sales
    FROM order_items oi
    JOIN JSON_TABLE(
      CASE WHEN JSON_VALID(oi.addons) THEN oi.addons ELSE '[]' END,
      '$[*]' COLUMNS (addon_id INT PATH '$')
    ) addon_ids
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    LEFT JOIN menu_item_addons mia ON mia.id = addon_ids.addon_id AND mia.item_id = oi.item_id AND mia.tenant_id = oi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status <> 'cancelled' AND ${filter}
    GROUP BY mi.id, mi.title, addon_ids.addon_id, mia.title, mia.price
    ORDER BY addon_sales DESC, quantity_sold DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "addon-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_addon_sales"), value: rows.reduce((sum, row) => sum + money(row.addon_sales), 0), type: "money" },
      { label: t("reports_quantity_sold"), value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: t("reports_addons"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_addon_sales"),
      columns: [
        { key: "item", label: t("reports_item") },
        { key: "addon", label: t("reports_addon") },
        { key: "order_lines", label: t("reports_lines"), type: "number" },
        { key: "quantity_sold", label: t("reports_qty"), type: "number" },
        { key: "addon_price", label: t("reports_addon_price"), type: "money" },
        { key: "addon_sales", label: t("reports_addon_sales"), type: "money" },
      ],
      rows,
    }],
  });
};

const getMenuPriceAuditReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const itemRows = await query(conn, `
    SELECT
      'Item' AS type,
      mi.title AS item,
      '-' AS option_name,
      COALESCE(c.title, 'Uncategorized') AS category,
      COALESCE(mi.price, 0) AS price,
      COALESCE(mi.net_price, 0) AS net_price,
      COALESCE(t.title, '-') AS tax,
      COALESCE(t.rate, 0) AS tax_rate,
      CASE WHEN mi.is_enabled = 1 THEN 'Enabled' ELSE 'Disabled' END AS status
    FROM menu_items mi
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    LEFT JOIN taxes t ON t.id = mi.tax_id AND t.tenant_id = mi.tenant_id
    WHERE mi.tenant_id = ?
    ORDER BY mi.title ASC
  `, [tenantId]);

  const variantRows = await query(conn, `
    SELECT
      'Variant' AS type,
      mi.title AS item,
      miv.title AS option_name,
      COALESCE(c.title, 'Uncategorized') AS category,
      COALESCE(miv.price, 0) AS price,
      COALESCE(mi.net_price, 0) AS net_price,
      COALESCE(t.title, '-') AS tax,
      COALESCE(t.rate, 0) AS tax_rate,
      CASE WHEN mi.is_enabled = 1 THEN 'Enabled' ELSE 'Disabled' END AS status
    FROM menu_item_variants miv
    INNER JOIN menu_items mi ON mi.id = miv.item_id AND mi.tenant_id = miv.tenant_id
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    LEFT JOIN taxes t ON t.id = mi.tax_id AND t.tenant_id = mi.tenant_id
    WHERE miv.tenant_id = ?
    ORDER BY mi.title ASC, miv.title ASC
  `, [tenantId]);

  const addonRows = await query(conn, `
    SELECT
      'Addon' AS type,
      mi.title AS item,
      mia.title AS option_name,
      COALESCE(c.title, 'Uncategorized') AS category,
      COALESCE(mia.price, 0) AS price,
      COALESCE(mi.net_price, 0) AS net_price,
      COALESCE(t.title, '-') AS tax,
      COALESCE(t.rate, 0) AS tax_rate,
      CASE WHEN mi.is_enabled = 1 THEN 'Enabled' ELSE 'Disabled' END AS status
    FROM menu_item_addons mia
    INNER JOIN menu_items mi ON mi.id = mia.item_id AND mi.tenant_id = mia.tenant_id
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    LEFT JOIN taxes t ON t.id = mi.tax_id AND t.tenant_id = mi.tenant_id
    WHERE mia.tenant_id = ?
    ORDER BY mi.title ASC, mia.title ASC
  `, [tenantId]);

  const rows = [...itemRows, ...variantRows, ...addonRows];

  return makeReport({ t,
    reportId: "menu-price-audit",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_items"), value: itemRows.length, type: "number" },
      { label: t("reports_variants"), value: variantRows.length, type: "number" },
      { label: t("reports_addons"), value: addonRows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_menu_price_audit"),
      columns: [
        { key: "type", label: t("reports_type") },
        { key: "item", label: t("reports_item") },
        { key: "option_name", label: t("reports_option") },
        { key: "category", label: t("reports_category") },
        { key: "price", label: t("reports_price"), type: "money" },
        { key: "net_price", label: t("reports_net_price"), type: "money" },
        { key: "tax", label: t("reports_tax") },
        { key: "tax_rate", label: t("reports_tax_rate"), type: "number" },
        { key: "status", label: t("reports_status") },
      ],
      rows,
    }],
  });
};

const getCustomerSummaryReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const customerFilter = getFilterCondition("created_at", type, from, to);
  const orderFilter = getFilterCondition("o.date", type, from, to);

  const [totals, newCustomers, activeCustomers, topCustomers] = await Promise.all([
    query(conn, `
      SELECT
        COUNT(*) AS total_customers,
        SUM(CASE WHEN is_member = 1 THEN 1 ELSE 0 END) AS member_customers,
        SUM(CASE WHEN is_member = 0 THEN 1 ELSE 0 END) AS non_member_customers
      FROM customers
      WHERE tenant_id = ?
    `, [tenantId]),
    query(conn, `
      SELECT COUNT(*) AS new_customers
      FROM customers
      WHERE tenant_id = ? AND ${customerFilter.filter}
    `, [tenantId, ...customerFilter.params]),
    query(conn, `
      SELECT COUNT(DISTINCT o.customer_id) AS active_customers
      FROM orders o
      WHERE o.tenant_id = ? AND o.customer_type = 'CUSTOMER' AND o.customer_id IS NOT NULL AND ${orderFilter.filter}
    `, [tenantId, ...orderFilter.params]),
    query(conn, `
      SELECT
        c.phone,
        c.name,
        c.email,
        c.is_member,
        COUNT(o.id) AS orders,
        COALESCE(SUM(i.total), 0) AS revenue,
        COALESCE(AVG(i.total), 0) AS average_order_value
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.phone AND o.tenant_id = c.tenant_id AND ${orderFilter.filter}
      LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
      WHERE c.tenant_id = ?
      GROUP BY c.phone, c.name, c.email, c.is_member
      HAVING orders > 0
      ORDER BY revenue DESC
      LIMIT 25
    `, [...orderFilter.params, tenantId]),
  ]);

  return makeReport({ t,
    reportId: "customer-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_total_customers"), value: totals[0]?.total_customers || 0, type: "number" },
      { label: t("reports_new_customers"), value: newCustomers[0]?.new_customers || 0, type: "number" },
      { label: t("reports_active_customers"), value: activeCustomers[0]?.active_customers || 0, type: "number" },
      { label: t("reports_members"), value: totals[0]?.member_customers || 0, type: "number" },
    ],
    tables: [{
      title: t("reports_top_active_customers"),
      columns: [
        { key: "name", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "email", label: t("reports_email") },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "average_order_value", label: t("reports_aov"), type: "money" },
      ],
      rows: topCustomers,
    }],
  });
};

const getNewCustomersReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      phone,
      name,
      email,
      birth_date,
      gender,
      CASE WHEN is_member = 1 THEN 'Member' ELSE 'Guest' END AS membership,
      created_at
    FROM customers
    WHERE tenant_id = ? AND ${filter}
    ORDER BY created_at DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "new-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_new_customers"), value: rows.length, type: "number" },
      { label: t("reports_members"), value: rows.filter((row) => row.membership === "Member").length, type: "number" },
      { label: t("reports_with_email"), value: rows.filter((row) => row.email).length, type: "number" },
    ],
    tables: [{
      title: t("reports_new_customers"),
      columns: [
        { key: "created_at", label: t("reports_created"), type: "datetime" },
        { key: "name", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "email", label: t("reports_email") },
        { key: "gender", label: t("reports_gender") },
        { key: "membership", label: t("reports_membership") },
      ],
      rows,
    }],
  });
};

const getReturningCustomersReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      c.phone,
      COALESCE(c.name, o.customer_id) AS name,
      c.email,
      CASE WHEN c.is_member = 1 THEN 'Member' ELSE 'Guest' END AS membership,
      COUNT(o.id) AS orders,
      COALESCE(SUM(i.total), 0) AS revenue,
      MAX(o.date) AS last_order_at
    FROM orders o
    LEFT JOIN customers c ON c.phone = o.customer_id AND c.tenant_id = o.tenant_id
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND o.customer_type = 'CUSTOMER' AND o.customer_id IS NOT NULL AND ${filter}
    GROUP BY c.phone, c.name, c.email, c.is_member, o.customer_id
    ORDER BY orders DESC, revenue DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "returning-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_returning_customers"), value: rows.length, type: "number" },
      { label: t("reports_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_returning_customers"),
      columns: [
        { key: "name", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "email", label: t("reports_email") },
        { key: "membership", label: t("reports_membership") },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "last_order_at", label: t("reports_last_order"), type: "datetime" },
      ],
      rows,
    }],
  });
};

const getTopCustomersReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      c.phone,
      COALESCE(c.name, o.customer_id, 'Walk-in') AS name,
      c.email,
      CASE WHEN c.is_member = 1 THEN 'Member' ELSE 'Guest' END AS membership,
      COUNT(o.id) AS orders,
      COALESCE(SUM(i.total), 0) AS revenue,
      COALESCE(AVG(i.total), 0) AS average_order_value,
      MAX(o.date) AS last_order_at
    FROM orders o
    LEFT JOIN customers c ON c.phone = o.customer_id AND c.tenant_id = o.tenant_id
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND o.customer_type = 'CUSTOMER' AND ${filter}
    GROUP BY c.phone, c.name, c.email, c.is_member, o.customer_id
    ORDER BY revenue DESC, orders DESC
    LIMIT 100
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "top-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_top_customer_revenue"), value: rows[0]?.revenue || 0, type: "money" },
      { label: t("reports_customers"), value: rows.length, type: "number" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_top_customers"),
      columns: [
        { key: "name", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "email", label: t("reports_email") },
        { key: "membership", label: t("reports_membership") },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "average_order_value", label: t("reports_aov"), type: "money" },
        { key: "last_order_at", label: t("reports_last_order"), type: "datetime" },
      ],
      rows,
    }],
  });
};

const getCustomerBirthdaysReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await query(conn, `
    SELECT
      phone,
      name,
      email,
      birth_date,
      gender,
      CASE WHEN is_member = 1 THEN 'Member' ELSE 'Guest' END AS membership,
      CASE
        WHEN birth_date IS NULL THEN NULL
        ELSE DATEDIFF(
          STR_TO_DATE(CONCAT(YEAR(CURDATE()) + (DATE_FORMAT(birth_date, '%m-%d') < DATE_FORMAT(CURDATE(), '%m-%d')), '-', DATE_FORMAT(birth_date, '%m-%d')), '%Y-%m-%d'),
          CURDATE()
        )
      END AS days_until_birthday
    FROM customers
    WHERE tenant_id = ? AND birth_date IS NOT NULL
    ORDER BY days_until_birthday ASC, name ASC
    LIMIT 100
  `, [tenantId]);

  return makeReport({ t,
    reportId: "customer-birthdays",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_customers_with_birthdays"), value: rows.length, type: "number" },
      { label: t("reports_next_7_days"), value: rows.filter((row) => Number(row.days_until_birthday) <= 7).length, type: "number" },
      { label: t("reports_next_30_days"), value: rows.filter((row) => Number(row.days_until_birthday) <= 30).length, type: "number" },
    ],
    tables: [{
      title: t("reports_upcoming_birthdays"),
      columns: [
        { key: "days_until_birthday", label: t("reports_days"), type: "number" },
        { key: "name", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "email", label: t("reports_email") },
        { key: "birth_date", label: t("reports_birth_date"), type: "date" },
        { key: "membership", label: t("reports_membership") },
      ],
      rows,
    }],
  });
};

const getMemberCustomersReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await query(conn, `
    SELECT
      c.phone,
      c.name,
      c.email,
      c.birth_date,
      c.gender,
      c.created_at,
      COUNT(o.id) AS orders,
      COALESCE(SUM(i.total), 0) AS revenue,
      MAX(o.date) AS last_order_at
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.phone AND o.tenant_id = c.tenant_id
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE c.tenant_id = ? AND c.is_member = 1
    GROUP BY c.phone, c.name, c.email, c.birth_date, c.gender, c.created_at
    ORDER BY revenue DESC, c.created_at DESC
  `, [tenantId]);

  return makeReport({ t,
    reportId: "member-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_members"), value: rows.length, type: "number" },
      { label: t("reports_member_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_member_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
    ],
    tables: [{
      title: t("reports_member_customers"),
      columns: [
        { key: "name", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "email", label: t("reports_email") },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "last_order_at", label: t("reports_last_order"), type: "datetime" },
        { key: "created_at", label: t("reports_created"), type: "datetime" },
      ],
      rows,
    }],
  });
};

const getOrderStatusReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("date", type, from, to);
  const rows = await query(conn, `
    SELECT
      status,
      payment_status,
      COUNT(*) AS orders
    FROM orders
    WHERE tenant_id = ? AND ${filter}
    GROUP BY status, payment_status
    ORDER BY status ASC, payment_status ASC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "order-status",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_completed"), value: rows.filter((row) => row.status === "completed").reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_cancelled"), value: rows.filter((row) => row.status === "cancelled").reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_pending_payment"), value: rows.filter((row) => row.payment_status === "pending").reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
    ],
    tables: [{
      title: t("reports_order_status"),
      columns: [
        { key: "status", label: t("reports_status") },
        { key: "payment_status", label: t("reports_payment") },
        { key: "orders", label: t("reports_orders"), type: "number" },
      ],
      rows,
    }],
  });
};

const getKitchenPerformanceReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      oi.status,
      COUNT(*) AS item_lines,
      COALESCE(SUM(oi.quantity), 0) AS quantity,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS sales_value
    FROM order_items oi
    WHERE oi.tenant_id = ? AND ${filter}
    GROUP BY oi.status
    ORDER BY item_lines DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "kitchen-performance",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_item_lines"), value: rows.reduce((sum, row) => sum + money(row.item_lines), 0), type: "number" },
      { label: t("reports_quantity"), value: rows.reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
      { label: t("reports_completed_qty"), value: rows.filter((row) => row.status === "completed" || row.status === "delivered").reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
      { label: t("reports_cancelled_qty"), value: rows.filter((row) => row.status === "cancelled").reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
    ],
    tables: [{
      title: t("reports_kitchen_item_status"),
      columns: [
        { key: "status", label: t("reports_status") },
        { key: "item_lines", label: t("reports_lines"), type: "number" },
        { key: "quantity", label: t("reports_quantity"), type: "number" },
        { key: "sales_value", label: t("reports_sales_value"), type: "money" },
      ],
      rows,
    }],
  });
};

const getTokenReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      o.token_no,
      o.id AS order_id,
      o.date,
      COALESCE(o.delivery_type, '-') AS order_type,
      o.status,
      o.payment_status,
      COALESCE(c.name, o.customer_id, 'Walk-in') AS customer,
      COALESCE(i.total, 0) AS total
    FROM orders o
    LEFT JOIN customers c ON c.phone = o.customer_id AND c.tenant_id = o.tenant_id
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND o.token_no IS NOT NULL AND ${filter}
    ORDER BY o.date DESC, o.token_no DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "token-report",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_tokens"), value: rows.length, type: "number" },
      { label: t("reports_paid_tokens"), value: rows.filter((row) => row.payment_status === "paid").length, type: "number" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_token_report"),
      columns: [
        { key: "token_no", label: t("reports_token") },
        { key: "order_id", label: t("reports_order") },
        { key: "date", label: t("reports_date"), type: "datetime" },
        { key: "order_type", label: t("reports_order_type") },
        { key: "customer", label: t("reports_customer") },
        { key: "status", label: t("reports_status") },
        { key: "payment_status", label: t("reports_payment") },
        { key: "total", label: t("reports_total"), type: "money" },
      ],
      rows,
    }],
  });
};

const getQrOrderReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("qo.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      qo.id AS order_id,
      qo.date,
      COALESCE(qo.delivery_type, '-') AS order_type,
      COALESCE(st.table_title, '-') AS table_title,
      COALESCE(c.name, qo.customer_id, 'Walk-in') AS customer,
      qo.status,
      qo.payment_status,
      COUNT(qoi.id) AS item_lines,
      COALESCE(SUM(qoi.quantity), 0) AS quantity,
      COALESCE(SUM(qoi.price * qoi.quantity), 0) AS estimated_total
    FROM qr_orders qo
    LEFT JOIN qr_order_items qoi ON qoi.order_id = qo.id AND qoi.tenant_id = qo.tenant_id
    LEFT JOIN customers c ON c.phone = qo.customer_id AND c.tenant_id = qo.tenant_id
    LEFT JOIN store_tables st ON st.id = qo.table_id AND st.tenant_id = qo.tenant_id
    WHERE qo.tenant_id = ? AND ${filter}
    GROUP BY qo.id, qo.date, qo.delivery_type, st.table_title, c.name, qo.customer_id, qo.status, qo.payment_status
    ORDER BY qo.date DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "qr-order-report",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_qr_orders"), value: rows.length, type: "number" },
      { label: t("reports_quantity"), value: rows.reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
      { label: t("reports_estimated_total"), value: rows.reduce((sum, row) => sum + money(row.estimated_total), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_qr_orders"),
      columns: [
        { key: "order_id", label: t("reports_order") },
        { key: "date", label: t("reports_date"), type: "datetime" },
        { key: "order_type", label: t("reports_order_type") },
        { key: "table_title", label: t("reports_table") },
        { key: "customer", label: t("reports_customer") },
        { key: "status", label: t("reports_status") },
        { key: "payment_status", label: t("reports_payment") },
        { key: "quantity", label: t("reports_qty"), type: "number" },
        { key: "estimated_total", label: t("reports_estimated_total"), type: "money" },
      ],
      rows,
    }],
  });
};

const getTableTurnoverReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(st.table_title, 'No table') AS table_title,
      COALESCE(st.floor, '-') AS floor,
      COALESCE(st.seating_capacity, 0) AS seating_capacity,
      COUNT(o.id) AS orders,
      COUNT(DISTINCT DATE(o.date)) AS active_days,
      COALESCE(SUM(i.total), 0) AS revenue,
      COALESCE(AVG(i.total), 0) AS average_order_value
    FROM orders o
    LEFT JOIN store_tables st ON st.id = o.table_id AND st.tenant_id = o.tenant_id
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND ${filter}
    GROUP BY st.id, st.table_title, st.floor, st.seating_capacity
    ORDER BY orders DESC, revenue DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "table-turnover",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_table_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_tables"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_table_turnover"),
      columns: [
        { key: "table_title", label: t("reports_table") },
        { key: "floor", label: t("reports_floor") },
        { key: "seating_capacity", label: t("reports_seats"), type: "number" },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "active_days", label: t("reports_active_days"), type: "number" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "average_order_value", label: t("reports_aov"), type: "money" },
      ],
      rows,
    }],
  });
};

const getStaffCreatedOrdersReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("o.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(o.created_by, 'Unassigned') AS username,
      COALESCE(u.name, o.created_by, 'Unassigned') AS staff_name,
      COUNT(o.id) AS orders,
      SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) AS completed_orders,
      SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
      SUM(CASE WHEN o.payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
      COALESCE(SUM(i.total), 0) AS revenue,
      COALESCE(AVG(i.total), 0) AS average_order_value
    FROM orders o
    LEFT JOIN users u ON u.username = o.created_by AND u.tenant_id = o.tenant_id
    LEFT JOIN invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = ? AND ${filter}
    GROUP BY o.created_by, u.name
    ORDER BY orders DESC, revenue DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "staff-created-orders",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_staff"), value: rows.length, type: "number" },
      { label: t("reports_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_paid_orders"), value: rows.reduce((sum, row) => sum + money(row.paid_orders), 0), type: "number" },
    ],
    tables: [{
      title: t("reports_staff_created_orders"),
      columns: [
        { key: "staff_name", label: t("reports_staff") },
        { key: "username", label: t("reports_username") },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "completed_orders", label: t("reports_completed"), type: "number" },
        { key: "cancelled_orders", label: t("reports_cancelled"), type: "number" },
        { key: "paid_orders", label: t("reports_paid"), type: "number" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "average_order_value", label: t("reports_aov"), type: "money" },
      ],
      rows,
    }],
  });
};

const getInventoryRows = async (conn, tenantId, where = "", params = []) => query(conn, `
  SELECT
    id AS item_id,
    title,
    COALESCE(quantity, 0) AS quantity,
    unit,
    COALESCE(min_quantity_threshold, 0) AS min_quantity_threshold,
    COALESCE(status, CASE
      WHEN COALESCE(quantity, 0) <= 0 THEN 'out'
      WHEN COALESCE(quantity, 0) <= COALESCE(min_quantity_threshold, 0) THEN 'low'
      ELSE 'in'
    END) AS status,
    GREATEST(COALESCE(min_quantity_threshold, 0) - COALESCE(quantity, 0), 0) AS reorder_quantity,
    updated_at
  FROM inventory_items
  WHERE tenant_id = ? ${where}
  ORDER BY status ASC, title ASC
`, [tenantId, ...params]);

const getInventorySummaryReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await getInventoryRows(conn, tenantId);

  return makeReport({ t,
    reportId: "inventory-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_inventory_items"), value: rows.length, type: "number" },
      { label: t("reports_low_stock"), value: rows.filter((row) => row.status === "low").length, type: "number" },
      { label: t("reports_out_of_stock"), value: rows.filter((row) => row.status === "out" || money(row.quantity) <= 0).length, type: "number" },
      { label: t("reports_units_tracked"), value: new Set(rows.map((row) => row.unit).filter(Boolean)).size, type: "number" },
    ],
    tables: [{
      title: t("reports_inventory_summary"),
      columns: [
        { key: "title", label: t("reports_item") },
        { key: "quantity", label: t("reports_quantity"), type: "quantity" },
        { key: "unit", label: t("reports_unit") },
        { key: "min_quantity_threshold", label: t("reports_minimum"), type: "quantity" },
        { key: "reorder_quantity", label: t("reports_reorder_qty"), type: "quantity" },
        { key: "status", label: t("reports_status") },
        { key: "updated_at", label: t("reports_updated"), type: "datetime" },
      ],
      rows,
    }],
  });
};

const getLowStockReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await getInventoryRows(conn, tenantId, "AND COALESCE(quantity, 0) <= COALESCE(min_quantity_threshold, 0)");

  return makeReport({ t,
    reportId: "low-stock",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_low_stock_items"), value: rows.length, type: "number" },
      { label: t("reports_out_of_stock"), value: rows.filter((row) => money(row.quantity) <= 0).length, type: "number" },
      { label: t("reports_reorder_units"), value: rows.reduce((sum, row) => sum + money(row.reorder_quantity), 0), type: "quantity" },
    ],
    tables: [{
      title: t("reports_low_stock"),
      columns: [
        { key: "title", label: t("reports_item") },
        { key: "quantity", label: t("reports_quantity"), type: "quantity" },
        { key: "unit", label: t("reports_unit") },
        { key: "min_quantity_threshold", label: t("reports_minimum"), type: "quantity" },
        { key: "reorder_quantity", label: t("reports_reorder_qty"), type: "quantity" },
        { key: "status", label: t("reports_status") },
      ],
      rows,
    }],
  });
};

const getStockMovementsReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("il.created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      il.id AS movement_id,
      il.created_at,
      ii.title AS item,
      ii.unit,
      il.type AS movement_type,
      COALESCE(il.quantity_change, 0) AS quantity_change,
      COALESCE(il.previous_quantity, 0) AS previous_quantity,
      COALESCE(il.new_quantity, 0) AS new_quantity,
      COALESCE(u.name, il.created_by, '-') AS staff,
      COALESCE(il.note, '') AS note
    FROM inventory_logs il
    INNER JOIN inventory_items ii ON ii.id = il.inventory_item_id AND ii.tenant_id = il.tenant_id
    LEFT JOIN users u ON u.username = il.created_by AND u.tenant_id = il.tenant_id
    WHERE il.tenant_id = ? AND ${filter}
    ORDER BY il.created_at DESC, il.id DESC
    LIMIT 1000
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "stock-movements",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_movements"), value: rows.length, type: "number" },
      { label: t("reports_stock_in"), value: rows.filter((row) => row.movement_type === "IN").reduce((sum, row) => sum + money(row.quantity_change), 0), type: "quantity" },
      { label: t("reports_stock_out"), value: rows.filter((row) => row.movement_type === "OUT").reduce((sum, row) => sum + money(row.quantity_change), 0), type: "quantity" },
      { label: t("reports_wastage"), value: rows.filter((row) => row.movement_type === "WASTAGE").reduce((sum, row) => sum + money(row.quantity_change), 0), type: "quantity" },
    ],
    tables: [{
      title: t("reports_stock_movements"),
      columns: [
        { key: "created_at", label: t("reports_date"), type: "datetime" },
        { key: "item", label: t("reports_item") },
        { key: "movement_type", label: t("reports_type") },
        { key: "quantity_change", label: t("reports_change"), type: "quantity" },
        { key: "previous_quantity", label: t("reports_previous"), type: "quantity" },
        { key: "new_quantity", label: t("reports_new"), type: "quantity" },
        { key: "unit", label: t("reports_unit") },
        { key: "staff", label: t("reports_staff") },
        { key: "note", label: t("reports_note") },
      ],
      rows,
    }],
  });
};

const getWastageReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("il.created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      ii.title AS item,
      ii.unit,
      COUNT(il.id) AS movement_count,
      COALESCE(SUM(il.quantity_change), 0) AS wasted_quantity,
      MAX(il.created_at) AS last_wasted_at,
      COALESCE(MAX(il.note), '') AS last_note
    FROM inventory_logs il
    INNER JOIN inventory_items ii ON ii.id = il.inventory_item_id AND ii.tenant_id = il.tenant_id
    WHERE il.tenant_id = ? AND il.type = 'WASTAGE' AND ${filter}
    GROUP BY ii.id, ii.title, ii.unit
    ORDER BY wasted_quantity DESC, movement_count DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "wastage",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_wastage_items"), value: rows.length, type: "number" },
      { label: t("reports_wastage_quantity"), value: rows.reduce((sum, row) => sum + money(row.wasted_quantity), 0), type: "quantity" },
      { label: t("reports_movements"), value: rows.reduce((sum, row) => sum + money(row.movement_count), 0), type: "number" },
    ],
    tables: [{
      title: t("reports_wastage"),
      columns: [
        { key: "item", label: t("reports_item") },
        { key: "wasted_quantity", label: t("reports_wasted_qty"), type: "quantity" },
        { key: "unit", label: t("reports_unit") },
        { key: "movement_count", label: t("reports_movements"), type: "number" },
        { key: "last_wasted_at", label: t("reports_last_wasted"), type: "datetime" },
        { key: "last_note", label: t("reports_last_note") },
      ],
      rows,
    }],
  });
};

const getRecipeUsageReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      ii.title AS inventory_item,
      ii.unit,
      COALESCE(mi.title, 'Deleted item') AS menu_item,
      COALESCE(miv.title, CASE WHEN mir.variant_id = 0 THEN 'Base item' ELSE 'Variant #' END) AS variant,
      COALESCE(mia.title, CASE WHEN mir.addon_id = 0 THEN '-' ELSE 'Addon #' END) AS addon,
      COALESCE(mir.quantity, 0) AS recipe_quantity,
      COALESCE(SUM(oi.quantity), 0) AS sold_quantity,
      COALESCE(SUM(oi.quantity * mir.quantity), 0) AS estimated_usage
    FROM menu_item_recipes mir
    INNER JOIN inventory_items ii ON ii.id = mir.inventory_item_id AND ii.tenant_id = mir.tenant_id
    LEFT JOIN menu_items mi ON mi.id = mir.menu_item_id AND mi.tenant_id = mir.tenant_id
    LEFT JOIN menu_item_variants miv ON miv.id = mir.variant_id AND miv.item_id = mir.menu_item_id AND miv.tenant_id = mir.tenant_id
    LEFT JOIN menu_item_addons mia ON mia.id = mir.addon_id AND mia.item_id = mir.menu_item_id AND mia.tenant_id = mir.tenant_id
    LEFT JOIN order_items oi ON oi.item_id = mir.menu_item_id
      AND oi.tenant_id = mir.tenant_id
      AND oi.status <> 'cancelled'
      AND (mir.variant_id = 0 OR COALESCE(oi.variant_id, 0) = mir.variant_id)
      AND mir.addon_id = 0
      AND ${filter}
    WHERE mir.tenant_id = ?
    GROUP BY ii.id, ii.title, ii.unit, mi.id, mi.title, miv.id, miv.title, mia.id, mia.title, mir.variant_id, mir.addon_id, mir.quantity
    ORDER BY estimated_usage DESC, inventory_item ASC
  `, [...params, tenantId]);

  return makeReport({ t,
    reportId: "recipe-usage",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_recipe_lines"), value: rows.length, type: "number" },
      { label: t("reports_estimated_usage"), value: rows.reduce((sum, row) => sum + money(row.estimated_usage), 0), type: "quantity" },
      { label: t("reports_items_sold"), value: rows.reduce((sum, row) => sum + money(row.sold_quantity), 0), type: "number" },
    ],
    tables: [{
      title: t("reports_recipe_usage_estimate"),
      columns: [
        { key: "inventory_item", label: t("reports_inventory_item") },
        { key: "menu_item", label: t("reports_menu_item") },
        { key: "variant", label: t("reports_variant") },
        { key: "addon", label: t("reports_addon") },
        { key: "recipe_quantity", label: t("reports_recipe_qty"), type: "quantity" },
        { key: "sold_quantity", label: t("reports_sold_qty"), type: "number" },
        { key: "estimated_usage", label: t("reports_estimated_usage"), type: "quantity" },
        { key: "unit", label: t("reports_unit") },
      ],
      rows,
    }],
  });
};

const getStockReorderReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const rows = await getInventoryRows(conn, tenantId, "AND COALESCE(quantity, 0) <= COALESCE(min_quantity_threshold, 0)");

  return makeReport({ t,
    reportId: "stock-reorder",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_reorder_items"), value: rows.length, type: "number" },
      { label: t("reports_suggested_quantity"), value: rows.reduce((sum, row) => sum + money(row.reorder_quantity), 0), type: "quantity" },
      { label: t("reports_out_of_stock"), value: rows.filter((row) => money(row.quantity) <= 0).length, type: "number" },
    ],
    tables: [{
      title: t("reports_reorder_list"),
      columns: [
        { key: "title", label: t("reports_item") },
        { key: "quantity", label: t("reports_current"), type: "quantity" },
        { key: "min_quantity_threshold", label: t("reports_minimum"), type: "quantity" },
        { key: "reorder_quantity", label: t("reports_suggested_qty"), type: "quantity" },
        { key: "unit", label: t("reports_unit") },
        { key: "status", label: t("reports_status") },
      ],
      rows,
    }],
  });
};

const getTaxSummaryReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS invoices,
      COALESCE(SUM(sub_total), 0) AS taxable_sales,
      COALESCE(SUM(tax_total), 0) AS tax_total,
      COALESCE(SUM(total), 0) AS revenue
    FROM invoices
    WHERE tenant_id = ? AND ${filter}
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `, [tenantId, ...params]);

  const taxSetupRows = await query(conn, `
    SELECT
      title,
      COALESCE(rate, 0) AS rate,
      type
    FROM taxes
    WHERE tenant_id = ?
    ORDER BY title ASC
  `, [tenantId]);

  return makeReport({ t,
    reportId: "tax-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_tax_collected"), value: rows.reduce((sum, row) => sum + money(row.tax_total), 0), type: "money" },
      { label: t("reports_taxable_sales"), value: rows.reduce((sum, row) => sum + money(row.taxable_sales), 0), type: "money" },
      { label: t("reports_invoices"), value: rows.reduce((sum, row) => sum + money(row.invoices), 0), type: "number" },
      { label: t("reports_tax_rules"), value: taxSetupRows.length, type: "number" },
    ],
    tables: [
      {
        title: t("reports_tax_by_date"),
        columns: [
          { key: "date", label: t("reports_date"), type: "date" },
          { key: "invoices", label: t("reports_invoices"), type: "number" },
          { key: "taxable_sales", label: t("reports_taxable_sales"), type: "money" },
          { key: "tax_total", label: t("reports_tax"), type: "money" },
          { key: "revenue", label: t("reports_revenue"), type: "money" },
        ],
        rows,
      },
      {
        title: t("reports_tax_setup"),
        columns: [
          { key: "title", label: t("reports_tax") },
          { key: "rate", label: t("reports_rate"), type: "number" },
          { key: "type", label: t("reports_type") },
        ],
        rows: taxSetupRows,
      },
    ],
    charts: [{ type: "line", title: t("reports_tax_trend"), data: [...rows].reverse() }],
  });
};

const getTaxByItemReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("oi.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(mi.title, 'Deleted item') AS item,
      COALESCE(c.title, 'Uncategorized') AS category,
      COALESCE(t.title, 'No tax') AS tax,
      COALESCE(t.rate, 0) AS tax_rate,
      COALESCE(t.type, 'other') AS tax_type,
      COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS item_sales,
      COALESCE(SUM(CASE
        WHEN t.type = 'inclusive' AND COALESCE(t.rate, 0) > 0 THEN (oi.price * oi.quantity) - ((oi.price * oi.quantity) / (1 + (t.rate / 100)))
        WHEN t.type = 'exclusive' THEN (oi.price * oi.quantity) * (t.rate / 100)
        ELSE 0
      END), 0) AS estimated_tax
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id AND mi.tenant_id = oi.tenant_id
    LEFT JOIN categories c ON c.id = mi.category AND c.tenant_id = mi.tenant_id
    LEFT JOIN taxes t ON t.id = mi.tax_id AND t.tenant_id = mi.tenant_id
    WHERE oi.tenant_id = ? AND oi.status <> 'cancelled' AND ${filter}
    GROUP BY mi.id, mi.title, c.title, t.id, t.title, t.rate, t.type
    ORDER BY estimated_tax DESC, item_sales DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "tax-by-item",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_estimated_tax"), value: rows.reduce((sum, row) => sum + money(row.estimated_tax), 0), type: "money" },
      { label: t("reports_item_sales"), value: rows.reduce((sum, row) => sum + money(row.item_sales), 0), type: "money" },
      { label: t("reports_items"), value: rows.length, type: "number" },
    ],
    tables: [{
      title: t("reports_tax_by_item"),
      columns: [
        { key: "item", label: t("reports_item") },
        { key: "category", label: t("reports_category") },
        { key: "tax", label: t("reports_tax") },
        { key: "tax_rate", label: t("reports_rate"), type: "number" },
        { key: "tax_type", label: t("reports_type") },
        { key: "quantity_sold", label: t("reports_qty"), type: "number" },
        { key: "item_sales", label: t("reports_item_sales"), type: "money" },
        { key: "estimated_tax", label: t("reports_estimated_tax"), type: "money" },
      ],
      rows,
    }],
  });
};

const getServiceChargeReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS invoices,
      COALESCE(SUM(sub_total), 0) AS net_sales,
      COALESCE(SUM(service_charge_total), 0) AS service_charge_total,
      COALESCE(SUM(total), 0) AS revenue
    FROM invoices
    WHERE tenant_id = ? AND ${filter}
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "service-charge",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_service_charge"), value: rows.reduce((sum, row) => sum + money(row.service_charge_total), 0), type: "money" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_invoices"), value: rows.reduce((sum, row) => sum + money(row.invoices), 0), type: "number" },
    ],
    tables: [{
      title: t("reports_service_charge_by_date"),
      columns: [
        { key: "date", label: t("reports_date"), type: "date" },
        { key: "invoices", label: t("reports_invoices"), type: "number" },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "service_charge_total", label: t("reports_service_charge"), type: "money" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: t("reports_service_charge_trend"), data: [...rows].reverse() }],
  });
};

const getDailyCloseReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const invoiceFilter = getFilterCondition("created_at", type, from, to);
  const orderFilter = getFilterCondition("date", type, from, to);
  const paymentFilter = getFilterCondition("i.created_at", type, from, to);

  const [invoiceRows, orderRows, paymentRows] = await Promise.all([
    query(conn, `
      SELECT
        DATE(created_at) AS date,
        COUNT(*) AS invoices,
        COALESCE(SUM(sub_total), 0) AS net_sales,
        COALESCE(SUM(tax_total), 0) AS tax_total,
        COALESCE(SUM(service_charge_total), 0) AS service_charge_total,
        COALESCE(SUM(total), 0) AS revenue
      FROM invoices
      WHERE tenant_id = ? AND ${invoiceFilter.filter}
      GROUP BY DATE(created_at)
    `, [tenantId, ...invoiceFilter.params]),
    query(conn, `
      SELECT
        DATE(date) AS date,
        COUNT(*) AS orders,
        SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END) AS unpaid_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders
      FROM orders
      WHERE tenant_id = ? AND ${orderFilter.filter}
      GROUP BY DATE(date)
    `, [tenantId, ...orderFilter.params]),
    query(conn, `
      SELECT
        DATE(i.created_at) AS date,
        COALESCE(pt.title, 'Unassigned') AS payment_type,
        COALESCE(SUM(i.total), 0) AS total
      FROM invoices i
      LEFT JOIN payment_types pt ON pt.id = i.payment_type_id AND pt.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND ${paymentFilter.filter}
      GROUP BY DATE(i.created_at), i.payment_type_id, pt.title
    `, [tenantId, ...paymentFilter.params]),
  ]);

  const rowsByDate = new Map();
  invoiceRows.forEach((row) => rowsByDate.set(String(row.date), { ...row, orders: 0, unpaid_orders: 0, cancelled_orders: 0, payment_mix: "" }));
  orderRows.forEach((row) => {
    const key = String(row.date);
    rowsByDate.set(key, { ...(rowsByDate.get(key) || { date: row.date, invoices: 0, net_sales: 0, tax_total: 0, service_charge_total: 0, revenue: 0 }), ...row });
  });
  paymentRows.forEach((row) => {
    const key = String(row.date);
    const current = rowsByDate.get(key) || { date: row.date, invoices: 0, net_sales: 0, tax_total: 0, service_charge_total: 0, revenue: 0, orders: 0, unpaid_orders: 0, cancelled_orders: 0, payment_mix: "" };
    current.payment_mix = [current.payment_mix, `${row.payment_type}: ${money(row.total).toFixed(2)}`].filter(Boolean).join(" | ");
    rowsByDate.set(key, current);
  });

  const rows = [...rowsByDate.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return makeReport({ t,
    reportId: "daily-close",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: t("reports_orders"), value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: t("reports_tax"), value: rows.reduce((sum, row) => sum + money(row.tax_total), 0), type: "money" },
      { label: t("reports_service_charge"), value: rows.reduce((sum, row) => sum + money(row.service_charge_total), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_daily_close"),
      columns: [
        { key: "date", label: t("reports_date"), type: "date" },
        { key: "orders", label: t("reports_orders"), type: "number" },
        { key: "invoices", label: t("reports_invoices"), type: "number" },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "tax_total", label: t("reports_tax"), type: "money" },
        { key: "service_charge_total", label: t("reports_service_charge"), type: "money" },
        { key: "revenue", label: t("reports_revenue"), type: "money" },
        { key: "unpaid_orders", label: t("reports_unpaid"), type: "number" },
        { key: "cancelled_orders", label: t("reports_cancelled"), type: "number" },
        { key: "payment_mix", label: t("reports_payment_mix") },
      ],
      rows,
    }],
  });
};

const getInvoiceRegisterReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("i.created_at", type, from, to);
  const rows = await query(conn, `
    SELECT
      i.id AS invoice_id,
      i.created_at,
      COALESCE(pt.title, 'Unassigned') AS payment_type,
      COALESCE(u.name, i.created_by, '-') AS staff,
      COALESCE(i.sub_total, 0) AS net_sales,
      COALESCE(i.tax_total, 0) AS tax_total,
      COALESCE(i.service_charge_total, 0) AS service_charge_total,
      COALESCE(i.total, 0) AS total
    FROM invoices i
    LEFT JOIN payment_types pt ON pt.id = i.payment_type_id AND pt.tenant_id = i.tenant_id
    LEFT JOIN users u ON u.username = i.created_by AND u.tenant_id = i.tenant_id
    WHERE i.tenant_id = ? AND ${filter}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 2000
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "invoice-register",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_invoices"), value: rows.length, type: "number" },
      { label: t("reports_revenue"), value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
      { label: t("reports_tax"), value: rows.reduce((sum, row) => sum + money(row.tax_total), 0), type: "money" },
      { label: t("reports_service_charge"), value: rows.reduce((sum, row) => sum + money(row.service_charge_total), 0), type: "money" },
    ],
    tables: [{
      title: t("reports_invoice_register"),
      columns: [
        { key: "invoice_id", label: t("reports_invoice") },
        { key: "created_at", label: t("reports_created"), type: "datetime" },
        { key: "payment_type", label: t("reports_payment") },
        { key: "staff", label: t("reports_staff") },
        { key: "net_sales", label: t("reports_net_sales"), type: "money" },
        { key: "tax_total", label: t("reports_tax"), type: "money" },
        { key: "service_charge_total", label: t("reports_service"), type: "money" },
        { key: "total", label: t("reports_total"), type: "money" },
      ],
      rows,
    }],
  });
};

const getReservationSummaryReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("r.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      COALESCE(r.status, 'Unassigned') AS status,
      COALESCE(st.table_title, '-') AS table_title,
      COUNT(r.id) AS reservations,
      COALESCE(SUM(r.people_count), 0) AS guests,
      MIN(r.date) AS first_reservation,
      MAX(r.date) AS last_reservation
    FROM reservations r
    LEFT JOIN store_tables st ON st.id = r.table_id AND st.tenant_id = r.tenant_id
    WHERE r.tenant_id = ? AND ${filter}
    GROUP BY COALESCE(r.status, 'Unassigned'), st.id, st.table_title
    ORDER BY reservations DESC, guests DESC
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "reservation-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_reservations"), value: rows.reduce((sum, row) => sum + money(row.reservations), 0), type: "number" },
      { label: t("reports_guests"), value: rows.reduce((sum, row) => sum + money(row.guests), 0), type: "number" },
      { label: t("reports_statuses"), value: new Set(rows.map((row) => row.status)).size, type: "number" },
    ],
    tables: [{
      title: t("reports_reservation_summary"),
      columns: [
        { key: "status", label: t("reports_status") },
        { key: "table_title", label: t("reports_table") },
        { key: "reservations", label: t("reports_reservations"), type: "number" },
        { key: "guests", label: t("reports_guests"), type: "number" },
        { key: "first_reservation", label: t("reports_first"), type: "datetime" },
        { key: "last_reservation", label: t("reports_last"), type: "datetime" },
      ],
      rows,
    }],
  });
};

const getUpcomingReservationsReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("r.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      r.id AS reservation_id,
      r.date,
      COALESCE(c.name, r.customer_id, 'Walk-in') AS customer,
      r.customer_id AS phone,
      COALESCE(st.table_title, '-') AS table_title,
      COALESCE(r.people_count, 0) AS people_count,
      COALESCE(r.status, '-') AS status,
      COALESCE(r.notes, '') AS notes,
      r.unique_code
    FROM reservations r
    LEFT JOIN customers c ON c.phone = r.customer_id AND c.tenant_id = r.tenant_id
    LEFT JOIN store_tables st ON st.id = r.table_id AND st.tenant_id = r.tenant_id
    WHERE r.tenant_id = ? AND r.date >= NOW() AND ${filter}
    ORDER BY r.date ASC
    LIMIT 500
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "upcoming-reservations",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_upcoming"), value: rows.length, type: "number" },
      { label: t("reports_guests"), value: rows.reduce((sum, row) => sum + money(row.people_count), 0), type: "number" },
      { label: t("reports_tables"), value: new Set(rows.map((row) => row.table_title).filter((value) => value && value !== "-")).size, type: "number" },
    ],
    tables: [{
      title: t("reports_upcoming_reservations"),
      columns: [
        { key: "date", label: t("reports_date"), type: "datetime" },
        { key: "customer", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "table_title", label: t("reports_table") },
        { key: "people_count", label: t("reports_guests"), type: "number" },
        { key: "status", label: t("reports_status") },
        { key: "unique_code", label: t("reports_code") },
        { key: "notes", label: t("reports_notes") },
      ],
      rows,
    }],
  });
};

const getReservationNoShowReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("r.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      r.id AS reservation_id,
      r.date,
      COALESCE(c.name, r.customer_id, 'Walk-in') AS customer,
      r.customer_id AS phone,
      COALESCE(st.table_title, '-') AS table_title,
      COALESCE(r.people_count, 0) AS people_count,
      COALESCE(r.status, '-') AS status,
      COALESCE(r.notes, '') AS notes
    FROM reservations r
    LEFT JOIN customers c ON c.phone = r.customer_id AND c.tenant_id = r.tenant_id
    LEFT JOIN store_tables st ON st.id = r.table_id AND st.tenant_id = r.tenant_id
    WHERE r.tenant_id = ?
      AND r.date < NOW()
      AND ${filter}
      AND (
        LOWER(COALESCE(r.status, '')) IN ('no-show', 'no show', 'noshow')
        OR LOWER(COALESCE(r.status, '')) NOT IN ('completed', 'seated', 'arrived', 'checked-in', 'checked in', 'cancelled')
      )
    ORDER BY r.date DESC
    LIMIT 500
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "reservation-no-show",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_possible_no_shows"), value: rows.length, type: "number" },
      { label: t("reports_guests"), value: rows.reduce((sum, row) => sum + money(row.people_count), 0), type: "number" },
      { label: t("reports_explicit_no_show"), value: rows.filter((row) => ["no-show", "no show", "noshow"].includes(String(row.status || "").toLowerCase())).length, type: "number" },
    ],
    tables: [{
      title: t("reports_possible_reservation_no_shows"),
      columns: [
        { key: "date", label: t("reports_date"), type: "datetime" },
        { key: "customer", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "table_title", label: t("reports_table") },
        { key: "people_count", label: t("reports_guests"), type: "number" },
        { key: "status", label: t("reports_status") },
        { key: "notes", label: t("reports_notes") },
      ],
      rows,
    }],
  });
};

const getFeedbackSummaryReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("f.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      DATE(f.date) AS date,
      COUNT(f.id) AS feedback_count,
      COALESCE(AVG(f.average_rating), 0) AS average_rating,
      COALESCE(AVG(f.food_quality_rating), 0) AS food_quality_rating,
      COALESCE(AVG(f.service_rating), 0) AS service_rating,
      COALESCE(AVG(f.staff_behavior_rating), 0) AS staff_behavior_rating,
      COALESCE(AVG(f.ambiance_rating), 0) AS ambiance_rating,
      COALESCE(AVG(f.recommend_rating), 0) AS recommend_rating
    FROM feedbacks f
    WHERE f.tenant_id = ? AND ${filter}
    GROUP BY DATE(f.date)
    ORDER BY date DESC
  `, [tenantId, ...params]);

  const totalFeedback = rows.reduce((sum, row) => sum + money(row.feedback_count), 0);
  const weightedAverage = (key) => totalFeedback ? rows.reduce((sum, row) => sum + money(row[key]) * money(row.feedback_count), 0) / totalFeedback : 0;

  return makeReport({ t,
    reportId: "feedback-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_feedback"), value: totalFeedback, type: "number" },
      { label: t("reports_average_rating"), value: weightedAverage("average_rating"), type: "number" },
      { label: t("reports_service"), value: weightedAverage("service_rating"), type: "number" },
      { label: t("reports_recommend"), value: weightedAverage("recommend_rating"), type: "number" },
    ],
    tables: [{
      title: t("reports_feedback_summary"),
      columns: [
        { key: "date", label: t("reports_date"), type: "date" },
        { key: "feedback_count", label: t("reports_feedback"), type: "number" },
        { key: "average_rating", label: t("reports_average"), type: "number" },
        { key: "food_quality_rating", label: t("reports_food"), type: "number" },
        { key: "service_rating", label: t("reports_service"), type: "number" },
        { key: "staff_behavior_rating", label: t("reports_staff"), type: "number" },
        { key: "ambiance_rating", label: t("reports_ambiance"), type: "number" },
        { key: "recommend_rating", label: t("reports_recommend"), type: "number" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: t("reports_feedback_trend"), data: [...rows].reverse() }],
  });
};

const getNegativeFeedbackReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("f.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      f.id AS feedback_id,
      f.date,
      f.invoice_id,
      COALESCE(c.name, f.phone, 'Guest') AS customer,
      f.phone,
      COALESCE(f.average_rating, 0) AS average_rating,
      COALESCE(f.food_quality_rating, 0) AS food_quality_rating,
      COALESCE(f.service_rating, 0) AS service_rating,
      COALESCE(f.staff_behavior_rating, 0) AS staff_behavior_rating,
      COALESCE(f.ambiance_rating, 0) AS ambiance_rating,
      COALESCE(f.recommend_rating, 0) AS recommend_rating,
      COALESCE(f.remarks, '') AS remarks
    FROM feedbacks f
    LEFT JOIN customers c ON c.phone = f.phone AND c.tenant_id = f.tenant_id
    WHERE f.tenant_id = ?
      AND ${filter}
      AND (
        COALESCE(f.average_rating, 0) <= 3
        OR COALESCE(f.service_rating, 0) <= 3
        OR COALESCE(f.food_quality_rating, 0) <= 3
        OR COALESCE(f.recommend_rating, 0) <= 3
      )
    ORDER BY f.date DESC
    LIMIT 500
  `, [tenantId, ...params]);

  return makeReport({ t,
    reportId: "negative-feedback",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_negative_feedback"), value: rows.length, type: "number" },
      { label: t("reports_avg_rating"), value: rows.length ? rows.reduce((sum, row) => sum + money(row.average_rating), 0) / rows.length : 0, type: "number" },
      { label: t("reports_with_remarks"), value: rows.filter((row) => row.remarks).length, type: "number" },
    ],
    tables: [{
      title: t("reports_negative_feedback"),
      columns: [
        { key: "date", label: t("reports_date"), type: "datetime" },
        { key: "invoice_id", label: t("reports_invoice") },
        { key: "customer", label: t("reports_customer") },
        { key: "phone", label: t("reports_phone") },
        { key: "average_rating", label: t("reports_average"), type: "number" },
        { key: "food_quality_rating", label: t("reports_food"), type: "number" },
        { key: "service_rating", label: t("reports_service"), type: "number" },
        { key: "recommend_rating", label: t("reports_recommend"), type: "number" },
        { key: "remarks", label: t("reports_remarks") },
      ],
      rows,
    }],
  });
};

const getRecommendationScoreReport = async (conn, type, from, to, tenantId, currency, store, t = (key) => key) => {
  const { filter, params } = getFilterCondition("f.date", type, from, to);
  const rows = await query(conn, `
    SELECT
      CASE
        WHEN COALESCE(f.recommend_rating, 0) >= 9 THEN 'Promoters'
        WHEN COALESCE(f.recommend_rating, 0) >= 7 THEN 'Passives'
        WHEN COALESCE(f.recommend_rating, 0) > 0 THEN 'Detractors'
        ELSE 'Unrated'
      END AS recommendation_group,
      COUNT(f.id) AS feedback_count,
      COALESCE(AVG(f.recommend_rating), 0) AS average_recommend_rating,
      COALESCE(AVG(f.average_rating), 0) AS average_rating
    FROM feedbacks f
    WHERE f.tenant_id = ? AND ${filter}
    GROUP BY recommendation_group
    ORDER BY average_recommend_rating DESC
  `, [tenantId, ...params]);

  const total = rows.reduce((sum, row) => sum + money(row.feedback_count), 0);
  const promoters = rows.filter((row) => row.recommendation_group === "Promoters").reduce((sum, row) => sum + money(row.feedback_count), 0);
  const detractors = rows.filter((row) => row.recommendation_group === "Detractors").reduce((sum, row) => sum + money(row.feedback_count), 0);
  const score = total ? ((promoters - detractors) / total) * 100 : 0;

  return makeReport({ t,
    reportId: "recommendation-score",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: t("reports_recommendation_score"), value: score, type: "number" },
      { label: t("reports_feedback"), value: total, type: "number" },
      { label: t("reports_promoters"), value: promoters, type: "number" },
      { label: t("reports_detractors"), value: detractors, type: "number" },
    ],
    tables: [{
      title: t("reports_recommendation_score"),
      columns: [
        { key: "recommendation_group", label: t("reports_group") },
        { key: "feedback_count", label: t("reports_feedback"), type: "number" },
        { key: "average_recommend_rating", label: t("reports_avg_recommend"), type: "number" },
        { key: "average_rating", label: t("reports_avg_rating"), type: "number" },
      ],
      rows,
    }],
    charts: [{ type: "pie", title: t("reports_recommendation_mix"), data: rows }],
  });
};

const REPORT_BUILDERS = {
  "sales-summary": getSalesSummaryReport,
  "gross-sales": getGrossSalesReport,
  "net-sales": getNetSalesReport,
  "sales-by-hour": (conn, type, from, to, tenantId, currency, store, t) => getGroupedInvoiceReport({
    conn,
    t,
    reportId: "sales-by-hour",
    type,
    from,
    to,
    tenantId,
    currency,
    store,
    groupSelect: "LPAD(HOUR(i.created_at), 2, '0') AS hour",
    groupBy: "LPAD(HOUR(i.created_at), 2, '0')",
    orderBy: "hour ASC",
    tableTitleKey: "reports_sales_by_hour",
    summaryLabelKey: "reports_revenue",
    columns: [
      { key: "hour", label: t("reports_hour") },
      { key: "invoices", label: t("reports_invoices"), type: "number" },
      { key: "net_sales", label: t("reports_net_sales"), type: "money" },
      { key: "revenue", label: t("reports_revenue"), type: "money" },
      { key: "average_order_value", label: t("reports_aov"), type: "money" },
    ],
  }),
  "sales-by-day": (conn, type, from, to, tenantId, currency, store, t) => getGroupedInvoiceReport({
    conn,
    t,
    reportId: "sales-by-day",
    type,
    from,
    to,
    tenantId,
    currency,
    store,
    groupSelect: "DATE(i.created_at) AS date",
    groupBy: "DATE(i.created_at)",
    orderBy: "date DESC",
    tableTitleKey: "reports_sales_by_day",
    summaryLabelKey: "reports_revenue",
    columns: [
      { key: "date", label: t("reports_date"), type: "date" },
      { key: "invoices", label: t("reports_invoices"), type: "number" },
      { key: "net_sales", label: t("reports_net_sales"), type: "money" },
      { key: "revenue", label: t("reports_revenue"), type: "money" },
      { key: "average_order_value", label: t("reports_aov"), type: "money" },
    ],
  }),
  "sales-by-month": (conn, type, from, to, tenantId, currency, store, t) => getGroupedInvoiceReport({
    conn,
    t,
    reportId: "sales-by-month",
    type,
    from,
    to,
    tenantId,
    currency,
    store,
    groupSelect: "DATE_FORMAT(i.created_at, '%Y-%m') AS month",
    groupBy: "DATE_FORMAT(i.created_at, '%Y-%m')",
    orderBy: "month DESC",
    tableTitleKey: "reports_sales_by_month",
    summaryLabelKey: "reports_revenue",
    columns: [
      { key: "month", label: t("reports_month") },
      { key: "invoices", label: t("reports_invoices"), type: "number" },
      { key: "net_sales", label: t("reports_net_sales"), type: "money" },
      { key: "revenue", label: t("reports_revenue"), type: "money" },
      { key: "average_order_value", label: t("reports_aov"), type: "money" },
    ],
  }),
  "sales-by-order-type": getSalesByOrderTypeReport,
  "sales-by-table": getSalesByTableReport,
  "invoice-detail": getInvoiceDetailReport,
  "voids-cancellations": getVoidsCancellationsReport,
  "average-order-value": getAverageOrderValueReport,
  "payment-summary": getPaymentSummaryReport,
  "cash-report": (conn, type, from, to, tenantId, currency, store, t) => getPaymentKeywordReport(conn, type, from, to, tenantId, currency, store, "cash-report", "reports_cash_report", ["cash"], t),
  "card-report": (conn, type, from, to, tenantId, currency, store, t) => getPaymentKeywordReport(conn, type, from, to, tenantId, currency, store, "card-report", "reports_card_report", ["card", "credit", "debit"], t),
  "unpaid-orders": getUnpaidOrdersReport,
  "payment-type-mix": getPaymentTypeMixReport,
  "top-selling-items": getTopSellingItemsReport,
  "low-selling-items": getLowSellingItemsReport,
  "item-sales": getItemSalesReport,
  "category-sales": getCategorySalesReport,
  "variant-sales": getVariantSalesReport,
  "addon-sales": getAddonSalesReport,
  "menu-price-audit": getMenuPriceAuditReport,
  "customer-summary": getCustomerSummaryReport,
  "new-customers": getNewCustomersReport,
  "returning-customers": getReturningCustomersReport,
  "top-customers": getTopCustomersReport,
  "customer-birthdays": getCustomerBirthdaysReport,
  "member-customers": getMemberCustomersReport,
  "order-status": getOrderStatusReport,
  "kitchen-performance": getKitchenPerformanceReport,
  "token-report": getTokenReport,
  "qr-order-report": getQrOrderReport,
  "table-turnover": getTableTurnoverReport,
  "staff-created-orders": getStaffCreatedOrdersReport,
  "inventory-summary": getInventorySummaryReport,
  "low-stock": getLowStockReport,
  "stock-movements": getStockMovementsReport,
  "wastage": getWastageReport,
  "recipe-usage": getRecipeUsageReport,
  "stock-reorder": getStockReorderReport,
  "tax-summary": getTaxSummaryReport,
  "tax-by-item": getTaxByItemReport,
  "service-charge": getServiceChargeReport,
  "daily-close": getDailyCloseReport,
  "invoice-register": getInvoiceRegisterReport,
  "reservation-summary": getReservationSummaryReport,
  "upcoming-reservations": getUpcomingReservationsReport,
  "reservation-no-show": getReservationNoShowReport,
  "feedback-summary": getFeedbackSummaryReport,
  "negative-feedback": getNegativeFeedbackReport,
  "recommendation-score": getRecommendationScoreReport,
};

exports.getReportByIdDB = async (reportId, type, from, to, tenantId, t = (key) => key) => {
  const builder = REPORT_BUILDERS[reportId];
  if (!builder) {
    const error = new Error("Unknown report");
    error.statusCode = 404;
    throw error;
  }

  const conn = await getMySqlPromiseConnection();
  try {
    const currency = await getCurrencyDB(tenantId);
    const storeSettings = await getStoreSettingDB(tenantId);
    const store = {
      name: storeSettings?.store_name || "Kadesh Food",
      address: storeSettings?.address || "",
      phone: storeSettings?.phone || "",
      email: storeSettings?.email || "",
      image: storeSettings?.store_image || null,
    };
    return builder(conn, type, from, to, tenantId, currency, store, t);
  } finally {
    conn.release();
  }
};

exports.getOrdersCountDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const { filter, params } = getFilterCondition("date", type, from, to);
    const rows = await query(conn, `SELECT COUNT(*) AS todays_orders FROM orders WHERE tenant_id = ? AND ${filter}`, [tenantId, ...params]);
    return rows[0].todays_orders;
  } finally {
    conn.release();
  }
};

exports.getNewCustomerCountDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const { filter, params } = getFilterCondition("created_at", type, from, to);
    const rows = await query(conn, `SELECT COUNT(*) AS new_customers_count FROM customers WHERE tenant_id = ? AND ${filter}`, [tenantId, ...params]);
    return rows[0].new_customers_count;
  } finally {
    conn.release();
  }
};

exports.getRepeatCustomerCountDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const { filter, params } = getFilterCondition("date", type, from, to);
    const rows = await query(conn, `SELECT COUNT(DISTINCT customer_id) AS todays_repeat_customers FROM orders WHERE tenant_id = ? AND ${filter} AND customer_type = 'CUSTOMER'`, [tenantId, ...params]);
    return rows[0].todays_repeat_customers;
  } finally {
    conn.release();
  }
};

exports.getAverageOrderValueDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const totals = await getInvoiceTotals(conn, type, from, to, tenantId);
    return totals.average_order_value;
  } finally {
    conn.release();
  }
};

exports.getTotalPaymentsByPaymentTypesDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const rows = await getPaymentRows(conn, type, from, to, tenantId);
    return rows.map((row) => ({ title: row.payment_type, total: row.total, invoice_count: row.invoice_count }));
  } finally {
    conn.release();
  }
};

exports.getTotalCustomersDB = async (tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const rows = await query(conn, "SELECT COUNT(*) AS total_customer FROM customers WHERE tenant_id = ?", [tenantId]);
    return rows[0].total_customer;
  } finally {
    conn.release();
  }
};

exports.getRevenueDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const totals = await getInvoiceTotals(conn, type, from, to, tenantId);
    return totals.total_sales;
  } finally {
    conn.release();
  }
};

exports.getTotalTaxDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const totals = await getInvoiceTotals(conn, type, from, to, tenantId);
    return totals.tax_total;
  } finally {
    conn.release();
  }
};

exports.getTotalServiceChargeDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const totals = await getInvoiceTotals(conn, type, from, to, tenantId);
    return totals.service_charge_total;
  } finally {
    conn.release();
  }
};

exports.getTotalNetRevenueDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const totals = await getInvoiceTotals(conn, type, from, to, tenantId);
    return totals.net_sales;
  } finally {
    conn.release();
  }
};

exports.getTopSellingItemsDB = async (type, from, to, tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const rows = await getTopSellingItems(conn, type, from, to, tenantId);
    return rows.map((row) => ({ ...row, orders_count: row.quantity_sold }));
  } finally {
    conn.release();
  }
};
