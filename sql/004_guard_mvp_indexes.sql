ALTER TABLE incidents
  ADD INDEX idx_incidents_user_created (user_id, created_at);

ALTER TABLE attendance_sessions
  ADD INDEX idx_att_user_status (user_id, status, check_in_at);

ALTER TABLE media_assets
  ADD INDEX idx_media_kind_created (kind, created_at);
