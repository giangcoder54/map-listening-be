/**
 * Tra từ tiếng Anh (Wiktionary, CC BY-SA, dữ liệu nạp vào bảng wiktionary_en bằng tools/wiktionary_load.py).
 *
 *   GET /dict/:word?lang=vi-VN   IPA, nghĩa tiếng Anh, ví dụ, và nghĩa theo ngôn ngữ nếu Wiktionary có.
 *                                 Dạng biến hình (did, buried) kèm nghĩa của từ gốc.
 *                                 404 NOT_FOUND khi không có mục: giao diện tự dùng phương án dự phòng.
 *
 * Không cần đăng nhập, chỉ đọc. Kết quả ít đổi nên được cache 1 ngày ở trình duyệt và CDN.
 */
import { wordKey, dictLang } from '../lib/dict';

export function registerDictRoutes(router: any, context: any) {
	const { database, logger } = context;

	const findEntry = async (w: string) => {
		const row = await database('wiktionary_en').select('doc').where({ w }).first();
		return row?.doc ?? null;
	};

	router.get('/dict/:word', async (req: any, res: any) => {
		const w = wordKey(String(req.params.word || ''));
		if (!w) return res.status(400).json({ success: false, code: 'BAD_WORD', message: 'Bad word' });
		const lang = dictLang(req.query?.lang);
		try {
			const doc = await findEntry(w);
			if (!doc) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found' });

			// Dạng biến hình: lấy thêm nghĩa của từ gốc
			let lemma: any = null;
			if (doc.form_of?.lemma && doc.form_of.lemma !== w) {
				const base = await findEntry(doc.form_of.lemma);
				if (base) lemma = { word: base.w, ipa: base.ipa, senses: (base.senses || []).slice(0, 2).map((s: any) => ({ g: s.g, ex: s.ex })) };
			}

			res.set('Cache-Control', 'public, max-age=86400');
			return res.json({ success: true, data: {
				word: doc.w,
				lang,
				ipa: doc.ipa || null,
				pos: doc.pos || [],
				senses: (doc.senses || []).map((s: any) => ({ g: s.g, ex: s.ex || null })),
				// Bản dịch theo từng từ (Wiktionary dịch ít từ, nên thường là null)
				tr: doc.tr?.[lang] ?? null,
				form_of: doc.form_of ? { lemma: doc.form_of.lemma, tags: doc.form_of.tags || [], base: lemma } : null,
				source: 'Wiktionary (CC BY-SA)',
			} });
		} catch (error: any) {
			logger?.error?.(`[dict] lookup ${w} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});
}
