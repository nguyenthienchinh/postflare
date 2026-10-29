-- Account avatars copied to R2 (worker/lib/avatars.ts): platforms hand out signed, expiring picture URLs (Instagram,
-- Facebook, TikTok...). When the avatar was last copied or re-checked; NULL = never (the frequent cron picks these up
-- first, a few per tick, so existing accounts get their copy without a manual step).
ALTER TABLE accounts ADD COLUMN avatar_checked_at INTEGER;
