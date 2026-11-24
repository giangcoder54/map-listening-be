-- Đấu & Luyện cùng: who is still on the page. The browser pings every 10 s; a member silent for 45 s has left
-- (lib/coop.ts sweepPresence). NULL = never pinged (old rows): joined_at counts instead.
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS last_seen timestamptz;
