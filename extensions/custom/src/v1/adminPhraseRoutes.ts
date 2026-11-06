/**
 * Phrase Lab content for admins and content editors (lib/staff.ts).
 *
 *   GET    /admin/phrases                ?type=<uuid> &status=draft|published &q= &page= &limit=
 *   GET    /admin/phrases/:id            phrase + translations + clips
 *   PATCH  /admin/phrases/:id            { type_id?, text?, text_linked?, ipa?, kind?, status?, is_premium?, sort?,
 *                                          translations?: { [languages_code]: { meaning, usage, avoid, similar, replies, wrong_meanings, situations } } }
 *   DELETE /admin/phrases/:id
 *   POST   /admin/phrases/import         { youtube_video_id, publish?, items: [...] } (from /admin/phrases/import)
 *   PATCH  /admin/phrase-clips/:id       { start_time?, end_time?, line_text?, context?, status?, sort? }
 *   DELETE /admin/phrase-clips/:id
 *   GET    /admin/phrase-types           every type (drafts too), for the selects
 *
 * Import: an item whose phrase already exists (same text once normalised) only adds its
 * clip and fills the empty texts; a new one creates the phrase (+ vi-VN texts).
 */
import { UUID_RE } from '../lib/lessons';
import { DEFAULT_LOCALE, jsonList, normalizePhrase, slugify } from '../lib/phrases';
import { isStaff } from '../lib/staff';

const KINDS = ['reaction', 'situational', 'frame'];
const STATUSES = ['draft', 'published'];
const TR_TEXT = ['meaning', 'usage', 'avoid'] as const;

const str = (value: any, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
/** "1:15.3", "75.3" or 75.3 -> seconds */
const seconds = (value: any) => {
	if (typeof value === 'number') return value;
	const parts = String(value ?? '').trim().replace(/[[\]]/g, '').split(':').map(Number);
	if (!parts.length || parts.some((n) => Number.isNaN(n))) return NaN;
	return parts.reduce((acc, n) => acc * 60 + n, 0);
};
const strings = (value: any, max = 300, count = 10) =>
	jsonList(value).map((v) => str(v, max)).filter(Boolean).slice(0, count);
const similarList = (value: any) =>
	jsonList(value)
		.map((v: any) => (typeof v === 'string' ? { text: str(v, 200), note: '' } : { text: str(v?.text, 200), note: str(v?.note, 300) }))
		.filter((v) => v.text)
		.slice(0, 6);

/** Clean translation fields from a request body (only the ones given) */
function translationPatch(input: any) {
	const out: Record<string, any> = {};
	if (!input || typeof input !== 'object') return out;
	for (const key of TR_TEXT) if (input[key] !== undefined) out[key] = str(input[key], key === 'meaning' ? 500 : 2000) || null;
	if (input.similar !== undefined) out.similar_phrases = JSON.stringify(similarList(input.similar));
	if (input.replies !== undefined) out.replies = JSON.stringify(strings(input.replies, 200, 6));
	if (input.wrong_meanings !== undefined) out.wrong_meanings = JSON.stringify(strings(input.wrong_meanings, 300, 4));
	if (input.situations !== undefined) out.situations = JSON.stringify(strings(input.situations, 500, 8));
	return out;
}

export function registerAdminPhraseRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-phrases] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	const uniqueSlug = async (trx: any, text: string, ownId?: string) => {
		const base = slugify(text);
		for (let i = 1; i < 100; i++) {
			const slug = i === 1 ? base : `${base}-${i}`;
			const taken = await trx('phrases').where('slug', slug).modify((q: any) => { if (ownId) q.whereNot('id', ownId); }).first('id');
			if (!taken) return slug;
		}
		return `${base}-${Date.now()}`;
	};

	/** Insert or update the texts of one language */
	const saveTranslation = async (trx: any, phraseId: string, lang: string, patch: Record<string, any>, onlyEmpty = false) => {
		if (!Object.keys(patch).length) return;
		const row = await trx('phrases_translations').where({ phrases_id: phraseId, languages_code: lang }).first();
		if (!row) {
			await trx('phrases_translations').insert({ phrases_id: phraseId, languages_code: lang, ...patch });
			return;
		}
		const update = onlyEmpty
			? Object.fromEntries(Object.entries(patch).filter(([key]) => {
				const current = row[key];
				return current === null || current === '' || (Array.isArray(current) && !current.length) || current === '[]';
			}))
			: patch;
		if (Object.keys(update).length) await trx('phrases_translations').where('id', row.id).update(update);
	};

	router.get('/admin/phrase-types', staff(async (_req, res) => {
		const types = await database('phrase_types as t')
			.leftJoin('phrases as p', 'p.type_id', 't.id')
			.select('t.id', 't.name', 't.slug', 't.sort', 't.status', 't.is_premium',
				database.raw('count(p.id)::int AS phrases'),
				database.raw(`count(p.id) FILTER (WHERE p.status = 'published')::int AS published`))
			.groupBy('t.id')
			.orderByRaw('t.sort ASC NULLS LAST, t.name');
		return res.json({ success: true, data: types });
	}));

	router.get('/admin/phrases', staff(async (req, res) => {
		const query = req.query || {};
		const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
		const page = Math.max(1, Math.floor(Number(query.page)) || 1);
		const q = database('phrases as p')
			.join('phrase_types as t', 't.id', 'p.type_id')
			.leftJoin('phrases_translations as tr', function (this: any) {
				this.on('tr.phrases_id', 'p.id').andOn('tr.languages_code', database.raw('?', [DEFAULT_LOCALE]));
			});
		const type = String(query.type || '');
		if (type) {
			if (!UUID_RE.test(type)) return res.status(400).json({ success: false, message: 'Invalid type' });
			q.where('p.type_id', type);
		}
		if (STATUSES.includes(String(query.status))) q.where('p.status', String(query.status));
		const text = str(query.q, 200);
		if (text) q.whereRaw(`(p.text ILIKE ? ESCAPE '\\' OR tr.meaning ILIKE ? ESCAPE '\\')`, [`%${likeEscape(text)}%`, `%${likeEscape(text)}%`]);

		const rows = await q.clone()
			.select('p.id', 'p.text', 'p.slug', 'p.status', 'p.is_premium', 'p.kind', 'p.sort', 'p.learners_count', 'p.date_created',
				't.id as type_id', 't.name as type_name', 'tr.meaning',
				database.raw(`(SELECT count(*)::int FROM phrase_clips c WHERE c.phrase_id = p.id AND c.status = 'published') AS clips`),
				database.raw(`coalesce(jsonb_array_length(tr.situations), 0) AS situations`),
				database.raw('count(*) OVER ()::int AS total'))
			.orderByRaw('t.sort ASC NULLS LAST, p.sort ASC NULLS LAST, p.date_created ASC, p.id')
			.limit(limit)
			.offset((page - 1) * limit);
		const total = rows[0]?.total ?? (page > 1 ? Number((await q.clone().count('* as n').first())?.n) || 0 : 0);
		return res.json({ success: true, data: rows.map(({ total: _t, ...r }: any) => r), total, page, limit });
	}));

	router.get('/admin/phrases/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
		const phrase = await database('phrases').where('id', id).first();
		if (!phrase) return res.status(404).json({ success: false, message: 'Not found' });
		const [translations, clips] = await Promise.all([
			database('phrases_translations').select('*').where('phrases_id', id),
			database('phrase_clips as c').leftJoin('source_videos as sv', 'sv.id', 'c.source_video_id')
				.select('c.*', 'sv.title as video_title').where('c.phrase_id', id)
				.orderByRaw('c.sort ASC NULLS LAST, c.date_created ASC'),
		]);
		return res.json({
			success: true,
			data: {
				...phrase,
				translations: Object.fromEntries(translations.map((t: any) => [t.languages_code, {
					meaning: t.meaning || '', usage: t.usage || '', avoid: t.avoid || '',
					similar: jsonList(t.similar_phrases), replies: jsonList(t.replies), wrong_meanings: jsonList(t.wrong_meanings), situations: jsonList(t.situations),
				}])),
				clips: clips.map((c: any) => ({ ...c, start_time: Number(c.start_time), end_time: Number(c.end_time) })),
			},
		});
	}));

	router.patch('/admin/phrases/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
		const body = req.body || {};
		const phrase = await database('phrases').where('id', id).first();
		if (!phrase) return res.status(404).json({ success: false, message: 'Not found' });

		const patch: Record<string, any> = {};
		if (body.type_id !== undefined) {
			if (!UUID_RE.test(String(body.type_id)) || !(await database('phrase_types').where('id', body.type_id).first('id'))) {
				return res.status(400).json({ success: false, message: 'Unknown type' });
			}
			patch.type_id = body.type_id;
		}
		if (body.text !== undefined) {
			const text = str(body.text, 255);
			if (!text) return res.status(400).json({ success: false, message: 'The phrase cannot be empty' });
			const normalized = normalizePhrase(text);
			const twin = await database('phrases').where('text_normalized', normalized).whereNot('id', id).first('id', 'text');
			if (twin) return res.status(409).json({ success: false, message: `"${twin.text}" already exists` });
			patch.text = text;
			patch.text_normalized = normalized;
		}
		if (body.text_linked !== undefined) patch.text_linked = str(body.text_linked, 255) || null;
		if (body.ipa !== undefined) patch.ipa = str(body.ipa, 255) || null;
		if (body.kind !== undefined) {
			if (!KINDS.includes(body.kind)) return res.status(400).json({ success: false, message: 'Invalid kind' });
			patch.kind = body.kind;
		}
		if (body.status !== undefined) {
			if (!STATUSES.includes(body.status)) return res.status(400).json({ success: false, message: 'Invalid status' });
			patch.status = body.status;
		}
		if (body.is_premium !== undefined) patch.is_premium = body.is_premium === true;
		if (body.sort !== undefined) patch.sort = body.sort === null || body.sort === '' ? null : Math.round(Number(body.sort)) || 0;

		await database.transaction(async (trx: any) => {
			if (Object.keys(patch).length) await trx('phrases').where('id', id).update({ ...patch, date_updated: trx.fn.now() });
			const langs = await trx('languages').pluck('code');
			for (const [lang, input] of Object.entries(body.translations || {})) {
				if (!langs.includes(lang)) continue;
				await saveTranslation(trx, id, lang, translationPatch(input));
			}
		});
		return res.json({ success: true });
	}));

	router.delete('/admin/phrases/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
		const count = await database('phrases').where('id', id).delete();
		return res.json({ success: !!count });
	}));

	router.patch('/admin/phrase-clips/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
		const clip = await database('phrase_clips').where('id', id).first();
		if (!clip) return res.status(404).json({ success: false, message: 'Not found' });
		const body = req.body || {};
		const patch: Record<string, any> = {};
		for (const key of ['start_time', 'end_time'] as const) {
			if (body[key] === undefined) continue;
			const s = seconds(body[key]);
			if (!Number.isFinite(s) || s < 0) return res.status(400).json({ success: false, message: `Invalid ${key}` });
			patch[key] = Math.round(s * 100) / 100;
		}
		const start = patch.start_time ?? Number(clip.start_time);
		const end = patch.end_time ?? Number(clip.end_time);
		if (end <= start) return res.status(400).json({ success: false, message: 'The end must be after the start' });
		if (body.line_text !== undefined) patch.line_text = str(body.line_text, 500) || null;
		if (body.context !== undefined) patch.context = str(body.context, 500) || null;
		if (body.status !== undefined) {
			if (!STATUSES.includes(body.status)) return res.status(400).json({ success: false, message: 'Invalid status' });
			patch.status = body.status;
		}
		if (body.sort !== undefined) patch.sort = body.sort === null || body.sort === '' ? null : Math.round(Number(body.sort)) || 0;
		if (Object.keys(patch).length) await database('phrase_clips').where('id', id).update(patch);
		return res.json({ success: true });
	}));

	router.delete('/admin/phrase-clips/:id', staff(async (req, res) => {
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
		const count = await database('phrase_clips').where('id', id).delete();
		return res.json({ success: !!count });
	}));

	/**
	 * items: [{ time | start, end?, phrase, line_text, type (slug), kind, ipa, text_linked,
	 *   meaning_vi, usage_vi, avoid_vi, similar[{text, note_vi}], replies[], wrong_meanings_vi[],
	 *   situations_vi[], context_vi }]
	 */
	router.post('/admin/phrases/import', staff(async (req, res) => {
		const body = req.body || {};
		const videoId = str(body.youtube_video_id, 20);
		if (!/^[\w-]{11}$/.test(videoId)) return res.status(400).json({ success: false, message: 'Invalid YouTube video id' });
		const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
		if (!items.length) return res.status(400).json({ success: false, message: 'Nothing to import' });
		const status = body.publish === false ? 'draft' : 'published';

		const [types, video] = await Promise.all([
			database('phrase_types').select('id', 'slug'),
			database('source_videos').where('youtube_video_id', videoId).first('id'),
		]);
		const typeBySlug = new Map(types.map((t: any) => [t.slug, t.id]));
		const results: any[] = [];

		for (const item of items) {
			const text = str(item?.phrase, 255);
			const normalized = normalizePhrase(text);
			const start = seconds(item?.start ?? item?.time);
			const end = item?.end !== undefined ? seconds(item.end) : start + 3;
			const typeId = typeBySlug.get(str(item?.type, 100));
			if (!normalized || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
				results.push({ phrase: text, ok: false, message: 'Missing phrase or time' });
				continue;
			}
			try {
				const result = await database.transaction(async (trx: any) => {
					let phrase = await trx('phrases').where('text_normalized', normalized).first('id', 'slug');
					let created = false;
					if (!phrase) {
						if (!typeId) throw Object.assign(new Error(`Unknown type "${str(item?.type, 100)}"`), { expose: true });
						const kind = KINDS.includes(item?.kind) ? item.kind : 'situational';
						const sort = Number((await trx('phrases').where('type_id', typeId).max('sort as m').first())?.m) || 0;
						[phrase] = await trx('phrases').insert({
							type_id: typeId,
							slug: await uniqueSlug(trx, text),
							text,
							text_normalized: normalized,
							text_linked: str(item?.text_linked, 255) || null,
							ipa: str(item?.ipa, 255) || null,
							kind,
							status,
							sort: sort + 1,
							user_created: req.accountability.user,
						}).returning(['id', 'slug']);
						created = true;
					}
					await saveTranslation(trx, phrase.id, DEFAULT_LOCALE, translationPatch({
						meaning: item?.meaning_vi,
						usage: item?.usage_vi,
						avoid: item?.avoid_vi,
						similar: jsonList(item?.similar).map((s: any) => (typeof s === 'string' ? s : { text: s?.text, note: s?.note_vi ?? s?.note })),
						replies: item?.replies,
						wrong_meanings: item?.wrong_meanings_vi,
						situations: item?.situations_vi,
					}), !created);
					const clipCount = Number((await trx('phrase_clips').where('phrase_id', phrase.id).count('* as n').first())?.n) || 0;
					const clip = await trx('phrase_clips').insert({
						phrase_id: phrase.id,
						source_video_id: video?.id || null,
						youtube_video_id: videoId,
						start_time: Math.round(start * 100) / 100,
						end_time: Math.round(end * 100) / 100,
						line_text: str(item?.line_text, 500) || null,
						context: str(item?.context_vi ?? item?.context, 500) || null,
						sort: clipCount + 1,
					}).onConflict(['phrase_id', 'youtube_video_id', 'start_time']).ignore().returning('id');
					return { phrase: text, ok: true, id: phrase.id, slug: phrase.slug, created, clip_added: clip.length > 0 };
				});
				results.push(result);
			} catch (error: any) {
				if (!error?.expose) logger?.error?.(`[admin-phrases] import "${text}" failed: ${String(error)}`);
				results.push({ phrase: text, ok: false, message: error?.expose ? error.message : 'Server error' });
			}
		}
		return res.json({
			success: true,
			data: {
				results,
				created: results.filter((r) => r.created).length,
				clips_added: results.filter((r) => r.clip_added).length,
				failed: results.filter((r) => !r.ok).length,
			},
		});
	}));
}
