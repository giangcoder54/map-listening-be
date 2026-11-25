-- Saving a word failed with 'record "new" has no field "kind"': review_card_add (2026-12-03_review_cards.sql)
-- named NEW.kind inside a CASE, and PL/pgSQL looks the field up even when the other branch is taken.
-- user_words has no kind column; read it through jsonb, as review_card_drop does.
CREATE OR REPLACE FUNCTION review_card_add() RETURNS trigger AS $$
BEGIN
	INSERT INTO review_cards (user_id, kind, ref_id)
	VALUES (NEW.user_id, CASE TG_TABLE_NAME WHEN 'user_words' THEN 'word' ELSE to_jsonb(NEW)->>'kind' END, NEW.id)
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END $$ LANGUAGE plpgsql;
