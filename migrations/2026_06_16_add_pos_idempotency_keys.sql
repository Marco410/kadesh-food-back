CREATE TABLE IF NOT EXISTS pos_idempotency_keys (
  idempotency_key VARCHAR(36) NOT NULL,
  tenant_id INT NOT NULL,
  order_id INT DEFAULT NULL,
  token_no VARCHAR(20) DEFAULT NULL,
  response_json JSON DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idempotency_key),
  INDEX idx_pos_idempotency_tenant (tenant_id),
  CONSTRAINT pos_idempotency_keys_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
