-- Allow marking shifts as missed when guard does not check in by 50% of duty window
ALTER TABLE shifts
  MODIFY status ENUM('scheduled', 'active', 'completed', 'cancelled', 'missed') NOT NULL DEFAULT 'scheduled';
