/**
 * An account that has really learned: the guard against Kim cương farmed with throwaway accounts.
 *
 * A new account can feed another one: lose a paid room or duel on purpose (the winner takes the fees), or use
 * someone's help hints (the helper earns per use). So these need an established account: one that bought Kim
 * cương once, or has at least TRUST.minRight right answers with the first one TRUST.minDays days ago or more.
 */
export const TRUST = { minDays: 3, minRight: 20 };

export async function isEstablished(db: any, userId: string): Promise<boolean> {
	const bought = await db('coin_events').where({ user_id: userId, reason: 'purchase' }).first('id');
	if (bought) return true;
	// Both reads stop early (index user_id + date_created): a learner with years of answers costs the same as a new one
	const old = await db('listening_attempts').where({ user_id: userId, is_correct: true })
		.where('date_created', '<=', new Date(Date.now() - TRUST.minDays * 86_400_000)).first('id');
	if (!old) return false;
	const row = await db.raw(
		`SELECT count(*)::int AS n FROM (SELECT 1 FROM listening_attempts WHERE user_id = ? AND is_correct LIMIT ?) x`,
		[userId, TRUST.minRight],
	);
	return (Number(row.rows?.[0]?.n) || 0) >= TRUST.minRight;
}
