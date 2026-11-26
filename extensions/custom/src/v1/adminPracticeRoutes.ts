/**
 * The practice bank, "Kho bài tập", for the team (/admin/practice).
 *
 *   GET   /admin/practice                  every video of the bank (any status) with its sentences:
 *                                          shown / hidden, and the default Xu price
 *   GET   /admin/practice/:id              one video's sentences (its answer, rule, level, hidden or not)
 *   GET   /admin/practice/candidates       videos with sentences that are not in the bank yet
 *   POST  /admin/practice                  { source_video_id } puts a video in the bank (as a draft)
 *   PATCH /admin/practice/:id              { title?, status?, is_premium?, price_xu? } admins only
 *   PUT   /admin/practice/clips/:clipId    { hidden } keep a sentence out of the bank (or back in)
 *   POST  /admin/practice/lesson           { skill_id } the hidden lesson (kind 'bank') that holds a
 *                                          rule's bank-only sentences, made the first time
 *   POST  /admin/practice/from-clip        { clip_id } puts a saved sentence's video in the bank
 *   DELETE /admin/practice/clips/:clipId   a bank-only sentence no learner has played
 *   DELETE /admin/practice/:id             admins only; a video no learner has played or opened
 *
 * A sentence is a published clip of the video (lib/bank.ts CLIP_FILTER); hiding one only keeps the
 * bank from showing it (practice_hidden_clips), the clip stays in its lesson. A bank-only sentence
 * is a clip the team cuts here (ClipEditor), kept in a hidden 'bank' lesson.
 */
import { BANK, CLIP_FILTER } from '../lib/bank';
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

/** Where learners leave rows about a clip: a sentence with any of them is hidden, not deleted */
const CLIP_HISTORY = ['listening_runs', 'listening_answers', 'listening_attempts', 'listening_reviews', 'practice_clip_progress', 'star_uses'];

export function registerAdminPracticeRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-practice] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	/** The video's place in the bank, added as a draft at the end when it has none */
	const addToBank = async (videoId: string): Promise<{ id: string; added: boolean } | null> => {
		const sv = await database('source_videos').select('title').where('id', videoId).first();
		if (!sv) return null;
		const had = await database('practice_videos').select('id').where('source_video_id', videoId).first();
		if (had) return { id: had.id, added: false };
		const { rows } = await database.raw(`
			INSERT INTO practice_videos (short_id, source_video_id, title, status, sort)
			VALUES (substr(md5(random()::text || clock_timestamp()::text), 1, 8), ?, left(trim(?), 200), 'draft', coalesce((SELECT max(sort) FROM practice_videos), 0) + 1)
			RETURNING id`, [videoId, sv.title || 'Video']);
		return { id: rows[0].id, added: true };
	};

	router.post('/admin/practice/lesson', staff(async (req, res) => {
		const skillId = String(req.body?.skill_id || '');
		if (!UUID_RE.test(skillId)) return res.status(400).json({ success: false, message: 'Chọn quy tắc của câu' });
		const lesson = await database.transaction(async (trx: any) => {
			// Locked, so two saves at once do not make two lessons for the rule
			const skill = await trx('listening_skills').select('slug', 'name').where('id', skillId).forUpdate().first();
			if (!skill) return null;
			const had = await trx('listening_lessons').select('id', 'text').where({ skill_id: skillId, kind: 'bank' }).first();
			if (had) return had;
			const text = `Kho bài tập · ${skill.name}`;
			const { rows } = await trx.raw(`
				INSERT INTO listening_lessons (id, status, sort, skill_id, short_id, slug, text, difficulty, is_premium, date_created, user_created, kind, practice_shuffle, trap_draw)
				VALUES (gen_random_uuid(), 'published', coalesce((SELECT max(sort) FROM listening_lessons WHERE kind = 'bank'), 8999) + 1, ?,
					substr(md5(random()::text || clock_timestamp()::text), 1, 8), ?, ?, 'medium', false, now(), ?, 'bank', false, 0)
				RETURNING id, text`, [skillId, `kho-${skill.slug}`, text, req.accountability.user]);
			await trx('listening_lessons_translations').insert([
				{ listening_lessons_id: rows[0].id, languages_code: 'vi-VN', title: text },
				{ listening_lessons_id: rows[0].id, languages_code: 'en-US', title: `Practice bank · ${skill.name}` },
			]);
			return rows[0];
		});
		if (!lesson) return res.status(404).json({ success: false, message: 'Không tìm thấy quy tắc' });
		return res.json({ success: true, data: { id: lesson.id, text: lesson.text } });
	}));

	router.post('/admin/practice/from-clip', staff(async (req, res) => {
		const id = String(req.body?.clip_id || '');
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const clip = await database('listening_clips').select('source_video_id').where('id', id).first();
		const placed = clip?.source_video_id ? await addToBank(clip.source_video_id) : null;
		if (!placed) return res.status(404).json({ success: false, message: 'Not found' });
		return res.json({ success: true, data: placed });
	}));

	router.delete('/admin/practice/clips/:clipId', staff(async (req, res) => {
		const id = String(req.params.clipId);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const clip = await database('listening_clips as c').join('listening_lessons as l', 'l.id', 'c.lesson_id').select('l.kind').where('c.id', id).first();
		if (!clip) return res.status(404).json({ success: false, message: 'Not found' });
		if (clip.kind !== 'bank') return res.status(409).json({ success: false, message: 'Câu này thuộc một bài học: xoá ở màn Bài học, hoặc bấm Ẩn để bỏ khỏi kho' });
		for (const table of CLIP_HISTORY) {
			if (await database(table).where('clip_id', id).first()) return res.status(409).json({ success: false, message: 'Đã có người học làm câu này: bấm Ẩn thay vì xoá' });
		}
		await database('listening_clips').where('id', id).del();
		return res.json({ success: true });
	}));

	router.delete('/admin/practice/:id', staff(async (req, res) => {
		if (!req.accountability.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad id' });
		for (const table of ['listening_runs', 'practice_video_unlocks']) {
			if (await database(table).where('practice_id', id).first()) return res.status(409).json({ success: false, message: 'Đã có người học làm hoặc mở video này: chuyển về Nháp thay vì xoá' });
		}
		const n = await database('practice_videos').where('id', id).del();
		return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
	}));

	router.get('/admin/practice', staff(async (req, res) => {
		const { rows } = await database.raw(`
			SELECT p.id, p.short_id, p.title, p.status, p.is_premium, p.price_xu, p.sort, sv.youtube_video_id, sv.thumbnail_url, sv.title AS video_title, sv.channel_name,
				count(c.id)::int AS total,
				count(h.clip_id)::int AS hidden
			FROM practice_videos p
			JOIN source_videos sv ON sv.id = p.source_video_id
			LEFT JOIN (
				SELECT c.id, c.source_video_id FROM listening_clips c
				JOIN source_videos sv ON sv.id = c.source_video_id
				JOIN listening_lessons l ON l.id = c.lesson_id
				JOIN listening_skills s ON s.id = l.skill_id
				WHERE ${CLIP_FILTER}
			) c ON c.source_video_id = p.source_video_id
			LEFT JOIN practice_hidden_clips h ON h.clip_id = c.id
			GROUP BY p.id, sv.id
			ORDER BY p.sort, p.date_created`);
		return res.json({ success: true, data: { can_edit: !!req.accountability.admin, default_price: BANK.price, videos: rows.map((r: any) => ({
			id: r.id, short_id: r.short_id, youtube_id: r.youtube_video_id, title: r.title, video_title: r.video_title || '', channel: r.channel_name || '', status: r.status, is_premium: !!r.is_premium, price_xu: r.price_xu, sort: r.sort,
			thumbnail: r.thumbnail_url || `https://i.ytimg.com/vi/${r.youtube_video_id}/hqdefault.jpg`, total: r.total, hidden: r.hidden,
		})) } });
	}));

	router.get('/admin/practice/candidates', staff(async (_req, res) => {
		const { rows } = await database.raw(`
			SELECT sv.id, sv.title, sv.channel_name, sv.youtube_video_id, sv.thumbnail_url, count(c.id)::int AS clips
			FROM listening_clips c
			JOIN source_videos sv ON sv.id = c.source_video_id
			JOIN listening_lessons l ON l.id = c.lesson_id
			JOIN listening_skills s ON s.id = l.skill_id
			WHERE ${CLIP_FILTER} AND NOT EXISTS (SELECT 1 FROM practice_videos p WHERE p.source_video_id = sv.id)
			GROUP BY sv.id ORDER BY count(c.id) DESC, sv.title`);
		return res.json({ success: true, data: { videos: rows.map((r: any) => ({
			id: r.id, title: r.title || '', channel: r.channel_name || '', clips: r.clips, thumbnail: r.thumbnail_url || `https://i.ytimg.com/vi/${r.youtube_video_id}/hqdefault.jpg`,
		})) } });
	}));

	router.post('/admin/practice', staff(async (req, res) => {
		const id = String(req.body?.source_video_id || '');
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Bad video' });
		const placed = await addToBank(id);
		if (!placed) return res.status(404).json({ success: false, message: 'Video not found' });
		if (!placed.added) return res.status(409).json({ success: false, message: 'Already in the bank' });
		return res.json({ success: true, data: { id: placed.id } });
	}));

	router.get('/admin/practice/:id', staff(async (req, res) => {
		if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const { rows } = await database.raw(`
			SELECT c.id, c.transcript, c.answer, c.difficulty, c.start_time, s.name AS rule, s.id AS skill_id, l.id AS lesson_id, l.text AS lesson_text, l.kind AS lesson_kind, (h.clip_id IS NOT NULL) AS hidden
			FROM practice_videos p
			JOIN source_videos sv ON sv.id = p.source_video_id
			JOIN listening_clips c ON c.source_video_id = sv.id
			JOIN listening_lessons l ON l.id = c.lesson_id
			JOIN listening_skills s ON s.id = l.skill_id
			LEFT JOIN practice_hidden_clips h ON h.clip_id = c.id
			WHERE p.id = ? AND ${CLIP_FILTER}
			ORDER BY c.start_time, c.id`, [req.params.id]);
		return res.json({ success: true, data: { clips: rows.map((r: any) => ({
			id: r.id, text: String(r.transcript || '').replace(/[[\]]/g, ''), answer: r.answer || (String(r.transcript || '').match(/\[([^\]]+)\]/)?.[1] ?? ''),
			difficulty: r.difficulty, rule: r.rule, hidden: !!r.hidden,
			/** Cut for the bank: edited and deleted here; else it belongs to a lesson */
			own: r.lesson_kind === 'bank', skill_id: r.skill_id, lesson_id: r.lesson_id, lesson_text: r.lesson_text,
		})) } });
	}));

	router.patch('/admin/practice/:id', staff(async (req, res) => {
		if (!req.accountability.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: 'Bad id' });
		const b = req.body || {};
		const patch: Record<string, unknown> = {};
		if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 200);
		if (b.status === 'draft' || b.status === 'published') patch.status = b.status;
		if (typeof b.is_premium === 'boolean') patch.is_premium = b.is_premium;
		if ('price_xu' in b) {
			const n = b.price_xu === null || b.price_xu === '' ? null : Math.floor(Number(b.price_xu));
			if (n !== null && !(n >= 0 && n <= 100000)) return res.status(400).json({ success: false, message: 'Bad price' });
			patch.price_xu = n;
		}
		if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: 'Nothing to change' });
		const n = await database('practice_videos').where('id', req.params.id).update(patch);
		return n ? res.json({ success: true }) : res.status(404).json({ success: false, message: 'Not found' });
	}));

	router.put('/admin/practice/clips/:clipId', staff(async (req, res) => {
		if (!UUID_RE.test(req.params.clipId)) return res.status(400).json({ success: false, message: 'Bad id' });
		if (req.body?.hidden) await database('practice_hidden_clips').insert({ clip_id: req.params.clipId }).onConflict('clip_id').ignore();
		else await database('practice_hidden_clips').where('clip_id', req.params.clipId).del();
		return res.json({ success: true });
	}));
}
