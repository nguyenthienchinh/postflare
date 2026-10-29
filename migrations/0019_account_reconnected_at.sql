-- When an existing account was last connected again (OAuth reconnect or re-entered credentials); NULL = never.
-- `updated_at` also moves on token refreshes and status changes, so it cannot tell a reconnect apart.
ALTER TABLE accounts ADD COLUMN reconnected_at INTEGER;
