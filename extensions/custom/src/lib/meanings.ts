/**
 * Meanings of English words in the learner's language (table word_meanings, filled by database/tools/import_kaikki.py from the
 * Wiktionary edition of that language). A card shows `short`, the My words page shows the whole first sense.
 */
type Db = any;

/** A sense cut to one line a card can hold: no leading "(thường)", the first of the `;` parts, at most `limit` characters */
export function shorten(gloss: string, limit = 60): string {
	let s = gloss.trim();
	while (s.startsWith('(')) {
		let depth = 0;
		let end = -1;
		for (let i = 0; i < s.length; i++) {
			if (s[i] === '(') depth++;
			else if (s[i] === ')' && --depth === 0) { end = i; break; }
		}
		if (end < 0) break;
		s = s.slice(end + 1).trim();
	}
	const first = (s || gloss).split(';')[0]!;
	const plain = first.replace(/\s*\([^)]*\)/g, '').trim();
	s = (plain.length >= 3 ? plain : first).replace(/\s+/g, ' ').replace(/^[ .,;:]+|[ .,;:)]+$/g, '');
	if (s.length > limit) {
		const cut = s.lastIndexOf(',', limit);
		s = cut > 12 ? s.slice(0, cut) : `${s.slice(0, limit - 1).trimEnd()}…`;
	}
	return s;
}

/** The first sense of a word in a language; for "resides" / "molecules" the sense of its base word */
export async function meaningFor(database: Db, word: string, lang: string): Promise<{ short: string; meaning: string; pos: string | null } | null> {
	const l = String(lang || 'vi').slice(0, 2).toLowerCase();
	const first = (w: string) => database('word_meanings').select('short', 'meaning', 'pos').where({ word: w, lang: l, ord: 1 }).first();
	let row = await first(word);
	if (!row) {
		const lemma = (await database('wiktionary_en').select(database.raw("doc->'form_of'->>'lemma' AS lemma")).where({ w: word }).first())?.lemma;
		if (lemma) row = await first(String(lemma));
	}
	return row ? { short: row.short, meaning: row.meaning, pos: row.pos } : null;
}

const pools = new Map<string, { at: number; rows: string[] }>();
/** Short meanings of other words of the same language and part of speech: wrong answers of the same kind as the right one. Kept an hour. */
export async function meaningPool(database: Db, lang: string, pos: string | null): Promise<string[]> {
	const key = `${lang}|${pos ?? ''}`;
	const hit = pools.get(key);
	if (hit && Date.now() - hit.at < 3_600_000) return hit.rows;
	const q = database('word_meanings').where({ lang, ord: 1 });
	if (pos) q.where({ pos });
	const rows: string[] = (await q.orderByRaw('random()').limit(400).pluck('short')).map(String);
	pools.set(key, { at: Date.now(), rows });
	if (pools.size > 200) pools.delete(pools.keys().next().value as string);
	return rows;
}

/** An IPA line as a learner can read it: without the marks for "non-syllabic" / "syllabic" (/ˈlaɪ̯f/ -> /ˈlaɪf/), which fonts draw as a stray blob */
export const cleanIpa = (ipa: unknown): string | null => (ipa ? String(ipa).replace(/[\u032F\u0329]/g, '') : null);
