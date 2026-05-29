const { getMySqlPromiseConnection } = require("../config/mysql.db");

/**
 * Get all printer configs for a tenant.
 */
exports.getPrinterConfigsDB = async (tenantId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    const sql = `
      SELECT id, name, transport, address, paper_size, is_default, is_kot_printer, auto_cut
      FROM printer_configs
      WHERE tenant_id = ?
      ORDER BY is_default DESC, is_kot_printer DESC, name ASC;
    `;
    const [rows] = await conn.query(sql, [tenantId]);
    return rows;
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    conn.release();
  }
};

/**
 * Add a printer config.
 * Enforces single-default and single-KOT within the tenant.
 */
exports.addPrinterConfigDB = async (tenantId, { name, transport, address, paper_size, is_default, is_kot_printer, auto_cut }) => {
  const conn = await getMySqlPromiseConnection();
  try {
    await conn.beginTransaction();

    // If this printer is the default, unmark other defaults
    if (is_default) {
      await conn.query(`UPDATE printer_configs SET is_default = 0 WHERE tenant_id = ?`, [tenantId]);
    }

    // If this printer is the KOT printer, unmark other KOT printers
    if (is_kot_printer) {
      await conn.query(`UPDATE printer_configs SET is_kot_printer = 0 WHERE tenant_id = ?`, [tenantId]);
    }

    // Check if this is the first printer — if so, make it default
    const [existing] = await conn.query(`SELECT COUNT(*) AS cnt FROM printer_configs WHERE tenant_id = ?`, [tenantId]);
    const isFirst = existing[0].cnt === 0;

    const sql = `
      INSERT INTO printer_configs (tenant_id, name, transport, address, paper_size, is_default, is_kot_printer, auto_cut)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `;

    const [result] = await conn.query(sql, [
      tenantId,
      name,
      transport,
      address,
      paper_size || 80,
      isFirst ? 1 : (is_default ? 1 : 0),
      is_kot_printer ? 1 : 0,
      auto_cut !== undefined ? (auto_cut ? 1 : 0) : 1,
    ]);

    await conn.commit();
    return result.insertId;
  } catch (error) {
    await conn.rollback();
    console.error(error);
    throw error;
  } finally {
    conn.release();
  }
};

/**
 * Update a printer config.
 */
exports.updatePrinterConfigDB = async (tenantId, printerId, updates) => {
  const conn = await getMySqlPromiseConnection();
  try {
    await conn.beginTransaction();

    // If setting as default, unmark others
    if (updates.is_default) {
      await conn.query(`UPDATE printer_configs SET is_default = 0 WHERE tenant_id = ?`, [tenantId]);
    }

    // If setting as KOT, unmark others
    if (updates.is_kot_printer) {
      await conn.query(`UPDATE printer_configs SET is_kot_printer = 0 WHERE tenant_id = ?`, [tenantId]);
    }

    const fields = [];
    const values = [];

    const allowedFields = ['name', 'transport', 'address', 'paper_size', 'is_default', 'is_kot_printer', 'auto_cut'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (fields.length === 0) {
      await conn.commit();
      return;
    }

    values.push(printerId, tenantId);

    const sql = `UPDATE printer_configs SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`;
    await conn.query(sql, values);

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    console.error(error);
    throw error;
  } finally {
    conn.release();
  }
};

/**
 * Delete a printer config.
 */
exports.deletePrinterConfigDB = async (tenantId, printerId) => {
  const conn = await getMySqlPromiseConnection();
  try {
    await conn.query(`DELETE FROM printer_configs WHERE id = ? AND tenant_id = ?`, [printerId, tenantId]);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    conn.release();
  }
};
