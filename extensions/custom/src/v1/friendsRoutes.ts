/**
 * Friends (database/migrations/2026-11-28_friends.sql): a leaderboard between people who added each other.
 *
 *   POST /friends/add      { code }  the other person's invite code (the one on /invite) -> { name }. Both become friends.
 *   POST /friends/remove   { id }    a friend's id (as GET /leaderboard?scope=friends gives it) -> both sides stop being friends
 *
 * The board itself is GET /leaderboard?scope=friends (engagementRoutes.ts).
 */
import { findReferrer } from '../lib/referrals';
import { publicName } from './engagementRoutes';
import { UUID_RE } from '../lib/lessons';

/** Friends one learner can have: keeps the private board and its query small */
const MAX_FRIENDS = 100;

export function registerFriendsRoutes(router: any, context: any) {
	const { database, logger } = context;
	const need = (req: any, res: any) => {
		const userId = req.accountability?.user as string | undefined;
		if (!userId) res.status(401).json({ success: false, message: 'Unauthorized' });
		return userId || null;
	};

	router.post('/friends/add', async (req: any, res: any) => {
		const userId = need(req, res);
		if (!userId) return;
		try {
			const friend = await findReferrer(database, String(req.body?.code ?? ''));
			if (!friend) return res.status(404).json({ success: false, code: 'NO_SUCH_CODE', message: 'No learner has this code.' });
			if (friend.id === userId) return res.status(400).json({ success: false, code: 'SELF', message: 'This is your own code.' });
			const count = await database('user_friends').where('user_id', userId).count('* as n').first();
			if (Number(count?.n) >= MAX_FRIENDS) return res.status(400).json({ success: false, code: 'TOO_MANY', message: 'Too many friends.' });
			await database('user_friends')
				.insert([{ user_id: userId, friend_id: friend.id }, { user_id: friend.id, friend_id: userId }])
				.onConflict(['user_id', 'friend_id']).ignore();
			return res.json({ success: true, data: { name: publicName(friend.first_name, friend.last_name) } });
		} catch (error) {
			logger?.error?.(`[friends] add failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});

	router.post('/friends/remove', async (req: any, res: any) => {
		const userId = need(req, res);
		if (!userId) return;
		const id = String(req.body?.id ?? '');
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
		try {
			await database('user_friends').where({ user_id: userId, friend_id: id }).orWhere({ user_id: id, friend_id: userId }).del();
			return res.json({ success: true });
		} catch (error) {
			logger?.error?.(`[friends] remove failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});
}
