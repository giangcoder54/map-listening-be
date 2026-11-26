/**
 * Translations of a lesson's learner text for the team (Intensive il_translations, Extensive el_translations):
 * one row per key, with the base (Vietnamese) text beside it. The base stays in the lesson's own columns;
 * another language is only rows here, and an empty one falls back to the base (multi-language skill).
 */
export type TrRow = { key: string; label: string; base: string };

/** Languages a learner can read besides the base one */
export async function otherLangs(db: any, base: string): Promise<string[]> {
	const rows = await db('languages').select('code').whereNot('code', base).orderBy('code');
	return rows.map((r: any) => String(r.code));
}

/** The rows with what `lang` has for each */
export async function readTr(db: any, table: string, lessonId: string, lang: string, rows: TrRow[]) {
	const have = new Map<string, string>((await db(table).select('key', 'text').where({ lesson_id: lessonId, lang })).map((r: any) => [r.key, r.text]));
	return rows.map((r) => ({ ...r, text: have.get(r.key) ?? '' }));
}

/** Saves the keys sent (only those the lesson has); an empty text removes the key so the base shows */
export async function writeTr(db: any, table: string, lessonId: string, lang: string, items: Record<string, unknown>, rows: TrRow[]) {
	const allowed = new Set(rows.map((r) => r.key));
	const sent = Object.entries(items || {}).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, String(v ?? '').trim().slice(0, 4000)] as [string, string]);
	await db.transaction(async (trx: any) => {
		if (sent.length) await trx(table).where({ lesson_id: lessonId, lang }).whereIn('key', sent.map(([k]) => k)).delete();
		const keep = sent.filter(([, t]) => t);
		if (keep.length) await trx(table).insert(keep.map(([key, text]) => ({ lesson_id: lessonId, lang, key, text })));
	});
	return sent.length;
}
