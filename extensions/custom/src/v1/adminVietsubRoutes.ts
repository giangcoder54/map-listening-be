/**
 * A clip's subtitle translations (Vietsub and other languages), from the clip editor
 * (admins and content editors). Stored as the lines of its video (2026-11-08_video_lines.sql):
 * a line is translated once for every clip that has it; the learner sees it once an item is
 * answered (lib/subs.ts).
 *
 *   GET  /admin/clips/:id/subs?lang=vi-VN   the clip's lines with their translation in `lang`,
 *                                            and the languages that can be translated to
 *   POST /admin/subs/translate              { lang, lines: [english] } -> { tr: [translation] }
 *                                            by the AI (lib/ai.ts), nothing saved
 *   PUT  /admin/clips/:id/subs              { lang, lines: [{ start, end, text, tr, origin }] }
 *                                            the clip's lines become these (a line of the same
 *                                            video with the same words within 4 s is reused,
 *                                            else a new one), and their translations are saved.
 *                                            An empty `tr` leaves the line's translation as it is.
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';
import { aiConfigured, aiJson } from '../lib/ai';

const LANG_NAME: Record<string, string> = { vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', es: 'Spanish', fr: 'French' };
/** The words as stored: no [brackets], no ">>" turn marks, single spaces */
const clean = (s: unknown) => String(s ?? '').replace(/[[\]]/g, '').replace(/>>/g, '').replace(/\s+/g, ' ').trim();
/** For matching a line again: letters and digits only */
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();

export function registerAdminVietsubRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-subs] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const langOf = async (raw: unknown) => {
		const code = String(raw || 'vi-VN').trim();
		const row = await database('languages').select('code').where('code', code).first();
		return row && !code.toLowerCase().startsWith('en') ? code : null;
	};

	router.get('/admin/clips/:id/subs', staff(async (req, res) => {
		if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: 'Bad clip id' });
		const lang = await langOf(req.query.lang);
		if (!lang) return res.status(400).json({ success: false, message: 'Unknown language' });
		const [lines, languages] = await Promise.all([
			database('listening_clip_lines as cl')
				.join('video_lines as vl', 'vl.id', 'cl.line_id')
				.leftJoin('video_line_translations as tr', function (this: any) {
					this.on('tr.line_id', 'vl.id').andOn('tr.languages_code', database.raw('?', [lang]));
				})
				.select('vl.text', 'cl.partial', 'tr.text as tr', 'tr.origin', database.raw('tr.source_hash = md5(vl.text) AS fresh'))
				.where('cl.clip_id', req.params.id)
				.orderBy('cl.sort'),
			database('languages').select('code', 'name').whereRaw("lower(code) NOT LIKE 'en%'").orderBy('code'),
		]);
		return res.json({ success: true, data: { lang, languages, ai: aiConfigured(), lines: lines.map((l: any) => ({ text: l.text, partial: !!l.partial, tr: l.tr || '', origin: l.origin || null, fresh: l.tr ? !!l.fresh : null })) } });
	}));

	router.post('/admin/subs/translate', staff(async (req, res) => {
		const lang = await langOf(req.body?.lang);
		const lines: string[] = Array.isArray(req.body?.lines) ? req.body.lines.map(clean).slice(0, 40) : [];
		if (!lang || !lines.length || lines.some((l) => !l)) return res.status(400).json({ success: false, message: 'Nothing to translate' });
		if (!aiConfigured()) return res.status(503).json({ success: false, code: 'AI_OFF', message: 'AI is not configured' });
		const name = LANG_NAME[lang.split('-')[0]!.toLowerCase()] || lang;
		const out = await aiJson<{ tr?: unknown }>([
			{
				role: 'system',
				content: `You translate English video subtitles into ${name} subtitles for language learners. `
					+ 'Translate each line on its own, in order, into natural spoken language a native speaker would say in that situation (not word for word), '
					+ 'keeping names, numbers and the tone (casual, joking, angry). Use the other lines only as context. '
					+ 'Answer JSON only: {"tr": ["line 1", "line 2", ...]} with exactly as many lines as given.',
			},
			{ role: 'user', content: JSON.stringify({ lines }) },
		], { maxTokens: 300 + lines.join(' ').length * 3, timeoutMs: 40000, temperature: 0.3, logger });
		const tr = Array.isArray(out?.tr) ? out!.tr.map((t) => String(t ?? '').replace(/\s+/g, ' ').trim()) : null;
		if (!tr || tr.length !== lines.length || tr.some((t) => !t)) return res.status(502).json({ success: false, code: 'AI_FAILED', message: 'The AI did not answer one line per line' });
		return res.json({ success: true, data: { tr } });
	}));

	router.put('/admin/clips/:id/subs', staff(async (req, res) => {
		if (!UUID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: 'Bad clip id' });
		const lang = await langOf(req.body?.lang);
		if (!lang) return res.status(400).json({ success: false, message: 'Unknown language' });
		const given = (Array.isArray(req.body?.lines) ? req.body.lines : []).slice(0, 60).map((l: any) => ({
			text: clean(l?.text),
			tr: String(l?.tr ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
			origin: l?.origin === 'ai' ? 'ai' : 'human',
			startMs: Math.max(0, Math.round(Number(l?.start) * 1000) || 0),
			endMs: Math.max(0, Math.round(Number(l?.end) * 1000) || 0),
		})).filter((l: any) => l.text);
		const clip = await database('listening_clips').select('id', 'source_video_id').where('id', req.params.id).first();
		if (!clip?.source_video_id) return res.status(404).json({ success: false, message: 'Clip not found' });

		await database.transaction(async (trx: any) => {
			const have = await trx('video_lines').select('id', 'text', 'start_ms').where('source_video_id', clip.source_video_id);
			await trx('listening_clip_lines').where('clip_id', clip.id).del();
			for (const [sort, l] of given.entries()) {
				const n = norm(l.text);
				let line = have.find((h: any) => norm(h.text) === n && Math.abs(Number(h.start_ms) - l.startMs) <= 4000);
				if (!line) {
					[line] = await trx('video_lines').insert({
						source_video_id: clip.source_video_id, start_ms: l.startMs, end_ms: Math.max(l.endMs, l.startMs + 100), text: l.text, origin: 'edit',
					}).returning(['id', 'text', 'start_ms']);
					have.push(line);
				}
				await trx('listening_clip_lines').insert({ clip_id: clip.id, line_id: line.id, sort, partial: false });
				if (l.tr) {
					await trx.raw(
						`INSERT INTO video_line_translations (line_id, languages_code, text, source_hash, origin)
						 SELECT ?::uuid, ?::varchar, ?::text, md5(text), ?::varchar FROM video_lines WHERE id = ?::uuid
						 ON CONFLICT (line_id, languages_code) DO UPDATE SET text = EXCLUDED.text, source_hash = EXCLUDED.source_hash,
						 	origin = EXCLUDED.origin, date_updated = now()`,
						[line.id, lang, l.tr, l.origin, line.id],
					);
				}
			}
		});
		return res.json({ success: true, data: { lines: given.length } });
	}));
}
