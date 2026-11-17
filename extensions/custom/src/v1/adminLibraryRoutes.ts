/**
 * The video library seen by topic, channel and level (/admin/library). Admins and content editors.
 *
 *   GET    /admin/library/meta                   topics, content types, counts (untagged, broken...)
 *   GET    /admin/library/videos                 ?page&limit&q&channel&topic&type&level_min&level_max
 *                                                &subs=manual|asr&flag=untagged|broken|low|pick|manual
 *                                                &ids=a,b&sort=new|level|level_desc|length
 *                                                -> { items, total, page, limit }
 *   PATCH  /admin/library/videos/:id             { topic, subtopics, content_type, level_manual,
 *                                                editor_pick, note } manual tags (null clears one)
 *   POST   /admin/library/videos/:id/retag       ask the AI again for this video
 *   GET    /admin/library/channels               ?page&limit&q  channels with counts, tags, topics
 *   PUT    /admin/library/channels               { channel_name, topic, content_type, accent, note }
 *   GET    /admin/library/topics                 topics with videos per level band (coverage)
 *   POST   /admin/library/topics                 { code, name, hint }
 *   PATCH  /admin/library/topics/:code           { name, hint, sort }
 *   DELETE /admin/library/topics/:code           only when no video or channel uses it (admins)
 *   POST   /admin/library/process                { limit } measure + AI-tag the next videos;
 *                                                the page calls it again until nothing is left
 *
 * Effective tag = manual -> AI -> channel default (lib/videoTags.ts EFFECTIVE).
 */
import { isStaff } from '../lib/staff';
import { CONTENT_TYPES, EFFECTIVE, aiTag, computeSignals, relevel } from '../lib/videoTags';
import { aiConfigured } from '../lib/ai';

const UUID = /^[0-9a-f-]{36}$/i;
const int = (v: any, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number.parseInt(v, 10) || d));

export function registerAdminLibraryRoutes(router: any, context: any) {
	const { database, logger } = context;
	const deny = (req: any, res: any) => {
		if (isStaff(req.accountability)) return false;
		res.status(403).json({ success: false, message: 'Admins and editors only' });
		return true;
	};
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[admin-library] ${what} failed: ${String(error?.stack || error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	const topicCodes = async () => new Set((await database('video_topics').select('code')).map((t: any) => t.code));

	router.get('/admin/library/meta', async (req: any, res: any) => {
		if (deny(req, res)) return;
		try {
			const [topics, counts] = await Promise.all([
				database('video_topics').select('code', 'name', 'hint', 'sort').orderBy('sort'),
				database.raw(`
					SELECT count(*)::int AS total,
						count(*) FILTER (WHERE jsonb_typeof(v.transcript) = 'array' AND (t.signals_at IS NULL OR v.transcript_updated_at > t.signals_at))::int AS to_measure,
						count(*) FILTER (WHERE t.signals_at IS NOT NULL AND t.ai_at IS NULL AND NOT coalesce(t.broken, false) AND NOT (coalesce(ct.apply_all, false) AND ct.topic IS NOT NULL))::int AS to_tag,
						count(*) FILTER (WHERE t.broken)::int AS broken,
						count(*) FILTER (WHERE t.ai_error IS NOT NULL)::int AS ai_failed,
						count(*) FILTER (WHERE t.ai_confidence = 'low')::int AS low,
						count(DISTINCT v.channel_name)::int AS channels
					FROM source_videos v LEFT JOIN video_tags t ON t.source_video_id = v.id
					LEFT JOIN channel_tags ct ON ct.channel_name = v.channel_name`),
			]);
			return res.json({ success: true, data: { topics, content_types: CONTENT_TYPES, counts: counts.rows[0], ai: aiConfigured() } });
		} catch (e) {
			return fail(res, 'meta', e);
		}
	});

	router.get('/admin/library/videos', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const page = int(req.query.page, 1, 1, 100000);
		const limit = int(req.query.limit, 25, 5, 100);
		const where: string[] = [];
		const args: any[] = [];
		const s = (k: string) => String(req.query[k] ?? '').trim();
		if (s('q')) { where.push('(v.title ILIKE ? OR v.channel_name ILIKE ?)'); args.push(`%${s('q')}%`, `%${s('q')}%`); }
		if (s('channel')) { where.push('v.channel_name = ?'); args.push(s('channel')); }
		if (s('topic') === '_none') where.push(`${EFFECTIVE.topic} IS NULL`);
		else if (s('topic')) {
			where.push(`(${EFFECTIVE.topic} = ? OR ? = ANY(coalesce(t.subtopics, t.ai_subtopics, '{}')))`);
			args.push(s('topic'), s('topic'));
		}
		if (s('type')) { where.push(`${EFFECTIVE.type} = ?`); args.push(s('type')); }
		if (s('level_min')) { where.push(`${EFFECTIVE.level} >= ?`); args.push(int(s('level_min'), 1, 1, 10)); }
		if (s('level_max')) { where.push(`${EFFECTIVE.level} <= ?`); args.push(int(s('level_max'), 10, 1, 10)); }
		if (s('subs') === 'manual' || s('subs') === 'asr') { where.push('v.transcript_kind = ?'); args.push(s('subs')); }
		const flag = s('flag');
		if (flag === 'untagged') where.push('t.ai_at IS NULL AND t.topic IS NULL');
		if (flag === 'broken') where.push('t.broken');
		if (flag === 'low') where.push("t.ai_confidence = 'low' AND t.topic IS NULL");
		if (flag === 'failed') where.push('t.ai_error IS NOT NULL');
		if (flag === 'pick') where.push('t.editor_pick');
		if (flag === 'manual') where.push('(t.topic IS NOT NULL OR t.content_type IS NOT NULL OR t.level_manual IS NOT NULL)');
		const ids = s('ids').split(',').filter((x) => UUID.test(x));
		if (s('ids')) {
			if (!ids.length) return res.json({ success: true, data: { items: [], total: 0, page, limit } });
			where.push(`v.id IN (${ids.map(() => '?').join(',')})`); args.push(...ids);
		}
		const order = ({
			level: `${EFFECTIVE.level} ASC NULLS LAST, v.date_created DESC`,
			level_desc: `${EFFECTIVE.level} DESC NULLS LAST, v.date_created DESC`,
			length: 't.duration_s ASC NULLS LAST',
			title: 'v.title ASC',
		} as Record<string, string>)[s('sort')] || 'v.date_created DESC';
		const from = `FROM source_videos v
			LEFT JOIN video_tags t ON t.source_video_id = v.id
			LEFT JOIN channel_tags ct ON ct.channel_name = v.channel_name
			${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
		try {
			const [items, total] = await Promise.all([
				database.raw(`
					SELECT v.id, v.youtube_video_id, v.title, v.channel_name, v.thumbnail_url, v.transcript_kind, v.date_created,
						t.duration_s, t.wpm, t.rare_ratio, t.speech_ratio, t.level, t.level_manual, t.level_why, t.broken, t.score,
						t.ai_topic, t.ai_subtopics, t.ai_content_type, t.ai_confidence, t.ai_reason, t.ai_error,
						t.topic, t.subtopics, t.content_type, t.editor_pick, t.note,
						ct.topic AS channel_topic, ct.content_type AS channel_type,
						${EFFECTIVE.topic} AS eff_topic, ${EFFECTIVE.type} AS eff_type, ${EFFECTIVE.level} AS eff_level,
						EXISTS (SELECT 1 FROM listening_clips c WHERE c.source_video_id = v.id AND c.lesson_id IS NOT NULL) AS used
					${from}
					ORDER BY ${order}
					LIMIT ? OFFSET ?`, [...args, limit, (page - 1) * limit]),
				database.raw(`SELECT count(*)::int AS n ${from}`, args),
			]);
			return res.json({ success: true, data: { items: items.rows, total: total.rows[0].n, page, limit } });
		} catch (e) {
			return fail(res, 'videos', e);
		}
	});

	router.patch('/admin/library/videos/:id', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const id = String(req.params.id);
		if (!UUID.test(id)) return res.status(400).json({ success: false, message: 'Invalid video' });
		const b = req.body || {};
		const codes = await topicCodes();
		const patch: any = { date_updated: new Date() };
		const bad = (m: string) => res.status(400).json({ success: false, message: m });
		if ('topic' in b) {
			if (b.topic !== null && !codes.has(b.topic)) return bad('Unknown topic');
			patch.topic = b.topic;
		}
		if ('subtopics' in b) {
			if (b.subtopics !== null && (!Array.isArray(b.subtopics) || !b.subtopics.every((x: any) => codes.has(x)) || b.subtopics.length > 3)) return bad('Unknown subtopic');
			patch.subtopics = b.subtopics;
		}
		if ('content_type' in b) {
			if (b.content_type !== null && !CONTENT_TYPES[b.content_type]) return bad('Unknown content type');
			patch.content_type = b.content_type;
		}
		if ('level_manual' in b) {
			if (b.level_manual !== null && !(Number.isInteger(b.level_manual) && b.level_manual >= 1 && b.level_manual <= 10)) return bad('Level is 1 to 10');
			patch.level_manual = b.level_manual;
		}
		if ('editor_pick' in b) patch.editor_pick = !!b.editor_pick;
		if ('note' in b) patch.note = b.note === null ? null : String(b.note).slice(0, 500);
		try {
			if (!(await database('source_videos').where('id', id).first('id'))) return res.status(404).json({ success: false, message: 'Not found' });
			await database('video_tags').insert({ source_video_id: id, ...patch }).onConflict('source_video_id').merge();
			if ('content_type' in b) await relevel(database, [id]);
			return res.json({ success: true });
		} catch (e) {
			return fail(res, 'save video tags', e);
		}
	});

	router.post('/admin/library/videos/:id/retag', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const id = String(req.params.id);
		if (!UUID.test(id)) return res.status(400).json({ success: false, message: 'Invalid video' });
		try {
			await computeSignals(database, { ids: [id] });
			const out = await aiTag(database, { ids: [id], logger });
			return res.json({ success: true, data: out });
		} catch (e) {
			return fail(res, 'retag', e);
		}
	});

	router.get('/admin/library/channels', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const page = int(req.query.page, 1, 1, 100000);
		const limit = int(req.query.limit, 25, 5, 100);
		const q = String(req.query.q || '').trim();
		const sort = String(req.query.sort || 'videos');
		const order = sort === 'name' ? 'c.channel_name ASC' : sort === 'level' ? 'c.avg_level ASC NULLS LAST' : 'c.videos DESC, c.channel_name';
		const args = q ? [`%${q}%`] : [];
		try {
			const base = `
				WITH c AS (
					SELECT v.channel_name, count(*)::int AS videos,
						round(avg(${EFFECTIVE.level}), 1) AS avg_level,
						min(${EFFECTIVE.level}) AS min_level, max(${EFFECTIVE.level}) AS max_level,
						count(*) FILTER (WHERE v.transcript_kind = 'manual')::int AS manual,
						count(*) FILTER (WHERE t.broken)::int AS broken,
						max(v.date_created) AS last_added
					FROM source_videos v
					LEFT JOIN video_tags t ON t.source_video_id = v.id
					LEFT JOIN channel_tags ct ON ct.channel_name = v.channel_name
					WHERE v.channel_name IS NOT NULL ${q ? 'AND v.channel_name ILIKE ?' : ''}
					GROUP BY v.channel_name
				)`;
			const [rows, total] = await Promise.all([
				database.raw(`${base}
					SELECT c.*, ct.topic, ct.content_type, ct.accent, ct.note, ct.apply_all, ct.allowed_topics,
						(SELECT json_agg(json_build_object('topic', x.topic, 'n', x.n) ORDER BY x.n DESC)
						 FROM (SELECT ${EFFECTIVE.topic} AS topic, count(*)::int AS n
							FROM source_videos v LEFT JOIN video_tags t ON t.source_video_id = v.id
							LEFT JOIN channel_tags ct ON ct.channel_name = v.channel_name
							WHERE v.channel_name = c.channel_name AND ${EFFECTIVE.topic} IS NOT NULL
							GROUP BY 1 ORDER BY 2 DESC LIMIT 4) x) AS topics
					FROM c LEFT JOIN channel_tags ct ON ct.channel_name = c.channel_name
					ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, limit, (page - 1) * limit]),
				database.raw(`${base} SELECT count(*)::int AS n FROM c`, args),
			]);
			return res.json({ success: true, data: { items: rows.rows, total: total.rows[0].n, page, limit } });
		} catch (e) {
			return fail(res, 'channels', e);
		}
	});

	router.put('/admin/library/channels', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const b = req.body || {};
		const name = String(b.channel_name || '').trim();
		if (!name) return res.status(400).json({ success: false, message: 'channel_name required' });
		const codes = await topicCodes();
		if (b.topic && !codes.has(b.topic)) return res.status(400).json({ success: false, message: 'Unknown topic' });
		if (b.content_type && !CONTENT_TYPES[b.content_type]) return res.status(400).json({ success: false, message: 'Unknown content type' });
		const allowed: string[] = Array.isArray(b.allowed_topics) ? b.allowed_topics : [];
		if (!allowed.every((c) => codes.has(c))) return res.status(400).json({ success: false, message: 'Unknown topic in the allowed list' });
		try {
			await database('channel_tags').insert({
				channel_name: name, topic: b.topic || null, content_type: b.content_type || null,
				apply_all: !!b.apply_all, allowed_topics: allowed.length ? allowed : null,
				accent: b.accent ? String(b.accent).slice(0, 20) : null, note: b.note ? String(b.note).slice(0, 500) : null, date_updated: new Date(),
			}).onConflict('channel_name').merge();
			// Videos of the channel that fall back on its type get their level again
			const ids = (await database('source_videos').where('channel_name', name).select('id')).map((r: any) => r.id);
			await relevel(database, ids);
			return res.json({ success: true });
		} catch (e) {
			return fail(res, 'save channel', e);
		}
	});

	router.get('/admin/library/topics', async (req: any, res: any) => {
		if (deny(req, res)) return;
		try {
			const [topics, cov] = await Promise.all([
				database('video_topics').select('code', 'name', 'hint', 'sort').orderBy('sort'),
				database.raw(`
					SELECT ${EFFECTIVE.topic} AS topic, ${EFFECTIVE.level} AS level, count(*)::int AS n,
						count(*) FILTER (WHERE ${EFFECTIVE.type} NOT IN ('film_scene', 'trailer', 'lesson') AND coalesce(t.speech_ratio, 1) >= 0.45)::int AS extensive
					FROM source_videos v
					LEFT JOIN video_tags t ON t.source_video_id = v.id
					LEFT JOIN channel_tags ct ON ct.channel_name = v.channel_name
					WHERE NOT coalesce(t.broken, false)
					GROUP BY 1, 2`),
			]);
			return res.json({ success: true, data: { topics, coverage: cov.rows } });
		} catch (e) {
			return fail(res, 'topics', e);
		}
	});

	router.post('/admin/library/topics', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const b = req.body || {};
		const code = String(b.code || '').trim().toLowerCase();
		if (!/^[a-z][a-z0-9_]{1,39}$/.test(code)) return res.status(400).json({ success: false, message: 'Code: a-z, 0-9, _ (2-40)' });
		if (!String(b.name || '').trim()) return res.status(400).json({ success: false, message: 'Name required' });
		try {
			const max = await database('video_topics').max('sort as m').first();
			await database('video_topics').insert({ code, name: String(b.name).trim().slice(0, 80), hint: b.hint ? String(b.hint).slice(0, 300) : null, sort: (Number(max?.m) || 0) + 10 });
			return res.json({ success: true });
		} catch (e: any) {
			if (e?.code === '23505') return res.status(409).json({ success: false, message: 'Code already used' });
			return fail(res, 'add topic', e);
		}
	});

	router.patch('/admin/library/topics/:code', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const b = req.body || {};
		const patch: any = {};
		if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 80);
		if ('hint' in b) patch.hint = b.hint ? String(b.hint).slice(0, 300) : null;
		if (Number.isInteger(b.sort)) patch.sort = b.sort;
		if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: 'Nothing to change' });
		try {
			const n = await database('video_topics').where('code', req.params.code).update(patch);
			return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
		} catch (e) {
			return fail(res, 'edit topic', e);
		}
	});

	router.delete('/admin/library/topics/:code', async (req: any, res: any) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		const code = String(req.params.code);
		try {
			const used = await database.raw(`
				SELECT (SELECT count(*) FROM video_tags WHERE topic = ? OR ai_topic = ? OR ? = ANY(coalesce(subtopics, '{}')) OR ? = ANY(coalesce(ai_subtopics, '{}')))::int
					+ (SELECT count(*) FROM channel_tags WHERE topic = ?)::int AS n`, [code, code, code, code, code]);
			if (used.rows[0].n > 0) return res.status(409).json({ success: false, message: `Used by ${used.rows[0].n} videos or channels: move them first` });
			await database('video_topics').where('code', code).del();
			return res.json({ success: true });
		} catch (e) {
			return fail(res, 'delete topic', e);
		}
	});

	router.post('/admin/library/process', async (req: any, res: any) => {
		if (deny(req, res)) return;
		const limit = int(req.body?.limit, 8, 1, 20);
		try {
			const measured = await computeSignals(database, { limit: limit * 10 });
			const tagged = measured ? { tried: 0, ok: 0, configured: aiConfigured() } : await aiTag(database, { limit, logger });
			const left = await database.raw(`
				SELECT count(*) FILTER (WHERE jsonb_typeof(v.transcript) = 'array' AND (t.signals_at IS NULL OR v.transcript_updated_at > t.signals_at))::int AS to_measure,
					count(*) FILTER (WHERE t.signals_at IS NOT NULL AND t.ai_at IS NULL AND NOT coalesce(t.broken, false) AND NOT (coalesce(ct.apply_all, false) AND ct.topic IS NOT NULL))::int AS to_tag
				FROM source_videos v LEFT JOIN video_tags t ON t.source_video_id = v.id`);
			return res.json({ success: true, data: { measured, ...tagged, ...left.rows[0] } });
		} catch (e) {
			return fail(res, 'process', e);
		}
	});
}
