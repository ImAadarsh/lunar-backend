-- Replace employee certifications and role-based training with guard↔site training assignments.

DROP TABLE IF EXISTS training_completions;
DROP TABLE IF EXISTS training_requirements;
DROP TABLE IF EXISTS employee_certifications;

CREATE TABLE IF NOT EXISTS guard_site_training (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  trained_on DATE NULL,
  notes VARCHAR(512) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_guard_site_training (user_id, site_id),
  KEY idx_guard_site_training_site (site_id),
  KEY idx_guard_site_training_user (user_id),
  CONSTRAINT fk_guard_site_training_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_guard_site_training_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_guard_site_training_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
