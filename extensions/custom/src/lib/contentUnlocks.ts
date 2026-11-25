/**
 * Who may play a paid Extensive ('el') or Intensive ('il') lesson (is_premium = costs Kim cương): one who bought
 * it (content_unlocks, lib/coins.ts unlockContent). Free lessons are open to all.
 */
import { COIN } from './coins';

export type ContentKind = 'el' | 'il';

export type Access = {
	/** Locked for this learner: paid content not bought */
	locked: (l: { id: string; is_premium?: boolean | null }) => boolean;
	/** Kim cương to open one lesson of this kind */
	price: number;
};

/** The learner's access to one kind. `ids` narrows the bought rows read (a lesson page needs one, a list a page of them). */
export async function accessOf(db: any, userId: string | null, kind: ContentKind, _logger?: any, ids?: string[]): Promise<Access> {
	let owned = new Set<string>();
	if (userId) {
		const q = db('content_unlocks').select('lesson_id').where({ user_id: userId, kind });
		if (ids) q.whereIn('lesson_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
		owned = new Set((await q).map((r: any) => r.lesson_id));
	}
	return {
		locked: (l) => !!l.is_premium && !owned.has(l.id),
		price: COIN.unlockContent[kind] ?? 100,
	};
}
