const { getPaymentTypesDB } = require("../services/settings.service");

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ONLINE_PAYMENT_KEYWORDS = [
  "stripe",
  "paystack",
  "paypal",
  "card",
  "credit",
  "debit",
  "online",
  "terminal",
  "tap",
  "gateway",
];

exports.isValidUuid = (value) => typeof value === "string" && UUID_REGEX.test(value);

exports.getSyncHeaders = (req) => {
  const idempotencyKey = req.headers["x-idempotency-key"] || null;
  const offlineCreatedAt = req.headers["x-offline-created-at"] || null;
  const isSync = Boolean(idempotencyKey);

  return { idempotencyKey, offlineCreatedAt, isSync };
};

exports.parseOfflineCreatedAt = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

exports.buildOrderResponse = (req, { orderId, tokenNo, invoiceId = null }) => {
  const response = {
    message: req.__("order_created_token", { token: tokenNo }),
    orderId,
    tokenNo: String(tokenNo),
  };

  if (invoiceId != null) {
    response.invoiceId = invoiceId;
  }

  return response;
};

exports.validateSyncIdempotencyKey = (idempotencyKey) => {
  if (!exports.isValidUuid(idempotencyKey)) {
    return "Invalid X-Idempotency-Key header. Expected a UUID.";
  }
  return null;
};

exports.validateOfflineCreatedAt = (offlineCreatedAt) => {
  if (!offlineCreatedAt) return null;
  if (!exports.parseOfflineCreatedAt(offlineCreatedAt)) {
    return "Invalid X-Offline-Created-At header. Expected ISO 8601 date.";
  }
  return null;
};

exports.isOfflineSafePaymentType = async (tenantId, paymentTypeId) => {
  const paymentTypes = await getPaymentTypesDB(true, tenantId);
  const paymentType = paymentTypes.find((pt) => pt.id == paymentTypeId);

  if (!paymentType) {
    return { ok: false, message: "Invalid payment type." };
  }

  const title = (paymentType.title || "").toLowerCase();
  const icon = (paymentType.icon || "").toLowerCase();
  const haystack = `${title} ${icon}`;

  const requiresGateway = ONLINE_PAYMENT_KEYWORDS.some((keyword) =>
    haystack.includes(keyword)
  );

  if (requiresGateway) {
    return {
      ok: false,
      message:
        "Offline sync only supports offline-safe payment methods (e.g. cash). Online or gateway payments cannot be synced.",
    };
  }

  return { ok: true, paymentType };
};

exports.emitPosOrderSocketEvents = async (io, tenantId, orderId, { isPaid = false } = {}) => {
  if (!io) return;

  const { getOrderByIdForSocketDB } = require("../services/kitchen.service");
  const order = await getOrderByIdForSocketDB(tenantId, orderId);
  if (!order) return;

  const room = String(tenantId);
  io.to(room).emit("new_order", order);

  if (isPaid) {
    io.to(room).emit("order_update", order);
  }
};
