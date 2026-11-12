/**
 * Vietsub: what a clip's lines mean in the learner's language, shown once an item is answered
 * (2026-11-08_video_lines.sql). Never while listening: the learner would read, not listen, and a
 * translation gives the answer away ("cần phải" → "need to").
 *
 * A line only partly in the clip (a lead-in cut, a line left hanging) has no translation: "…".
 * A translation made from an older English text (source_hash differs) is out of date: not shown.
 * null when the language has no translation for any line of the clip, or is English.
 */
export type SubLine = { speaker: string | null; partial: boolean; text: string; tr: string | null };

/** The page's language as a languages.code: "vi" → "vi-VN" */
export async function languageOf(database: any, locale: unknown): Promise<string | null> {
	const l = String(locale || '').trim().toLowerCase();
	if (!l || l.startsWith('en')) return null;
	const row = await database('languages').select('code').whereRaw('lower(code) = ? OR lower(code) LIKE ?', [l, `${l.split('-')[0]}-%`]).orderByRaw('lower(code) = ? DESC', [l]).first();
	return row?.code || null;
}

export async function subsOf(database: any, clipId: string, locale: unknown): Promise<{ lang: string; lines: SubLine[] } | null> {
	const lang = await languageOf(database, locale);
	if (!lang) return null;
	const rows = await database('listening_clip_lines as cl')
		.join('video_lines as vl', 'vl.id', 'cl.line_id')
		.leftJoin('video_line_translations as tr', function (this: any) {
			this.on('tr.line_id', 'vl.id').andOn('tr.languages_code', database.raw('?', [lang]));
		})
		.select('cl.partial', 'vl.speaker', 'vl.text', 'tr.text as tr', database.raw('tr.source_hash = md5(vl.text) AS fresh'))
		.where('cl.clip_id', clipId)
		.orderBy('cl.sort');
	const lines: SubLine[] = rows.map((r: any) => ({
		speaker: r.speaker || null,
		partial: !!r.partial,
		text: r.text,
		tr: !r.partial && r.fresh && r.tr ? String(r.tr) : null,
	}));
	return lines.some((l) => l.tr) ? { lang, lines } : null;
}
