/**
 * Intensive Listening (database/migrations/2026-11-19_intensive_listening.sql).
 *
 * A short passage heard sentence by sentence and typed back. Each sentence is checked word by word
 * (diffWords), every missed word gets one label (labelMisses) so the learner is told WHY, not just
 * what, and a missed sentence becomes a Review card (heard, then typed again).
 *
 * A typed word is first sorted into "heard" or "missed":
 *   ok          the word
 *   typo        heard it, wrote it wrong: 1 letter off (2 from 8 letters), letters swapped, or a word that
 *               sounds the same (their / there). Counted as heard, shown as spelling. Never when the typed
 *               word is itself another real word (than / then): that one was heard as a different word.
 *   wrong / missing  a miss, labelled below
 *
 * Labels of a miss, in the order they are decided:
 *   vocab       the learner does not know the word (said so, or the word is rare and they did not say otherwise)
 *   speed       fixed when heard again at 0.75x, before the hint showed it
 *   linking / confusable / imagine
 *               the word sits in a trap the lesson author marked
 *   linking     the letters are right but split in the wrong places ("an ice" for "a nice"), or the word break
 *               came out wrong where a final consonant meets the next vowel ("term out" for "turns out")
 *   (shared chunks, il_chunks: "sort of" → "sorta" are traps in every passage, see withChunks)
 *   overload    a long sentence (12+ words) right at the start, the tail lost
 *   ending      the word without (or with an extra) ending: can / can't, walk / walked, protein / proteins
 *   weak        a small function word lost (do, you, to, of, the, have...): said weak and fast
 *   spelling    typed something that is not a word, close to the right one: heard, could not spell it
 *   confusable  typed another real word that looks/sounds close (thirteen / thirty)
 *   sound       anything else: heard, known, not recognised
 * "Real word" and "rare word" come from the library's own subtitles (wordRank.ts, il_wordrank.py).
 */
import { createEmptyCard, Rating } from 'ts-fsrs';
import { cardColumns, schedule } from './review';
import { WORD_LIST } from './wordRank';

export const IL = {
	/** Sentences longer than this many words can show "overload" */
	longSentence: 12,
	/** A label is only named as the learner's main one after this many misses over this many lessons */
	mainMisses: 5,
	mainLessons: 3,
	/** A sentence counts as heard when this share of its words is right */
	rightRatio: 0.85,
	reviewSession: 10,
	xpAgain: 5,
	/** A word ranked past this in the library is ticked "I don't know it" until the learner says otherwise */
	rareRank: 4000,
};

export const LABELS = ['vocab', 'speed', 'linking', 'confusable', 'imagine', 'ending', 'weak', 'overload', 'spelling', 'sound'] as const;
export type Label = (typeof LABELS)[number];
/** Labels that are not a listening miss: no Review card for them alone */
export const NOT_LISTENING: Label[] = ['vocab', 'spelling'];
export type TrapKind = 'linking' | 'confusable' | 'imagine';
export type Trap = { text: string; kind: TrapKind; real?: string; note?: string; /** the Connected Speech skill (slug) that teaches it, when the author names one */ skill?: string };

/**
 * A passage's own traps plus the shared chunks (il_chunks, edited in the admin): a chunk the author already marked
 * in the passage is not added twice, and one that is not in the sentence simply never matches (trapSpans).
 */
export function withChunks(traps: Trap[], chunks: Trap[]): Trap[] {
	const own = new Set(traps.map((t) => tokens(t.text).join(' ')));
	return [...traps, ...chunks.filter((c) => !own.has(tokens(c.text).join(' ')))];
}

/** Lower case, curly quotes straight, punctuation off, words split on spaces and hyphens */
export function tokens(s: string): string[] {
	return String(s || '')
		.toLowerCase()
		.replace(/[‘’ʼ`]/g, "'")
		.replace(/[^a-z0-9'\s-]/g, ' ')
		.replace(/(^|\s)'+|'+(\s|$)/g, ' ')
		.split(/[\s-]+/)
		.filter(Boolean);
}

/** The form words are compared in: apostrophes dropped, so "didnt" = "didn't" */
const bare = (w: string) => w.replace(/'/g, '');

const RANK = new Map<string, number>(WORD_LIST.split(' ').map((w, i) => [w, i + 1]));
/** Position of a word in the library (1 = most said), or Infinity */
export const rankOf = (w: string) => RANK.get(bare(w.toLowerCase())) ?? Infinity;
export const isWord = (w: string) => RANK.has(bare(w.toLowerCase())) || /^\d+$/.test(w);

/** Small words said weak and fast in connected speech */
export const FUNCTION_WORDS = new Set((
	'a an the and but or so if as at by for from in into of on to with up out about than then that this these those ' +
	'i me my you your he him his she her it its we us our they them their there here ' +
	'am is are was were be been being do does did have has had will would shall should can could may might must ' +
	'not no just very too also some any all what who when where how why which im youre hes shes were theyre ive youve weve ' +
	'theyve ill youll well theyll id youd hed wed theyd dont doesnt didnt cant couldnt wont wouldnt isnt arent wasnt werent ' +
	'hasnt havent hadnt shouldnt lets thats whats theres heres gonna wanna gotta'
).split(' '));

/** Words said the same way: typing one for the other is spelling, not listening */
const HOMOPHONES = [
	'their there theyre', 'to too two', 'your youre', 'its its', 'hear here', 'know no', 'knew new', 'write right rite',
	'weather whether', 'buy by bye', 'for four fore', 'one won', 'see sea', 'wear where ware', 'whose whos', 'weak week',
	'meet meat', 'piece peace', 'plain plane', 'break brake', 'flower flour', 'hour our', 'son sun', 'wait weight',
	'which witch', 'would wood', 'allowed aloud', 'mail male', 'pair pear', 'sale sail', 'tail tale', 'threw through',
	'brake break', 'principal principle', 'stationary stationery', 'complement compliment', 'cell sell', 'cent scent sent',
	'dear deer', 'die dye', 'fair fare', 'flew flu', 'grown groan', 'heal heel', 'hole whole', 'made maid', 'not knot',
	'pause paws', 'road rode', 'role roll', 'seen scene', 'some sum', 'steal steel', 'wail whale', 'way weigh', 'wine whine',
	'ate eight', 'be bee', 'blew blue', 'nose knows', 'passed past', 'rain reign', 'red read', 'tide tied', 'toe tow',
].map((g) => g.split(' '));
const sameSound = (a: string, b: string) => HOMOPHONES.some((g) => g.includes(a) && g.includes(b));

/** Informal spellings a learner may type for what they heard */
const INFORMAL: Record<string, string[]> = {
	gonna: ['going', 'to'], wanna: ['want', 'to'], gotta: ['got', 'to'], kinda: ['kind', 'of'], sorta: ['sort', 'of'],
	lemme: ['let', 'me'], gimme: ['give', 'me'], dunno: ['dont', 'know'], outta: ['out', 'of'], cause: ['because'], cuz: ['because'],
};

/** Endings a word can lose or gain while the rest is heard: can / can't, walk / walked, protein / proteins */
const ENDINGS = ['s', 'es', 'ed', 'd', 't', 'nt', 'n', 'll', 're', 've', 'm', 'ing', 'er', 'ly'];
const endingOff = (a: string, b: string) => {
	const [long, short] = a.length > b.length ? [a, b] : [b, a];
	return short.length >= 2 && long.startsWith(short) && ENDINGS.includes(long.slice(short.length));
};

export function lev(a: string, b: string): number {
	if (a === b) return 0;
	const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0]!;
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const up = prev[j]!;
			prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = up;
		}
	}
	return prev[b.length]!;
}

/** Same word, or heard and written wrong (see the header); null = a miss */
export function sameWord(ref: string, typed: string): 'ok' | 'typo' | null {
	const a = bare(ref);
	const b = bare(typed);
	if (a === b) return 'ok';
	if (sameSound(a, b)) return 'typo';
	// A missing or extra ending (or another real word) is a listening miss, not a slip: "sens" for "sense" is only spelling
	if ((a.startsWith(b) || b.startsWith(a)) && (endingOff(a, b) || isWord(b))) return null;
	// Another real word was heard (than / then, live / leave): a miss
	if (isWord(b) && isWord(a)) return null;
	const d = lev(a, b);
	// Two letters swapped: "teh", "freind"
	if (a.length >= 3 && a.length === b.length && d <= 2 && [...a].sort().join('') === [...b].sort().join('')) return 'typo';
	// A slip that does not change the sound: a letter dropped or added (comunity, sens), a vowel letter for another.
	// A consonant letter for another (resize / reside) is another sound: a miss, not a slip.
	if (a.length >= 4 && d <= (a.length >= 8 ? 2 : 1) && soundKept(a, b)) return 'typo';
	return null;
}

const VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
/** Keys next to each other on a QWERTY keyboard: a finger slip (phome for phone), not a mishearing */
const KEY_POS = new Map<string, [number, number]>(['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].flatMap((row, r) => [...row].map((c, i) => [c, [r, i + [0, 0.25, 0.75][r]!] as [number, number]])));
const nextKey = (a: string, b: string) => {
	const p = KEY_POS.get(a);
	const q = KEY_POS.get(b);
	return !!p && !!q && Math.abs(p[0] - q[0]) <= 1 && Math.abs(p[1] - q[1]) <= 1.1;
};
/** True when every difference between the two spellings is a letter added or dropped, a vowel letter in place of a vowel letter, or a neighbouring key */
function soundKept(a: string, b: string): boolean {
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
	let i = a.length;
	let j = b.length;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1] && d[i]![j] === d[i - 1]![j - 1]) { i--; j--; }
		else if (d[i]![j] === d[i - 1]![j - 1]! + 1) {
			if (!(VOWEL_LETTERS.has(a[i - 1]!) && VOWEL_LETTERS.has(b[j - 1]!)) && !nextKey(a[i - 1]!, b[j - 1]!)) return false;
			i--; j--;
		} else if (d[i]![j] === d[i - 1]![j]! + 1) i--;
		else j--;
	}
	return true;
}

export type WordResult = { w: string; status: 'ok' | 'typo' | 'wrong' | 'missing'; typed?: string; /** a proper name: shown, never graded */ name?: boolean };
/** What the learner typed, word by word, judged without giving the sentence away: `gap` = words missing just before it */
export type TypedMark = { status: 'ok' | 'typo' | 'wrong' | 'extra'; gap: number };

/** Typed words, with informal spellings opened up ("gonna" -> going to) unless the sentence itself has them; `from` = index in what was typed */
function typedTokens(typed: string, R: string[]) {
	const out: { w: string; from: number }[] = [];
	const T = tokens(typed);
	for (let from = 0; from < T.length; from++) {
		const w = T[from]!;
		// The written sentence says "kinda" and the learner typed "kind of": the same thing heard, one word
		const shut = Object.entries(INFORMAL).find(([k, e]) => R.includes(k) && !R.includes(w) && e.length > 1 && e.every((x, n) => bare(T[from + n] || '') === x));
		if (shut) { out.push({ w: shut[0], from }); from += shut[1].length - 1; continue; }
		const open = INFORMAL[bare(w)];
		if (open && !R.includes(w)) open.forEach((x) => out.push({ w: x, from }));
		else out.push({ w, from });
	}
	return out;
}

/**
 * Proper names (Neil, London): a capital letter in the middle of a sentence. Not graded: nobody can know a spelling by ear,
 * so they are shown in the answer and never counted, marked or sent to the learner's misses. One flag per word of tokens(reference).
 */
export function nameFlags(reference: string): boolean[] {
	const out: boolean[] = [];
	let start = true;
	for (const raw of String(reference || '').split(/\s+/).filter(Boolean)) {
		const n = tokens(raw).length;
		if (!n) continue;
		const core = raw.replace(/^[^A-Za-z0-9]+/, '');
		const pronounI = /^I(['’]|$)/.test(core.replace(/[^A-Za-z0-9'’].*$/, ''));
		const name = !start && /^[A-Z]/.test(core) && !pronounI;
		for (let k = 0; k < n; k++) out.push(name);
		start = /[.?!…:]["'”’)]*$/.test(raw) && !/^(Mr|Mrs|Ms|Dr|St|Prof|Jr|Sr)\.$/.test(raw);
	}
	return out;
}

/** Word by word: the reference sentence against what was typed (an edit-distance alignment) */
export function diffWords(reference: string, typed: string): { words: WordResult[]; right: number; total: number; marks: TypedMark[]; tailGap: number } {
	const R = tokens(reference);
	const names = nameFlags(reference);
	const isName = (i: number) => names.length === R.length && !!names[i];
	const TT = typedTokens(typed, R);
	const T = TT.map((x) => x.w);
	// Costs: a word left out or added 2; a word typed for a close one (that / that's, kinda / kind) 2; for a very different
	// one 3. So "that's sound kind of" against "does that sound kinda" lines "sound" up with "sound" instead of pairing
	// every word with its neighbour.
	const cost = (i: number, j: number) => {
		if (sameWord(R[i]!, T[j]!)) return 0;
		const a = bare(R[i]!);
		const b = bare(T[j]!);
		return endingOff(a, b) || lev(a, b) / Math.max(a.length, b.length, 1) <= 0.5 ? 2 : 3;
	};
	const GAP = 2;
	const d: number[][] = Array.from({ length: R.length + 1 }, () => new Array(T.length + 1).fill(0));
	for (let i = 0; i <= R.length; i++) d[i]![0] = i * GAP;
	for (let j = 0; j <= T.length; j++) d[0]![j] = j * GAP;
	for (let i = 1; i <= R.length; i++) {
		for (let j = 1; j <= T.length; j++) {
			d[i]![j] = Math.min(d[i - 1]![j]! + GAP, d[i]![j - 1]! + GAP, d[i - 1]![j - 1]! + cost(i - 1, j - 1));
		}
	}
	const words: WordResult[] = [];
	const tStatus: TypedMark['status'][] = T.map(() => 'extra');
	const gapBefore = new Array(T.length + 1).fill(0);
	let i = R.length;
	let j = T.length;
	while (i > 0) {
		if (j > 0 && d[i]![j] === d[i - 1]![j - 1]! + cost(i - 1, j - 1)) {
			const s = isName(i - 1) ? 'ok' : sameWord(R[i - 1]!, T[j - 1]!);
			words.push(s === 'ok' ? { w: R[i - 1]!, status: s, ...(isName(i - 1) ? { name: true } : {}) } : { w: R[i - 1]!, status: s || 'wrong', typed: T[j - 1]! });
			tStatus[j - 1] = s || 'wrong';
			i--; j--;
		} else if (d[i]![j] === d[i - 1]![j]! + GAP) {
			if (isName(i - 1)) words.push({ w: R[i - 1]!, status: 'ok', name: true });
			else { words.push({ w: R[i - 1]!, status: 'missing' }); gapBefore[j]++; }
			i--;
		} else {
			j--; // an extra typed word: not counted against the learner
		}
	}
	words.reverse();
	// Back to the words as typed (an opened-up "gonna" is one word for the learner): the worst of its parts
	const worst = ['ok', 'typo', 'extra', 'wrong'] as const;
	const n = tokens(typed).length;
	const marks: TypedMark[] = Array.from({ length: n }, () => ({ status: 'ok' as TypedMark['status'], gap: 0 }));
	TT.forEach((x, k) => {
		const m = marks[x.from]!;
		if (worst.indexOf(tStatus[k]!) > worst.indexOf(m.status as any)) m.status = tStatus[k]!;
		m.gap += gapBefore[k];
	});
	const tailGap = n ? gapBefore[T.length] : R.length;
	const graded = words.filter((x) => !x.name);
	const right = graded.filter((x) => x.status === 'ok' || x.status === 'typo').length;
	return { words, right, total: graded.length, marks, tailGap };
}

export const isRight = (r: { right: number; total: number }) => r.total > 0 && r.right / r.total >= IL.rightRatio;

/**
 * The hint after a wrong check: the sentence as stars only, one star per letter, punctuation kept ("**** *** ****?").
 * No word is shown, so a fix at 0.75x is a real listen, not a copy. null when nothing is missed.
 */
export function hintOf(reference: string, words: WordResult[]): string[] | null {
	if (!words.some((x) => x.status === 'wrong' || x.status === 'missing')) return null;
	// A word the learner already got right is shown; the rest is stars, one per letter (nothing new is revealed)
	let seen = 0;
	return String(reference || '').split(/\s+/).filter(Boolean).map((w) => {
		const n = tokens(w).length;
		const part = words.slice(seen, seen + n);
		seen += n;
		const right = n > 0 && part.every((x) => x.status === 'ok' || x.status === 'typo');
		return right ? w : w.replace(/[A-Za-z0-9]/g, '*');
	});
}

/** Index range [from, to) each trap covers among the sentence's words */
function trapSpans(sentence: string, traps: Trap[]) {
	const R = tokens(sentence).map(bare);
	return traps.flatMap((t) => {
		const P = tokens(t.text).map(bare);
		if (!P.length) return [];
		for (let i = 0; i + P.length <= R.length; i++) {
			if (P.every((p, k) => R[i + k] === p)) return [{ from: i, to: i + P.length, trap: t }];
		}
		return [];
	});
}

/** Sentence words whose letters were heard but split in the wrong places: "a nice" typed "an ice", "into" typed "in to" */
function splitAt(R: string[], T: string[]): Set<number> {
	const out = new Set<number>();
	const r = R.map(bare);
	const t = T.map(bare);
	for (let i = 0; i < r.length; i++) {
		for (let a = 1; a <= 3 && i + a <= r.length; a++) {
			const joined = r.slice(i, i + a).join('');
			if (joined.length < 3) continue;
			for (let j = 0; j < t.length; j++) {
				for (let b = 1; b <= 3 && j + b <= t.length; b++) {
					if (a === 1 && b === 1) continue;
					if (t.slice(j, j + b).join('') === joined && t.slice(j, j + b).join(' ') !== r.slice(i, i + a).join(' ')) {
						for (let k = i; k < i + a; k++) out.add(k);
					}
				}
			}
		}
	}
	return out;
}

const VOWEL_START = /^(?:[aeio]|u(?!s|ni|ti))/;
/** A final consonant (a silent final e does not count: "make", "like") */
const CONS_END = /[^aeiouy]$|[^aeiou]e$/;
/**
 * Word junctions where a final consonant links to the vowel that starts the next word and what the learner typed
 * breaks exactly there: "turns out" typed "term out", "sort of" typed "soil up". Maps the sentence index to the
 * skill that teaches it (flap-t for a /t/ or /d/ after a vowel or r, else linking-words).
 */
function linkedAt(words: WordResult[]): Map<number, string> {
	const out = new Map<number, string>();
	const lost = (x?: WordResult) => !!x && (x.status === 'missing' || x.status === 'wrong');
	for (let i = 0; i + 1 < words.length; i++) {
		const a = bare(words[i]!.w.toLowerCase());
		const b = bare(words[i + 1]!.w.toLowerCase());
		if (!CONS_END.test(a) || !VOWEL_START.test(b) || (FUNCTION_WORDS.has(a) && FUNCTION_WORDS.has(b))) continue;
		const ta = words[i]!.typed ? bare(words[i]!.typed!.toLowerCase()) : '';
		const tb = words[i + 1]!.typed ? bare(words[i + 1]!.typed!.toLowerCase()) : '';
		// The break sits at the junction: the first word lost its last letter, or the second its first
		// Only a word that was typed (differently) counts: a word left out says nothing about the junction, and a word
		// that is the right one with an ending off (can't / can) is the "ending" label
		const sameStem = (x: string, y: string) => x.startsWith(y) || y.startsWith(x);
		const endBroke = lost(words[i]) && !!ta && !sameStem(a, ta) && ta.slice(-1) !== a.slice(-1);
		const startBroke = lost(words[i + 1]) && !!tb && !sameStem(b, tb) && tb[0] !== b[0];
		if (!endBroke && !startBroke) continue;
		const skill = /[aeiour][td]e?$/.test(a) ? 'flap-t' : 'linking-words';
		if (lost(words[i])) out.set(i, skill);
		if (lost(words[i + 1])) out.set(i + 1, skill);
	}
	return out;
}

export type Miss = { word: string; label: Label; /** a word typed right that the learner marked as a guess: its index in the sentence */ guessAt?: number; real?: string; note?: string; typed?: string; skill?: string };

/**
 * The Connected Speech skill (slug in listening_skills) that teaches a kind of miss, or null when none does:
 * the author's own `skill` on the trap first, else by the kind of miss.
 */
export function skillFor(label: Label, word: string, typed: string, trap?: Trap): string | null {
	if (trap?.skill) return trap.skill;
	if (label === 'weak') return 'weak-forms';
	if (label === 'linking') return /dʒ|tʃ/.test(trap?.real || '') || /(did|do|would|could|should|got|get|bet|let|but|that|what|not|hit|put|meet) you/i.test(trap?.text || '') ? 'yod-coalescence' : 'linking-words';
	if (label === 'ending') {
		const a = bare(word);
		const b = bare(typed);
		const tail = (a.length > b.length ? a.slice(b.length) : b.slice(a.length));
		if (tail === 's' || tail === 'es') return 's-endings';
		if (tail === 'd' || tail === 'ed') return 'ed-endings';
		if (tail === 't' || tail === 'nt') return 'stop-t';
		return 'final-consonants';
	}
	return null;
}

/** Content words missed that the learner most likely does not know yet (rare in the library), to tick "I don't know it" */
export function likelyUnknown(words: WordResult[]): string[] {
	return [...new Set(words
		.filter((x) => (x.status === 'wrong' || x.status === 'missing') && !FUNCTION_WORDS.has(bare(x.w)) && rankOf(x.w) > IL.rareRank)
		// Typed close to the word (resize for reside): the sounds were heard, so ask "misheard or misspelt?" instead
		.filter((x) => !(x.typed && lev(bare(x.w), bare(x.typed)) / Math.max(x.w.length, 1) <= 0.5))
		.map((x) => x.w))];
}

/**
 * One label for every missed word. `unknown`: words the learner does not know. `slow`: the word results of the
 * retry at 0.75x, when there is one (a word right there is "speed"). `typed`: what was typed, to find split words.
 */
export type Heard = 'spelling' | 'misheard';
/** Typed like any word, but never a listening miss */
const ARTICLES = new Set(['a', 'an', 'the']);
export function labelMisses(sentence: string, traps: Trap[], words: WordResult[], unknown: string[] = [], slow?: WordResult[] | null, typed = '', hinted: number[] = [], heard: Record<string, Heard> = {}): Miss[] {
	const known = new Set(unknown.map((u) => bare(u.toLowerCase())));
	const spans = trapSpans(sentence, traps);
	const split = typed ? splitAt(tokens(sentence), tokens(typed)) : new Set<number>();
	const linked = linkedAt(words);
	const n = words.length;
	const lostAt = words.map((x) => x.status === 'missing' || x.status === 'wrong');
	// Long sentence, the start right, the tail lost
	const cut = Math.ceil(n * 0.6);
	const overload = n >= IL.longSentence && lostAt.slice(0, cut).every((x) => !x) && lostAt.slice(cut).filter(Boolean).length >= 2;

	const out: Miss[] = [];
	words.forEach((x, idx) => {
		if (!lostAt[idx]) return;
		// a / an / the still have to be typed, but a lost article says nothing about the learner's ear
		if (ARTICLES.has(x.w.toLowerCase())) return;
		const trap = spans.find((s) => idx >= s.from && idx < s.to)?.trap;
		const w = bare(x.w);
		const t = x.typed ? bare(x.typed) : '';
		let label: Label;
		if (known.has(w)) label = 'vocab';
		// Fixed at 0.75x before the hint gave it away: heard once slower
		else if (slow && !hinted.includes(idx) && (slow[idx]?.status === 'ok' || slow[idx]?.status === 'typo')) label = 'speed';
		else if (trap) label = trap.kind;
		else if (split.has(idx) || linked.has(idx)) label = 'linking';
		else if (overload && idx >= cut) label = 'overload';
		else if (t && endingOff(w, t)) label = 'ending';
		else if (FUNCTION_WORDS.has(w)) label = 'weak';
		else if (t && !isWord(t) && t[0] === w[0] && soundKept(w, t) && lev(w, t) / Math.max(w.length, 1) <= 0.45) label = 'spelling';
		else if (t && lev(w, t) / Math.max(w.length, 1) <= 0.5) label = 'confusable';
		else label = 'sound';
		// The learner's own answer to "misheard or misspelt?" (asked only where letters cannot tell: see toConfirm)
		// The learner's own mark wins: "heard it, only misspelt" is spelling whatever the letters say; "heard another
		// word" turns a close non-word into sound and an unrecognised real word into confusable
		const h = heard[w];
		if (h === 'spelling' && t && label !== 'vocab') label = 'spelling';
		else if (h === 'misheard' && t && label === 'spelling') label = isWord(t) ? 'confusable' : 'sound';
		else if (h === 'misheard' && t && label === 'sound' && isWord(t)) label = 'confusable';
		const skill = (label === 'linking' && !trap && linked.get(idx)) || skillFor(label, x.w, x.typed || '', trap);
		out.push({ word: x.w, label, typed: x.typed, ...(skill ? { skill } : {}), ...(trap && label === trap.kind ? { real: trap.real, note: trap.note } : {}) });
	});
	return out;
}

/**
 * Misses where letters alone cannot say whether the learner misheard or only misspelt: the typed word is close to the
 * right one (labelled spelling or confusable, before the learner's answer). The learner is asked; `guess` is preselected.
 */
export function toConfirm(misses: Miss[]): { word: string; typed: string; guess: Heard }[] {
	const seen = new Set<string>();
	return misses.filter((m) => m.typed && (m.label === 'spelling' || m.label === 'confusable') && !seen.has(m.word) && seen.add(m.word))
		.map((m) => ({ word: m.word, typed: m.typed!, guess: m.label === 'spelling' ? 'spelling' : 'misheard' }));
}

/** The label that names a sentence: the most frequent listening one among its misses (vocab / spelling only when that is all) */
export function sentenceLabel(misses: Miss[]): Label | null {
	if (!misses.length) return null;
	const count = new Map<Label, number>();
	for (const m of misses) count.set(m.label, (count.get(m.label) || 0) + 1);
	const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
	const listening = sorted.filter(([l]) => !NOT_LISTENING.includes(l));
	return (listening[0] || sorted[0])![0];
}

/** Grade of a Review card (same scale as lib/review.ts gradeOf): wrong Again, slow or 3+ listens Hard, 2nd listen Good, 1st Easy */
export function reviewGrade(correct: boolean, listens: number, slow: boolean) {
	if (!correct) return Rating.Again;
	if (slow || listens >= 3) return Rating.Hard;
	if (listens === 2) return Rating.Good;
	return Rating.Easy;
}

/** A new Review card: first review tomorrow */
export function newCard(userId: string, sentenceId: string, label: Label, now = new Date()) {
	const card = createEmptyCard(now);
	card.due = new Date(now.getTime() + 24 * 3600 * 1000);
	return { user_id: userId, kind: 'sentence', ref_id: sentenceId, label, ...cardColumns(card) };
}

export { schedule, cardColumns };
