-- Luyện cùng v3: the whole sentence is typed (dictation), docs/duel-and-coop-spec.md.
-- What each player typed (first, and after the talk) stays on the answer row.
ALTER TABLE coop_answers ADD COLUMN IF NOT EXISTS typed  text;
ALTER TABLE coop_answers ADD COLUMN IF NOT EXISTS typed2 text;

-- What learners really hear instead of a word: one row per (sentence, word, what was typed), counted when a room shows its answer.
-- Later the commonest ones become the wrong answers of Đấu (spelling slips are not counted: only misses).
CREATE TABLE IF NOT EXISTS dict_mishears (
	source varchar(4)  NOT NULL,           -- 'il' (il_sentences) or 'clip' (listening_clips)
	ref_id text        NOT NULL,
	word   varchar(60) NOT NULL,           -- the word in the sentence
	heard  varchar(60) NOT NULL,           -- what was typed in its place
	n      integer     NOT NULL DEFAULT 1,
	PRIMARY KEY (source, ref_id, word, heard)
);
