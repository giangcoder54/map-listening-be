-- The learner's own marks on a checked sentence ([{ idx: word indexes, kind: new|blur|other|spell }]), shown again on the result page
ALTER TABLE il_results ADD COLUMN IF NOT EXISTS marks jsonb NOT NULL DEFAULT '[]'::jsonb;
