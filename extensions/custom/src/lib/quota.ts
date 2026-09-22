/**
 * Giới hạn lượt luyện tập của gói Free (Listening Lab).
 *
 * Luật đã chốt:
 *   - Premium còn hạn            -> không giới hạn.
 *   - User Free đã đăng nhập     -> FREE_MONTHLY_QUOTA lượt/tháng (mặc định 15).
 *   - Khách chưa đăng nhập       -> KHÔNG được chấm bài, phải đăng nhập.
 *
 * Vì sao khách không còn hạn mức dùng thử: danh tính của khách là `anonymous_id`
 * do chính client sinh ra và gửi lên, nên xoá cookie (hoặc gửi một UUID mới) là
 * reset được hạn mức. Không có cách nào vá chỗ đó khi định danh nằm ở phía
 * client, nên hạn mức khách bị bỏ hẳn thay vì giả vờ rằng nó có tác dụng.
 *   - 1 lượt = lần bấm "Check" ĐẦU TIÊN ở mỗi clip trong tháng. Bấm Check lại
 *     ở đúng clip đó (gõ sai chính tả, thử lại) KHÔNG trừ thêm lượt.
 *   - "Show answer" (reveal) KHÔNG trừ lượt.
 *   - Reset vào 00:00 ngày 1 mỗi tháng theo giờ Việt Nam.
 *
 * Vì đếm theo "clip khác nhau" nên bảng lưu thẳng từng (chủ thể, tháng, clip)
 * chứ không lưu một con số đếm: số lượt đã dùng = số dòng. Một nguồn sự thật
 * duy nhất, không sợ bộ đếm và danh sách clip lệch nhau theo thời gian.
 */

const QUOTA_TABLE = 'listening_quota_clips';

export const FREE_MONTHLY_QUOTA = Number(process.env.FREE_MONTHLY_QUOTA || 15);
/**
 * Hạn mức của khách, nay luôn là 0: chấm bài bắt buộc đăng nhập.
 * Giữ biến lại (và vẫn đọc env) để bật lại chế độ dùng thử chỉ cần đổi một dòng.
 */
export const GUEST_MONTHLY_QUOTA = Number(process.env.GUEST_MONTHLY_QUOTA || 0);

/** Lệch giờ để chốt mốc sang tháng. Mặc định +7 = giờ Việt Nam. */
const TZ_OFFSET_HOURS = Number(process.env.QUOTA_TZ_OFFSET_HOURS || 7);

let quotaTableReady: Promise<void> | null = null;

export interface QuotaState {
	/** Có được phép làm tiếp không (false = đã hết lượt). */
	allowed: boolean;
	/** Premium -> true, bỏ qua mọi giới hạn. */
	unlimited: boolean;
	/** Request này có thực sự trừ 1 lượt không (clip mới), hay miễn phí (làm lại). */
	charged: boolean;
	limit: number | null;
	used: number;
	remaining: number | null;
	period: string;
	resetsAt: string;
	/** Khi hết lượt: khách cần đăng ký, user Free cần nâng cấp. */
	requires: 'signup' | 'upgrade' | null;
}

/** Tháng hiện tại dạng 'YYYY-MM', tính theo giờ Việt Nam. */
export function currentPeriod(now: Date = new Date()): string {
	const d = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600_000);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Thời điểm quota được cấp lại: 00:00 ngày 1 tháng sau, giờ Việt Nam. */
export function periodResetsAt(period: string): string {
	const [year, month] = period.split('-').map(Number);
	// Date.UTC(year, month, 1) = ngày 1 THÁNG SAU (month đang là 1-based nên đã lệch sẵn 1)
	const utcMs = Date.UTC(year || 1970, month || 0, 1) - TZ_OFFSET_HOURS * 3600_000;
	return new Date(utcMs).toISOString();
}

/** Khoá định danh chủ thể đang tính lượt. Null = không xác định được (không đếm). */
export function subjectKey(userId: string | null, anonymousId: string | null): string | null {
	if (userId) return `user:${userId}`;
	if (anonymousId) return `anon:${anonymousId}`;
	return null;
}

export function ensureQuotaTable(database: any, logger?: any): Promise<void> {
	if (!quotaTableReady) {
		quotaTableReady = (async () => {
			const exists = await database.schema.hasTable(QUOTA_TABLE);
			if (exists) return;
			await database.schema.createTable(QUOTA_TABLE, (table: any) => {
				table.uuid('id').primary().defaultTo(database.raw('gen_random_uuid()'));
				table.string('subject_key', 80).notNullable();
				table.string('period', 7).notNullable();
				table.uuid('clip_id').notNullable();
				table.timestamp('date_created', { useTz: true }).defaultTo(database.fn.now());
				table.unique(['subject_key', 'period', 'clip_id']);
				table.index(['subject_key', 'period']);
			});
			logger?.info?.(`[quota] Đã tạo bảng ${QUOTA_TABLE}`);
		})().catch((error: any) => {
			quotaTableReady = null;
			throw error;
		});
	}
	return quotaTableReady;
}

/**
 * Premium còn hiệu lực? Đọc thẳng cột trên directus_users (do activatePremiumForUser ghi).
 * Lỗi đọc -> coi như KHÔNG premium nhưng log rõ, vì im lặng ở đây nghĩa là user đã
 * trả tiền lại bị chặn như user free.
 */
export async function isPremiumUser(database: any, userId: string | null, logger?: any): Promise<boolean> {
	if (!userId) return false;
	try {
		const row = await database('directus_users')
			.select('is_premium', 'premium_until')
			.where('id', userId)
			.first();
		if (!row || !row.is_premium) return false;
		if (row.premium_until && new Date(row.premium_until).getTime() < Date.now()) return false;
		return true;
	} catch (error: any) {
		logger?.error?.(`[quota] Không đọc được trạng thái premium của ${userId}: ${String(error)}`);
		return false;
	}
}

/**
 * Chuyển lượt đã dùng lúc còn là khách sang tài khoản vừa đăng nhập.
 * Không làm việc này thì ai cũng xài hết lượt khách rồi đăng ký để được thêm
 * trọn bộ lượt của user. Clip nào tài khoản đã tính rồi thì bỏ, không nhân đôi.
 */
async function mergeGuestUsage(trx: any, userKey: string, anonKey: string, period: string): Promise<void> {
	await trx.raw(
		`
		UPDATE ${QUOTA_TABLE} q
		SET subject_key = ?
		WHERE q.subject_key = ?
		  AND q.period = ?
		  AND NOT EXISTS (
			SELECT 1 FROM ${QUOTA_TABLE} u
			WHERE u.subject_key = ? AND u.period = q.period AND u.clip_id = q.clip_id
		  )
		`,
		[userKey, anonKey, period, userKey],
	);
	// Phần còn lại là clip tài khoản đã có -> xoá cho sạch.
	await trx(QUOTA_TABLE).where({ subject_key: anonKey, period }).del();
}

function buildState(params: {
	allowed: boolean;
	unlimited: boolean;
	charged: boolean;
	limit: number | null;
	used: number;
	period: string;
	isGuest: boolean;
}): QuotaState {
	const { allowed, unlimited, charged, limit, used, period, isGuest } = params;
	return {
		allowed,
		unlimited,
		charged,
		limit,
		used,
		remaining: limit === null ? null : Math.max(0, limit - used),
		period,
		resetsAt: periodResetsAt(period),
		requires: allowed ? null : (isGuest ? 'signup' : 'upgrade'),
	};
}

interface QuotaArgs {
	database: any;
	logger?: any;
	userId: string | null;
	anonymousId: string | null;
	clipId?: string;
}

/**
 * Xin 1 lượt cho lần bấm Check ở một clip. Chạy trong transaction + advisory lock
 * theo chủ thể: user bấm nhanh hai lần hay mở hai tab cũng không vượt được giới hạn,
 * và khoá tự nhả khi transaction kết thúc.
 */
export async function consumeQuotaForClip(args: QuotaArgs & { clipId: string }): Promise<QuotaState> {
	const { database, logger, userId, anonymousId, clipId } = args;
	const period = currentPeriod();

	await ensureQuotaTable(database, logger);

	if (await isPremiumUser(database, userId, logger)) {
		return buildState({ allowed: true, unlimited: true, charged: false, limit: null, used: 0, period, isGuest: false });
	}

	// Khách chưa đăng nhập: không chấm bài, không ghi lượt. `requires: 'signup'`
	// (do buildState đặt khi isGuest) là thứ frontend dùng để mời đăng nhập.
	if (!userId) {
		return buildState({ allowed: false, unlimited: false, charged: false, limit: 0, used: 0, period, isGuest: true });
	}

	const key = subjectKey(userId, anonymousId);
	const isGuest = false;
	const limit = FREE_MONTHLY_QUOTA;

	// Không định danh được chủ thể -> coi như hết lượt. Với user đã đăng nhập thì
	// nhánh này không xảy ra (subjectKey luôn trả về `user:<id>`), giữ lại để phòng.
	if (!key) {
		return buildState({ allowed: false, unlimited: false, charged: false, limit, used: limit, period, isGuest });
	}

	return database.transaction(async (trx: any) => {
		await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${key}:${period}`]);

		if (userId && anonymousId) {
			await mergeGuestUsage(trx, key, `anon:${anonymousId}`, period);
		}

		const already = await trx(QUOTA_TABLE)
			.where({ subject_key: key, period, clip_id: clipId })
			.first();

		const countRow = await trx(QUOTA_TABLE)
			.where({ subject_key: key, period })
			.count({ c: '*' })
			.first();
		const used = Number(countRow?.c ?? 0);

		// Clip này đã tính trong tháng -> làm lại bao nhiêu lần cũng miễn phí.
		if (already) {
			return buildState({ allowed: true, unlimited: false, charged: false, limit, used, period, isGuest });
		}

		if (used >= limit) {
			return buildState({ allowed: false, unlimited: false, charged: false, limit, used, period, isGuest });
		}

		await trx(QUOTA_TABLE).insert({ subject_key: key, period, clip_id: clipId });
		return buildState({ allowed: true, unlimited: false, charged: true, limit, used: used + 1, period, isGuest });
	});
}

/** Chỉ đọc trạng thái để hiển thị ("còn 3/15 lượt"), không trừ lượt. */
export async function getQuotaStatus(args: QuotaArgs): Promise<QuotaState> {
	const { database, logger, userId, anonymousId } = args;
	const period = currentPeriod();

	await ensureQuotaTable(database, logger);

	if (await isPremiumUser(database, userId, logger)) {
		return buildState({ allowed: true, unlimited: true, charged: false, limit: null, used: 0, period, isGuest: false });
	}

	// Giống consumeQuotaForClip: khách không có hạn mức nào để hiển thị.
	if (!userId) {
		return buildState({ allowed: false, unlimited: false, charged: false, limit: 0, used: 0, period, isGuest: true });
	}

	const key = subjectKey(userId, anonymousId);
	const isGuest = false;
	const limit = FREE_MONTHLY_QUOTA;

	if (!key) {
		return buildState({ allowed: false, unlimited: false, charged: false, limit, used: limit, period, isGuest });
	}

	return database.transaction(async (trx: any) => {
		await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${key}:${period}`]);

		// Gộp luôn ở đây để ngay sau khi đăng nhập, số lượt hiện trên giao diện đã đúng,
		// không phải đợi tới lần Check đầu tiên.
		if (userId && anonymousId) {
			await mergeGuestUsage(trx, key, `anon:${anonymousId}`, period);
		}

		const countRow = await trx(QUOTA_TABLE)
			.where({ subject_key: key, period })
			.count({ c: '*' })
			.first();
		const used = Number(countRow?.c ?? 0);

		return buildState({ allowed: used < limit, unlimited: false, charged: false, limit, used, period, isGuest });
	});
}

/** Rút gọn để trả ra API (snake_case cho khớp phần còn lại của response). */
export function publicQuota(state: QuotaState) {
	return {
		unlimited: state.unlimited,
		limit: state.limit,
		// Hạn mức của user đã đăng ký: dùng cho lời mời "đăng ký để có N lượt"
		// hiện với khách (khách chỉ có GUEST_MONTHLY_QUOTA).
		free_limit: FREE_MONTHLY_QUOTA,
		used: state.used,
		remaining: state.remaining,
		period: state.period,
		resets_at: state.resetsAt,
		charged: state.charged,
		requires: state.requires,
	};
}
