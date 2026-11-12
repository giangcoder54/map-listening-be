/**
 * What a wrong answer says about what the learner heard, so the page can tell them where they
 * went wrong instead of only "the answer was he'll" (2026-11-06_practice_custom.sql).
 *
 * The answer given and the part asked for are compared word by word; the first word that differs
 * names the mistake:
 *   missing    heard the word without its ending: "he" for "he'll" (the 'll swallowed)
 *   extra      heard an ending that is not there: "they'll" for "they" (a trap)
 *   ending     the right word with another ending: "he'd" for "he'll"
 *   full       the full form of a contraction: "he will" for "he'll" (right meaning, not what was said)
 *   short      a contraction of the full form said: "they'll" for "they will" (a trap)
 *   typo       one letter off in a longer word, nothing heard wrong
 *   word       another word: "she'll" for "he'll"
 *   dropped    a whole word missed: "need" for "need to"
 *   added      a word typed that was not said: "need to" for "need"
 * `heard` / `said`: the two words that differ, `ending`: the ending at stake ("'ll").
 * The team may write why a wrong choice is wrong (a practice step's `why`): that line wins.
 */
import { normalizeAnswer } from '../v1/engagementRoutes';

export type MistakeKind = 'missing' | 'extra' | 'ending' | 'full' | 'short' | 'typo' | 'word' | 'dropped' | 'added';
export type Mistake = { kind: MistakeKind; heard: string; said: string; ending: string | null; note: string | null };

/** Contraction endings and the words they stand for */
const ENDINGS: [string, string[]][] = [
	["n't", ['not']], ["'ll", ['will']], ["'re", ['are']], ["'ve", ['have']], ["'d", ['would', 'had']], ["'s", ['is', 'has', 'us']], ["'m", ['am']],
];
/** Contractions whose base changes */
const ODD: Record<string, string> = { "won't": 'will not', "can't": 'cannot', "shan't": 'shall not', "ain't": 'am not' };

const tokens = (s: string) => normalizeAnswer(s.replace(/[’‘]/g, "'")).split(' ').filter(Boolean);

/** "he'll" → { base: "he", ending: "'ll" }; a plain word → null */
export function splitContraction(word: string): { base: string; ending: string } | null {
	const w = word.toLowerCase().replace(/[’‘]/g, "'");
	if (ODD[w]) return { base: ODD[w]!.split(' ')[0]!, ending: "n't" };
	for (const [ending] of ENDINGS) if (w.endsWith(ending) && w.length > ending.length) return { base: w.slice(0, -ending.length), ending };
	return null;
}

/** The full forms of a contraction: "he'll" → ["he will"], "he'd" → ["he would", "he had"] */
function fullForms(word: string): string[] {
	const w = word.toLowerCase();
	if (ODD[w]) return [ODD[w]!, ...(w === "can't" ? ['can not'] : [])];
	const c = splitContraction(w);
	if (!c) return [];
	const words = ENDINGS.find(([e]) => e === c.ending)?.[1] || [];
	return words.map((x) => `${c.base} ${x}`);
}

function distance(a: string, b: string) {
	const row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const keep = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = keep;
		}
	}
	return row[b.length]!;
}

/**
 * The mistake in `given` against `target` (the part asked for). `why`: lines the team wrote
 * for wrong answers, by answer. null when nothing can be said (empty answer, "I can't hear it").
 */
export function mistakeOf(target: string, given: string, why: Record<string, string> = {}): Mistake | null {
	const g = tokens(given);
	const t = tokens(target);
	if (!g.length || !t.length) return null;
	const noteFor = () => {
		const key = normalizeAnswer(given);
		for (const [answer, line] of Object.entries(why)) if (normalizeAnswer(answer) === key && line.trim()) return line.trim();
		return null;
	};
	const note = noteFor();
	const make = (kind: MistakeKind, heard: string, said: string, ending: string | null = null): Mistake => ({ kind, heard, said, ending, note });

	// Full form typed for a contraction said, or the other way round
	const gs = g.join(' ');
	const ts = t.join(' ');
	for (let i = 0; i < t.length; i++) {
		for (const full of fullForms(t[i]!)) {
			if ([...t.slice(0, i), full, ...t.slice(i + 1)].join(' ') === gs) return make('full', full, t[i]!, splitContraction(t[i]!)?.ending ?? null);
		}
	}
	for (let i = 0; i < g.length; i++) {
		for (const full of fullForms(g[i]!)) {
			if ([...g.slice(0, i), full, ...g.slice(i + 1)].join(' ') === ts) return make('short', g[i]!, full, splitContraction(g[i]!)?.ending ?? null);
		}
	}

	// Words heard right at both ends are set aside: what is left is the mistake. Nothing left on
	// one side is a whole word missed ("need" for "need to") or one added that was not said.
	let a = 0;
	while (a < g.length && a < t.length && g[a] === t[a]) a++;
	let z = 0;
	while (z < g.length - a && z < t.length - a && g[g.length - 1 - z] === t[t.length - 1 - z]) z++;
	const gm = g.slice(a, g.length - z);
	const tm = t.slice(a, t.length - z);
	if (!gm.length && tm.length) return make('dropped', '', tm.join(' '));
	if (gm.length && !tm.length) return make('added', gm.join(' '), '');

	const n = Math.max(g.length, t.length);
	for (let i = 0; i < n; i++) {
		const heard = g[i] ?? '';
		const said = t[i] ?? '';
		if (heard === said) continue;
		if (!heard || !said) return make('word', gm.join(' '), tm.join(' '));
		const hc = splitContraction(heard);
		const sc = splitContraction(said);
		if (sc && !hc && sc.base === heard) return make('missing', heard, said, sc.ending);
		if (hc && !sc && hc.base === said) return make('extra', heard, said, hc.ending);
		if (hc && sc && hc.base === sc.base) return make('ending', heard, said, sc.ending);
		if (said.length >= 4 && distance(heard, said) === 1 && !hc && !sc) return make('typo', heard, said);
		return make('word', heard, said, sc?.ending ?? hc?.ending ?? null);
	}
	return make('word', gs, ts);
}

/** The mistakes of a run, by kind, most first (the lesson's summary) */
export function mistakesOf(items: { result?: { correct: boolean; mistake?: Mistake | null } | null }[]) {
	const count = new Map<MistakeKind, number>();
	for (const it of items) {
		const m = it.result && !it.result.correct ? it.result.mistake : null;
		if (m) count.set(m.kind, (count.get(m.kind) || 0) + 1);
	}
	return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n }));
}
