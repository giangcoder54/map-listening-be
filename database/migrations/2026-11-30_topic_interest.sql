-- Topics a learner said they like, for the "For you" row on the Extensive / Intensive lobbies (lib/recommend.ts).
--   user_topic_prefs    one row per topic the learner picked
--   user_topic_survey   the learner answered (or skipped) the question, so it is not asked again
-- What the learner then does (lessons finished or left half-way, in el_attempts / il_attempts) moves the
-- interest after that; the picks are only the starting point. No learner text here: topic names are in
-- video_topic_translations. Guests keep their picks in the browser and send them as ?topics=.

create table if not exists user_topic_prefs (
    user_id      uuid not null references directus_users(id) on delete cascade,
    topic        text not null references video_topics(code) on update cascade on delete cascade,
    date_created timestamptz not null default now(),
    primary key (user_id, topic)
);

create table if not exists user_topic_survey (
    user_id      uuid primary key references directus_users(id) on delete cascade,
    skipped      boolean not null default false,
    date_updated timestamptz not null default now()
);

-- Rollback:
-- drop table if exists user_topic_prefs;
-- drop table if exists user_topic_survey;
