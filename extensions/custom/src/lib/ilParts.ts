/**
 * Intensive Listening on a whole video: the transcript cut into sentences and parts ("chặng"), and the lines said more
 * than once (a chorus), which a learner types once.
 */
import { tokens } from './intensive';

export const IL_PART = { aim: 12, max: 16, words: 16 };
export type Cue = { text: string; start: number; end: number };
export type Cut = { text: string; start_ms: number; end_ms: number; part: number };

/** Two lines are the same line when their words are */
export const lineKey = (text: string) => tokens(text).join(' ').replace(/'/g, '');

/** For each sentence (in order), the n of the first sentence with the same words; null = said for the first time here */
export const sameAs = (list: { n: number; text: string }[]): (number | null)[] => {
	const first = new Map<string, number>();
	return list.map((s) => {
		const k = lineKey(s.text);
		const at = first.get(k);
		if (at === undefined) { first.set(k, s.n); return null; }
		return at;
	});
};

/** Humming and non-words: nothing to type */
const FILLER = /^(oh|ooh|uh|uhh|um|mm|mmm|mum|mah|hmm|ah|eh|ha|la|na|da|yeah|yea|woah|whoa|hey)$/;
const isFiller = (text: string) => { const w = tokens(text); return !w.length || w.every((x) => FILLER.test(x)); };
const tidy = (text: string) => String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]/g, ' ').replace(/\s+/g, ' ').trim();

/** Subtitle cues -> sentences. A transcript with punctuation is joined up to the end of each sentence; one without
 *  (lyrics) keeps a line per cue. A cue ends where the next one starts, at the latest. */
export const sentencesOf = (cues: Cue[]): Omit<Cut, 'part'>[] => {
	const list = cues.map((c) => ({ text: tidy(c.text), start: Math.round(Number(c.start)), end: Math.round(Number(c.end)) }))
		.filter((c) => c.text && Number.isFinite(c.start) && Number.isFinite(c.end)).sort((a, b) => a.start - b.start);
	for (let i = 0; i < list.length - 1; i++) if (list[i]!.end > list[i + 1]!.start && list[i + 1]!.start > list[i]!.start) list[i]!.end = list[i + 1]!.start;
	const ends = (t: string) => /[.?!]["'”’]?$/.test(t);
	const prose = list.filter((c) => ends(c.text)).length >= list.length * 0.3;
	const out: Omit<Cut, 'part'>[] = [];
	let cur: { text: string; start: number; end: number } | null = null;
	const flush = () => { if (cur && !isFiller(cur.text) && cur.end - cur.start >= 600) out.push({ text: cur.text, start_ms: cur.start, end_ms: cur.end }); cur = null; };
	for (const c of list) {
		if (isFiller(c.text)) { flush(); continue; }
		if (cur && (c.start - cur.end > 1500 || tokens(`${cur.text} ${c.text}`).length > IL_PART.words)) flush();
		cur = cur ? { text: `${cur.text} ${c.text}`, start: cur.start, end: c.end } : { ...c };
		if (!prose || ends(cur.text)) flush();
	}
	flush();
	// A sentence too long to keep in mind (over 18 words) is not typed: it is still heard in the video
	return out.filter((s) => tokens(s.text).length <= 18);
};

/** Parts of about IL_PART.aim lines to type (repeats do not count), cut at the longest pause near that size */
export const withParts = (list: Omit<Cut, 'part'>[]): Cut[] => {
	const repeat = sameAs(list.map((s, i) => ({ n: i + 1, text: s.text }))).map((x) => x !== null);
	const out: Cut[] = [];
	let part = 1;
	let from = 0;
	while (from < list.length) {
		let to = from;
		let asked = 0;
		const cuts: number[] = [];
		while (to < list.length && asked < IL_PART.max) {
			if (!repeat[to]) asked++;
			to++;
			if (asked >= IL_PART.aim - 3) cuts.push(to);
		}
		const left = repeat.slice(to).filter((r) => !r).length;
		// A short tail joins the last part when it fits
		if (to < list.length && !(asked + left <= IL_PART.max)) {
			const gap = (i: number) => (i < list.length ? list[i]!.start_ms - list[i - 1]!.end_ms : 0);
			to = cuts.sort((a, b) => gap(b) - gap(a) || b - a)[0] ?? to;
		} else to = list.length;
		for (let i = from; i < to; i++) out.push({ ...list[i]!, part });
		from = to;
		part++;
	}
	return out;
};
