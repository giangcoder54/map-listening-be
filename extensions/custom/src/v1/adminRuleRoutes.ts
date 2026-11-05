/**
 * The order of the rules inside each group (/admin/rules). Learners open the rules of a group
 * one after the other in this order (lib/lessons.ts ruleLockedBy), so it is the learning path.
 *
 *   GET /admin/rules                     every group with its rules in order, and the lessons
 *                                        each rule has: all, published, and playable (published
 *                                        with a core or pool clip: what learners see)
 *   PUT /admin/groups/:id/rule-order     { ids: [skill id, ...] } every rule of the group, in the
 *                                        new order. Admins only: content editors may read the
 *                                        rules, not change them (2026-10-15_content_editor.sql).
 *
 * Order is written as sort 10, 20, 30... so a rule added later by hand in Directus can still
 * slot between two others.
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';

export function registerAdminRuleRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[admin-rules] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};

	router.get('/admin/rules', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			const [groups, rules] = await Promise.all([
				database('listening_groups').select('id', 'name', 'slug', 'status', 'sort').orderByRaw('sort ASC NULLS LAST, name'),
				database.raw(`
					SELECT s.id, s.group_id, s.name, s.slug, s.status, s.sort, s.is_premium,
						count(l.id)::int AS lessons,
						count(l.id) FILTER (WHERE l.status = 'published')::int AS published,
						count(l.id) FILTER (WHERE l.status = 'published' AND EXISTS (
							SELECT 1 FROM listening_clips c
							WHERE c.lesson_id = l.id AND c.status = 'published' AND c.role IN ('core', 'pool')
						))::int AS playable
					FROM listening_skills s
					LEFT JOIN listening_lessons l ON l.skill_id = s.id
					GROUP BY s.id
					ORDER BY s.sort ASC NULLS LAST, s.name
				`),
			]);
			return res.json({
				success: true,
				data: {
					can_edit: !!req.accountability.admin,
					groups: groups.map((g: any) => ({ ...g, rules: rules.rows.filter((r: any) => r.group_id === g.id) })),
				},
			});
		} catch (error) {
			return fail(res, 'Load rules', error);
		}
	});

	router.put('/admin/groups/:id/rule-order', async (req: any, res: any) => {
		if (!req.accountability?.admin) return res.status(403).json({ success: false, message: 'Admins only' });
		const groupId = String(req.params.id || '');
		const ids: unknown = req.body?.ids;
		if (!UUID_RE.test(groupId)) return res.status(400).json({ success: false, message: 'Invalid group' });
		if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && UUID_RE.test(id)) || new Set(ids).size !== ids.length) {
			return res.status(400).json({ success: false, message: 'ids: every rule id of the group, once each' });
		}
		try {
			const saved = await database.transaction(async (trx: any) => {
				// Lock the group's rules: two admins saving at once end with one whole order
				const own = await trx('listening_skills').select('id').where('group_id', groupId).forUpdate();
				const ownIds = new Set(own.map((r: any) => r.id));
				if (own.length !== ids.length || !ids.every((id) => ownIds.has(id))) return null;
				for (const [i, id] of (ids as string[]).entries()) {
					await trx('listening_skills').where('id', id).update({ sort: (i + 1) * 10 });
				}
				return ids.length;
			});
			if (saved === null) {
				return res.status(409).json({ success: false, code: 'RULES_CHANGED', message: 'The rules of this group changed: reload and try again' });
			}
			return res.json({ success: true, data: { saved } });
		} catch (error) {
			return fail(res, 'Save rule order', error);
		}
	});
}
