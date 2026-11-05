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

/** Wrong answers for a phrase: its last mixed-up word swapped (none when it has no such word) */
export function mixUps(target: string): string[] {
	const words = target.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
	let at = -1;
	words.forEach((w, i) => { if (MIXED_UP[clean(w)]) at = i; });
	if (at < 0) return [];
	return MIXED_UP[clean(words[at]!)]!.map((alt) => words.map((w, i) => (i === at ? alt : w)).join(' '));
}
