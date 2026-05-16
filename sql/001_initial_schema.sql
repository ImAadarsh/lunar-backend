-- Lunar Security — initial schema (InnoDB, utf8mb4)
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS export_jobs;
DROP TABLE IF EXISTS payroll_runs;
DROP TABLE IF EXISTS incident_attachments;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS patrol_scans;
DROP TABLE IF EXISTS gps_points;
DROP TABLE IF EXISTS attendance_sessions;
DROP TABLE IF EXISTS shift_swaps;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS shift_templates;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS roles;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE roles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_roles_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(32) DEFAULT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT UNSIGNED NOT NULL,
  status ENUM('active', 'invited', 'suspended') NOT NULL DEFAULT 'active',
  two_factor_enabled TINYINT(1) NOT NULL DEFAULT 0,
  two_factor_secret VARBINARY(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_users_email (email),
  KEY idx_users_role (role_id),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE refresh_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME DEFAULT NULL,
  KEY idx_refresh_user (user_id),
  KEY idx_refresh_expires (expires_at),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED DEFAULT NULL,
  action VARCHAR(128) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) DEFAULT NULL,
  payload JSON DEFAULT NULL,
  ip VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_user (user_id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sites (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(512) DEFAULT NULL,
  center_lat DECIMAL(10, 7) NOT NULL,
  center_lng DECIMAL(10, 7) NOT NULL,
  geofence_radius_m INT UNSIGNED DEFAULT NULL,
  geofence_polygon JSON DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_sites_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE checkpoints (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id INT UNSIGNED NOT NULL,
  label VARCHAR(255) NOT NULL,
  qr_code VARCHAR(64) NOT NULL,
  lat DECIMAL(10, 7) NOT NULL,
  lng DECIMAL(10, 7) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_checkpoints_qr (qr_code),
  KEY idx_checkpoints_site (site_id),
  CONSTRAINT fk_checkpoints_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shift_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  recurrence JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shifts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  template_id INT UNSIGNED DEFAULT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  status ENUM('scheduled', 'active', 'completed', 'cancelled') NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_shifts_site_time (site_id, starts_at),
  KEY idx_shifts_user_time (user_id, starts_at),
  KEY idx_shifts_status (status),
  CONSTRAINT fk_shifts_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_shifts_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_shifts_template FOREIGN KEY (template_id) REFERENCES shift_templates (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shift_swaps (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shift_id BIGINT UNSIGNED NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  target_user_id INT UNSIGNED DEFAULT NULL,
  status ENUM('pending', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME DEFAULT NULL,
  KEY idx_swap_shift (shift_id),
  CONSTRAINT fk_swap_shift FOREIGN KEY (shift_id) REFERENCES shifts (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_swap_requester FOREIGN KEY (requested_by) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_swap_target FOREIGN KEY (target_user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE attendance_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  shift_id BIGINT UNSIGNED NOT NULL,
  check_in_at DATETIME NOT NULL,
  check_out_at DATETIME DEFAULT NULL,
  check_in_lat DECIMAL(10, 7) NOT NULL,
  check_in_lng DECIMAL(10, 7) NOT NULL,
  check_out_lat DECIMAL(10, 7) DEFAULT NULL,
  check_out_lng DECIMAL(10, 7) DEFAULT NULL,
  inside_geofence_in TINYINT(1) NOT NULL DEFAULT 1,
  inside_geofence_out TINYINT(1) DEFAULT NULL,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  KEY idx_att_user (user_id),
  KEY idx_att_shift (shift_id),
  CONSTRAINT fk_att_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_att_shift FOREIGN KEY (shift_id) REFERENCES shifts (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE gps_points (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  shift_id BIGINT UNSIGNED NOT NULL,
  lat DECIMAL(10, 7) NOT NULL,
  lng DECIMAL(10, 7) NOT NULL,
  accuracy_m DECIMAL(8, 2) DEFAULT NULL,
  recorded_at DATETIME(3) NOT NULL,
  batch_id CHAR(36) DEFAULT NULL,
  KEY idx_gps_shift_time (shift_id, recorded_at),
  KEY idx_gps_user_time (user_id, recorded_at),
  CONSTRAINT fk_gps_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_gps_shift FOREIGN KEY (shift_id) REFERENCES shifts (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE patrol_scans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  checkpoint_id INT UNSIGNED NOT NULL,
  scanned_at DATETIME(3) NOT NULL,
  client_message_id CHAR(36) DEFAULT NULL,
  UNIQUE KEY uk_patrol_client (client_message_id),
  KEY idx_patrol_user_time (user_id, scanned_at),
  KEY idx_patrol_checkpoint (checkpoint_id),
  CONSTRAINT fk_patrol_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_patrol_checkpoint FOREIGN KEY (checkpoint_id) REFERENCES checkpoints (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE media_assets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  kind ENUM('visual_log', 'incident', 'profile', 'other') NOT NULL DEFAULT 'other',
  storage_key VARCHAR(512) NOT NULL,
  public_url VARCHAR(1024) DEFAULT NULL,
  mime VARCHAR(128) DEFAULT NULL,
  size_bytes INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_media_user (user_id),
  CONSTRAINT fk_media_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE incidents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  category VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status ENUM('open', 'in_review', 'closed') NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_incidents_site (site_id),
  KEY idx_incidents_status (status),
  CONSTRAINT fk_incidents_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_incidents_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE incident_attachments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  incident_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uk_inc_media (incident_id, media_id),
  CONSTRAINT fk_ia_incident FOREIGN KEY (incident_id) REFERENCES incidents (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ia_media FOREIGN KEY (media_id) REFERENCES media_assets (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sos_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  lat DECIMAL(10, 7) NOT NULL,
  lng DECIMAL(10, 7) NOT NULL,
  message VARCHAR(512) DEFAULT NULL,
  status ENUM('active', 'acknowledged', 'resolved') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME DEFAULT NULL,
  KEY idx_sos_status (status, created_at),
  KEY idx_sos_user (user_id),
  CONSTRAINT fk_sos_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payroll_runs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status ENUM('draft', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'draft',
  notes VARCHAR(512) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_payroll_period (period_start, period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE export_jobs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(64) NOT NULL,
  status ENUM('queued', 'running', 'done', 'failed') NOT NULL DEFAULT 'queued',
  file_url VARCHAR(1024) DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_export_status (status),
  CONSTRAINT fk_export_user FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles (slug, name) VALUES
  ('admin', 'Administrator'),
  ('supervisor', 'Supervisor'),
  ('guard', 'Guard')
ON DUPLICATE KEY UPDATE name = VALUES(name);
