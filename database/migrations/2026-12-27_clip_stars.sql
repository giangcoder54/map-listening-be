-- Ngôi sao may mắn only on marked clips ("câu thử thách"), set by the team in the admin.
--   star_on    the clip can take a star
--   star_win   Kim cương won when right; NULL = by difficulty (COIN.star.easy / medium / hard)
--   star_lose  Kim cương lost when wrong; NULL = star_win (or the difficulty's win) x COIN.star.losePct %
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS star_on   boolean  NOT NULL DEFAULT false;
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS star_win  smallint CHECK (star_win  IS NULL OR star_win  BETWEEN 1 AND 500);
ALTER TABLE listening_clips ADD COLUMN IF NOT EXISTS star_lose smallint CHECK (star_lose IS NULL OR star_lose BETWEEN 1 AND 500);

-- A start: the hard clips that are drawn into runs. The team changes it from the lesson page.
UPDATE listening_clips SET star_on = true WHERE difficulty = 3 AND role IN ('pool', 'trap', 'challenge') AND status = 'published';
