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

const makeReport = ({ reportId, currency, store, type, from, to, summary = [], tables = [], charts = [] }) => ({
  reportId,
  title: REPORT_TITLES[reportId],
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

const getSalesSummaryReport = async (conn, type, from, to, tenantId, currency, store) => {
  const [invoiceTotals, orderTotals, newCustomersRows, totalCustomersRows, topItems, payments] = await Promise.all([
    getInvoiceTotals(conn, type, from, to, tenantId),
    getOrderTotals(conn, type, from, to, tenantId),
    query(conn, `SELECT COUNT(*) AS new_customers FROM customers WHERE tenant_id = ? AND ${getFilterCondition("created_at", type, from, to).filter}`, [tenantId, ...getFilterCondition("created_at", type, from, to).params]),
    query(conn, "SELECT COUNT(*) AS total_customers FROM customers WHERE tenant_id = ?", [tenantId]),
    getTopSellingItems(conn, type, from, to, tenantId),
    getPaymentRows(conn, type, from, to, tenantId),
  ]);

  return makeReport({
    reportId: "sales-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Orders", value: orderTotals.orders_count || 0, type: "number" },
      { label: "Average Order Value", value: money(invoiceTotals.average_order_value), type: "money" },
      { label: "Total Customers", value: totalCustomersRows[0]?.total_customers || 0, type: "number" },
      { label: "New Customers", value: newCustomersRows[0]?.new_customers || 0, type: "number" },
      { label: "Repeat Customers", value: orderTotals.repeat_customers || 0, type: "number" },
      { label: "Revenue", value: money(invoiceTotals.total_sales), type: "money" },
      { label: "Net Sales", value: money(invoiceTotals.net_sales), type: "money" },
      { label: "Tax", value: money(invoiceTotals.tax_total), type: "money" },
      { label: "Service Charge", value: money(invoiceTotals.service_charge_total), type: "money" },
    ],
    tables: [
      {
        title: "Top Selling Items",
        columns: [
          { key: "title", label: "Item" },
          { key: "quantity_sold", label: "Qty", type: "number" },
          { key: "gross_sales", label: "Gross Sales", type: "money" },
          { key: "price", label: "Price", type: "money" },
        ],
        rows: topItems,
      },
      {
        title: "Payments by Method",
        columns: [
          { key: "payment_type", label: "Payment Type" },
          { key: "invoice_count", label: "Invoices", type: "number" },
          { key: "total", label: "Total", type: "money" },
        ],
        rows: payments,
      },
    ],
    charts: [{ type: "pie", title: "Payments by Method", data: payments }],
  });
};

const getGrossSalesReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "gross-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Gross Sales", value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
      { label: "Items Sold", value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: "Selling Items", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Gross Sales by Item",
      columns: [
        { key: "item", label: "Item" },
        { key: "category", label: "Category" },
        { key: "quantity_sold", label: "Qty", type: "number" },
        { key: "gross_sales", label: "Gross Sales", type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: "Gross Sales by Item", data: rows.slice(0, 10) }],
  });
};

const getNetSalesReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "net-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Net Sales", value: money(totals.net_sales), type: "money" },
      { label: "Tax", value: money(totals.tax_total), type: "money" },
      { label: "Service Charge", value: money(totals.service_charge_total), type: "money" },
      { label: "Revenue", value: money(totals.total_sales), type: "money" },
    ],
    tables: [{
      title: "Net Sales by Date",
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "invoices", label: "Invoices", type: "number" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "tax_total", label: "Tax", type: "money" },
        { key: "service_charge_total", label: "Service Charge", type: "money" },
        { key: "total_sales", label: "Revenue", type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: "Net Sales Trend", data: [...rows].reverse() }],
  });
};

const getGroupedInvoiceReport = async ({ conn, reportId, type, from, to, tenantId, currency, store, groupSelect, groupBy, orderBy = "revenue DESC", columns, tableTitle, summaryLabel }) => {
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

  return makeReport({
    reportId,
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: summaryLabel, value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Invoices", value: rows.reduce((sum, row) => sum + money(row.invoices), 0), type: "number" },
      { label: "Average Order Value", value: rows.length ? rows.reduce((sum, row) => sum + money(row.revenue), 0) / rows.reduce((sum, row) => sum + money(row.invoices), 0) : 0, type: "money" },
    ],
    tables: [{ title: tableTitle, columns, rows }],
    charts: [{ type: "bar", title: tableTitle, data: rows }],
  });
};

const getSalesByOrderTypeReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "sales-by-order-type",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Order Types", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Sales by Order Type",
      columns: [
        { key: "order_type", label: "Order Type" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "average_order_value", label: "AOV", type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: "Revenue by Order Type", data: rows }],
  });
};

const getSalesByTableReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "sales-by-table",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Tables", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Sales by Table",
      columns: [
        { key: "table_title", label: "Table" },
        { key: "floor", label: "Floor" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "average_order_value", label: "AOV", type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: "Revenue by Table", data: rows.slice(0, 12) }],
  });
};

const getInvoiceDetailReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "invoice-detail",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Invoices", value: rows.length, type: "number" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
      { label: "Net Sales", value: rows.reduce((sum, row) => sum + money(row.net_sales), 0), type: "money" },
    ],
    tables: [{
      title: "Invoice Detail",
      columns: [
        { key: "invoice_id", label: "Invoice" },
        { key: "created_at", label: "Created", type: "datetime" },
        { key: "customer", label: "Customer" },
        { key: "payment_type", label: "Payment" },
        { key: "order_type", label: "Order Type" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "tax_total", label: "Tax", type: "money" },
        { key: "service_charge_total", label: "Service", type: "money" },
        { key: "total", label: "Total", type: "money" },
      ],
      rows,
    }],
  });
};

const getVoidsCancellationsReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "voids-cancellations",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Cancelled Orders", value: cancelledOrders[0]?.cancelled_orders || 0, type: "number" },
      { label: "Cancelled Items", value: rows.length, type: "number" },
      { label: "Lost Sales", value: rows.reduce((sum, row) => sum + money(row.lost_sales), 0), type: "money" },
    ],
    tables: [{
      title: "Cancelled Items",
      columns: [
        { key: "date", label: "Date", type: "datetime" },
        { key: "order_id", label: "Order" },
        { key: "item", label: "Item" },
        { key: "quantity", label: "Qty", type: "number" },
        { key: "price", label: "Price", type: "money" },
        { key: "lost_sales", label: "Lost Sales", type: "money" },
        { key: "notes", label: "Notes" },
      ],
      rows,
    }],
  });
};

const getAverageOrderValueReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "average-order-value",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Average Order Value", value: money(totals.average_order_value), type: "money" },
      { label: "Invoices", value: totals.invoice_count || 0, type: "number" },
      { label: "Revenue", value: money(totals.total_sales), type: "money" },
    ],
    tables: [{
      title: "Average Order Value by Date",
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "invoices", label: "Invoices", type: "number" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "average_order_value", label: "AOV", type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: "AOV Trend", data: [...rows].reverse() }],
  });
};

const getPaymentSummaryReport = async (conn, type, from, to, tenantId, currency, store) => {
  const rows = await getPaymentRows(conn, type, from, to, tenantId);
  const total = rows.reduce((sum, row) => sum + money(row.total), 0);

  return makeReport({
    reportId: "payment-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Payments", value: total, type: "money" },
      { label: "Invoices", value: rows.reduce((sum, row) => sum + money(row.invoice_count), 0), type: "number" },
      { label: "Payment Types", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Payment Summary",
      columns: [
        { key: "payment_type", label: "Payment Type" },
        { key: "invoice_count", label: "Invoices", type: "number" },
        { key: "total", label: "Total", type: "money" },
        { key: "share", label: "Share %" },
      ],
      rows: rows.map((row) => ({ ...row, share: total ? `${((money(row.total) / total) * 100).toFixed(2)}%` : "0.00%" })),
    }],
    charts: [{ type: "pie", title: "Payment Mix", data: rows }],
  });
};

const getPaymentKeywordReport = async (conn, type, from, to, tenantId, currency, store, reportId, title, keywords) => {
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

  return makeReport({
    reportId,
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: title, value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
      { label: "Invoices", value: rows.length, type: "number" },
      { label: "Average Payment", value: rows.length ? rows.reduce((sum, row) => sum + money(row.total), 0) / rows.length : 0, type: "money" },
    ],
    tables: [{
      title,
      columns: [
        { key: "invoice_id", label: "Invoice" },
        { key: "created_at", label: "Created", type: "datetime" },
        { key: "payment_type", label: "Payment Type" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "tax_total", label: "Tax", type: "money" },
        { key: "service_charge_total", label: "Service", type: "money" },
        { key: "total", label: "Total", type: "money" },
      ],
      rows,
    }],
  });
};

const getUnpaidOrdersReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "unpaid-orders",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Unpaid Orders", value: rows.length, type: "number" },
      { label: "Estimated Total", value: rows.reduce((sum, row) => sum + money(row.estimated_total), 0), type: "money" },
      { label: "Customers", value: new Set(rows.map((row) => row.customer)).size, type: "number" },
    ],
    tables: [{
      title: "Unpaid Orders",
      columns: [
        { key: "order_id", label: "Order" },
        { key: "date", label: "Date", type: "datetime" },
        { key: "order_type", label: "Order Type" },
        { key: "table_title", label: "Table" },
        { key: "customer", label: "Customer" },
        { key: "status", label: "Status" },
        { key: "estimated_total", label: "Estimated Total", type: "money" },
      ],
      rows,
    }],
  });
};

const getPaymentTypeMixReport = async (conn, type, from, to, tenantId, currency, store) => {
  const rows = await getPaymentRows(conn, type, from, to, tenantId);
  const total = rows.reduce((sum, row) => sum + money(row.total), 0);
  const reportRows = rows.map((row) => ({
    ...row,
    share: total ? `${((money(row.total) / total) * 100).toFixed(2)}%` : "0.00%",
  }));

  return makeReport({
    reportId: "payment-type-mix",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Payment Total", value: total, type: "money" },
      { label: "Top Payment Type", value: reportRows[0]?.payment_type || "-", type: "text" },
      { label: "Payment Types", value: reportRows.length, type: "number" },
    ],
    tables: [{
      title: "Payment Type Mix",
      columns: [
        { key: "payment_type", label: "Payment Type" },
        { key: "invoice_count", label: "Invoices", type: "number" },
        { key: "total", label: "Total", type: "money" },
        { key: "share", label: "Share %" },
      ],
      rows: reportRows,
    }],
    charts: [{ type: "pie", title: "Payment Type Mix", data: reportRows }],
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

const makeItemSalesReport = ({ reportId, title, rows, currency, store, type, from, to }) => makeReport({
  reportId,
  currency,
  store,
  type,
  from,
  to,
  summary: [
    { label: "Gross Sales", value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
    { label: "Quantity Sold", value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
    { label: "Items", value: rows.length, type: "number" },
  ],
  tables: [{
    title,
    columns: [
      { key: "item", label: "Item" },
      { key: "category", label: "Category" },
      { key: "quantity_sold", label: "Qty", type: "number" },
      { key: "gross_sales", label: "Gross Sales", type: "money" },
      { key: "average_sold_price", label: "Avg Sold Price", type: "money" },
      { key: "current_price", label: "Current Price", type: "money" },
    ],
    rows,
  }],
  charts: [{ type: "bar", title, data: rows.slice(0, 12) }],
});

const getTopSellingItemsReport = async (conn, type, from, to, tenantId, currency, store) => {
  const rows = await getItemSalesRows(conn, type, from, to, tenantId, "quantity_sold DESC, gross_sales DESC");
  return makeItemSalesReport({ reportId: "top-selling-items", title: "Top Selling Items", rows: rows.slice(0, 50), currency, store, type, from, to });
};

const getLowSellingItemsReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeItemSalesReport({ reportId: "low-selling-items", title: "Low Selling Items", rows: rows.slice(0, 50), currency, store, type, from, to });
};

const getItemSalesReport = async (conn, type, from, to, tenantId, currency, store) => {
  const rows = await getItemSalesRows(conn, type, from, to, tenantId);
  return makeItemSalesReport({ reportId: "item-sales", title: "Item Sales", rows, currency, store, type, from, to });
};

const getCategorySalesReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "category-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Gross Sales", value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
      { label: "Quantity Sold", value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: "Categories", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Category Sales",
      columns: [
        { key: "category", label: "Category" },
        { key: "items_sold", label: "Items", type: "number" },
        { key: "quantity_sold", label: "Qty", type: "number" },
        { key: "gross_sales", label: "Gross Sales", type: "money" },
        { key: "average_sold_price", label: "Avg Sold Price", type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "bar", title: "Category Sales", data: rows }],
  });
};

const getVariantSalesReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "variant-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Gross Sales", value: rows.reduce((sum, row) => sum + money(row.gross_sales), 0), type: "money" },
      { label: "Quantity Sold", value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: "Variants", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Variant Sales",
      columns: [
        { key: "item", label: "Item" },
        { key: "variant", label: "Variant" },
        { key: "quantity_sold", label: "Qty", type: "number" },
        { key: "gross_sales", label: "Gross Sales", type: "money" },
        { key: "average_sold_price", label: "Avg Sold Price", type: "money" },
        { key: "current_price", label: "Current Price", type: "money" },
      ],
      rows,
    }],
  });
};

const getAddonSalesReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "addon-sales",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Addon Sales", value: rows.reduce((sum, row) => sum + money(row.addon_sales), 0), type: "money" },
      { label: "Quantity Sold", value: rows.reduce((sum, row) => sum + money(row.quantity_sold), 0), type: "number" },
      { label: "Addons", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Addon Sales",
      columns: [
        { key: "item", label: "Item" },
        { key: "addon", label: "Addon" },
        { key: "order_lines", label: "Lines", type: "number" },
        { key: "quantity_sold", label: "Qty", type: "number" },
        { key: "addon_price", label: "Addon Price", type: "money" },
        { key: "addon_sales", label: "Addon Sales", type: "money" },
      ],
      rows,
    }],
  });
};

const getMenuPriceAuditReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "menu-price-audit",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Items", value: itemRows.length, type: "number" },
      { label: "Variants", value: variantRows.length, type: "number" },
      { label: "Addons", value: addonRows.length, type: "number" },
    ],
    tables: [{
      title: "Menu Price Audit",
      columns: [
        { key: "type", label: "Type" },
        { key: "item", label: "Item" },
        { key: "option_name", label: "Option" },
        { key: "category", label: "Category" },
        { key: "price", label: "Price", type: "money" },
        { key: "net_price", label: "Net Price", type: "money" },
        { key: "tax", label: "Tax" },
        { key: "tax_rate", label: "Tax Rate", type: "number" },
        { key: "status", label: "Status" },
      ],
      rows,
    }],
  });
};

const getCustomerSummaryReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "customer-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Total Customers", value: totals[0]?.total_customers || 0, type: "number" },
      { label: "New Customers", value: newCustomers[0]?.new_customers || 0, type: "number" },
      { label: "Active Customers", value: activeCustomers[0]?.active_customers || 0, type: "number" },
      { label: "Members", value: totals[0]?.member_customers || 0, type: "number" },
    ],
    tables: [{
      title: "Top Active Customers",
      columns: [
        { key: "name", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "average_order_value", label: "AOV", type: "money" },
      ],
      rows: topCustomers,
    }],
  });
};

const getNewCustomersReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "new-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "New Customers", value: rows.length, type: "number" },
      { label: "Members", value: rows.filter((row) => row.membership === "Member").length, type: "number" },
      { label: "With Email", value: rows.filter((row) => row.email).length, type: "number" },
    ],
    tables: [{
      title: "New Customers",
      columns: [
        { key: "created_at", label: "Created", type: "datetime" },
        { key: "name", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "gender", label: "Gender" },
        { key: "membership", label: "Membership" },
      ],
      rows,
    }],
  });
};

const getReturningCustomersReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "returning-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Returning Customers", value: rows.length, type: "number" },
      { label: "Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
    ],
    tables: [{
      title: "Returning Customers",
      columns: [
        { key: "name", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "membership", label: "Membership" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "last_order_at", label: "Last Order", type: "datetime" },
      ],
      rows,
    }],
  });
};

const getTopCustomersReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "top-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Top Customer Revenue", value: rows[0]?.revenue || 0, type: "money" },
      { label: "Customers", value: rows.length, type: "number" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
    ],
    tables: [{
      title: "Top Customers",
      columns: [
        { key: "name", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "membership", label: "Membership" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "average_order_value", label: "AOV", type: "money" },
        { key: "last_order_at", label: "Last Order", type: "datetime" },
      ],
      rows,
    }],
  });
};

const getCustomerBirthdaysReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "customer-birthdays",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Customers with Birthdays", value: rows.length, type: "number" },
      { label: "Next 7 Days", value: rows.filter((row) => Number(row.days_until_birthday) <= 7).length, type: "number" },
      { label: "Next 30 Days", value: rows.filter((row) => Number(row.days_until_birthday) <= 30).length, type: "number" },
    ],
    tables: [{
      title: "Upcoming Birthdays",
      columns: [
        { key: "days_until_birthday", label: "Days", type: "number" },
        { key: "name", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "birth_date", label: "Birth Date", type: "date" },
        { key: "membership", label: "Membership" },
      ],
      rows,
    }],
  });
};

const getMemberCustomersReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "member-customers",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Members", value: rows.length, type: "number" },
      { label: "Member Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Member Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
    ],
    tables: [{
      title: "Member Customers",
      columns: [
        { key: "name", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "last_order_at", label: "Last Order", type: "datetime" },
        { key: "created_at", label: "Created", type: "datetime" },
      ],
      rows,
    }],
  });
};

const getOrderStatusReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "order-status",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Completed", value: rows.filter((row) => row.status === "completed").reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Cancelled", value: rows.filter((row) => row.status === "cancelled").reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Pending Payment", value: rows.filter((row) => row.payment_status === "pending").reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
    ],
    tables: [{
      title: "Order Status",
      columns: [
        { key: "status", label: "Status" },
        { key: "payment_status", label: "Payment" },
        { key: "orders", label: "Orders", type: "number" },
      ],
      rows,
    }],
  });
};

const getKitchenPerformanceReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "kitchen-performance",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Item Lines", value: rows.reduce((sum, row) => sum + money(row.item_lines), 0), type: "number" },
      { label: "Quantity", value: rows.reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
      { label: "Completed Qty", value: rows.filter((row) => row.status === "completed" || row.status === "delivered").reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
      { label: "Cancelled Qty", value: rows.filter((row) => row.status === "cancelled").reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
    ],
    tables: [{
      title: "Kitchen Item Status",
      columns: [
        { key: "status", label: "Status" },
        { key: "item_lines", label: "Lines", type: "number" },
        { key: "quantity", label: "Quantity", type: "number" },
        { key: "sales_value", label: "Sales Value", type: "money" },
      ],
      rows,
    }],
  });
};

const getTokenReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "token-report",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Tokens", value: rows.length, type: "number" },
      { label: "Paid Tokens", value: rows.filter((row) => row.payment_status === "paid").length, type: "number" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
    ],
    tables: [{
      title: "Token Report",
      columns: [
        { key: "token_no", label: "Token" },
        { key: "order_id", label: "Order" },
        { key: "date", label: "Date", type: "datetime" },
        { key: "order_type", label: "Order Type" },
        { key: "customer", label: "Customer" },
        { key: "status", label: "Status" },
        { key: "payment_status", label: "Payment" },
        { key: "total", label: "Total", type: "money" },
      ],
      rows,
    }],
  });
};

const getQrOrderReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "qr-order-report",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "QR Orders", value: rows.length, type: "number" },
      { label: "Quantity", value: rows.reduce((sum, row) => sum + money(row.quantity), 0), type: "number" },
      { label: "Estimated Total", value: rows.reduce((sum, row) => sum + money(row.estimated_total), 0), type: "money" },
    ],
    tables: [{
      title: "QR Orders",
      columns: [
        { key: "order_id", label: "Order" },
        { key: "date", label: "Date", type: "datetime" },
        { key: "order_type", label: "Order Type" },
        { key: "table_title", label: "Table" },
        { key: "customer", label: "Customer" },
        { key: "status", label: "Status" },
        { key: "payment_status", label: "Payment" },
        { key: "quantity", label: "Qty", type: "number" },
        { key: "estimated_total", label: "Estimated Total", type: "money" },
      ],
      rows,
    }],
  });
};

const getTableTurnoverReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "table-turnover",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Table Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Tables", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Table Turnover",
      columns: [
        { key: "table_title", label: "Table" },
        { key: "floor", label: "Floor" },
        { key: "seating_capacity", label: "Seats", type: "number" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "active_days", label: "Active Days", type: "number" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "average_order_value", label: "AOV", type: "money" },
      ],
      rows,
    }],
  });
};

const getStaffCreatedOrdersReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "staff-created-orders",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Staff", value: rows.length, type: "number" },
      { label: "Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Paid Orders", value: rows.reduce((sum, row) => sum + money(row.paid_orders), 0), type: "number" },
    ],
    tables: [{
      title: "Staff Created Orders",
      columns: [
        { key: "staff_name", label: "Staff" },
        { key: "username", label: "Username" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "completed_orders", label: "Completed", type: "number" },
        { key: "cancelled_orders", label: "Cancelled", type: "number" },
        { key: "paid_orders", label: "Paid", type: "number" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "average_order_value", label: "AOV", type: "money" },
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

const getInventorySummaryReport = async (conn, type, from, to, tenantId, currency, store) => {
  const rows = await getInventoryRows(conn, tenantId);

  return makeReport({
    reportId: "inventory-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Inventory Items", value: rows.length, type: "number" },
      { label: "Low Stock", value: rows.filter((row) => row.status === "low").length, type: "number" },
      { label: "Out of Stock", value: rows.filter((row) => row.status === "out" || money(row.quantity) <= 0).length, type: "number" },
      { label: "Units Tracked", value: new Set(rows.map((row) => row.unit).filter(Boolean)).size, type: "number" },
    ],
    tables: [{
      title: "Inventory Summary",
      columns: [
        { key: "title", label: "Item" },
        { key: "quantity", label: "Quantity", type: "quantity" },
        { key: "unit", label: "Unit" },
        { key: "min_quantity_threshold", label: "Minimum", type: "quantity" },
        { key: "reorder_quantity", label: "Reorder Qty", type: "quantity" },
        { key: "status", label: "Status" },
        { key: "updated_at", label: "Updated", type: "datetime" },
      ],
      rows,
    }],
  });
};

const getLowStockReport = async (conn, type, from, to, tenantId, currency, store) => {
  const rows = await getInventoryRows(conn, tenantId, "AND COALESCE(quantity, 0) <= COALESCE(min_quantity_threshold, 0)");

  return makeReport({
    reportId: "low-stock",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Low Stock Items", value: rows.length, type: "number" },
      { label: "Out of Stock", value: rows.filter((row) => money(row.quantity) <= 0).length, type: "number" },
      { label: "Reorder Units", value: rows.reduce((sum, row) => sum + money(row.reorder_quantity), 0), type: "quantity" },
    ],
    tables: [{
      title: "Low Stock",
      columns: [
        { key: "title", label: "Item" },
        { key: "quantity", label: "Quantity", type: "quantity" },
        { key: "unit", label: "Unit" },
        { key: "min_quantity_threshold", label: "Minimum", type: "quantity" },
        { key: "reorder_quantity", label: "Reorder Qty", type: "quantity" },
        { key: "status", label: "Status" },
      ],
      rows,
    }],
  });
};

const getStockMovementsReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "stock-movements",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Movements", value: rows.length, type: "number" },
      { label: "Stock In", value: rows.filter((row) => row.movement_type === "IN").reduce((sum, row) => sum + money(row.quantity_change), 0), type: "quantity" },
      { label: "Stock Out", value: rows.filter((row) => row.movement_type === "OUT").reduce((sum, row) => sum + money(row.quantity_change), 0), type: "quantity" },
      { label: "Wastage", value: rows.filter((row) => row.movement_type === "WASTAGE").reduce((sum, row) => sum + money(row.quantity_change), 0), type: "quantity" },
    ],
    tables: [{
      title: "Stock Movements",
      columns: [
        { key: "created_at", label: "Date", type: "datetime" },
        { key: "item", label: "Item" },
        { key: "movement_type", label: "Type" },
        { key: "quantity_change", label: "Change", type: "quantity" },
        { key: "previous_quantity", label: "Previous", type: "quantity" },
        { key: "new_quantity", label: "New", type: "quantity" },
        { key: "unit", label: "Unit" },
        { key: "staff", label: "Staff" },
        { key: "note", label: "Note" },
      ],
      rows,
    }],
  });
};

const getWastageReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "wastage",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Wastage Items", value: rows.length, type: "number" },
      { label: "Wastage Quantity", value: rows.reduce((sum, row) => sum + money(row.wasted_quantity), 0), type: "quantity" },
      { label: "Movements", value: rows.reduce((sum, row) => sum + money(row.movement_count), 0), type: "number" },
    ],
    tables: [{
      title: "Wastage",
      columns: [
        { key: "item", label: "Item" },
        { key: "wasted_quantity", label: "Wasted Qty", type: "quantity" },
        { key: "unit", label: "Unit" },
        { key: "movement_count", label: "Movements", type: "number" },
        { key: "last_wasted_at", label: "Last Wasted", type: "datetime" },
        { key: "last_note", label: "Last Note" },
      ],
      rows,
    }],
  });
};

const getRecipeUsageReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "recipe-usage",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Recipe Lines", value: rows.length, type: "number" },
      { label: "Estimated Usage", value: rows.reduce((sum, row) => sum + money(row.estimated_usage), 0), type: "quantity" },
      { label: "Items Sold", value: rows.reduce((sum, row) => sum + money(row.sold_quantity), 0), type: "number" },
    ],
    tables: [{
      title: "Recipe Usage Estimate",
      columns: [
        { key: "inventory_item", label: "Inventory Item" },
        { key: "menu_item", label: "Menu Item" },
        { key: "variant", label: "Variant" },
        { key: "addon", label: "Addon" },
        { key: "recipe_quantity", label: "Recipe Qty", type: "quantity" },
        { key: "sold_quantity", label: "Sold Qty", type: "number" },
        { key: "estimated_usage", label: "Estimated Usage", type: "quantity" },
        { key: "unit", label: "Unit" },
      ],
      rows,
    }],
  });
};

const getStockReorderReport = async (conn, type, from, to, tenantId, currency, store) => {
  const rows = await getInventoryRows(conn, tenantId, "AND COALESCE(quantity, 0) <= COALESCE(min_quantity_threshold, 0)");

  return makeReport({
    reportId: "stock-reorder",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Reorder Items", value: rows.length, type: "number" },
      { label: "Suggested Quantity", value: rows.reduce((sum, row) => sum + money(row.reorder_quantity), 0), type: "quantity" },
      { label: "Out of Stock", value: rows.filter((row) => money(row.quantity) <= 0).length, type: "number" },
    ],
    tables: [{
      title: "Reorder List",
      columns: [
        { key: "title", label: "Item" },
        { key: "quantity", label: "Current", type: "quantity" },
        { key: "min_quantity_threshold", label: "Minimum", type: "quantity" },
        { key: "reorder_quantity", label: "Suggested Qty", type: "quantity" },
        { key: "unit", label: "Unit" },
        { key: "status", label: "Status" },
      ],
      rows,
    }],
  });
};

const getTaxSummaryReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "tax-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Tax Collected", value: rows.reduce((sum, row) => sum + money(row.tax_total), 0), type: "money" },
      { label: "Taxable Sales", value: rows.reduce((sum, row) => sum + money(row.taxable_sales), 0), type: "money" },
      { label: "Invoices", value: rows.reduce((sum, row) => sum + money(row.invoices), 0), type: "number" },
      { label: "Tax Rules", value: taxSetupRows.length, type: "number" },
    ],
    tables: [
      {
        title: "Tax by Date",
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "invoices", label: "Invoices", type: "number" },
          { key: "taxable_sales", label: "Taxable Sales", type: "money" },
          { key: "tax_total", label: "Tax", type: "money" },
          { key: "revenue", label: "Revenue", type: "money" },
        ],
        rows,
      },
      {
        title: "Tax Setup",
        columns: [
          { key: "title", label: "Tax" },
          { key: "rate", label: "Rate", type: "number" },
          { key: "type", label: "Type" },
        ],
        rows: taxSetupRows,
      },
    ],
    charts: [{ type: "line", title: "Tax Trend", data: [...rows].reverse() }],
  });
};

const getTaxByItemReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "tax-by-item",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Estimated Tax", value: rows.reduce((sum, row) => sum + money(row.estimated_tax), 0), type: "money" },
      { label: "Item Sales", value: rows.reduce((sum, row) => sum + money(row.item_sales), 0), type: "money" },
      { label: "Items", value: rows.length, type: "number" },
    ],
    tables: [{
      title: "Tax by Item",
      columns: [
        { key: "item", label: "Item" },
        { key: "category", label: "Category" },
        { key: "tax", label: "Tax" },
        { key: "tax_rate", label: "Rate", type: "number" },
        { key: "tax_type", label: "Type" },
        { key: "quantity_sold", label: "Qty", type: "number" },
        { key: "item_sales", label: "Item Sales", type: "money" },
        { key: "estimated_tax", label: "Estimated Tax", type: "money" },
      ],
      rows,
    }],
  });
};

const getServiceChargeReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "service-charge",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Service Charge", value: rows.reduce((sum, row) => sum + money(row.service_charge_total), 0), type: "money" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Invoices", value: rows.reduce((sum, row) => sum + money(row.invoices), 0), type: "number" },
    ],
    tables: [{
      title: "Service Charge by Date",
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "invoices", label: "Invoices", type: "number" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "service_charge_total", label: "Service Charge", type: "money" },
        { key: "revenue", label: "Revenue", type: "money" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: "Service Charge Trend", data: [...rows].reverse() }],
  });
};

const getDailyCloseReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "daily-close",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.revenue), 0), type: "money" },
      { label: "Orders", value: rows.reduce((sum, row) => sum + money(row.orders), 0), type: "number" },
      { label: "Tax", value: rows.reduce((sum, row) => sum + money(row.tax_total), 0), type: "money" },
      { label: "Service Charge", value: rows.reduce((sum, row) => sum + money(row.service_charge_total), 0), type: "money" },
    ],
    tables: [{
      title: "Daily Close",
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "orders", label: "Orders", type: "number" },
        { key: "invoices", label: "Invoices", type: "number" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "tax_total", label: "Tax", type: "money" },
        { key: "service_charge_total", label: "Service Charge", type: "money" },
        { key: "revenue", label: "Revenue", type: "money" },
        { key: "unpaid_orders", label: "Unpaid", type: "number" },
        { key: "cancelled_orders", label: "Cancelled", type: "number" },
        { key: "payment_mix", label: "Payment Mix" },
      ],
      rows,
    }],
  });
};

const getInvoiceRegisterReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "invoice-register",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Invoices", value: rows.length, type: "number" },
      { label: "Revenue", value: rows.reduce((sum, row) => sum + money(row.total), 0), type: "money" },
      { label: "Tax", value: rows.reduce((sum, row) => sum + money(row.tax_total), 0), type: "money" },
      { label: "Service Charge", value: rows.reduce((sum, row) => sum + money(row.service_charge_total), 0), type: "money" },
    ],
    tables: [{
      title: "Invoice Register",
      columns: [
        { key: "invoice_id", label: "Invoice" },
        { key: "created_at", label: "Created", type: "datetime" },
        { key: "payment_type", label: "Payment" },
        { key: "staff", label: "Staff" },
        { key: "net_sales", label: "Net Sales", type: "money" },
        { key: "tax_total", label: "Tax", type: "money" },
        { key: "service_charge_total", label: "Service", type: "money" },
        { key: "total", label: "Total", type: "money" },
      ],
      rows,
    }],
  });
};

const getReservationSummaryReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "reservation-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Reservations", value: rows.reduce((sum, row) => sum + money(row.reservations), 0), type: "number" },
      { label: "Guests", value: rows.reduce((sum, row) => sum + money(row.guests), 0), type: "number" },
      { label: "Statuses", value: new Set(rows.map((row) => row.status)).size, type: "number" },
    ],
    tables: [{
      title: "Reservation Summary",
      columns: [
        { key: "status", label: "Status" },
        { key: "table_title", label: "Table" },
        { key: "reservations", label: "Reservations", type: "number" },
        { key: "guests", label: "Guests", type: "number" },
        { key: "first_reservation", label: "First", type: "datetime" },
        { key: "last_reservation", label: "Last", type: "datetime" },
      ],
      rows,
    }],
  });
};

const getUpcomingReservationsReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "upcoming-reservations",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Upcoming", value: rows.length, type: "number" },
      { label: "Guests", value: rows.reduce((sum, row) => sum + money(row.people_count), 0), type: "number" },
      { label: "Tables", value: new Set(rows.map((row) => row.table_title).filter((value) => value && value !== "-")).size, type: "number" },
    ],
    tables: [{
      title: "Upcoming Reservations",
      columns: [
        { key: "date", label: "Date", type: "datetime" },
        { key: "customer", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "table_title", label: "Table" },
        { key: "people_count", label: "Guests", type: "number" },
        { key: "status", label: "Status" },
        { key: "unique_code", label: "Code" },
        { key: "notes", label: "Notes" },
      ],
      rows,
    }],
  });
};

const getReservationNoShowReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "reservation-no-show",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Possible No-Shows", value: rows.length, type: "number" },
      { label: "Guests", value: rows.reduce((sum, row) => sum + money(row.people_count), 0), type: "number" },
      { label: "Explicit No-Show", value: rows.filter((row) => ["no-show", "no show", "noshow"].includes(String(row.status || "").toLowerCase())).length, type: "number" },
    ],
    tables: [{
      title: "Possible Reservation No-Shows",
      columns: [
        { key: "date", label: "Date", type: "datetime" },
        { key: "customer", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "table_title", label: "Table" },
        { key: "people_count", label: "Guests", type: "number" },
        { key: "status", label: "Status" },
        { key: "notes", label: "Notes" },
      ],
      rows,
    }],
  });
};

const getFeedbackSummaryReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "feedback-summary",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Feedback", value: totalFeedback, type: "number" },
      { label: "Average Rating", value: weightedAverage("average_rating"), type: "number" },
      { label: "Service", value: weightedAverage("service_rating"), type: "number" },
      { label: "Recommend", value: weightedAverage("recommend_rating"), type: "number" },
    ],
    tables: [{
      title: "Feedback Summary",
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "feedback_count", label: "Feedback", type: "number" },
        { key: "average_rating", label: "Average", type: "number" },
        { key: "food_quality_rating", label: "Food", type: "number" },
        { key: "service_rating", label: "Service", type: "number" },
        { key: "staff_behavior_rating", label: "Staff", type: "number" },
        { key: "ambiance_rating", label: "Ambiance", type: "number" },
        { key: "recommend_rating", label: "Recommend", type: "number" },
      ],
      rows,
    }],
    charts: [{ type: "line", title: "Feedback Trend", data: [...rows].reverse() }],
  });
};

const getNegativeFeedbackReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "negative-feedback",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Negative Feedback", value: rows.length, type: "number" },
      { label: "Avg Rating", value: rows.length ? rows.reduce((sum, row) => sum + money(row.average_rating), 0) / rows.length : 0, type: "number" },
      { label: "With Remarks", value: rows.filter((row) => row.remarks).length, type: "number" },
    ],
    tables: [{
      title: "Negative Feedback",
      columns: [
        { key: "date", label: "Date", type: "datetime" },
        { key: "invoice_id", label: "Invoice" },
        { key: "customer", label: "Customer" },
        { key: "phone", label: "Phone" },
        { key: "average_rating", label: "Average", type: "number" },
        { key: "food_quality_rating", label: "Food", type: "number" },
        { key: "service_rating", label: "Service", type: "number" },
        { key: "recommend_rating", label: "Recommend", type: "number" },
        { key: "remarks", label: "Remarks" },
      ],
      rows,
    }],
  });
};

const getRecommendationScoreReport = async (conn, type, from, to, tenantId, currency, store) => {
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

  return makeReport({
    reportId: "recommendation-score",
    currency,
    store,
    type,
    from,
    to,
    summary: [
      { label: "Recommendation Score", value: score, type: "number" },
      { label: "Feedback", value: total, type: "number" },
      { label: "Promoters", value: promoters, type: "number" },
      { label: "Detractors", value: detractors, type: "number" },
    ],
    tables: [{
      title: "Recommendation Score",
      columns: [
        { key: "recommendation_group", label: "Group" },
        { key: "feedback_count", label: "Feedback", type: "number" },
        { key: "average_recommend_rating", label: "Avg Recommend", type: "number" },
        { key: "average_rating", label: "Avg Rating", type: "number" },
      ],
      rows,
    }],
    charts: [{ type: "pie", title: "Recommendation Mix", data: rows }],
  });
};

const REPORT_BUILDERS = {
  "sales-summary": getSalesSummaryReport,
  "gross-sales": getGrossSalesReport,
  "net-sales": getNetSalesReport,
  "sales-by-hour": (conn, type, from, to, tenantId, currency, store) => getGroupedInvoiceReport({
    conn,
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
    tableTitle: "Sales by Hour",
    summaryLabel: "Revenue",
    columns: [
      { key: "hour", label: "Hour" },
      { key: "invoices", label: "Invoices", type: "number" },
      { key: "net_sales", label: "Net Sales", type: "money" },
      { key: "revenue", label: "Revenue", type: "money" },
      { key: "average_order_value", label: "AOV", type: "money" },
    ],
  }),
  "sales-by-day": (conn, type, from, to, tenantId, currency, store) => getGroupedInvoiceReport({
    conn,
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
    tableTitle: "Sales by Day",
    summaryLabel: "Revenue",
    columns: [
      { key: "date", label: "Date", type: "date" },
      { key: "invoices", label: "Invoices", type: "number" },
      { key: "net_sales", label: "Net Sales", type: "money" },
      { key: "revenue", label: "Revenue", type: "money" },
      { key: "average_order_value", label: "AOV", type: "money" },
    ],
  }),
  "sales-by-month": (conn, type, from, to, tenantId, currency, store) => getGroupedInvoiceReport({
    conn,
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
    tableTitle: "Sales by Month",
    summaryLabel: "Revenue",
    columns: [
      { key: "month", label: "Month" },
      { key: "invoices", label: "Invoices", type: "number" },
      { key: "net_sales", label: "Net Sales", type: "money" },
      { key: "revenue", label: "Revenue", type: "money" },
      { key: "average_order_value", label: "AOV", type: "money" },
    ],
  }),
  "sales-by-order-type": getSalesByOrderTypeReport,
  "sales-by-table": getSalesByTableReport,
  "invoice-detail": getInvoiceDetailReport,
  "voids-cancellations": getVoidsCancellationsReport,
  "average-order-value": getAverageOrderValueReport,
  "payment-summary": getPaymentSummaryReport,
  "cash-report": (conn, type, from, to, tenantId, currency, store) => getPaymentKeywordReport(conn, type, from, to, tenantId, currency, store, "cash-report", "Cash Report", ["cash"]),
  "card-report": (conn, type, from, to, tenantId, currency, store) => getPaymentKeywordReport(conn, type, from, to, tenantId, currency, store, "card-report", "Card Report", ["card", "credit", "debit"]),
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

exports.getReportByIdDB = async (reportId, type, from, to, tenantId) => {
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
    return builder(conn, type, from, to, tenantId, currency, store);
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
