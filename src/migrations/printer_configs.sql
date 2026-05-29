-- Printer configurations table
-- Stores thermal printer settings at the tenant level so all captains share the same config.
-- Each printer is identified by its transport + address combo.

CREATE TABLE IF NOT EXISTS printer_configs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  transport ENUM('bluetooth', 'tcp', 'usb') NOT NULL DEFAULT 'bluetooth',
  address VARCHAR(255) NOT NULL COMMENT 'BLE MAC, TCP host:port, or USB vendorId:productId',
  paper_size SMALLINT NOT NULL DEFAULT 80 COMMENT '58 or 80 mm',
  is_default TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Default receipt printer',
  is_kot_printer TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Designated KOT/kitchen printer',
  auto_cut TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Auto-cut after print',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
