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
		logger?.error?.(`[premium] Không đọc được trạng thái premium của ${userId}: ${String(error)}`);
		return false;
	}
}

/**
 * Challenge này user có được làm không? Bài is_free = true mở cho mọi người (kể cả
 * khách), các bài còn lại chỉ dành cho Premium.
 */
export async function canAccessTarget(
	database: any,
	target: { is_free?: boolean | null } | null | undefined,
	userId: string | null,
	logger?: any,
): Promise<boolean> {
	if (target?.is_free === true) return true;
	return isPremiumUser(database, userId, logger);
}
