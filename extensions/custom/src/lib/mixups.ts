/**
 * Small words learners hear one for another in fast speech, and the wrong answers made from
 * them: the mixed-up word of a phrase swapped for each word it is heard as ("asked her" →
 * asked him, asked a, asked his). Used when a clip has no wrong answers of its own; the team
 * can still change them (a practice step's `wrong`). Mirrors MIXED_UP in the site's
 * utils/adminLessons.ts, which suggests the same ones while authoring.
 * "him" is not swapped for "'em": with the h dropped both sound the same, a fair answer; and
 * "them" and "'em" are one word, never a wrong answer for each other.
 */
export const MIXED_UP: Record<string, string[]> = {
	him: ['them', 'her', 'his'], her: ['him', 'a', 'his'], his: ['is', 'this', "he's"], he: ['it', 'she', 'we'],
	them: ['him', 'then', 'her'], "'em": ['him', 'her', 'then'], it: ['he', 'at', 'in'], she: ['he', 'see', 'we'],
	have: ['of', 'a', 'had'], has: ['is', 'as', 'was'], had: ['would', 'have', 'has'], of: ['have', 'a', 'on'],
	is: ['his', 'as', 'was'], was: ['is', 'as', 'were'], a: ['her', 'the', 'an'], the: ['a', 'that', 'this'],
	and: ['an', 'in', 'on'], to: ['the', 'a', 'too'], you: ['ya', 'he', 'your'], your: ['you', "you're", 'her'],
	can: ["can't", 'could', 'and'], "can't": ['can', 'cat', 'car'], for: ['four', 'from', 'far'], at: ['it', 'a', 'and'],
	hate: ['ate', 'eight', 'hit'], ate: ['hate', 'eight', 'eat'], let: ['led', 'lead', 'lid'], get: ['got', 'gat', 'gate'],
};

const clean = (w: string) => w.toLowerCase().replace(/[^a-z']/g, '');

/**
 * A pronoun with an ending ("he'll"): the same pronoun bare and with its other endings
 * ("he", "he's", "he'd"). These are fair wrong answers: they fit the sentence as well, so only
 * the ending heard tells them apart. Mirrors contractionMixUps in the site's utils/adminLessons.ts.
 */
const ENDINGS_OF: Record<string, string[]> = {
	i: ["'m", "'d", "'ll", "'ve"],
	you: ["'re", "'d", "'ll", "'ve"], we: ["'re", "'d", "'ll", "'ve"], they: ["'re", "'d", "'ll", "'ve"],
	he: ["'s", "'d", "'ll"], she: ["'s", "'d", "'ll"], it: ["'s", "'d", "'ll"], that: ["'s", "'d", "'ll"],
	there: ["'s", "'d", "'ll"], who: ["'s", "'d", "'ll"], what: ["'s", "'d", "'ll"], where: ["'s", "'d", "'ll"],
};
export function contractionMixUps(word: string): string[] | null {
	const m = word.replace(/[’‘]/g, "'").match(/^([A-Za-z]+)('(?:ll|d|s|re|ve|m))$/);
	if (!m) return null;
	const [, base, ending] = m as unknown as [string, string, string];
	const others = ENDINGS_OF[base.toLowerCase()];
	if (!others) return null;
	return [base, ...others.filter((e) => e !== ending.toLowerCase()).map((e) => base + e)].slice(0, 3);
}

/** Wrong answers for a phrase: a pronoun's other endings, else its last mixed-up word swapped (none when it has no such word) */
export function mixUps(target: string): string[] {
	const words = target.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
	// The last word that has mix-ups: a pronoun with an ending, or a small word of MIXED_UP
	for (let i = words.length - 1; i >= 0; i--) {
		const alts = contractionMixUps(words[i]!.replace(/[^A-Za-z'’]/g, '')) || MIXED_UP[clean(words[i]!)];
		if (alts) return alts.map((alt) => words.map((w, k) => (k === i ? alt : w)).join(' '));
	}
	return [];
}
