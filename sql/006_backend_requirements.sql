-- Backend requirement gaps: real-time command feed, payroll workflow, media metadata.

ALTER TABLE payroll_runs
  MODIFY COLUMN status ENUM('draft', 'processing', 'completed', 'approved', 'finalized', 'failed') NOT NULL DEFAULT 'draft',
  ADD COLUMN approved_at DATETIME NULL AFTER result_json,
  ADD COLUMN approved_by INT UNSIGNED NULL AFTER approved_at,
  ADD COLUMN finalized_at DATETIME NULL AFTER approved_by,
  ADD COLUMN finalized_by INT UNSIGNED NULL AFTER finalized_at,
  ADD KEY idx_payroll_status (status),
  ADD CONSTRAINT fk_payroll_approved_by FOREIGN KEY (approved_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_payroll_finalized_by FOREIGN KEY (finalized_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('bonus', 'deduction', 'correction', 'other') NOT NULL DEFAULT 'other',
  amount_pence BIGINT NOT NULL,
  reason VARCHAR(512) DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pa_run_user (payroll_run_id, user_id),
  CONSTRAINT fk_pa_run FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_pa_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_pa_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payslips (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  payroll_line_id BIGINT UNSIGNED DEFAULT NULL,
  status ENUM('draft', 'issued') NOT NULL DEFAULT 'draft',
  payload JSON NOT NULL,
  issued_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_payslip_run_user (payroll_run_id, user_id),
  KEY idx_payslip_user_created (user_id, created_at),
  CONSTRAINT fk_payslip_run FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_payslip_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_payslip_line FOREIGN KEY (payroll_line_id) REFERENCES payroll_lines (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE media_assets
  ADD COLUMN sha256 CHAR(64) NULL AFTER size_bytes,
  ADD COLUMN access_token CHAR(64) NULL AFTER sha256,
  ADD COLUMN processing_status ENUM('stored', 'validated', 'rejected') NOT NULL DEFAULT 'stored' AFTER access_token,
  ADD COLUMN processing_note VARCHAR(512) NULL AFTER processing_status,
  ADD UNIQUE KEY uk_media_access_token (access_token),
  ADD KEY idx_media_processing (processing_status, created_at);

CREATE TABLE IF NOT EXISTS command_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(64) NOT NULL,
  actor_user_id INT UNSIGNED DEFAULT NULL,
  subject_user_id INT UNSIGNED DEFAULT NULL,
  site_id INT UNSIGNED DEFAULT NULL,
  entity_type VARCHAR(64) DEFAULT NULL,
  entity_id VARCHAR(64) DEFAULT NULL,
  payload JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_command_created (created_at),
  KEY idx_command_type_created (type, created_at),
  KEY idx_command_site_created (site_id, created_at),
  CONSTRAINT fk_command_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_command_subject FOREIGN KEY (subject_user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_command_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
