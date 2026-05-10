-- Optional: restrict supervisors to specific sites (empty table = no restriction for supervisors)

CREATE TABLE IF NOT EXISTS user_site_access (
  user_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, site_id),
  KEY idx_usa_site (site_id),
  CONSTRAINT fk_usa_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_usa_site FOREIGN KEY (site_id) REFERENCES sites (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
