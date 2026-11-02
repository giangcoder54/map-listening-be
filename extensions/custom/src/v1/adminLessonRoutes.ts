/**
 * The lesson list of /admin/lessons, filtered and paged here so it stays fast with
 * thousands of lessons (admins and content editors: both may read every lesson, see
 * database/migrations/2026-10-15_content_editor.sql; what an editor may change is
 * checked by Directus permissions and hook/editorScope.ts).
 *
 *   GET /admin/lessons        ?skill=<uuid> &author=me|none|<uuid> &state=all|needs_work|drafts
 *                             &q=<phrase> &page=1 &limit=50
 *                             -> rows (skill order, then lesson order) with clips per role,
 *                                total, and the count of each state tab for the other filters
 *   GET /admin/lessons/stats  every lesson: total, published, drafts, needs work, premium,
 *                             hidden, overall and per skill
 *   GET /admin/lessons/:id/readiness   the publish checklist of a lesson (lib/readiness.ts)
 *   GET /admin/skills/:id/test-readiness  can the rule's skip-ahead / final test be drawn
 *
 * "Needs work" is what the page flags on a row (src/utils/adminLessons.ts lessonIssues):
 * not published, or short of clips of a role (lib/readiness.ts READY; focus, choices and
 * explanation are checked on the lesson page). "Hidden": published without a core or pool
 * clip (the site does not show it). "Premium": the lesson, its skill or its group is premium.
 */
import { UUID_RE } from '../lib/lessons';
import { isStaff } from '../lib/staff';
import { READY, readinessOf, skillTestReadiness } from '../lib/readiness';

const STATES = ['all', 'needs_work', 'drafts'] as const;
type State = (typeof STATES)[number];

/** Clips per role of every lesson */
const CLIPS = `
	SELECT lesson_id,
		count(*) FILTER (WHERE role = 'core')::int AS core,
		count(*) FILTER (WHERE role = 'voice')::int AS voice,
		count(*) FILTER (WHERE role = 'pool')::int AS pool,
		count(*) FILTER (WHERE role = 'challenge')::int AS challenge,
		count(*) FILTER (WHERE role = 'trap')::int AS trap
	FROM listening_clips
	WHERE lesson_id IS NOT NULL AND status = 'published'
	GROUP BY lesson_id`;

/** Lessons of a skill that sits in a group: the ones the page lists */
const FROM = `
	FROM listening_lessons l
	JOIN listening_skills s ON s.id = l.skill_id
	JOIN listening_groups g ON g.id = s.group_id
	LEFT JOIN clips c ON c.lesson_id = l.id`;

const DRAFT = `l.status IS DISTINCT FROM 'published'`;
const SHORT = `(coalesce(c.core, 0) <> ${READY.core} OR coalesce(c.voice, 0) < ${READY.voice} OR coalesce(c.pool, 0) < ${READY.pool}
	OR coalesce(c.challenge, 0) < ${READY.challenge} OR coalesce(c.trap, 0) < ${READY.trap})`;
const NEEDS_WORK = `(${DRAFT} OR ${SHORT})`;
const HIDDEN = `(l.status = 'published' AND coalesce(c.core, 0) + coalesce(c.pool, 0) = 0)`;
const PREMIUM = `(coalesce(l.is_premium, false) OR coalesce(s.is_premium, false) OR coalesce(g.is_premium, false))`;
const STATE_SQL: Record<State, string | null> = { all: null, needs_work: NEEDS_WORK, drafts: DRAFT };

/** The numbers of a set of lessons (stats) */
const COUNTS = `
	count(l.id)::int AS total,
	count(l.id) FILTER (WHERE l.status = 'published')::int AS published,
	count(l.id) FILTER (WHERE ${DRAFT})::int AS drafts,
	count(l.id) FILTER (WHERE ${NEEDS_WORK})::int AS needs_work,
	count(l.id) FILTER (WHERE ${PREMIUM})::int AS premium,
	count(l.id) FILTER (WHERE ${HIDDEN})::int AS hidden`;

const ORDER = `g.sort ASC NULLS LAST, g.name, s.sort ASC NULLS LAST, s.name, l.sort ASC NULLS LAST, l.text, l.id`;

/** "50%_off" -> "50\%\_off", for ILIKE */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export function registerAdminLessonRoutes(router: any, context: any) {
	const { database, logger } = context;
	const staff = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only' });
		try {
			return await handler(req, res);
		} catch (error: any) {
			logger?.error?.(`[admin-lessons] ${req.method} ${req.path} failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	};

	router.get('/admin/lessons', staff(async (req, res) => {
		const query = req.query || {};
		const state: State = STATES.includes(query.state) ? query.state : 'all';
		const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
		const page = Math.max(1, Math.floor(Number(query.page)) || 1);

		// Every filter but the state tab: the tabs show their count for the rest
		const where: string[] = [];
		const bindings: unknown[] = [];
		const skill = String(query.skill || '');
		if (skill) {
			if (!UUID_RE.test(skill)) return res.status(400).json({ success: false, message: 'Invalid skill' });
			where.push('l.skill_id = ?');
			bindings.push(skill);
		}
		const author = String(query.author || '');
		if (author === 'me') {
			where.push('l.user_created = ?');
			bindings.push(req.accountability.user);
		} else if (author === 'none') {
			where.push('l.user_created IS NULL');
		} else if (author) {
			if (!UUID_RE.test(author)) return res.status(400).json({ success: false, message: 'Invalid author' });
			where.push('l.user_created = ?');
			bindings.push(author);
		}
		const q = String(query.q || '').trim().slice(0, 200);
		if (q) {
			where.push(`l.text ILIKE ? ESCAPE '\\'`);
			bindings.push(`%${likeEscape(q)}%`);
		}
		const whereSql = (extra: string | null) => {
			const all = extra ? [...where, extra] : where;
			return all.length ? `WHERE ${all.join(' AND ')}` : '';
		};

		const [rows, tabs] = await Promise.all([
			database.raw(`
				WITH clips AS (${CLIPS})
				SELECT l.id, l.text, l.status, l.is_premium, l.difficulty, l.sort, l.short_id, l.skill_id, l.published_at,
					l.user_created AS author_id, u.first_name AS author_first_name, u.last_name AS author_last_name,
					coalesce(c.core, 0) AS core, coalesce(c.voice, 0) AS voice, coalesce(c.pool, 0) AS pool,
					coalesce(c.challenge, 0) AS challenge, coalesce(c.trap, 0) AS trap,
					count(*) OVER (PARTITION BY l.skill_id)::int AS skill_matches,
					count(*) OVER ()::int AS total
				${FROM}
				LEFT JOIN directus_users u ON u.id = l.user_created
				${whereSql(STATE_SQL[state])}
				ORDER BY ${ORDER}
				LIMIT ? OFFSET ?
			`, [...bindings, limit, (page - 1) * limit]),
			database.raw(`
				WITH clips AS (${CLIPS})
				SELECT count(*)::int AS "all",
					count(*) FILTER (WHERE ${NEEDS_WORK})::int AS needs_work,
					count(*) FILTER (WHERE ${DRAFT})::int AS drafts
				${FROM}
				${whereSql(null)}
			`, bindings),
		]);

		const list = rows.rows as any[];
		const tabCounts = tabs.rows[0] || { all: 0, needs_work: 0, drafts: 0 };
		return res.json({
			success: true,
			data: {
				rows: list.map((r) => ({
					id: r.id,
					text: r.text,
					status: r.status,
					is_premium: !!r.is_premium,
					difficulty: r.difficulty,
					sort: r.sort,
					short_id: r.short_id,
					skill_id: r.skill_id,
					published_at: r.published_at,
					user_created: r.author_id ? { id: r.author_id, first_name: r.author_first_name, last_name: r.author_last_name } : null,
					counts: { core: r.core, voice: r.voice, pool: r.pool, challenge: r.challenge, trap: r.trap },
				})),
				// Lessons of each skill on this page that match, on every page
				skill_totals: Object.fromEntries(list.map((r) => [r.skill_id, r.skill_matches])),
				// A page past the end has no row to carry the total: the tab count has it
				total: list[0]?.total ?? tabCounts[state],
				page,
				limit,
				tabs: { all: tabCounts.all, needs_work: tabCounts.needs_work, drafts: tabCounts.drafts },
			},
		});
	}));

	router.get('/admin/lessons/stats', staff(async (_req, res) => {
		const bySkill = (await database.raw(`
			WITH clips AS (${CLIPS})
			SELECT s.id AS skill_id, s.group_id, ${COUNTS}
			FROM listening_skills s
			JOIN listening_groups g ON g.id = s.group_id
			LEFT JOIN listening_lessons l ON l.skill_id = s.id
			LEFT JOIN clips c ON c.lesson_id = l.id
			GROUP BY s.id, s.group_id, g.sort, g.name, s.sort, s.name
			ORDER BY g.sort ASC NULLS LAST, g.name, s.sort ASC NULLS LAST, s.name
		`)).rows as any[];
		const keys = ['total', 'published', 'drafts', 'needs_work', 'premium', 'hidden'] as const;
		const totals = Object.fromEntries(keys.map((k) => [k, bySkill.reduce((n, r) => n + (Number(r[k]) || 0), 0)]));
		return res.json({ success: true, data: { totals, by_skill: bySkill } });
	}));

	router.get('/admin/lessons/:id/readiness', staff(async (req, res) => {
		const id = String(req.params.id || '');
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid lesson' });
		return res.json({ success: true, data: await readinessOf(database, id) });
	}));

	router.get('/admin/skills/:id/test-readiness', staff(async (req, res) => {
		const id = String(req.params.id || '');
		if (!UUID_RE.test(id)) return res.status(400).json({ success: false, message: 'Invalid skill' });
		return res.json({ success: true, data: await skillTestReadiness(database, id) });
	}));
}
