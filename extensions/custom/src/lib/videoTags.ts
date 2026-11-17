/**
 * Tags of library videos (table video_tags, database/migrations/2026-11-16_video_tags.sql).
 *
 * computeSignals   from the transcript, no AI: speed, uncommon words, speaker turns, music /
 *                  laughter, length -> a score; level 1..10 = score (+ a bump by content type)
 *                  placed on fixed cut points. Also flags broken subtitles and drills that are
 *                  mostly silence.
 * aiTag            the AI picks a topic (from video_topics), up to 2 subtopics and a content
 *                  type (CONTENT_TYPES) from the title and parts of the transcript.
 *
 * Level is relative to this library (cut points = its deciles on 2026-11-16), not a CEFR band.
 * Films and shows get a bump: their subtitles do not mark who speaks and have long silences, so
 * the transcript alone makes them look easier than they sound.
 */
import { aiConfigured, aiJson } from './ai';

export const CONTENT_TYPES: Record<string, string> = {
	film_scene: 'Cảnh phim / series',
	trailer: 'Trailer',
	talk_show: 'Talk show',
	interview: 'Phỏng vấn',
	show: 'Gameshow / chương trình giải trí',
	talk: 'Thuyết trình, bài giảng, TED',
	explainer: 'Video giải thích',
	documentary: 'Phóng sự, tài liệu ngắn',
	news_report: 'Bản tin',
	vlog: 'Vlog, một người nói',
	podcast: 'Podcast, hội thoại',
	lesson: 'Bài dạy tiếng Anh',
	tutorial: 'Hướng dẫn',
	story: 'Kể chuyện',
};

const CUTS = [3.682, 4.319, 4.796, 5.181, 5.532, 5.815, 6.083, 6.431, 6.956];
const TYPE_BUMP: Record<string, number> = { film_scene: 1.2, trailer: 0.8, show: 0.5, talk_show: 0.4 };

export const levelOf = (score: number, type?: string | null) => {
	const s = score + (TYPE_BUMP[type || ''] || 0);
	return 1 + CUTS.filter((c) => s >= c).length;
};

/** SQL for the effective value: manual -> ai -> channel default */
export const EFFECTIVE = {
	topic: 'coalesce(t.topic, CASE WHEN ct.apply_all THEN ct.topic END, t.ai_topic, ct.topic)',
	type: 'coalesce(t.content_type, CASE WHEN ct.apply_all THEN ct.content_type END, t.ai_content_type, ct.content_type)',
	level: 'coalesce(t.level_manual, t.level)',
};

// ── Words common in the library (in >= 1% of its videos), cached a day ──────────────────────
let common: { set: Set<string>; at: number } | null = null;
async function commonWords(database: any): Promise<Set<string>> {
	if (common && Date.now() - common.at < 86400000) return common.set;
	const { rows } = await database.raw(`
		WITH n AS (SELECT count(*)::numeric AS n FROM source_videos WHERE jsonb_typeof(transcript) = 'array')
		SELECT w FROM (
			SELECT DISTINCT v.id, w
			FROM source_videos v,
				jsonb_array_elements(v.transcript) e,
				regexp_split_to_table(lower(replace(e->>'text', '’', '''')), '[^a-z'']+') w
			WHERE jsonb_typeof(v.transcript) = 'array' AND w ~ '^[a-z]'
		) x
		GROUP BY w HAVING count(*) >= (SELECT n FROM n) * 0.01`);
	common = { set: new Set(rows.map((r: any) => r.w)), at: Date.now() };
	return common.set;
}

const WORD = /[a-z]+(?:'[a-z]+)?/g;
const NOISE = /♪|\[[^\]]*(?:music|laugh|applause|cheer|crosstalk|inaudible)[^\]]*\]|\([^)]*(?:music|laugh|applause)[^)]*\)/i;
const TURN = /^\s*(?:>>|-\s)/;

type Cue = { text: string; start: number; end: number };

export function measure(cuesIn: Cue[], commonSet: Set<string>) {
	const cues = cuesIn.filter((c) => c?.text).sort((a, b) => (a.start || 0) - (b.start || 0));
	if (!cues.length) return null;
	const words: string[] = [];
	let speakMs = 0, prevEnd: number | null = null, noise = 0, turns = 0;
	for (const c of cues) {
		let s = c.start || 0;
		const e = c.end || 0;
		if (prevEnd !== null) s = Math.max(s, prevEnd); // rolling captions overlap
		if (e > s) speakMs += Math.min(e - s, 8000);
		prevEnd = Math.max(prevEnd || 0, e);
		if (NOISE.test(c.text)) noise++;
		if (TURN.test(c.text)) turns++;
		const plain = c.text.replace(/’/g, "'").replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').toLowerCase();
		words.push(...(plain.match(WORD) || []));
	}
	const durMs = Math.max(...cues.map((c) => c.end || 0)) - Math.min(...cues.map((c) => c.start || 0));
	const wc = words.length;
	const speakMin = speakMs / 60000;
	const durationS = Math.round(durMs / 1000);
	if (wc < 30 || speakMin <= 0) return { word_count: wc, duration_s: durationS, broken: true } as any;

	const known = words.filter((w) => commonSet.has(w)).length / wc;
	const wpm = wc / speakMin;
	const rare = 1 - known;
	const turnsPer10 = turns / Math.max(durationS / 600, 0.1);
	const noiseRatio = noise / cues.length;
	const speechRatio = Math.min(1, speakMs / Math.max(durMs, 1));

	const why: string[] = [];
	const score =
		Math.min(Math.max((wpm - 100) / 25, 0), 6) +
		Math.min(rare * 40, 4) +
		Math.min(turnsPer10 / 10, 2) +
		Math.min(noiseRatio * 10, 1) +
		(durationS > 900 ? 0.5 : 0);
	if (wpm >= 165) why.push(`nói nhanh (${Math.round(wpm)} từ/phút)`);
	else if (wpm < 125) why.push(`nói chậm (${Math.round(wpm)} từ/phút)`);
	if (rare >= 0.07) why.push(`nhiều từ ít gặp (${Math.round(rare * 100)}%)`);
	else if (rare < 0.035) why.push(`từ vựng thông dụng (${Math.round(rare * 100)}% từ ít gặp)`);
	if (turnsPer10 >= 10) why.push(`nhiều lượt người nói (${Math.round(turnsPer10)}/10 phút)`);
	if (noiseRatio >= 0.05) why.push('nhiều nhạc / tiếng cười');
	if (durationS > 900) why.push('dài trên 15 phút');
	if (speechRatio < 0.45) why.push('nhiều khoảng lặng');

	return {
		duration_s: durationS,
		word_count: wc,
		wpm: Math.round(wpm * 10) / 10,
		rare_ratio: Math.round(rare * 1000) / 1000,
		known_ratio: Math.round(known * 1000) / 1000,
		avg_cue_words: Math.round((wc / cues.length) * 10) / 10,
		speaker_turns: Math.round(turnsPer10),
		noise_ratio: Math.round(noiseRatio * 1000) / 1000,
		speech_ratio: Math.round(speechRatio * 1000) / 1000,
		score: Math.round(score * 100) / 100,
		// Garbled subtitles (letters run together) or not English: few library words. Myths and
		// history with many names sit at 0.72-0.80 and are fine; garbled / French / Spanish < 0.6
		broken: known < 0.65,
		why,
	};
}

const typeBumpWhy = (type?: string | null) =>
	TYPE_BUMP[type || ''] ? `${CONTENT_TYPES[type!]}: sub không ghi ai nói, khó hơn số liệu` : '';

/** Computed signals for videos never measured or whose transcript changed since; `ids` forces those */
export async function computeSignals(database: any, opts: { limit?: number; ids?: string[] } = {}) {
	const q = database('source_videos as v')
		.leftJoin('video_tags as t', 't.source_video_id', 'v.id')
		.leftJoin('channel_tags as ct', 'ct.channel_name', 'v.channel_name')
		.select('v.id', 'v.transcript', database.raw(`${EFFECTIVE.type} AS type`))
		.whereRaw("jsonb_typeof(v.transcript) = 'array'");
	if (opts.ids?.length) q.whereIn('v.id', opts.ids);
	else q.where((w: any) => w.whereNull('t.signals_at').orWhereRaw('v.transcript_updated_at > t.signals_at')).limit(opts.limit ?? 50);
	const rows = await q;
	if (!rows.length) return 0;
	const set = await commonWords(database);
	for (const r of rows) {
		const m = measure(r.transcript || [], set);
		const row: any = { signals_at: new Date(), date_updated: new Date() };
		if (!m || m.score === undefined) {
			Object.assign(row, { duration_s: m?.duration_s ?? 0, word_count: m?.word_count ?? 0, broken: true, level: null, score: null, level_why: 'quá ít lời để tính' });
		} else {
			const { why, ...vals } = m;
			const bump = typeBumpWhy(r.type);
			Object.assign(row, vals, {
				level: levelOf(m.score, r.type),
				level_why: [...why, bump, m.broken ? 'sub có vẻ bị lỗi' : ''].filter(Boolean).join('; ') || 'không có tín hiệu nổi bật',
			});
		}
		await database('video_tags').insert({ source_video_id: r.id, ...row }).onConflict('source_video_id').merge();
	}
	return rows.length;
}

/** Level again after a content type changed (AI or editor): no need to read the transcript */
export async function relevel(database: any, ids: string[]) {
	if (!ids.length) return;
	const rows = await database('video_tags as t')
		.join('source_videos as v', 'v.id', 't.source_video_id')
		.leftJoin('channel_tags as ct', 'ct.channel_name', 'v.channel_name')
		.whereIn('t.source_video_id', ids).whereNotNull('t.score')
		.select('t.source_video_id as id', 't.score', 't.level_why', database.raw(`${EFFECTIVE.type} AS type`));
	for (const r of rows) {
		const base = String(r.level_why || '').split('; ').filter((x: string) => !/sub không ghi ai nói/.test(x));
		const bump = typeBumpWhy(r.type);
		const why = [...base.filter((x: string) => x !== 'không có tín hiệu nổi bật'), bump].filter(Boolean);
		await database('video_tags').where('source_video_id', r.id)
			.update({ level: levelOf(Number(r.score), r.type), level_why: why.join('; ') || 'không có tín hiệu nổi bật' });
	}
}

// ── AI ──────────────────────────────────────────────────────────────────────────────────────

const excerpt = (cues: Cue[]) => {
	const text = (xs: Cue[]) => xs.map((c) => c.text).join(' ').replace(/\s+/g, ' ');
	const words = (s: string, n: number) => s.split(' ').slice(0, n).join(' ');
	const mid = Math.floor(cues.length / 2);
	return [
		`BEGINNING: ${words(text(cues.slice(0, 60)), 220)}`,
		`MIDDLE: ${words(text(cues.slice(mid, mid + 40)), 140)}`,
		`END: ${words(text(cues.slice(-30)), 90)}`,
	].join('\n');
};

/** AI tags for videos with signals but no AI tag yet (skips broken ones). Returns how many tried */
export async function aiTag(database: any, opts: { limit?: number; ids?: string[]; logger?: any } = {}) {
	if (!aiConfigured()) return { tried: 0, ok: 0, configured: false };
	const topics = await database('video_topics').select('code', 'name', 'hint').orderBy('sort');
	const q = database('source_videos as v')
		.join('video_tags as t', 't.source_video_id', 'v.id')
		.leftJoin('channel_tags as ct', 'ct.channel_name', 'v.channel_name')
		.select('v.id', 'v.title', 'v.channel_name', 'v.transcript', 'ct.topic as ch_topic', 'ct.content_type as ch_type', 'ct.note as ch_note', 'ct.allowed_topics as ch_allowed')
		.whereRaw('NOT (coalesce(ct.apply_all, false) AND ct.topic IS NOT NULL)'); // a channel that sets the topic for all needs no AI
	if (opts.ids?.length) q.whereIn('v.id', opts.ids);
	else q.whereNull('t.ai_at').where((w: any) => w.where('t.broken', false).orWhereNull('t.broken')).limit(opts.limit ?? 5);
	const rows = await q;
	const topicCodes = new Set(topics.map((t: any) => t.code));
	const system = [
		'You tag English videos for a listening course. Answer one JSON object only:',
		'{"topic": code, "subtopics": [code, ...] (0-2, not the topic), "content_type": code, "confidence": "high"|"medium"|"low", "reason": one short sentence in Vietnamese saying what the video is about}',
		'Topic codes (pick what the video is mostly ABOUT, not the channel):',
		...topics.map((t: any) => `- ${t.code}: ${t.hint || t.name}`),
		'Content type codes:',
		...Object.entries(CONTENT_TYPES).map(([k, v]) => `- ${k}: ${v}`),
		'A scene from a film or TV series is film_scene even when it is funny or about food. A talk show host chatting with a guest is talk_show.',
		'Use "low" confidence when the transcript is garbled or the video mixes many things.',
	].join('\n');
	let ok = 0;
	await Promise.all(rows.map(async (r: any) => {
		const hint = [r.ch_topic && `channel usually: ${r.ch_topic}`, r.ch_type && `channel type: ${r.ch_type}`, r.ch_note].filter(Boolean).join('; ');
		const allowed = (r.ch_allowed || []).filter((c: string) => topicCodes.has(c));
		const only = allowed.length ? `
This channel only covers these topics, pick the topic and subtopics among them: ${allowed.join(', ')}` : '';
		const user = `Title: ${r.title}\nChannel: ${r.channel_name}${hint ? ` (${hint})` : ''}\n${only}
${excerpt(r.transcript || [])}`;
		const out = await aiJson<any>([{ role: 'system', content: system }, { role: 'user', content: user }], { maxTokens: 300, timeoutMs: 90000, logger: opts.logger });
		const topic = out && topicCodes.has(out.topic) ? out.topic : null;
		const type = out && CONTENT_TYPES[out.content_type] ? out.content_type : null;
		// No answer (AI down, billing, timeout): left untagged so the next run tries again.
		// A wrong answer is kept as done, with the error, so it is not asked again and again.
		if (!out) {
			await database('video_tags').where('source_video_id', r.id).update({ ai_error: 'no answer' });
			return;
		}
		if (!topic || !type) {
			await database('video_tags').where('source_video_id', r.id).update({ ai_at: new Date(), ai_error: `bad answer: ${JSON.stringify(out).slice(0, 200)}` });
			return;
		}
		const subs = (Array.isArray(out.subtopics) ? out.subtopics : []).filter((s: any) => topicCodes.has(s) && s !== topic).slice(0, 2);
		await database('video_tags').where('source_video_id', r.id).update({
			ai_topic: topic, ai_subtopics: subs, ai_content_type: type,
			ai_confidence: ['high', 'medium', 'low'].includes(out.confidence) ? out.confidence : 'medium',
			ai_reason: String(out.reason || '').slice(0, 300), ai_at: new Date(), ai_error: null,
		});
		ok++;
	}));
	await relevel(database, rows.map((r: any) => r.id));
	return { tried: rows.length, ok, configured: true };
}

/** A video just added: measure it, then tag it; errors are logged, never thrown */
export async function tagNewVideos(database: any, ids: string[], logger?: any) {
	try {
		await computeSignals(database, { ids });
		await aiTag(database, { ids, logger });
	} catch (e: any) {
		logger?.warn?.(`[video-tags] ${e?.message}`);
	}
}
