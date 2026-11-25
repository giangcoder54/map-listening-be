-- Luyện cùng voice: 15 minutes per room, counted from the first time a player joins the call (lib/voice.ts).
ALTER TABLE coop_rooms ADD COLUMN IF NOT EXISTS voice_started_at timestamptz;
