-- Topic names in more than one language.
--   video_topics.name        stays the base (Vietnamese) name, shown to editors and when a translation is missing
--   video_topic_translations one row per topic and language (lang 'en-US', 'th-TH'...)
-- A new language = new rows here (and in el_translations / el_line_subs for lesson text); no code change.
-- Lesson titles live in el_translations (key = 'title'). Run after 2026-11-16_video_tags.sql.

create table if not exists video_topic_translations (
    code  text not null references video_topics(code) on update cascade on delete cascade,
    lang  text not null,
    name  text not null,
    primary key (code, lang)
);

insert into video_topic_translations (code, lang, name) values
  ('daily_life', 'en-US', 'Daily life'),
  ('food', 'en-US', 'Food & cooking'),
  ('travel', 'en-US', 'Travel'),
  ('work_business', 'en-US', 'Work & business'),
  ('money_economy', 'en-US', 'Money & economy'),
  ('science', 'en-US', 'Science'),
  ('technology', 'en-US', 'Technology'),
  ('health', 'en-US', 'Health'),
  ('relationships', 'en-US', 'Relationships & family'),
  ('self_improvement', 'en-US', 'Self-improvement'),
  ('entertainment_celebrity', 'en-US', 'Entertainment & celebrities'),
  ('film_story', 'en-US', 'Film & stories'),
  ('sports', 'en-US', 'Sports'),
  ('education_language', 'en-US', 'English learning & education'),
  ('history_culture', 'en-US', 'History & culture'),
  ('society_news', 'en-US', 'Society & news'),
  ('nature_animals', 'en-US', 'Nature & animals'),
  ('arts_literature', 'en-US', 'Arts, music & literature')
on conflict (code, lang) do nothing;

-- Rollback:
-- drop table if exists video_topic_translations;
