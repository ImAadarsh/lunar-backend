-- Guard HR profile fields (imported from roster / SIA licence spreadsheet).

CREATE TABLE IF NOT EXISTS guard_profiles (
  user_id INT UNSIGNED NOT NULL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  given_names VARCHAR(128) NULL,
  surname VARCHAR(128) NULL,
  gender VARCHAR(32) NULL,
  date_of_birth DATE NULL,
  sia_type VARCHAR(128) NULL,
  sia_number VARCHAR(64) NULL,
  sia_expiry_date DATE NULL,
  import_source VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_guard_profiles_sia_expiry (sia_expiry_date),
  KEY idx_guard_profiles_full_name (full_name),
  CONSTRAINT fk_guard_profiles_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
