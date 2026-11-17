-- Extensive Listening, part 2: what a learner gets after listening, and resuming a lesson.
--   el_lessons.summary / explore   short summary and "did you know" lines (Vietnamese: the authoring language)
--   el_vocab        5-8 words or phrases worth learning in the lesson (term + forms heard + meaning)
--   el_notes        people, organisations, places, culture the learner may not know (before = shown before listening)
--   el_line_subs    a translation of each transcript line, one row per language (lang 'vi-VN', 'th-TH'...)
--   el_translations the other learner text in other languages: key = summary | explore:0 | vocab:<n> | note:<n> |
--                   note_extra:<n> | title | intro | listen_for | q:<question id>:prompt | q:<id>:o<i> | q:<id>:explain
--                   (Vietnamese stays in the base columns; a new language = new rows here and in el_line_subs)
--   el_saved_words  words a learner saved for review
--   el_attempts.kind  first | redo (a redo counts minutes only: no XP, no Level move)
--   el_attempts.part  the part the learner reached, to resume
-- Run after 2026-11-17_extensive_listening.sql. Rollback at the bottom.

alter table el_lessons add column if not exists summary text;
alter table el_lessons add column if not exists explore text[];

create table if not exists el_vocab (
    id        uuid primary key default gen_random_uuid(),
    lesson_id uuid not null references el_lessons(id) on delete cascade,
    n         smallint not null,
    term      text not null,
    forms     text[] not null default '{}',   -- the forms heard in the video (frighten, frightened)
    kind      text not null default 'word',   -- word | phrase
    meaning   text not null,
    at_start  int,                            -- ms: a line of the video that has it
    at_end    int,
    unique (lesson_id, n)
);

create table if not exists el_notes (
    id        uuid primary key default gen_random_uuid(),
    lesson_id uuid not null references el_lessons(id) on delete cascade,
    n         smallint not null,
    term      text not null,
    forms     text[] not null default '{}',
    kind      text not null default 'culture', -- person | org | place | culture | idiom
    explain   text not null,
    extra     text,                            -- a related fact, shown after listening
    before    boolean not null default false,  -- shown before listening (must not give an answer away)
    unique (lesson_id, n)
);

create table if not exists el_line_subs (
    lesson_id uuid not null references el_lessons(id) on delete cascade,
    lang      text not null,
    start_ms  int not null,                    -- the transcript line's start
    text      text not null,                   -- **word to learn**  {{note}}
    primary key (lesson_id, lang, start_ms)
);

create table if not exists el_translations (
    lesson_id uuid not null references el_lessons(id) on delete cascade,
    lang      text not null,
    key       text not null,
    text      text not null,
    primary key (lesson_id, lang, key)
);

create table if not exists el_saved_words (
    user_id      uuid not null references directus_users(id) on delete cascade,
    vocab_id     uuid not null references el_vocab(id) on delete cascade,
    date_created timestamptz default now(),
    primary key (user_id, vocab_id)
);

alter table el_attempts add column if not exists kind text not null default 'first';
alter table el_attempts add column if not exists part smallint not null default 0;
do $$ begin
  alter table el_attempts add constraint el_attempts_kind_check check (kind in ('first', 'redo'));
exception when duplicate_object then null; end $$;

-- Rollback:
-- drop table if exists el_saved_words; drop table if exists el_translations; drop table if exists el_line_subs;
-- drop table if exists el_notes; drop table if exists el_vocab;
-- alter table el_lessons drop column if exists summary, drop column if exists explore;
-- alter table el_attempts drop constraint if exists el_attempts_kind_check, drop column if exists kind, drop column if exists part;
