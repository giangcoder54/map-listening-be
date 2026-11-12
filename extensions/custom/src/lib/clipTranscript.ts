/**
 * The words of a Phrase Lab clip, line by line, with a little context before the phrase
 * (the line or two before it, at most LEAD_MAX seconds), so the learner hears and reads how
 * the phrase comes up in the conversation.
 *
 * Source, best first: video_lines (checked by ear, translated in video_line_translations),
 * else source_videos.transcript (the video's own captions, [{start, end, text}] in ms).
 * YouTube's rolling captions keep a line on screen while the next one is said: a line ends
 * where the next one begins.
 */
export const LEAD_MAX = 6;
const TAIL = 0.4;
/** The line after the phrase (the reply): kept when it starts within AFTER_GAP s, cut at AFTER_MAX s */
const AFTER_GAP = 2.5;
const AFTER_MAX = 5;

/** `after`: the line said after the phrase's line (how the other person reacts) */
export type ClipLine = { start: number; end: number; text: string; tr: string; hit: boolean; after: boolean };
export type ClipCut = { lead_start: number; end: number; lines: ClipLine[] };

type Raw = { start: number; end: number; text: string; tr?: string };

const clean = (lines: Raw[]) => {
	const sorted = lines.filter((l) => l.text && l.end > l.start).sort((a, b) => a.start - b.start);
	for (let i = 0; i < sorted.length - 1; i++) {
		const a = sorted[i]!, b = sorted[i + 1]!;
		if (b.start > a.start && a.end > b.start) a.end = b.start;
	}
	return sorted;
};

const norm = (t: string) => ` ${String(t).toLowerCase().replace(/[‘’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

/**
 * Cut one clip (seconds) out of a video's lines. The phrase's line is the one that says the
 * phrase (else the one overlapping the clip most); before it, up to two whole lines that start
 * within LEAD_MAX seconds; after it, the next line when it follows within AFTER_GAP seconds
 * (the clip ends with it, at most AFTER_MAX seconds long), else the clip ends with the phrase's line.
 */
export function cutClip(all: Raw[], start: number, end: number, phrase: string): ClipCut {
	const lines = clean(all);
	const overlap = (l: Raw) => Math.min(l.end, end) - Math.max(l.start, start);
	const near = lines.map((l, k) => ({ l, k })).filter(({ l }) => overlap(l) > 0);
	if (!near.length) return { lead_start: Math.max(0, start - 1.5), end: end + TAIL, lines: [] };
	const p = norm(phrase).trim();
	const said = near.filter(({ l }) => p && norm(l.text).includes(` ${p} `));
	const hits = said.length ? said : [near.reduce((a, b) => (overlap(b.l) > overlap(a.l) ? b : a))];
	const i = hits[0]!.k;
	const last = hits[hits.length - 1]!.k;
	let first = i;
	while (first > i - 2 && first > 0 && lines[first - 1]!.start >= lines[i]!.start - LEAD_MAX) first--;
	const next = lines[last + 1];
	const after = next && next.start - lines[last]!.end <= AFTER_GAP ? last + 1 : -1;
	const picked = lines.slice(first, (after >= 0 ? after : last) + 1);
	const hitSet = new Set(hits.map((h) => h.k));
	const stop = after >= 0 ? Math.min(next!.end, next!.start + AFTER_MAX) : lines[last]!.end;
	return {
		lead_start: Number(Math.max(0, picked[0]!.start - 0.15).toFixed(2)),
		end: Number((Math.max(end, stop) + TAIL).toFixed(2)),
		lines: picked.map((l, n) => ({
			start: Number(l.start.toFixed(2)),
			end: Number((first + n === after ? Math.min(l.end, stop) : l.end).toFixed(2)),
			after: first + n === after,
			// Caption marks: ">>" (new speaker), a leading "- "
			text: l.text.replace(/>>\s*/g, '').replace(/^\s*-\s+/, '').replace(/\s+/g, ' ').trim(),
			tr: l.tr || '',
			hit: hitSet.has(first + n),
		})),
	};
}

/**
 * The cut of every clip, by clip id. `lang`: "vi" -> translations from vi-VN (video_lines only).
 */
export async function clipTranscripts(database: any, clips: { id: string; source_video_id: string | null; start: number; end: number }[], lang: string, phrase: string) {
	const out = new Map<string, ClipCut>();
	const videoIds = [...new Set(clips.map((c) => c.source_video_id).filter(Boolean))] as string[];
	if (!videoIds.length) return out;
	const [checked, videos] = await Promise.all([
		database('video_lines as v')
			.leftJoin('video_line_translations as t', function (this: any) {
				this.on('t.line_id', 'v.id').andOn(database.raw('lower(t.languages_code) like ?', [`${lang.toLowerCase()}%`]));
			})
			.select('v.source_video_id', 'v.start_ms', 'v.end_ms', 'v.text', 't.text as tr')
			.whereIn('v.source_video_id', videoIds),
		database('source_videos').select('id', 'transcript').whereIn('id', videoIds),
	]);
	const transcriptOf = new Map<string, Raw[]>();
	for (const v of videos) {
		let raw: any = v.transcript;
		if (typeof raw === 'string') {
			try { raw = JSON.parse(raw); } catch { raw = []; }
		}
		transcriptOf.set(v.id, (Array.isArray(raw) ? raw : []).map((l: any) => ({ start: Number(l.start) / 1000, end: Number(l.end) / 1000, text: String(l.text || '') })));
	}
	for (const c of clips) {
		if (!c.source_video_id) continue;
		const own = checked
			.filter((r: any) => r.source_video_id === c.source_video_id)
			.map((r: any) => ({ start: r.start_ms / 1000, end: r.end_ms / 1000, text: r.text, tr: lang && !lang.startsWith('en') ? r.tr || '' : '' }));
		// Checked lines when they cover the phrase, else the captions
		const covers = own.some((l: Raw) => l.end > c.start && l.start < c.end);
		out.set(c.id, cutClip(covers ? own : transcriptOf.get(c.source_video_id) || [], c.start, c.end, phrase));
	}
	return out;
}
