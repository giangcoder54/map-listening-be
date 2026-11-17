-- Tags for the video library (/admin/library): what each video is about, what kind of video it
-- is and how hard it is to follow, so lessons and extensive-listening sets can be built by query.
--
-- Three layers per video; the effective value is manual -> ai -> channel default:
--   computed  from the transcript (lib/videoTags.ts): speed, rare words, turns, noise, level
--   ai        topic / subtopics / content type picked by the AI from the lists below
--   manual    set by an editor in /admin/library, always wins
--
-- Topics live in video_topics so editors can add or rename them; content types are fixed in code.
-- Rollback at the bottom.

create table if not exists video_topics (
    code        text primary key,           -- daily_life, food ... (what the AI answers)
    name        text not null,              -- shown to editors
    hint        text,                       -- one line for the AI: what belongs here
    sort        int default 0
);

insert into video_topics (code, name, hint, sort) values
  ('daily_life', 'Đời sống hằng ngày', 'everyday routines, home, shopping, chatting about ordinary life', 10),
  ('food', 'Ẩm thực, nấu ăn', 'cooking, recipes, restaurants, street food, eating challenges', 20),
  ('travel', 'Du lịch', 'trips, places, cities, countries, transport', 30),
  ('work_business', 'Công việc, kinh doanh', 'jobs, careers, companies, management, workplace', 40),
  ('money_economy', 'Tiền bạc, kinh tế', 'economies, markets, prices, personal finance', 50),
  ('science', 'Khoa học', 'physics, space, biology, chemistry, maths, how things work', 60),
  ('technology', 'Công nghệ', 'computers, AI, internet, gadgets, apps, design of software', 70),
  ('health', 'Sức khoẻ', 'body, medicine, diet, exercise, mental health', 80),
  ('relationships', 'Quan hệ, gia đình, tình cảm', 'dating, family, friends, parenting', 90),
  ('self_improvement', 'Phát triển bản thân', 'motivation, habits, productivity, life advice', 100),
  ('entertainment_celebrity', 'Giải trí, người nổi tiếng', 'celebrities, talk shows, game shows, pop culture', 110),
  ('film_story', 'Phim, truyện', 'scenes from films or series, trailers, fiction and stories', 120),
  ('sports', 'Thể thao', 'sport, athletes, matches, wrestling', 130),
  ('education_language', 'Học tiếng Anh, giáo dục', 'English lessons, pronunciation, exams like IELTS, school and learning', 140),
  ('history_culture', 'Lịch sử, văn hoá', 'history, traditions, cultures, folk tales', 150),
  ('society_news', 'Xã hội, tin tức', 'news, politics, social issues, public speeches', 160),
  ('nature_animals', 'Thiên nhiên, động vật', 'animals, plants, environment, national parks', 170),
  ('arts_literature', 'Nghệ thuật, âm nhạc, văn học', 'music, singing, poetry, books, painting', 180)
on conflict (code) do nothing;

create table if not exists channel_tags (
    channel_name   text primary key,
    topic          text references video_topics(code) on update cascade on delete set null,
    content_type   text,
    accent         text,          -- us | uk | au | mixed ...
    note           text,
    date_updated   timestamptz default now()
);

create table if not exists video_tags (
    source_video_id uuid primary key references source_videos(id) on delete cascade,
    duration_s      int,
    word_count      int,
    wpm             numeric(5,1),
    rare_ratio      numeric(4,3),
    avg_cue_words   numeric(4,1),
    speaker_turns   int,
    noise_ratio     numeric(4,3),
    level           smallint,
    level_why       text,
    signals_at      timestamptz,
    ai_topic        text,
    ai_subtopics    text[],
    ai_content_type text,
    ai_confidence   text,
    ai_reason       text,
    ai_at           timestamptz,
    topic           text,
    subtopics       text[],
    content_type    text,
    level_manual    smallint,
    editor_pick     boolean default false,
    note            text,
    date_updated    timestamptz default now()
);

-- Added after the first run
alter table video_tags add column if not exists score        numeric(5,2);  -- raw difficulty before the content-type bump
alter table video_tags add column if not exists speech_ratio numeric(4,3);  -- speaking time / length (IELTS drills are mostly silence)
alter table video_tags add column if not exists known_ratio  numeric(4,3);  -- share of tokens that are library words (broken subtitles are low)
alter table video_tags add column if not exists broken       boolean default false;
alter table video_tags add column if not exists ai_error     text;

-- Channel options: take the channel's topic / type for every video (the AI skips them), or let the
-- AI pick only among some topics (a channel like TED-Ed covers science, history, health...)
alter table channel_tags add column if not exists apply_all      boolean default false;
alter table channel_tags add column if not exists allowed_topics text[];

create index if not exists video_tags_level_idx on video_tags(level);
create index if not exists video_tags_ai_topic_idx on video_tags(ai_topic);
create index if not exists video_tags_topic_idx on video_tags(topic);
create index if not exists source_videos_channel_idx on source_videos(channel_name);

-- Rollback:
-- drop table if exists video_tags; drop table if exists channel_tags; drop table if exists video_topics;
-- drop index if exists source_videos_channel_idx;
