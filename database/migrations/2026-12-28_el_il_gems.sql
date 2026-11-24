-- Extensive and Intensive Listening pay Kim cuong when a passage is finished the first time (coin_events.reason)
ALTER TABLE coin_events DROP CONSTRAINT IF EXISTS coin_events_reason_check;
ALTER TABLE coin_events ADD CONSTRAINT coin_events_reason_check CHECK (reason IN (
	'lesson','perfect','goal','streak','review','ad','unlock','premium_day','freeze','retest','refund','admin','trap','streak_milestone',
	'skill_test','replay','phrase_unlock','ai','challenge','bank','star','chest','card','card_skip','recovery','purchase','chargeback',
	'room_fee','room_prize','help','coop','extensive','intensive'));
