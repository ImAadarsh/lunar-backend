-- Add payroll line items, export job metadata, optional hourly pay on users.

ALTER TABLE users
  ADD COLUMN pay_rate_pence_hour INT UNSIGNED NULL DEFAULT NULL
    COMMENT 'Gross pay per hour in pence. NULL uses system default' AFTER status;

ALTER TABLE export_jobs
  ADD COLUMN params JSON NULL AFTER type,
  ADD COLUMN file_path VARCHAR(512) NULL AFTER file_url,
  ADD COLUMN error_message VARCHAR(1024) NULL AFTER file_path;

ALTER TABLE payroll_runs
  ADD COLUMN result_json JSON NULL COMMENT 'Summary + line ids' AFTER notes;

CREATE TABLE IF NOT EXISTS payroll_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  hours_worked DECIMAL(10, 2) NOT NULL,
  gross_pence BIGINT NOT NULL,
  paye_pence BIGINT NOT NULL,
  ni_employee_pence BIGINT NOT NULL,
  ni_employer_pence BIGINT NOT NULL,
  net_pence BIGINT NOT NULL,
  meta_json JSON NULL,
  KEY idx_pl_run (payroll_run_id),
  KEY idx_pl_user (user_id),
  CONSTRAINT fk_pl_run FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_pl_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
