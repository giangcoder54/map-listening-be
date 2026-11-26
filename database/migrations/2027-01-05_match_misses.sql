-- Match queue: only after 5 missed matches in a row is a learner kept out of the queue (lib/coop.ts missMatch).
ALTER TABLE match_bans ADD COLUMN IF NOT EXISTS misses smallint NOT NULL DEFAULT 0;
