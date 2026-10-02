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
 * Premium hết hạn -> trả về role Free User và tắt is_premium, để role trong Directus khớp
 * với trạng thái thật (quyền truy cập bài vẫn do isPremiumUser quyết định, không theo role).
 * Lifetime (premium_until NULL) không bao giờ bị hạ.
 */
export async function downgradeExpiredPremium(database: any, logger?: any): Promise<number> {
	try {
		const [premiumRole, freeRole] = await Promise.all([
			database('directus_roles').whereRaw("trim(name) = 'Premium User'").first('id'),
			database('directus_roles').whereRaw("trim(name) = 'Free User'").first('id'),
		]);
		if (!premiumRole || !freeRole) return 0;
		const count = await database('directus_users')
			.where('role', premiumRole.id)
			.whereNotNull('premium_until')
			.where('premium_until', '<', new Date())
			.update({ role: freeRole.id, is_premium: false });
		if (count) logger?.info?.(`[premium] Hạ ${count} user hết hạn Premium về Free User`);
		return count;
	} catch (error: any) {
		logger?.error?.(`[premium] Không hạ được user hết hạn Premium: ${String(error)}`);
		return 0;
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
