/**
 * The search box of a lesson list (Extensive, Intensive): lesson title (base and the learner's language),
 * video title and channel. Every word typed must be there. A word typed without accents finds any accents
 * ("day som" finds "dậy sớm"); a word typed with them must match them ("ngủ" does not find "người").
 * The catalogs are a few hundred rows, so they are matched here and the list query is then limited to the
 * ids found (no database extension needed).
 */
const MAX_CHARS = 80;
const MAX_WORDS = 8;

/** Lower case, punctuation to spaces, accents kept */
const clean = (s: string) => s.normalize('NFC').toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').normalize('NFC');

/** The words of ?q=, cleaned; empty when nothing was typed */
export const searchWords = (q: unknown) => clean(String(q ?? '').slice(0, MAX_CHARS)).split(' ').filter(Boolean).slice(0, MAX_WORDS);

/**
 * Latin-script words match from the start of a word, and a short one (up to 3 letters) only a whole word
 * ("ngu" does not find "nguoi", "art" does not find "start"). Scripts written without spaces match anywhere.
 */
export const matchesWords = (texts: (string | null | undefined)[], words: string[]) => {
	const exact = ` ${clean(texts.filter(Boolean).join(' '))} `;
	const folded = fold(exact);
	return words.every((w) => {
		const plain = fold(w);
		const hay = plain === w ? folded : exact;
		if (!/^[a-z0-9]+$/.test(plain)) return hay.includes(w);
		return hay.includes(w.length <= 3 ? ` ${w} ` : ` ${w}`);
	});
};

/** Ids of the published lessons the words find. `kind` picks the tables: el_lessons or il_lessons */
export const searchLessonIds = async (database: any, kind: 'el' | 'il', lang: string, words: string[]): Promise<string[]> => {
	const { rows } = await database.raw(`
		SELECT l.id, l.title, tt.text AS translated, sv.title AS video, sv.channel_name AS channel
		FROM ${kind}_lessons l
		JOIN source_videos sv ON sv.id = l.source_video_id
		LEFT JOIN ${kind}_translations tt ON tt.lesson_id = l.id AND tt.lang = ? AND tt.key = 'title'
		WHERE l.status = 'published'`, [lang]);
	return rows.filter((r: any) => matchesWords([r.title, r.translated, r.video, r.channel], words)).map((r: any) => r.id);
};
