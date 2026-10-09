-- Two starter posts (EN + VI) for the blog. Optional: read and edit them in /admin/blog
-- before running this on production. Safe to run twice (skips existing slugs).
BEGIN;

WITH p AS (
	INSERT INTO blog_posts (status, slug, author, tags, published_at)
	VALUES ('published', 'why-you-cant-understand-native-speakers', 'GuideLingo', 'listening,connected-speech', now())
	ON CONFLICT (slug) DO NOTHING
	RETURNING id
)
INSERT INTO blog_posts_translations (blog_posts_id, languages_code, title, excerpt, seo_description, content)
SELECT p.id, v.lang, v.title, v.excerpt, v.excerpt, v.content FROM p, (VALUES
('en-US',
 'Why you can''t understand native speakers (and how to fix it)',
 'You know the words, yet a film still sounds like one long blur. The problem is rarely vocabulary: it is how words change when people speak fast.',
$md$You read English well. You know most of the words in a TV series. And yet, when two characters talk, it sounds like one long blur.

That is not a vocabulary problem. It is a **connected speech** problem.

## Words do not sound the same in a sentence

A dictionary teaches you how a word sounds alone. Real speakers never say words alone. They join them, shorten them and drop sounds:

- **"tell him"** becomes *tell-im*: the /h/ disappears (H-dropping).
- **"going to"** becomes *gonna*, **"want to"** becomes *wanna*.
- **"turn it off"** becomes *tur-ni-toff*: the last consonant moves to the next word (linking).

Your brain is waiting for *tell* + *him*. It hears *tellim*, finds no match, and you lose the next three seconds of the sentence.

## The fix: train your ear on the changes, not the words

Listening more helps, but slowly. What works faster is to practise **one sound change at a time**, with short clips from real videos, until your ear expects it:

1. Hear a 2-second clip.
2. Type what you heard.
3. Compare, replay slowly, try again.

After a few dozen clips of the same pattern, *tellim* stops being noise and becomes "tell him".

{{cta:/listening-lab/skill/h-dropping|Practise H-dropping with real clips}}

## Where to start

Not sure which patterns trip you up? Take the 3-minute placement test: 10 real clips, and you get the skills to work on first.

{{cta:/placement-test|Take the free listening test}}
$md$),
('vi-VN',
 'Vì sao bạn không nghe được người bản xứ (và cách khắc phục)',
 'Bạn biết hết từ, nhưng xem phim vẫn chỉ nghe thấy một tràng âm thanh dính vào nhau. Vấn đề hiếm khi là từ vựng: mà là cách từ biến đổi khi người ta nói nhanh.',
$md$Bạn đọc tiếng Anh tốt. Bạn biết gần hết từ trong một tập phim. Vậy mà khi hai nhân vật nói chuyện, mọi thứ nghe như một tràng âm thanh dính vào nhau.

Đó không phải vấn đề từ vựng. Đó là vấn đề **nối âm (connected speech)**.

## Từ trong câu không nghe giống từ đứng một mình

Từ điển dạy bạn một từ đọc thế nào khi đứng riêng. Người bản xứ thì không bao giờ nói từng từ riêng lẻ. Họ nối, rút gọn và nuốt âm:

- **"tell him"** thành *tell-im*: âm /h/ biến mất (H-dropping).
- **"going to"** thành *gonna*, **"want to"** thành *wanna*.
- **"turn it off"** thành *tur-ni-toff*: phụ âm cuối nhảy sang từ sau (nối âm).

Não bạn đang chờ *tell* + *him*. Nó nghe *tellim*, không khớp với gì cả, và bạn lỡ luôn ba giây tiếp theo của câu.

## Cách sửa: luyện tai với các biến đổi, không phải với từ

Nghe nhiều cũng có ích, nhưng chậm. Cách nhanh hơn là luyện **từng kiểu biến đổi một**, bằng các đoạn clip ngắn trong video thật, cho tới khi tai bạn quen:

1. Nghe một đoạn 2 giây.
2. Gõ lại những gì bạn nghe.
3. So sánh, nghe chậm lại, thử lần nữa.

Sau vài chục clip cùng một kiểu, *tellim* không còn là tiếng ồn nữa mà là "tell him".

{{cta:/listening-lab/skill/h-dropping|Luyện H-dropping với clip thật}}

## Bắt đầu từ đâu

Chưa biết kiểu nào làm bạn vấp? Làm bài test 3 phút: 10 đoạn clip thật, xong là biết nên luyện kỹ năng nào trước.

{{cta:/placement-test|Làm bài test nghe miễn phí}}
$md$)
) AS v(lang, title, excerpt, content);

WITH p AS (
	INSERT INTO blog_posts (status, slug, author, tags, published_at)
	VALUES ('published', 'gonna-wanna-gotta', 'GuideLingo', 'listening,reductions', now() - interval '1 day')
	ON CONFLICT (slug) DO NOTHING
	RETURNING id
)
INSERT INTO blog_posts_translations (blog_posts_id, languages_code, title, excerpt, seo_description, content)
SELECT p.id, v.lang, v.title, v.excerpt, v.excerpt, v.content FROM p, (VALUES
('en-US',
 'Gonna, wanna, gotta: the reductions you hear in every film',
 'Native speakers rarely say "going to" or "want to" in full. Learn the five reductions that cover most of everyday speech.',
$md$Native speakers rarely say **"going to"**, **"want to"** or **"got to"** in full. In films, podcasts and real conversations you hear the short forms:

| Written | Spoken |
|---|---|
| going to | gonna |
| want to | wanna |
| got to | gotta |
| don't know | dunno |
| let me | lemme |

## Why this matters

If your ear only knows the full forms, every *gonna* is a small surprise. Small surprises add up: by the end of the sentence you are still decoding the beginning.

## You do not have to say them

You can keep speaking clearly. The point is to **recognise** them instantly. That only comes from hearing them many times, in real voices, at real speed.

{{cta:/listening-lab/skill/informal-reductions|Practise Gonna & Wanna}}
$md$),
('vi-VN',
 'Gonna, wanna, gotta: những dạng rút gọn bạn nghe trong mọi bộ phim',
 'Người bản xứ hiếm khi nói đủ "going to" hay "want to". Học 5 dạng rút gọn chiếm phần lớn lời nói hằng ngày.',
$md$Người bản xứ hiếm khi nói đủ **"going to"**, **"want to"** hay **"got to"**. Trong phim, podcast và hội thoại thật, bạn sẽ nghe dạng rút gọn:

| Viết | Nói |
|---|---|
| going to | gonna |
| want to | wanna |
| got to | gotta |
| don't know | dunno |
| let me | lemme |

## Vì sao quan trọng

Nếu tai bạn chỉ quen dạng đầy đủ, mỗi lần nghe *gonna* là một lần bất ngờ nhỏ. Bất ngờ nhỏ cộng dồn lại: tới cuối câu bạn vẫn đang giải mã đầu câu.

## Bạn không cần nói theo

Bạn vẫn có thể nói rõ ràng. Mục tiêu là **nhận ra ngay** khi nghe. Điều đó chỉ đến khi bạn nghe chúng nhiều lần, bằng giọng thật, ở tốc độ thật.

{{cta:/listening-lab/skill/informal-reductions|Luyện Gonna & Wanna}}
$md$)
) AS v(lang, title, excerpt, content);

COMMIT;
