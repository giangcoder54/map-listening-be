/**
 * YouTube captions -> transcript lines that each say one thing, like a dictation exercise:
 * a line is a sentence; a long sentence is broken at a comma (or colon / semicolon); a very short
 * sentence goes with the one next to it ("It's butter. I'm serious.").
 *
 * YouTube cues are cut by what fits on screen, so a sentence is often split across two cues.
 * Here every word gets a time first, then lines are cut by punctuation and timed by their words:
 *   - person-made track: the words are right and punctuated; a cue's time is spread over its words
 *   - automatic track: each word has its own time (srv3 <s t>) but there is no punctuation, so the
 *     AI adds punctuation and casing (and fixes plain mishearings), and its text is lined up with
 *     the timed words. Without the AI the cues are kept as they are.
 *
 * Times in ms, same shape as before: [{ text, start, end }].
 */
import { aiConfigured, aiJson } from './ai';

/**
 * `turn`: the first word after a speaker mark ("- ", ">>", "NAME:") in person-made subtitles.
 * `cue`: the first word of a caption cue (a place to break a long line that has no comma).
 */
export type Word = { w: string; start: number; end: number; turn?: boolean; cue?: boolean };
export type Line = { text: string; start: number; end: number };

/** A line longer than this (words) is broken at a comma */
const MAX_WORDS = 14;
/** Pieces shorter than this (words) are not made by a comma break */
const MIN_PIECE = 4;
/** A sentence this short (words) goes with the next one when they are said together */
const TINY = 2;
const MERGE_GAP = 400;
/** A word alone in a cue never lasts longer than this */
const WORD_MAX = 800;
/** Start a line a little before its first word: ASR word times come late */
const LEAD = 150;
/** Close gaps shorter than this: the line runs until the next one starts */
const JOIN_GAP = 700;

/** Where the subtitles mark another speaker: a line never runs across it */
const TURN = '¶';
/**
 * A speaker's name before a colon where a turn starts: "FEMALE SPEAKER:", "DEREK:", "President Obama:",
 * "The Press:". A single word only in capitals ("Remember: ..." is said).
 */
const LABEL = /(^|\n|¶\s*|[.?!…]["”']?\s+)((?:[A-Z][A-Z'.-]+(?:\s+[A-Z][A-Z'.-]+){0,2})|(?:[A-Z][a-z'.-]+)(?:\s+[A-Z][\w'.-]+){1,2}):\s+/g;

/**
 * What is not said: sound notes "(dramatic music)" "[Music]" "*sighs*", speaker names "[Derek]"
 * "DEREK:" "The Press:", music notes (the sung words are kept), and the ">>" / "- " that mark a new
 * speaker. A "- " marks one only where a caption line or a sentence starts: "hard - hard" is said.
 */
export const unsaid = (t: string) =>
	t.replace(/[♪♫]+/g, ' ')
		.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*\n]*\*/g, ' ')
		.replace(/>>/g, ` ${TURN} `)
		// a "- " starting a caption line before a capital opens a turn; before a small letter it is a pause
		.replace(/(^|\n|[.?!…]["”']?\s)\s*-+\s*(?=[A-Z0-9"“'¿¡.])/g, `$1 ${TURN} `)
		.replace(/(^|\n)\s*-+\s+/g, '$1 ')
		.replace(LABEL, `$1 ${TURN} `)
		.replace(/\s+/g, ' ').trim();
/** A caption stays on screen after it is said: its words take at most this long each */
const SAY_MS = 600;

/** Words of a text, the word after a speaker mark flagged `turn` */
function splitWords(text: string): { w: string; turn: boolean }[] {
	const out: { w: string; turn: boolean }[] = [];
	let turn = false;
	for (const w of text.split(' ')) {
		if (w === TURN) { turn = true; continue; }
		if (w) { out.push({ w, turn }); turn = false; }
	}
	return out;
}

const decode = (t: string) =>
	t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_m, c) => String.fromCodePoint(parseInt(c, 16)))
		.replace(/&#(\d+);/g, (_m, c) => String.fromCodePoint(parseInt(c, 10)));

/** Every word of an srv3 track with its time. `timed` is false when the track has no per-word times. */
export function srv3Words(xml: string): { words: Word[]; timed: boolean } {
	const words: Word[] = [];
	let timed = false;
	for (const m of xml.matchAll(/<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g)) {
		const t0 = parseInt(m[1]!, 10);
		const end = t0 + parseInt(m[2] || '0', 10);
		const inner = m[3]!;
		const segs = [...inner.matchAll(/<s([^>]*)>([^<]*)<\/s>/g)];
		if (segs.length) {
			const parts = segs.map((s) => ({ t: t0 + parseInt(/\bt="(\d+)"/.exec(s[1]!)?.[1] || '0', 10), text: unsaid(decode(s[2]!)) }));
			if (segs.some((s) => /\bt="\d+"/.test(s[1]!))) timed = true;
			parts.forEach((p, i) => {
				if (!p.text) return;
				const next = parts[i + 1]?.t ?? end;
				for (const { w } of splitWords(p.text)) words.push({ w, start: p.t, end: Math.min(Math.max(next, p.t + 100), p.t + WORD_MAX) });
			});
			continue;
		}
		// A cue without word times: spread its time over its words by their length
		const text = unsaid(decode(inner.replace(/<[^>]+>/g, ' ')));
		const ws = splitWords(text);
		if (!ws.length) continue;
		const total = ws.reduce((n, x) => n + x.w.length + 1, 0);
		// the words are said at the start of the cue, not over all the time it stays on screen
		const span = Math.min(end - t0, Math.max(800, ws.length * SAY_MS));
		let pos = 0;
		ws.forEach(({ w, turn }, i) => {
			const s = t0 + (span * pos) / total;
			pos += w.length + 1;
			words.push({ w, start: Math.round(s), end: Math.round(t0 + (span * pos) / total), ...(turn ? { turn } : {}), ...(i === 0 ? { cue: true } : {}) });
		});
	}
	return { words, timed };
}

const norm = (w: string) => w.toLowerCase().replace(/[‘’`]/g, "'").replace(/[^a-z0-9']/g, '');
/** A title before a name: "Mr. Potter" is one sentence */
const TITLE = /^["“(]?(Mr|Mrs|Ms|Mx|Dr|St|Jr|Sr|vs|Prof|Mt|Gen|Sgt|Capt|Lt|Col|Rev|Gov|Sen|Rep|Pres|Fr|Ft)\.$/i;
/**
 * Does the word end a sentence? Not after a title or an initial ("J."); after a dotted short form
 * ("U.S.", "a.m.") only when the next word starts with a capital.
 */
const endsSentence = (w: string, next?: string) => {
	if (!/[.!?…]["”')\]]*$/.test(w)) return false;
	if (/[!?…]["”')\]]*$/.test(w)) return true;
	if (TITLE.test(w) || /^["“(]?[A-Z]\.$/.test(w)) return false;
	if (/^["“(]?([A-Za-z]\.){2,}$/.test(w)) return !!next && /^["“(]?[A-Z]/.test(next);
	return true;
};
const endsClause = (w: string) => /[,;:]["”')\]]*$/.test(w);

/** Break one sentence (word indexes) into pieces of at most MAX_WORDS, at the comma nearest the middle */
function breakLong(idx: number[], words: Word[]): number[][] {
	if (idx.length <= MAX_WORDS) return [idx];
	let best = -1;
	for (let k = MIN_PIECE - 1; k < idx.length - MIN_PIECE; k++) {
		if (!endsClause(words[idx[k]!]!.w)) continue;
		if (best < 0 || Math.abs(k + 1 - idx.length / 2) < Math.abs(best + 1 - idx.length / 2)) best = k;
	}
	if (best < 0 && idx.length > MAX_WORDS * 2) {
		// No comma in a very long run (subtitles with little punctuation, song lyrics): break where
		// a caption cue starts, nearest the middle
		for (let k = MIN_PIECE - 1; k < idx.length - MIN_PIECE; k++) {
			if (!words[idx[k + 1]!]!.cue) continue;
			if (best < 0 || Math.abs(k + 1 - idx.length / 2) < Math.abs(best + 1 - idx.length / 2)) best = k;
		}
	}
	if (best < 0) return [idx];
	return [...breakLong(idx.slice(0, best + 1), words), ...breakLong(idx.slice(best + 1), words)];
}

/** Punctuated, timed words -> lines */
export function wordsToLines(words: Word[]): Line[] {
	const sentences: number[][] = [];
	let cur: number[] = [];
	words.forEach((w, i) => {
		// another speaker starts: the line before ends here even without a full stop
		if (w.turn && cur.length) { sentences.push(cur); cur = []; }
		cur.push(i);
		if (endsSentence(w.w, words[i + 1]?.w)) { sentences.push(cur); cur = []; }
	});
	if (cur.length) sentences.push(cur);

	// A tiny sentence goes with the next one when they are said together ("It's butter. I'm serious.")
	const merged: number[][] = [];
	for (let i = 0; i < sentences.length; i++) {
		const s = sentences[i]!;
		const next = sentences[i + 1];
		if (next && s.length <= TINY && s.length + next.length <= MAX_WORDS && !words[next[0]!]!.turn
			&& words[next[0]!]!.start - words[s.at(-1)!]!.end < MERGE_GAP) {
			sentences[i + 1] = [...s, ...next];
			continue;
		}
		merged.push(s);
	}

	const lines = merged.flatMap((s) => breakLong(s, words)).map((idx) => ({
		text: idx.map((i) => words[i]!.w).join(' '),
		start: Math.max(0, words[idx[0]!]!.start - LEAD),
		end: words[idx.at(-1)!]!.end,
	}));
	// A line runs until the next one starts, unless there is a real pause between them
	for (let i = 0; i < lines.length - 1; i++) {
		const a = lines[i]!, b = lines[i + 1]!;
		if (b.start < a.end || b.start - a.end < JOIN_GAP) a.end = Math.max(a.start + 300, b.start);
	}
	return lines;
}

/**
 * Line up the AI's punctuated text with the timed ASR words (longest common subsequence on the
 * bare words). Each AI word takes the time of the ASR word it matches; an unmatched one (a fixed
 * mishearing) takes the time between its matched neighbours.
 */
export function alignText(text: string, asr: Word[]): Word[] | null {
	const out = text.split(/\s+/).filter(Boolean);
	const a = asr.map((w) => norm(w.w)), b = out.map(norm);
	const n = a.length, m = b.length;
	if (!n || !m) return null;
	const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			dp[i]![j] = a[i] && a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	if (dp[0]![0]! < Math.min(n, m) * 0.85) return null; // the AI changed too much: do not trust it
	const hit: (number | null)[] = new Array(m).fill(null);
	for (let i = 0, j = 0; i < n && j < m;) {
		if (a[i] && a[i] === b[j]) { hit[j] = i; i++; j++; }
		else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
		else j++;
	}
	return out.map((w, j) => {
		if (hit[j] != null) return { w, start: asr[hit[j]!]!.start, end: asr[hit[j]!]!.end };
		let p = j - 1; while (p >= 0 && hit[p] == null) p--;
		let q = j + 1; while (q < m && hit[q] == null) q++;
		const start = p >= 0 ? asr[hit[p]!]!.end : q < m ? asr[hit[q]!]!.start : 0;
		const end = q < m ? asr[hit[q]!]!.start : start + 300;
		return { w, start, end: Math.max(end, start + 100) };
	});
}

/** Words per AI call; AI_PUNCT_CHUNK / AI_PUNCT_TIMEOUT_MS tune it for slow endpoints (bulk jobs) */
const CHUNK = Number(process.env.AI_PUNCT_CHUNK) || 220;
const PUNCT_TIMEOUT = Number(process.env.AI_PUNCT_TIMEOUT_MS) || 45000;
const PROMPT = `You add punctuation to an English speech transcript made by speech recognition.
Return {"text": "..."}: the same words in the same order, with sentence punctuation (. , ? ! : and quotes) and capital letters added.
Fix a word only when it is plainly misheard in context (e.g. "how is better made" about butter -> "How is butter made?"). Do not add, drop, reorder or paraphrase words; keep fillers and repetitions.`;

/** Tries per chunk (AI_PUNCT_TRIES) */
const PUNCT_TRIES = Number(process.env.AI_PUNCT_TRIES) || 2;
/** Calls in flight at once for one video (AI_PUNCT_PAR); chunks do not depend on each other */
const PUNCT_PAR = Number(process.env.AI_PUNCT_PAR) || 1;

/**
 * Punctuate ASR words with the AI, chunk by chunk (a chunk ends at a pause, so no sentence is cut).
 * The chunks are cut first, then sent (PUNCT_PAR at a time) and joined in order. A chunk the AI
 * answers badly is tried once more; one still bad makes the whole video fall back to its cues.
 */
async function punctuate(asr: Word[], logger?: any): Promise<Word[] | null> {
	const bounds: [number, number][] = [];
	for (let i = 0; i < asr.length;) {
		let j = Math.min(asr.length, i + CHUNK);
		if (j < asr.length) {
			// end the chunk at the longest pause in its last 40 words
			let best = j, gap = -1;
			for (let k = Math.max(i + 1, j - 40); k < j; k++) {
				const g = asr[k]!.start - asr[k - 1]!.end;
				if (g > gap) { gap = g; best = k; }
			}
			j = best;
		}
		bounds.push([i, j]);
		i = j;
	}
	const done: (Word[] | null)[] = new Array(bounds.length).fill(null);
	let next = 0, failed = false;
	const one = async () => {
		while (!failed && next < bounds.length) {
			const n = next++;
			const part = asr.slice(bounds[n]![0], bounds[n]![1]);
			for (let attempt = 0; attempt < PUNCT_TRIES && !done[n]; attempt++) {
				// the endpoint turns calls away when many arrive at once: wait longer each time
				if (attempt) await new Promise((r) => setTimeout(r, 4000 * attempt + Math.random() * 3000));
				const res = await aiJson<{ text?: string }>(
					[{ role: 'system', content: PROMPT }, { role: 'user', content: part.map((w) => w.w).join(' ') }],
					{ maxTokens: 2000, timeoutMs: PUNCT_TIMEOUT, logger },
				);
				done[n] = res?.text ? alignText(res.text, part) : null;
			}
			if (!done[n]) failed = true;
		}
	};
	await Promise.all(Array.from({ length: Math.min(PUNCT_PAR, bounds.length) }, one));
	return failed || done.some((d) => !d) ? null : done.flat() as Word[];
}

/**
 * Lines for a caption track's srv3 XML. `kind` 'manual' = person-made (already punctuated).
 * Returns null when it cannot do better than the cues (no AI for an automatic track, or the AI
 * answer could not be lined up): the caller keeps the cues.
 */
export async function sentenceLines(xml: string, kind: 'manual' | 'asr', logger?: any): Promise<Line[] | null> {
	const { words, timed } = srv3Words(xml);
	if (words.length < 3) return null;
	if (kind === 'manual') {
		// A track with no sentence punctuation at all cannot be cut into sentences
		if (!words.some((w) => endsSentence(w.w))) return null;
		return wordsToLines(words);
	}
	// Without a time for every word (stored cues, not a fresh srv3 track) the words of a cue share
	// its time: less exact, still within a fraction of a second
	void timed;
	if (!aiConfigured()) return null;
	const punctuated = await punctuate(words, logger);
	return punctuated ? wordsToLines(punctuated) : null;
}
