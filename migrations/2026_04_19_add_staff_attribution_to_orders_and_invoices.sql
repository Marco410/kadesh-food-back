ALTER TABLE orders
  ADD COLUMN created_by varchar(255) DEFAULT NULL AFTER tenant_id,
  ADD KEY orders_created_by_idx (created_by),
  ADD CONSTRAINT orders_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users (username)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

ALTER TABLE invoices
  ADD COLUMN created_by varchar(255) DEFAULT NULL AFTER service_charge_total,
  ADD KEY invoices_created_by_idx (created_by),
  ADD CONSTRAINT invoices_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users (username)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
