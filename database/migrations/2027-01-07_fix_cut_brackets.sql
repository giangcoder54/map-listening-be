-- Clips whose [bracket] cut a word in two ("[title]s"): the answer was only half the word, and the
-- page could not mask it, so the question came with no transcript at all. Safe to run twice.
BEGIN;

CREATE TEMP TABLE fix (clip uuid, old text, new text) ON COMMIT DROP;
INSERT INTO fix VALUES
	('e522836f-8361-45ed-9d60-c0febe30a74f', '[title]s', '[titles]'),
	('57b6ac27-3bcd-4c0c-ba39-f406269d3321', '[title]s', '[titles]'),
	('ecc2858c-9bbd-47ee-8388-63f1d2b59f8b', '4.[5 MILLION]', '[4.5 MILLION]'),
	('d5306b64-4281-488a-85f4-a38a1b726442', '1/[10th]', '[1/10th]'),
	('203e51bf-f738-4d30-a7ad-23cbc1cbb9b8', '[50]-INCH', '[50-INCH]'),
	('7576850d-b74c-4804-9212-ab25852ae38c', '[$1].2', '[$1.2]'),
	('537c2c2c-f257-4c93-8d83-306748437ff7', '[$58]-$68', '[$58-$68]'),
	('bf201452-f919-4939-81d6-27c5f71d6ebd', '[than twenty]-five', '[than twenty-five]'),
	('cdbdf4de-bdb5-481d-8883-161a7989c77c', 'went...[I''d', 'went... [I''d'),
	('093a4ecb-2038-4634-afae-0a17b86ba026', '[Next it]''s', '[Next it''s]'),
	('29a226fe-9a90-450b-a2b5-53422b3c082d', 'HER--[ON', 'HER-- [ON');

UPDATE listening_clips c
SET transcript = replace(c.transcript, f.old, f.new),
	cues = replace(c.cues::text, f.old, f.new)::jsonb,
	date_updated = now()
FROM fix f
WHERE c.id = f.clip AND position(f.old in c.transcript) > 0;

-- The answer column and the other spellings that follow the longer answer
UPDATE listening_clips SET answer = 'than twenty-five', choices = '["than twenty-nine", "than thirty-five", "than twenty-four"]'
	WHERE id = 'bf201452-f919-4939-81d6-27c5f71d6ebd' AND answer = 'than twenty';
UPDATE listening_clips SET accept_also = 'four point five million | 4.5 million | 4500000 | 4,500,000'
	WHERE id = 'ecc2858c-9bbd-47ee-8388-63f1d2b59f8b';
UPDATE listening_clips SET accept_also = 'one tenth | a tenth | 1 10th'
	WHERE id = 'd5306b64-4281-488a-85f4-a38a1b726442';
UPDATE listening_clips SET accept_also = 'fifty inch | 50 inch'
	WHERE id = '203e51bf-f738-4d30-a7ad-23cbc1cbb9b8';

-- Practice step of the "titles" clip: wrong choices plural too, else the right one stands out
UPDATE listening_lessons l
SET practice = (
	SELECT jsonb_agg(CASE WHEN s->>'clip_id' = 'e522836f-8361-45ed-9d60-c0febe30a74f'
		THEN jsonb_set(s, '{wrong}', '["tiles", "tights", "totals"]') ELSE s END ORDER BY n)
	FROM jsonb_array_elements(l.practice::jsonb) WITH ORDINALITY AS x(s, n))
WHERE l.practice::text LIKE '%e522836f-8361-45ed-9d60-c0febe30a74f%';

COMMIT;
