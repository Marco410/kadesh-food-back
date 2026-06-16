const { getMySqlPromiseConnection } = require("../config/mysql.db");

exports.getPosIdempotencyRecordDB = async (tenantId, idempotencyKey) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const [rows] = await conn.query(
      `SELECT idempotency_key, tenant_id, order_id, token_no, response_json
       FROM pos_idempotency_keys
       WHERE idempotency_key = ? AND tenant_id = ? AND order_id IS NOT NULL
       LIMIT 1`,
      [idempotencyKey, tenantId]
    );
    return rows[0] || null;
  } finally {
    conn.release();
  }
};

exports.savePosIdempotencyRecordDB = async (tenantId, idempotencyKey, orderId, tokenNo, response) => {
  const conn = await getMySqlPromiseConnection();
  try {
    await conn.query(
      `INSERT INTO pos_idempotency_keys (idempotency_key, tenant_id, order_id, token_no, response_json)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         order_id = IF(order_id IS NULL, VALUES(order_id), order_id),
         token_no = IF(token_no IS NULL, VALUES(token_no), token_no),
         response_json = IF(response_json IS NULL, VALUES(response_json), response_json)`,
      [idempotencyKey, tenantId, orderId, String(tokenNo), JSON.stringify(response)]
    );
  } finally {
    conn.release();
  }
};

exports.withIdempotencyLock = async (tenantId, idempotencyKey, fn) => {
  const conn = await getMySqlPromiseConnection();
  const lockName = `pos_idem:${tenantId}:${idempotencyKey}`;
  try {
    const [[lockRow]] = await conn.query("SELECT GET_LOCK(?, 30) AS acquired", [lockName]);
    if (!lockRow?.acquired) {
      throw new Error("IDEMPOTENCY_LOCK_TIMEOUT");
    }
    return await fn();
  } finally {
    await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
    conn.release();
  }
};
