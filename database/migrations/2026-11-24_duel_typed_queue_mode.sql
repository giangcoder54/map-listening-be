-- Đấu is typed too (points per answer are kept), and the queue serves both modes (Đấu and "Tìm bạn luyện" of Luyện cùng)
ALTER TABLE coop_answers ADD COLUMN IF NOT EXISTS points integer NOT NULL DEFAULT 0;
ALTER TABLE match_queue  ADD COLUMN IF NOT EXISTS mode varchar(8) NOT NULL DEFAULT 'duel';
