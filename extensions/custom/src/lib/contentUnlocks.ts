/**
 * Who may play a premium Extensive ('el') or Intensive ('il') lesson: a learner with Premium (kept until it ends),
 * or one who bought that lesson with Kim cương (content_unlocks, lib/coins.ts unlockContent). Free lessons are open to all.
 */
import { COIN } from './coins';
import { isPremiumUser } from './premium';

export type ContentKind = 'el' | 'il';

export type Access = {
	premium: boolean;
	/** Locked for this learner: premium content, no Premium, not bought */
	locked: (l: { id: string; is_premium?: boolean | null }) => boolean;
	/** Kim cương to open one lesson of this kind */
	price: number;
};

/** The learner's access to one kind. `ids` narrows the bought rows read (a lesson page needs one, a list a page of them). */
export async function accessOf(db: any, userId: string | null, kind: ContentKind, logger?: any, ids?: string[]): Promise<Access> {
	const premium = await isPremiumUser(db, userId, logger);
	let owned = new Set<string>();
	if (userId && !premium) {
		const q = db('content_unlocks').select('lesson_id').where({ user_id: userId, kind });
		if (ids) q.whereIn('lesson_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
		owned = new Set((await q).map((r: any) => r.lesson_id));
	}
	return {
		premium,
		locked: (l) => !!l.is_premium && !premium && !owned.has(l.id),
		price: COIN.unlockContent[kind] ?? 100,
	};
}
