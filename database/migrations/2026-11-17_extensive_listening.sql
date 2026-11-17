-- Extensive Listening: long, easy-enough videos heard in one go, a short check after each part.
--   el_lessons     one per video (a range of it), Level 1..10 from video_tags, a "listen for" question
--   el_segments    the parts of the range (1-3 min each, cut where the talk turns)
--   el_questions   one or two per part (seg_id) + the closing question (seg_id null, final = true),
--                  3 options, the answer, the transcript line it comes from (answer_start/end, ms)
--   el_attempts    a learner's go at a lesson: answers, subtitles on, replays, self rating
--   el_levels      a learner's Extensive Listening Level and its history
-- Lessons are written by Claude (docs/giao-trinh/tools/el_*.py) as drafts, reviewed in
-- /admin/library?tab=extensive. Run after 2026-11-16_video_tags.sql. Rollback at the bottom.

create table if not exists el_lessons (
    id              uuid primary key default gen_random_uuid(),
    short_id        text unique not null default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
    source_video_id uuid not null references source_videos(id) on delete cascade,
    title           text not null,              -- shown to learners (Vietnamese ok)
    level           smallint not null check (level between 1 and 10),
    topic           text references video_topics(code) on update cascade on delete set null,
    start_ms        int not null default 0,
    end_ms          int not null,
    listen_for      text not null,              -- the question shown before listening (= the final one)
    intro           text,                       -- one line of context, optional
    status          text not null default 'draft' check (status in ('draft', 'published', 'hidden')),
    is_premium      boolean not null default false,
    note            text,                       -- for editors
    sort            int default 0,
    date_created    timestamptz default now(),
    date_updated    timestamptz default now()
);
create index if not exists el_lessons_level_idx on el_lessons(status, level);
create index if not exists el_lessons_video_idx on el_lessons(source_video_id);

create table if not exists el_segments (
    id          uuid primary key default gen_random_uuid(),
    lesson_id   uuid not null references el_lessons(id) on delete cascade,
    n           smallint not null,              -- 1, 2, 3...
    start_ms    int not null,
    end_ms      int not null,
    unique (lesson_id, n)
);

create table if not exists el_questions (
    id            uuid primary key default gen_random_uuid(),
    lesson_id     uuid not null references el_lessons(id) on delete cascade,
    segment_id    uuid references el_segments(id) on delete cascade,  -- null: the closing question
    n             smallint not null default 1,
    prompt        text not null,
    options       jsonb not null,               -- ["...", "...", "..."]
    answer        smallint not null,            -- index into options
    explain       text,                         -- one line: why
    answer_start  int,                          -- ms: the line the answer is heard in (replayed on a miss)
    answer_end    int,
    kind          text default 'gist'           -- gist | detail | why | attitude
);
create index if not exists el_questions_lesson_idx on el_questions(lesson_id);

create table if not exists el_attempts (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references directus_users(id) on delete cascade,
    lesson_id     uuid not null references el_lessons(id) on delete cascade,
    level         smallint,                     -- the lesson's Level when heard
    answers       jsonb not null default '{}',  -- { question_id: { choice, right, replay } }
    right_count   smallint default 0,
    total         smallint default 0,
    subs_used     boolean default false,
    replays       smallint default 0,
    self_rating   text check (self_rating in ('most', 'half', 'little')),
    listened_s    int default 0,
    move          smallint,                     -- -1, 0, +1 on the learner's Level
    finished_at   timestamptz,
    date_created  timestamptz default now()
);
create index if not exists el_attempts_user_idx on el_attempts(user_id, date_created desc);
create index if not exists el_attempts_lesson_idx on el_attempts(lesson_id);

create table if not exists el_levels (
    user_id       uuid primary key references directus_users(id) on delete cascade,
    level         smallint not null default 3,
    source        text default 'default',       -- default | placement | moved
    history       jsonb not null default '[]',  -- [{ at, from, to, attempt }]
    intro_seen    boolean default false,
    date_updated  timestamptz default now()
);

-- XP for a lesson heard to the end (lib/xp.ts)
ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check
	CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test', 'phrase', 'phrase_review', 'extensive'));

-- Rollback:
-- drop table if exists el_attempts; drop table if exists el_levels; drop table if exists el_questions;
-- drop table if exists el_segments; drop table if exists el_lessons;
-- ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_reason_check;
-- ALTER TABLE xp_events ADD CONSTRAINT xp_events_reason_check
--   CHECK (reason IN ('lesson', 'replay', 'review', 'lesson_test', 'skill_test', 'phrase', 'phrase_review'));
