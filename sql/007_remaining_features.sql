-- Remaining non-excluded feature contracts: patrol compliance, visual logs,
-- HR documents, training, availability, payroll compliance, immutable audit,
-- media processing, report formats, site assets, and richer incident metadata.

ALTER TABLE export_jobs
  ADD COLUMN output_format ENUM('csv', 'xlsx', 'pdf') NOT NULL DEFAULT 'csv' AFTER type,
  ADD COLUMN file_mime VARCHAR(128) NULL AFTER file_path;

ALTER TABLE incidents
  ADD COLUMN shift_id BIGINT UNSIGNED NULL AFTER site_id,
  ADD COLUMN attendance_session_id BIGINT UNSIGNED NULL AFTER shift_id,
  ADD COLUMN lat DECIMAL(10, 7) NULL AFTER status,
  ADD COLUMN lng DECIMAL(10, 7) NULL AFTER lat,
  ADD COLUMN captured_at DATETIME NULL AFTER lng,
  ADD COLUMN device_info JSON NULL AFTER captured_at,
  ADD KEY idx_incidents_shift (shift_id),
  ADD CONSTRAINT fk_incidents_shift FOREIGN KEY (shift_id) REFERENCES shifts (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_incidents_attendance FOREIGN KEY (attendance_session_id) REFERENCES attendance_sessions (id)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE audit_logs
  ADD COLUMN prev_hash CHAR(64) NULL AFTER payload,
  ADD COLUMN row_hash CHAR(64) NULL AFTER prev_hash,
  ADD UNIQUE KEY uk_audit_row_hash (row_hash);

ALTER TABLE media_assets
  ADD COLUMN storage_provider VARCHAR(32) NOT NULL DEFAULT 'local' AFTER kind,
  ADD COLUMN object_key VARCHAR(512) NULL AFTER storage_key,
  ADD COLUMN scan_status ENUM('pending', 'clean', 'failed', 'skipped') NOT NULL DEFAULT 'pending' AFTER processing_note,
  ADD COLUMN processed_at DATETIME NULL AFTER scan_status,
  ADD COLUMN expires_at DATETIME NULL AFTER processed_at;

ALTER TABLE payslips
  MODIFY COLUMN status ENUM('draft', 'issued', 'sent', 'read', 'reissued') NOT NULL DEFAULT 'draft',
  ADD COLUMN file_path VARCHAR(512) NULL AFTER payload,
  ADD COLUMN file_mime VARCHAR(128) NULL AFTER file_path,
  ADD COLUMN sent_at DATETIME NULL AFTER issued_at,
  ADD COLUMN read_at DATETIME NULL AFTER sent_at,
  ADD COLUMN reissued_from_id BIGINT UNSIGNED NULL AFTER read_at,
  ADD KEY idx_payslip_status_user (status, user_id);

CREATE TABLE IF NOT EXISTS patrol_routes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id INT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  interval_minutes INT UNSIGNED NOT NULL DEFAULT 60,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_patrol_route_site (site_id, is_active),
  CONSTRAINT fk_patrol_route_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS patrol_route_checkpoints (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  route_id BIGINT UNSIGNED NOT NULL,
  checkpoint_id INT UNSIGNED NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  due_offset_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uk_route_checkpoint (route_id, checkpoint_id),
  CONSTRAINT fk_prc_route FOREIGN KEY (route_id) REFERENCES patrol_routes (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_prc_checkpoint FOREIGN KEY (checkpoint_id) REFERENCES checkpoints (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS visual_log_hours (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attendance_session_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  shift_id BIGINT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  due_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  incident_id BIGINT UNSIGNED NULL,
  status ENUM('due', 'completed', 'missed') NOT NULL DEFAULT 'due',
  note VARCHAR(1024) NULL,
  UNIQUE KEY uk_visual_hour (attendance_session_id, due_at),
  KEY idx_visual_user_due (user_id, due_at),
  CONSTRAINT fk_vlh_session FOREIGN KEY (attendance_session_id) REFERENCES attendance_sessions (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_vlh_incident FOREIGN KEY (incident_id) REFERENCES incidents (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_availability (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  status ENUM('available', 'unavailable', 'preferred') NOT NULL DEFAULT 'unavailable',
  reason VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_availability_user_time (user_id, starts_at, ends_at),
  CONSTRAINT fk_avail_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_avail_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_documents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NULL,
  document_type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status ENUM('active', 'expired', 'archived') NOT NULL DEFAULT 'active',
  expires_on DATE NULL,
  uploaded_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_emp_doc_user (user_id, status),
  CONSTRAINT fk_emp_doc_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_emp_doc_media FOREIGN KEY (media_id) REFERENCES media_assets (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_emergency_contacts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  relationship VARCHAR(64) NULL,
  phone VARCHAR(64) NOT NULL,
  email VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_emergency_user (user_id),
  CONSTRAINT fk_emergency_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_lifecycle_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  event_type ENUM('onboarding', 'status_change', 'offboarding', 'archive') NOT NULL,
  notes VARCHAR(1024) NULL,
  effective_on DATE NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lifecycle_user (user_id, created_at),
  CONSTRAINT fk_lifecycle_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS training_requirements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(1024) NULL,
  role_slug VARCHAR(32) NOT NULL DEFAULT 'guard',
  renewal_months INT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS training_completions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  requirement_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  completed_on DATE NOT NULL,
  expires_on DATE NULL,
  evidence_media_id BIGINT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_training_user_req (requirement_id, user_id),
  CONSTRAINT fk_training_req FOREIGN KEY (requirement_id) REFERENCES training_requirements (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_training_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_rules (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  config JSON NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_exceptions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  severity ENUM('info', 'warning', 'error') NOT NULL DEFAULT 'warning',
  code VARCHAR(64) NOT NULL,
  message VARCHAR(512) NOT NULL,
  resolved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_payroll_exception_run (payroll_run_id, severity),
  CONSTRAINT fk_pe_run FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS site_assets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id INT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  asset_type VARCHAR(64) NOT NULL,
  status ENUM('active', 'maintenance', 'retired') NOT NULL DEFAULT 'active',
  lat DECIMAL(10, 7) NULL,
  lng DECIMAL(10, 7) NULL,
  notes VARCHAR(1024) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_site_asset_site (site_id, status),
  CONSTRAINT fk_site_asset_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
