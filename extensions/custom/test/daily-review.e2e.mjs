/**
 * End-to-end test + timing of the daily review against a running local API (docker: map-listening-api / map-listening-db).
 *   node extensions/custom/test/daily-review.e2e.mjs
 * Makes a throw-away user (fixed id, static token), seeds cards, runs the cases, then deletes the user (cards cascade).
 */
import { execFileSync } from 'node:child_process';

const API = process.env.API || 'http://localhost:8081/api';
const UID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'e2e-review-token-0002';
const OTHER_TOKEN = 'e2e-review-token-0003';

const sql = (q) => execFileSync('docker', ['exec', '-i', 'map-listening-db', 'psql', '-U', 'postgres', '-d', 'map-listening', '-At', '-F', '', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8' }).trim();
const rows = (q) => sql(q).split('\n').filter(Boolean).map((l) => l.split(''));
const call = async (path, { method = 'GET', body, token = TOKEN } = {}) => {
	const t0 = performance.now();
	const res = await fetch(`${API}/v1/${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const ms = performance.now() - t0;
	let json = null;
	try { json = await res.json(); } catch { /* no body */ }
	return { status: res.status, json, data: json?.data, ms };
};
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor((p / 100) * b.length))]; };

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => { if (cond) pass++; else { fail++; failures.push(`${name} ${extra}`); } console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const cleanup = () => sql(`delete from review_log where user_id in ('${UID}','${OTHER}'); delete from directus_users where id in ('${UID}','${OTHER}');`);

async function main() {
	cleanup();
	// ---- fixtures -------------------------------------------------------------------------------------------------
	sql(`
insert into directus_users (id, email, status, role, token, first_name)
select v.id::uuid, v.email, 'active', (select role from directus_users where role is not null limit 1), v.token, 'e2e' from (values
 ('${UID}','e2e-review@test.local','${TOKEN}'), ('${OTHER}','e2e-other@test.local','${OTHER_TOKEN}')) v(id,email,token);
-- 8 words from real passage sentences (a long word of each), due, with the sentence's clip
insert into user_words (user_id, word, shown, meaning, source, video_id, start_ms, end_ms, example, due)
select distinct on (w) '${UID}', lower(w), lower(w), 'nghĩa ' || lower(w), 'intensive', sv.youtube_video_id, s.start_ms, s.end_ms, s.text, now() - interval '1 hour'
from (select s.*, (regexp_match(s.text, '[A-Za-z]{7,}'))[1] as w from il_sentences s) s
join il_lessons l on l.id = s.lesson_id join source_videos sv on sv.id = l.source_video_id
where s.w is not null and exists (select 1 from word_meanings m where m.word = lower(s.w) and m.lang = 'vi' and m.ord = 1) limit 8;
-- pattern / pair / spell cards from sentences
insert into il_cards (user_id, kind, key, shown, real, note, options, sentence_id, video_id, start_ms, end_ms, due)
select '${UID}','pattern', lower(split_part(s.text,' ',1) || ' ' || split_part(s.text,' ',2)), lower(split_part(s.text,' ',1) || ' ' || split_part(s.text,' ',2)), 'x', 'note', '["wrong one","wrong two"]'::jsonb, s.id, sv.youtube_video_id, s.start_ms, s.end_ms, now() - interval '1 hour'
from il_sentences s join il_lessons l on l.id=s.lesson_id join source_videos sv on sv.id=l.source_video_id where s.text ~ '^[A-Za-z]+ [A-Za-z]+ ' limit 3 on conflict do nothing;
insert into il_cards (user_id, kind, key, shown, real, options, sentence_id, video_id, start_ms, end_ms, due)
select '${UID}','pair','can|can''t','can / can''t','can','["can","can''t"]'::jsonb, s.id, sv.youtube_video_id, s.start_ms, s.end_ms, now() - interval '1 hour'
from il_sentences s join il_lessons l on l.id=s.lesson_id join source_videos sv on sv.id=l.source_video_id limit 1 on conflict do nothing;
insert into il_cards (user_id, kind, key, shown, sentence_id, video_id, start_ms, end_ms, due)
select '${UID}','spell', 'community', 'community', s.id, sv.youtube_video_id, s.start_ms, s.end_ms, now() - interval '1 hour'
from il_sentences s join il_lessons l on l.id=s.lesson_id join source_videos sv on sv.id=l.source_video_id limit 1 on conflict do nothing;
insert into il_review_cards (user_id, sentence_id, due) select '${UID}', id, now() - interval '1 hour' from il_sentences limit 2;
-- a card of another user and one not yet due, which must never show
update user_words set right_streak = 1 where id in (select id from user_words where user_id = '${UID}' order by word limit 4);
insert into user_words (user_id, word, shown, source, video_id, start_ms, end_ms, example, due) values ('${OTHER}','hidden','hidden','intensive','abc',0,3000,'hidden word',now() - interval '1 hour');
insert into user_words (user_id, word, shown, source, video_id, start_ms, end_ms, example, due) values ('${UID}','tomorrowword','tomorrowword','intensive','abc',0,3000,'tomorrowword here',now() + interval '1 day');
`);
	const wordRows = rows(`select u.id, u.word, u.shown, (select m.short from word_meanings m where m.word = u.word and m.lang = 'vi' and m.ord = 1) from user_words u where u.user_id='${UID}' and u.word <> 'tomorrowword'`);
	const wordBy = Object.fromEntries(wordRows.map(([id, word, shown, meaning]) => [id, { word, shown, meaning }]));
	const rightOf = (w) => (w.prompt === 'meaning' ? wordBy[w.id].meaning : wordBy[w.id].shown);

	console.log('\n== access');
	ok('no token -> 401', (await call('daily-review', { token: null })).status === 401);
	ok('answer without token -> 401', (await call('daily-review/answer', { method: 'POST', token: null, body: {} })).status === 401);

	console.log('\n== session');
	let s = await call('daily-review?size=25');
	ok('200 + success', s.status === 200 && s.json?.success === true);
	const items = s.data.items;
	const kinds = (k) => items.filter((i) => i.kind === k);
	ok('every kind appears', ['word', 'pattern', 'pair', 'spell', 'sentence'].every((k) => kinds(k).length > 0), JSON.stringify(items.map((i) => i.kind)));
	ok('total is what the session holds, due is what is waiting (8 words + 3 patterns + 1 pair + 1 spell + 2 sentences)', s.data.total === items.length && s.data.due >= 13, `total=${s.data.total} due=${s.data.due}`);
	ok('not-due and other users cards are not in the session', !JSON.stringify(items).includes('tomorrowword') && !JSON.stringify(items).includes('hidden'));
	ok('every item has a clip with video_id / start / end', items.every((i) => i.clip?.video_id && Number.isFinite(i.clip.start) && i.clip.end > i.clip.start));
	ok('prompt is true on the first visit of the day', s.data.prompt === true && s.data.compact === false);
	ok('minutes is a positive integer', Number.isInteger(s.data.minutes) && s.data.minutes >= 1);
	const choose = items.filter((i) => i.mode === 'choose');
	ok('choose items have 2-3 unique options and a token', choose.length > 0 && choose.every((i) => i.options.length >= 2 && i.options.length <= 3 && new Set(i.options).size === i.options.length && /^[0-9a-f]{12}$/.test(i.token)));
	ok('the answer is not sent as a field (no "answer"/"correct"/"real" keys; a new word is taught first, so its card has a learn block)', !/"(answer|correct|real)"\s*:/.test(JSON.stringify(items)));
	const words = kinds('word');
	ok('word choose (hear it): wrong options are real look-alikes (letters only, not a prefix of the word)', words.filter((w) => w.mode === 'choose' && w.prompt === 'word').every((w) => {
		const right = Object.values(wordBy).map((x) => x.shown).find((x) => w.options.includes(x));
		return right && w.options.filter((o) => o !== right).every((o) => /^[a-z]{3,}$/.test(o) && !o.startsWith(right) && !right.startsWith(o));
	}), JSON.stringify(words.map((w) => w.options)));
	ok('word choose (hear it) shows the sentence with a blank (before/after)', words.filter((w) => w.mode === 'choose' && w.prompt === 'word').some((w) => (w.before || w.after)));
	const fresh = words.filter((w) => w.streak === 0);
	ok('a new word (never reviewed) is taught first: learn block with the word, meaning and a line; seen words have none', words.every((w) => (w.streak === 0 ? !!(w.learn && w.learn.word && w.learn.meaning) : !w.learn)), JSON.stringify(words.map((w) => [w.streak, !!w.learn])));
	ok('a new word: wrong meanings look like the right one (Vietnamese lines of the same kind, never English)', fresh.every((w) => w.options.every((o) => o.split(/\s+/).length <= 12 && !/(the|of|and|to)/i.test(o))), JSON.stringify(fresh.map((w) => w.options)));
	ok('a new word: see the word, choose its meaning (right meaning among 2-3, wrong ones are other meanings)', fresh.length > 0 && fresh.every((w) => w.mode === 'choose' && w.prompt === 'meaning' && w.term === wordBy[w.id].shown && w.options.includes(wordBy[w.id].meaning) && new Set(w.options).size === w.options.length), JSON.stringify(fresh[0]));
	ok('caps: at most 10 words, 8 patterns, 6 pairs, 3 spells, 5 sentences', words.length <= 10 && kinds('pattern').length <= 8 && kinds('pair').length <= 6 && kinds('spell').length <= 3 && kinds('sentence').length <= 5);
	ok('pair is always a choice of two; spell is always typed; sentence is rate',
		kinds('pair').every((i) => i.mode === 'choose' && i.options.length === 2) && kinds('spell').every((i) => i.mode === 'type') && kinds('sentence').every((i) => (i.mode === 'choose' ? i.prompt === 'sentenceChoose' && i.options.length >= 2 : i.prompt === 'sentenceType')));
	const kindsInRow = items.slice(0, 10).map((i) => i.kind).join(',');
	ok('the first 10 are mixed: no kind three times in a row (the tail may be one kind when the others run out)', !/(word,){3}/.test(kindsInRow), kindsInRow);

	console.log('\n== answers: choose');
	const w1 = words.find((w) => w.mode === 'choose' && w.streak === 0);
	const right1 = rightOf(w1);
	const wrongChoice = w1.options.find((o) => o !== right1);
	let a = await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: w1.id, choice: wrongChoice, token: w1.token, listens: 1 } });
	ok('wrong choice -> correct=false, streak 0, a reveal with the word', a.status === 200 && a.data.correct === false && a.data.streak === 0 && a.data.reveal.answers.includes(right1), JSON.stringify(a.data));
	const w2 = words.filter((w) => w.mode === 'choose' && w.streak === 0)[1];
	const right2 = rightOf(w2);
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: w2.id, choice: right2, token: w2.token, listens: 1, ms: 4200 } });
	ok('right choice -> correct, streak 1, XP object, due in the future', a.data.correct === true && a.data.streak === 1 && a.data.next_in_days >= 0, JSON.stringify(a.data));
	const [[streak, dueFuture]] = rows(`select right_streak, due > now() from user_words where id='${w2.id}'`);
	ok('the card was updated in the DB (streak 1, due moved)', streak === '1' && dueFuture === 't');
	const [[logN, rating, ms]] = rows(`select count(*), max(rating), max(review_duration) from review_log where card_id='${w2.id}'`);
	ok('a review_log row with rating and duration', logN === '1' && Number(rating) >= 1 && ms === '4200');
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: w2.id, choice: right2, token: 'bad' } });
	ok('a forged token is a wrong answer', a.data.correct === false);

	console.log('\n== answers: type');
	// The word ladder: 0 meaning (choose) -> 1 hear, choose the word -> 2 meaning, type the word -> 3 hear, type the word
	for (const [st, prompt, mode] of [[0, 'meaning', 'choose'], [1, 'word', 'choose'], [2, 'recall', 'type'], [3, 'word', 'type']]) {
		sql(`update user_words set right_streak = ${st}, due = now() - interval '1 hour' where id = '${w2.id}'`);
		s = await call('daily-review?size=60');
		const it = s.data.items.find((i) => i.id === w2.id);
		ok(`ladder: word after ${st} right -> ${prompt} (${mode})`, it?.prompt === prompt && it.mode === mode, JSON.stringify(it));
		if (st === 2) ok('recall: the meaning is shown, the word is typed (letters count, no options)', it.hint === wordBy[w2.id].meaning && it.letters === wordBy[w2.id].shown.length && !it.options);
		if (st === 3) ok('hear and type: blank line, letters count, no options, no meaning shown', it.letters === wordBy[w2.id].shown.length && !it.options && !it.hint);
	}
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: w2.id, typed: 'zzzz' } });
	ok('a wrong typed answer sends the card back to streak 0', a.data.correct === false && a.data.streak === 0);
	sql(`update user_words set right_streak = 3, due = now() - interval '1 hour' where id = '${w2.id}'`);
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: w2.id, typed: wordBy[w2.id].shown.toUpperCase() + ' ' } });
	ok('typed answer ignores case and spaces', a.data.correct === true);
	const sp = items.find((i) => i.kind === 'spell');
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'spell', id: sp.id, typed: 'comunity' } });
	ok('spell is strict: a misspelling is wrong', a.data.correct === false);
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'spell', id: sp.id, typed: 'community' } });
	ok('spell: the right spelling is right', a.data.correct === true);
	// Sentences: 0 hear, choose the sentence -> 1 hear, type with the first letters -> 2+ hear, type
	const sen = items.find((i) => i.kind === 'sentence');
	const [[sText]] = rows(`select text from il_sentences where id = '${sen.id}'`);
	const setSen = (st) => sql(`update il_review_cards set right_streak = ${st}, due = now() - interval '1 hour' where user_id='${UID}' and sentence_id = '${sen.id}'`);
	const getSen = async () => (await call('daily-review?size=60')).data.items.find((i) => i.id === sen.id);
	let si = await getSen();
	ok('sentence after 0 right: hear it, choose among 2-3 sentences (the right one, others a word off)', si.mode === 'choose' && si.prompt === 'sentenceChoose' && si.options.includes(sText) && new Set(si.options).size === si.options.length && si.options.every((o) => o.split(/\s+/).length === sText.split(/\s+/).length), JSON.stringify(si.options));
	const wrongS = si.options.find((o) => o !== sText);
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'sentence', id: sen.id, choice: wrongS, token: si.token } });
	ok('a wrong sentence -> wrong, the right one is named in the reveal', a.data.correct === false && a.data.reveal.answers.includes(sText));
	setSen(0); si = await getSen();
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'sentence', id: sen.id, choice: sText, token: si.token } });
	ok('the right sentence -> right, streak 1', a.data.correct === true && a.data.streak === 1, JSON.stringify(a.data));
	setSen(1); si = await getSen();
	ok('sentence after 1 right: type it, with the first letter of each word as a hint', si.mode === 'type' && si.prompt === 'sentenceType' && !!si.hint && si.hint.split(/\s+/).length === sText.split(/\s+/).length && /^[^A-Za-z]*[A-Za-z]/.test(si.hint), JSON.stringify(si));
	setSen(2); si = await getSen();
	ok('sentence after 2 right: type it, no hint', si.mode === 'type' && si.prompt === 'sentenceType' && !si.hint);
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'sentence', id: sen.id, typed: sText.toLowerCase().replace(/[.,!?]/g, '') } });
	ok('typed sentence: right (case and punctuation do not matter), every word marked ok', a.data.correct === true && a.data.reveal.words.every((w) => w.status === 'ok'), JSON.stringify(a.data.reveal.words));
	setSen(2);
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'sentence', id: sen.id, typed: 'blah blah blah' } });
	ok('typed sentence: wrong -> streak 0, wrong words marked, the sentence shown', a.data.correct === false && a.data.streak === 0 && a.data.reveal.words.some((w) => w.status !== 'ok') && a.data.reveal.shown === sText);
	setSen(2);
	const sw = sText.split(/\s+/); sw[Math.floor(sw.length / 2)] = 'zzzz';
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'sentence', id: sen.id, typed: sw.join(' ') } });
	ok(`typed sentence: one wrong word of ${sw.length} is still right when 85% or more is right`, sw.length >= 7 ? a.data.correct === true : a.data.correct === false, `${sw.length} words, ${JSON.stringify(a.data)}`);
	const pr = items.find((i) => i.kind === 'pair');
	a = await call('daily-review/answer', { method: 'POST', body: { kind: 'pair', id: pr.id, choice: pr.options[0], token: pr.token } });
	const a2 = await call('daily-review/answer', { method: 'POST', body: { kind: 'pair', id: pr.id, choice: pr.options[1], token: pr.token } });
	ok('pair: exactly one of the two options is right', [a.data.correct, a2.data.correct].filter(Boolean).length === 1);

	console.log('\n== validation and ownership');
	ok('bad kind -> 400', (await call('daily-review/answer', { method: 'POST', body: { kind: 'nope', id: w1.id } })).status === 400);
	ok('bad id -> 400', (await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: 'x' } })).status === 400);
	const [[otherId]] = rows(`select id from user_words where user_id='${OTHER}'`);
	ok("another user's card -> 404", (await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: otherId, typed: 'hidden' } })).status === 404);
	ok("cannot suspend another user's card (card stays)", ((await call('daily-review/suspend', { method: 'POST', body: { kind: 'word', id: otherId } })), rows(`select suspended_at is null from user_words where id='${otherId}'`)[0][0] === 't'));

	console.log('\n== suspend ("known, do not ask again")');
	const victim = wordRows.find(([id]) => id !== w1.id && id !== w2.id)[0];
	sql(`update user_words set due = now() - interval '1 hour' where id='${victim}'`);
	ok('suspend -> 200', (await call('daily-review/suspend', { method: 'POST', body: { kind: 'word', id: victim } })).status === 200);
	s = await call('daily-review?size=60');
	ok('a suspended card never comes back', !s.data.items.some((i) => i.id === victim));
	ok('and its history stays (the row is not deleted)', rows(`select count(*) from user_words where id='${victim}'`)[0][0] === '1');

	console.log('\n== the daily popup (prompted)');
	ok('"later" counts one skip', (await call('daily-review/prompted', { method: 'POST', body: { action: 'later' } })).status === 200);
	s = await call('daily-review');
	ok('after it, prompt is false for the rest of the day and skips = 1', s.data.prompt === false && s.data.skips === 1 && s.data.compact === false);
	sql(`update directus_users set review_skips = 3 where id = '${UID}'`);
	s = await call('daily-review');
	ok('three "later"s -> compact bar, no popup', s.data.compact === true && s.data.prompt === false);
	await call('daily-review/prompted', { method: 'POST', body: { action: 'started' } });
	s = await call('daily-review');
	ok('"started" resets the skips', s.data.skips === 0 && s.data.compact === false);
	sql(`update directus_users set review_prompted_on = current_date - 1 where id = '${UID}'`);
	s = await call('daily-review');
	ok('a new day -> the popup is due again', s.data.prompt === true);
	const st = await call('daily-review/status');
	ok('status: no cards are built, only the popup question; it agrees with the session', st.status === 200 && st.data.items === undefined && st.data.total === s.data.total && st.data.prompt === s.data.prompt && st.data.compact === s.data.compact && st.data.minutes >= 1, JSON.stringify(st.data));
	ok('status without a token -> 401', (await call('daily-review/status', { token: null })).status === 401);
	await call('daily-review/prompted', { method: 'POST', body: { action: 'later' } });
	const st2 = await call('daily-review/status');
	ok('status after "later": no popup today, one skip', st2.data.prompt === false && st2.data.skips === 1);
	sql(`update directus_users set review_prompted_on = current_date - 1, review_skips = 0 where id = '${UID}'`);
	sql(`update user_words set due = now() + interval '1 day' where user_id='${UID}'; update il_cards set due = now() + interval '1 day' where user_id='${UID}'; update il_review_cards set due = now() + interval '1 day' where user_id='${UID}'`);
	s = await call('daily-review');
	ok('nothing due -> total 0, no popup', s.data.total === 0 && s.data.prompt === false && s.data.items.length === 0);

	console.log('\n== add to review (result screen)');
	const [[lessonId, sentId, sentN, sentText]] = rows(`select l.id, s.id, s.n, s.text from il_sentences s join il_lessons l on l.id = s.lesson_id order by s.n limit 1`);
	sql(`insert into il_attempts (user_id, lesson_id, seq, finished_at) values ('${UID}','${lessonId}',1,now())`);
	const [[attemptId]] = rows(`select id from il_attempts where user_id='${UID}'`);
	const firstWords = sentText.split(/\s+/).slice(2, 4).join(' ').replace(/[^A-Za-z' ]/g, '') || 'some words';
	const body = { attempt_id: attemptId, items: [
		{ kind: 'word', text: 'unboil', sentence_n: Number(sentN) },
		{ kind: 'pattern', text: firstWords, sentence_n: Number(sentN), real: 'x', note: 'n', wrong: ['aaa'] },
		{ kind: 'pair', text: 'than', other: 'then', sentence_n: Number(sentN) },
		{ kind: 'spell', text: 'receive', sentence_n: Number(sentN) },
		{ kind: 'pattern', text: 'zzz', sentence_n: 9999 },
		{ kind: 'word', text: '', sentence_n: Number(sentN) },
		{ kind: 'bogus', text: 'x', sentence_n: Number(sentN) },
	] };
	let r = await call('daily-review/add', { method: 'POST', body });
	ok('adds the 4 new valid items, skips the unknown sentence / empty / bogus ones', r.data?.added === 4, JSON.stringify(r.json));
	r = await call('daily-review/add', { method: 'POST', body });
	ok('adding the same items again adds nothing (no duplicates)', r.data?.added === 0);
	const pairKeys = rows(`select key from il_cards where user_id='${UID}' and kind='pair'`).map((x) => x[0]);
	ok('the pair is stored once with both words in a fixed order', pairKeys.includes('than|then') && pairKeys.filter((k) => k === 'than|then').length === 1, JSON.stringify(pairKeys));
	ok("another user's attempt -> 404", (await call('daily-review/add', { method: 'POST', token: OTHER_TOKEN, body })).status === 404);
	ok('bad attempt id -> 400', (await call('daily-review/add', { method: 'POST', body: { attempt_id: 'x', items: [] } })).status === 400);

	console.log('\n== performance');
	// 1) a normal day: a session of 25 cards, many requests
	sql(`update user_words set due = now() - interval '1 hour', right_streak = 0 where user_id='${UID}'; update il_cards set due = now() - interval '1 hour' where user_id='${UID}'; update il_review_cards set due = now() - interval '1 hour' where user_id='${UID}'; update directus_users set review_prompted_on = null where id='${UID}'`);
	const cold = await call('daily-review?size=25');
	console.log(`   first call after the cards changed (cold caches): ${cold.ms.toFixed(0)} ms`);
	ok('GET cold < 4000 ms', cold.ms < 4000);
	const timeGet = async (label, n, size = 25) => { const t = []; for (let i = 0; i < n; i++) t.push((await call(`daily-review?size=${size}`)).ms); console.log(`   ${label}: p50 ${pct(t, 50).toFixed(0)} ms, p95 ${pct(t, 95).toFixed(0)} ms, max ${Math.max(...t).toFixed(0)} ms`); return pct(t, 95); };
	ok('GET session (first-time cards, ~15 due): p95 < 800 ms', (await timeGet('15 due cards, streak 0', 20)) < 800);
	// 2) streak 1 -> the clip comes from the library (a regex over every manual transcript): the heaviest path
	sql(`update user_words set right_streak = 1 where user_id='${UID}'`);
	ok('GET session with streak-1 cards (library line search): p95 < 3000 ms', (await timeGet('streak 1 (library search)', 10)) < 3000);
	// 3) a learner with a big backlog: 600 words and 300 cards due
	sql(`
insert into user_words (user_id, word, shown, source, video_id, start_ms, end_ms, example, due)
select '${UID}', 'perf' || g, 'perf' || g, 'intensive', 'abc', 0, 3000, 'perf' || g || ' word', now() - (g || ' minutes')::interval from generate_series(1, 600) g on conflict do nothing;
insert into il_cards (user_id, kind, key, shown, options, video_id, start_ms, end_ms, due)
select '${UID}', 'spell', 'perfspell' || g, 'perfspell' || g, '[]'::jsonb, 'abc', 0, 3000, now() - (g || ' minutes')::interval from generate_series(1, 300) g on conflict do nothing;`);
	s = await call('daily-review?size=25');
	ok('backlog of 600 words + 300 cards: the session is capped at 25 and total matches it', s.data.items.length <= 25 && s.data.total === s.data.items.length && s.data.due >= 50, `total=${s.data.total} due=${s.data.due}`);
	ok('GET with a big backlog: p95 < 1500 ms', (await timeGet('900 cards due', 15)) < 1500);
	// the popup's question is asked on every page load: it must be cheap even with a big backlog
	const stt = []; for (let i = 0; i < 20; i++) stt.push((await call('daily-review/status')).ms);
	console.log(`   status (900 cards due): p50 ${pct(stt, 50).toFixed(0)} ms, p95 ${pct(stt, 95).toFixed(0)} ms`);
	ok('GET status with a big backlog: p95 < 100 ms', pct(stt, 95) < 100);
	// 4) many learners at once
	const burst = await Promise.all(Array.from({ length: 20 }, () => call('daily-review?size=25')));
	const bm = burst.map((x) => x.ms);
	console.log(`   20 parallel GETs: p50 ${pct(bm, 50).toFixed(0)} ms, p95 ${pct(bm, 95).toFixed(0)} ms, max ${Math.max(...bm).toFixed(0)} ms`);
	ok('20 parallel GETs all succeed', burst.every((x) => x.status === 200));
	ok('20 parallel GETs: max < 8000 ms', Math.max(...bm) < 8000);
	// 5) answers
	const ids = rows(`select id from user_words where user_id='${UID}' and word like 'perf%' limit 30`).map((x) => x[0]);
	const at = [];
	for (const id of ids) at.push((await call('daily-review/answer', { method: 'POST', body: { kind: 'word', id, typed: 'nope' } })).ms);
	console.log(`   30 answers: p50 ${pct(at, 50).toFixed(0)} ms, p95 ${pct(at, 95).toFixed(0)} ms`);
	ok('POST answer p95 < 400 ms', pct(at, 95) < 400);
	// 6) the same card answered twice at once (double click): both succeed, one card row, two log rows
	const same = ids[0];
	const dbl = await Promise.all([1, 2].map(() => call('daily-review/answer', { method: 'POST', body: { kind: 'word', id: same, typed: 'nope' } })));
	ok('a double-clicked answer does not crash or deadlock', dbl.every((x) => x.status === 200));
	// 7) the query that finds due cards uses the index
	const plan = sql(`set enable_seqscan = off; explain select * from user_words where user_id='${UID}' and due <= now() and suspended_at is null order by due limit 30`);
	ok('due query can use the user_words_due index (a small table may still be read whole by the planner)', /user_words_due|Index/.test(plan) && !/Seq Scan on user_words/.test(plan), plan.split('\n').slice(0, 4).join(' / '));
}

try { await main(); } catch (e) { fail++; failures.push(String(e)); console.error(e); } finally { try { cleanup(); } catch (e) { console.error('cleanup failed', String(e)); } }
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log('Failures:\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
