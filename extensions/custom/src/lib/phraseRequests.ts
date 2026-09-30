/**
 * Gợi ý cụm từ muốn có bài luyện. Bắt buộc đăng nhập (chống spam), nhưng cố ý
 * KHÔNG gắn gợi ý với tài khoản: chỉ lưu cụm từ + ghi chú tuỳ chọn, không lưu
 * user, email, IP hay id ẩn danh. Cùng một cụm từ (sau khi
 * chuẩn hoá) được gộp vào một dòng và tăng request_count, để admin sắp theo độ
 * phổ biến trong Directus.
 */
const TABLE = 'phrase_requests';

let tableReady: Promise<void> | null = null;

export function ensurePhraseRequestsTable(database: any, logger?: any): Promise<void> {
	if (!tableReady) {
		tableReady = (async () => {
			if (!(await database.schema.hasTable(TABLE))) {
				await database.schema.createTable(TABLE, (t: any) => {
					t.uuid('id').primary().defaultTo(database.raw('gen_random_uuid()'));
					t.string('phrase', 120).notNullable();
					t.string('phrase_normalized', 120).notNullable().unique();
					t.text('note').nullable();
					t.integer('request_count').notNullable().defaultTo(1);
					// new | planned | done | hidden - admin đổi tay trong Directus
					t.string('status', 20).notNullable().defaultTo('new');
					t.timestamp('date_created', { useTz: true }).notNullable().defaultTo(database.fn.now());
					t.timestamp('date_updated', { useTz: true }).notNullable().defaultTo(database.fn.now());
				});
				logger?.info?.(`[phrase-requests] Đã tạo bảng ${TABLE}`);
			}
			// Đăng ký với Directus để bảng hiện trong app admin (không có dòng này thì
			// Directus coi là bảng lạ và ẩn đi).
			await database('directus_collections')
				.insert({
					collection: TABLE,
					icon: 'lightbulb',
					note: 'Cụm từ người dùng muốn có bài luyện (ẩn danh)',
					hidden: false,
					singleton: false,
					sort_field: null,
					archive_field: 'status',
					archive_value: 'hidden',
					unarchive_value: 'new',
				})
				.onConflict('collection')
				.ignore();
		})().catch((error: any) => {
			tableReady = null; // thử lại ở request sau
			logger?.error?.(`[phrase-requests] Không tạo được bảng: ${String(error)}`);
			throw error;
		});
	}
	return tableReady;
}

const normalizePhrase = (phrase: string) =>
	phrase.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').replace(/\s+/g, ' ').trim();

// Chống spam trong bộ nhớ, không ghi xuống đâu cả: tối đa 5 lần gửi / giờ / tài khoản.
// Mất khi Directus khởi động lại - chấp nhận được với một form gợi ý.
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const recentSubmits = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
	const now = Date.now();
	const hits = (recentSubmits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
	if (hits.length >= RATE_LIMIT) {
		recentSubmits.set(key, hits);
		return true;
	}
	hits.push(now);
	recentSubmits.set(key, hits);
	if (recentSubmits.size > 5000) recentSubmits.clear();
	return false;
}

export async function handlePhraseRequest(req: any, res: any, database: any, logger?: any) {
	const body = req.body || {};
	const userId = req.accountability?.user ?? null;

	if (!userId) {
		return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED', message: 'Please log in to send a suggestion.' });
	}

	// Honeypot: ô ẩn mà người thật không thấy. Bot điền vào thì trả "thành công" giả.
	if (typeof body.website === 'string' && body.website.trim()) {
		return res.status(201).json({ success: true });
	}

	const phrase = typeof body.phrase === 'string' ? body.phrase.replace(/\s+/g, ' ').trim() : '';
	const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
	const normalized = normalizePhrase(phrase);

	if (!normalized || phrase.length > 80 || !/\p{L}/u.test(normalized)) {
		return res.status(400).json({ success: false, code: 'INVALID_PHRASE', message: 'Please enter a phrase (up to 80 characters).' });
	}

	if (isRateLimited(String(userId))) {
		return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Too many suggestions. Please try again later.' });
	}

	try {
		await ensurePhraseRequestsTable(database, logger);
		await database.raw(
			`INSERT INTO ${TABLE} (phrase, phrase_normalized, note)
			 VALUES (?, ?, ?)
			 ON CONFLICT (phrase_normalized) DO UPDATE SET
			   request_count = ${TABLE}.request_count + 1,
			   note = CASE
			     WHEN EXCLUDED.note IS NULL THEN ${TABLE}.note
			     ELSE left(concat_ws(E'\\n---\\n', ${TABLE}.note, EXCLUDED.note), 3000)
			   END,
			   date_updated = now()`,
			[phrase, normalized.slice(0, 120), note || null],
		);
		return res.status(201).json({ success: true });
	} catch (error: any) {
		logger?.error?.(`[phrase-requests] Lưu gợi ý thất bại: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	}
}
