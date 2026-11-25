/**
 * The vocabulary of an Intensive passage, for the team (shown on the passage's page in the admin).
 *
 *   GET    /admin/intensive/:id/vocab           the items, with their translations { lang: meaning }
 *   POST   /admin/intensive/:id/vocab           { sentence_n, term, kind, meaning, forms?, translations? } add one
 *   PUT    /admin/intensive/:id/vocab/:vid      the same fields: change it (a language sent empty is removed)
 *   DELETE /admin/intensive/:id/vocab/:vid      remove it (words learners already saved are their own copies and stay)
 */
import { wordKey } from '../lib/dict';
import { tokens } from '../lib/intensive';
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

const KINDS = ['word', 'phrase', 'grammar'];

export function registerAdminIlVocabRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			if (!UUID_RE.test(String(req.params.id)) || (req.params.vid && !UUID_RE.test(String(req.params.vid)))) return res.status(400).json({ success: false, message: 'Bad id' });
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-il-vocab] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};
	const bad = (res: any, message: string) => res.status(422).json({ success: false, message });

	/** The item as it is saved, or why it cannot be */
	const readItem = async (lessonId: string, body: any, vid: string | null): Promise<{ error: string } | { row: Record<string, any>; translations: [string, string][] }> => {
		const term = String(body?.term || '').replace(/\s*(\.{3}|…)\s*/g, ' ... ').replace(/\s+/g, ' ').trim();
		const key = wordKey(term);
		if (!key) return { error: 'Từ / cụm chỉ gồm chữ tiếng Anh; cấu trúc tách rời viết chỗ cách bằng “...” (không đặt ở đầu hay cuối)' };
		if (key.split(' ... ').length > 2) return { error: 'Cấu trúc tách rời chỉ được một chỗ “...”' };
		const kind = String(body?.kind || 'word');
		if (!KINDS.includes(kind)) return { error: 'Loại không hợp lệ' };
		const meaning = String(body?.meaning || '').trim().slice(0, 300);
		if (!meaning) return { error: 'Cần nghĩa tiếng Việt' };
		const n = Number(body?.sentence_n);
		const s = Number.isInteger(n) ? await database('il_sentences').where({ lesson_id: lessonId, n }).first('text') : null;
		if (!s) return { error: 'Chọn câu có từ này' };
		// Heard in that sentence: each part, in order
		let rest = ` ${tokens(s.text).join(' ')} `;
		for (const part of key.split(' ... ')) {
			const p = ` ${tokens(part).join(' ')} `;
			const at = rest.indexOf(p);
			if (at < 0) return { error: `“${part}” không nằm trong câu ${n} (viết đúng như trong câu)` };
			rest = rest.slice(at + p.length - 1);
		}
		const same = await database('il_vocab').where('lesson_id', lessonId).whereRaw('lower(term) = ?', [term.toLowerCase()]).modify((q: any) => vid && q.whereNot('id', vid)).first('id');
		if (same) return { error: 'Bài này đã có mục đó' };
		const forms = [...new Set((Array.isArray(body?.forms) ? body.forms : []).map((f: unknown) => wordKey(String(f || ''))).filter((f: string | null): f is string => !!f && f !== key))].slice(0, 8);
		const translations: [string, string][] = Object.entries(body?.translations && typeof body.translations === 'object' ? body.translations : {})
			.filter(([lang]) => /^[a-z]{2}-[A-Z]{2}$/.test(lang) && lang !== 'vi-VN')
			.map(([lang, text]) => [lang, String(text || '').trim().slice(0, 300)]);
		return { row: { sentence_n: n, term, kind, meaning, forms }, translations };
	};
	const saveTranslations = async (trx: any, lessonId: string, vid: string, list: [string, string][]) => {
		for (const [lang, text] of list) {
			await trx('il_translations').where({ lesson_id: lessonId, lang, key: `vocab:${vid}` }).delete();
			if (text) await trx('il_translations').insert({ lesson_id: lessonId, lang, key: `vocab:${vid}`, text });
		}
	};

	router.get('/admin/intensive/:id/vocab', staff(async (req, res) => {
		const id = String(req.params.id);
		const [items, tr] = await Promise.all([
			database('il_vocab').where('lesson_id', id).orderBy('sentence_n').orderBy('date_created'),
			database('il_translations').select('lang', 'key', 'text').where('lesson_id', id).where('key', 'like', 'vocab:%'),
		]);
		return res.json({ success: true, data: items.map((v: any) => ({
			id: v.id, sentence_n: v.sentence_n, term: v.term, kind: v.kind, meaning: v.meaning, forms: v.forms || [],
			translations: Object.fromEntries(tr.filter((t: any) => t.key === `vocab:${v.id}`).map((t: any) => [t.lang, t.text])),
		})) });
	}));

	router.post('/admin/intensive/:id/vocab', staff(async (req, res) => {
		const id = String(req.params.id);
		const item = await readItem(id, req.body, null);
		if ('error' in item) return bad(res, item.error);
		await database.transaction(async (trx: any) => {
			const [row] = await trx('il_vocab').insert({ lesson_id: id, ...item.row }).returning('id');
			await saveTranslations(trx, id, row.id, item.translations);
		});
		return res.json({ success: true, data: null });
	}));

	router.put('/admin/intensive/:id/vocab/:vid', staff(async (req, res) => {
		const id = String(req.params.id);
		const vid = String(req.params.vid);
		if (!(await database('il_vocab').where({ id: vid, lesson_id: id }).first('id'))) return res.status(404).json({ success: false, message: 'Not found' });
		const item = await readItem(id, req.body, vid);
		if ('error' in item) return bad(res, item.error);
		await database.transaction(async (trx: any) => {
			await trx('il_vocab').where('id', vid).update(item.row);
			await saveTranslations(trx, id, vid, item.translations);
		});
		return res.json({ success: true, data: null });
	}));

	router.delete('/admin/intensive/:id/vocab/:vid', staff(async (req, res) => {
		const id = String(req.params.id);
		const vid = String(req.params.vid);
		await database.transaction(async (trx: any) => {
			await trx('il_translations').where({ lesson_id: id, key: `vocab:${vid}` }).delete();
			await trx('il_vocab').where({ id: vid, lesson_id: id }).delete();
		});
		return res.json({ success: true, data: null });
	}));
}
