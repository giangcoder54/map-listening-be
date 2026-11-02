/**
 * Runs and Xu (lib/runs.ts, lib/review.ts, lib/coins.ts, database/migrations/2026-11-02_rule_flow.sql).
 *
 *   POST /listening-lab/lessons/:key/runs     start or resume a lesson   body: { anonymous_id?, restart? }
 *   POST /listening-lab/lessons/:key/test     skip-ahead test of one lesson (signed in)
 *   POST /listening-lab/skills/:slug/test     the rule's test: skip it (Premium), or its final test
 *                                             once every lesson is done. One go a day, then Xu.
 *                                             body: { pay? }
 *   GET  /listening-lab/review                forms due for review, what is left today
 *   POST /listening-lab/review/runs           start or resume a review
 *   GET  /listening-lab/runs/:id              a run as the page plays it
 *   POST /listening-lab/runs/:id/answer       answer the current item: the server checks it
 *                                             body: { position, answer, listens, slow, hint, time_ms, anonymous_id? }
 *   POST /listening-lab/runs/:id/finish       every item answered: progress, review cards, XP and Xu
 *   GET  /listening-lab/wallet                Xu, freezes, unlocks left this week, prices
 *   POST /listening-lab/lessons/:key/unlock   buy a locked lesson with Xu (kept for good)
 *   POST /listening-lab/wallet/freeze         buy a streak freeze with Xu
 *
 * Tests and reviews are drawn for each learner and each go from the pools the team wrote:
 * different items, the same rules (lib/runs.ts drawTest, drawReview). Guests play lessons
 * only (learner key a:<anonymous_id>); tests and reviews keep progress, so they need an account.
 */
import { UUID_RE, answerOf, loadLessonGraph, type LessonGraph, type LessonRow } from '../lib/lessons';
import {
	LESSON_TEST, MAX_LISTENS, drawLesson, drawReview, drawTest, isRight, passed, summaryOf, weakestForms, withRetry,
	type PoolClip, type RunItem,
} from '../lib/runs';
import { REVIEW, gradeOf, masteryOf, schedule, cardColumns } from '../lib/review';
import { COIN, CoinError, buyFreeze, earnCoins, payRetest, unlockLesson, walletOf } from '../lib/coins';
import { MAX_FREEZES, grantRewards, lessonXp, recordPractice, vnDay, DEFAULT_GOAL } from '../lib/xp';
import { choicesOf, clipOut, lessonTranslations, readClips, registerLearner } from './lessonRoutes';
import { normalizeAnswer } from './engagementRoutes';

const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const badKey = (key: string) => !key || key.length > 64;
type Mode = 'learn' | 'lesson_test' | 'skill_test' | 'review';

function learnerOf(req: any) {
	const userId: string | null = req.accountability?.user ?? null;
	const raw = req.body?.anonymous_id ?? req.query?.anonymous_id;
	const anonymousId = typeof raw === 'string' && ANON_ID_RE.test(raw) ? raw : null;
	const key = userId ? `u:${userId}` : anonymousId ? `a:${anonymousId}` : null;
	return { userId, anonymousId, key };
}

/** A lesson's clips as drawing sees them, and the payload the page plays */
async function poolOf(database: any, g: LessonGraph, lesson: LessonRow) {
	const rows = await readClips(database, [lesson.id]);
	const group = g.groupOf(lesson);
	const others = (g.lessonsBySkill.get(lesson.skill_id) || []).filter((l) => l.id !== lesson.id).map((l) => l.text);
	const answers = rows.map((r: any) => answerOf(r, lesson.text, group.answer_mode));
	// Wrong choices: the other phrases of the lesson, then the other forms of the rule
	const phrases = [...new Set([...answers, ...others].filter(Boolean))] as string[];
	const wrongFor = (answer: string) => phrases.filter((p) => normalizeAnswer(p) !== normalizeAnswer(answer));
	const byId = new Map<string, { row: any; clip: PoolClip }>();
	rows.forEach((r: any, i: number) => {
		const answer = answers[i]!;
		byId.set(r.id, {
			row: r,
			clip: {
				id: r.id, role: r.role, answer,
				focus: String(r.focus_text || '').trim() || null,
				difficulty: r.difficulty ?? null,
				forced: r.answer_format || null,
				hasChoices: !!choicesOf(r, answer, wrongFor(answer)),
			},
		});
	});
	const payload = (item: RunItem, index: number) => {
		const hit = byId.get(item.clip_id);
		if (!hit) return null;
		const { row, clip } = hit;
		const base = clipOut(row, lesson.text, group.answer_mode, true, wrongFor(clip.answer));
		return {
			index,
			phase: item.phase,
			format: item.format,
			result: item.result || null,
			clip: {
				...base,
				format: item.format,
				choices: item.format === 'choice' ? choicesOf(row, clip.answer, wrongFor(clip.answer)) : null,
				focus: clip.focus,
			},
		};
	};
	return { lesson, byId, clips: [...byId.values()].map((x) => x.clip), payload };
}
type Pool = Awaited<ReturnType<typeof poolOf>>;

/** Pools of several lessons (tests of a rule, reviews), loaded once each */
async function poolsOf(database: any, g: LessonGraph, lessonIds: string[]) {
	const out = new Map<string, Pool>();
	for (const id of new Set(lessonIds)) {
		const lesson = g.lessonById.get(id);
		if (lesson) out.set(id, await poolOf(database, g, lesson));
	}
	return out;
}

/** The run as the page plays it. Every item keeps its index, whatever the page skips. */
async function runOut(database: any, g: LessonGraph, run: any) {
	const items: RunItem[] = run.items || [];
	const pools = await poolsOf(database, g, items.map((it) => it.lesson_id || run.lesson_id));
	const lesson = run.lesson_id ? g.lessonById.get(run.lesson_id) : null;
	const skill = run.skill_id ? g.skillById.get(run.skill_id) : null;
	return {
		id: run.id,
		mode: run.mode as Mode,
		status: run.status,
		position: Number(run.position) || 0,
		max_listens: MAX_LISTENS[run.mode] || 3,
		lesson: lesson ? { short_id: lesson.short_id, number: g.numberOf(lesson) } : null,
		skill: skill ? { slug: skill.slug, name: skill.name } : null,
		items: items.map((it, i) => pools.get(it.lesson_id || run.lesson_id)?.payload(it, i) || null).filter(Boolean),
	};
}

export function registerRunRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[runs] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	const coinFail = (res: any, e: CoinError) => {
		const status = e.code === 'NOT_ENOUGH' || e.code === 'WEEKLY_LIMIT' || e.code === 'MAX_FREEZES' ? 402 : 409;
		return res.status(status).json({ success: false, code: e.code });
	};

	/** The run, locked for this transaction; null when it is not this learner's */
	async function loadRun(req: any, trx: any = database) {
		const id = String(req.params.id || '');
		if (!UUID_RE.test(id)) return null;
		const { key } = learnerOf(req);
		const run = await trx('listening_runs').where('id', id).forUpdate().first();
		if (!run || !key || run.learner_key !== key) return null;
		return run;
	}

	/** Clips this learner answered before, among `ids` (drawing puts them last) */
	async function metOf(userId: string | null, ids: string[]) {
		const met = new Set<string>();
		if (!userId || !ids.length) return met;
		const rows = await database('listening_attempts').distinct('clip_id').where('user_id', userId).whereIn('clip_id', ids);
		for (const r of rows) met.add(r.clip_id);
		return met;
	}

	/** The active run of this learner for a mode and lesson / rule, or a new one with `draw()` items */
	async function openRun(
		learner: ReturnType<typeof learnerOf>,
		mode: Mode,
		where: { lesson_id?: string | null; skill_id?: string | null },
		draw: () => RunItem[] | Promise<RunItem[]>,
		opts: { restart?: boolean; valid?: (items: RunItem[]) => boolean } = {},
	) {
		return database.transaction(async (trx: any) => {
			const q = trx('listening_runs').where({ learner_key: learner.key, mode, status: 'active' });
			if (where.lesson_id !== undefined) q.where('lesson_id', where.lesson_id);
			if (where.skill_id !== undefined) q.where('skill_id', where.skill_id);
			const active = await q.orderBy('started_at', 'desc').forUpdate().first();
			const stale = active && opts.valid && !opts.valid(active.items || []);
			if (active && !opts.restart && !stale) return active;
			if (active) await trx('listening_runs').where('id', active.id).update({ status: 'abandoned', date_updated: trx.fn.now() });
			const items = await draw();
			if (!items.length) return null;
			const [row] = await trx('listening_runs').insert({
				user_id: learner.userId, learner_key: learner.key, mode,
				skill_id: where.skill_id ?? null, lesson_id: where.lesson_id ?? null, items: JSON.stringify(items),
			}).returning('*');
			return row;
		});
	}

	// ── A lesson ──────────────────────────────────────────────────────────
	router.post('/listening-lab/lessons/:key/runs', async (req: any, res: any) => {
		const lessonKey = String(req.params.key || '');
		if (badKey(lessonKey)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		const learner = learnerOf(req);
		if (!learner.key) return res.status(400).json({ success: false, message: 'anonymous_id needed' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(lessonKey);
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
			if (g.isLocked(lesson)) {
				return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED', price: COIN.unlock[lesson.kind || 'pattern'] ?? COIN.unlock.pattern });
			}
			if (g.isOrderLocked(lesson)) return res.status(403).json({ success: false, code: 'ORDER_LOCKED' });
			const pool = await poolOf(database, g, lesson);
			const run = await openRun(learner, 'learn', { lesson_id: lesson.id, skill_id: lesson.skill_id },
				async () => drawLesson(pool.clips, await metOf(learner.userId, [...pool.byId.keys()])),
				{ restart: !!req.body?.restart, valid: (items) => items.every((it) => pool.byId.has(it.clip_id)) });
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON', message: 'This lesson has no clip to play yet' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Start run', error);
		}
	});

	// ── Skip-ahead test of one lesson ─────────────────────────────────────
	router.post('/listening-lab/lessons/:key/test', async (req: any, res: any) => {
		const lessonKey = String(req.params.key || '');
		if (badKey(lessonKey)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		const learner = learnerOf(req);
		if (!learner.userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(lessonKey);
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
			if (g.isLocked(lesson)) return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED' });
			const pool = await poolOf(database, g, lesson);
			const run = await openRun(learner, 'lesson_test', { lesson_id: lesson.id, skill_id: lesson.skill_id },
				async () => drawTest([{ lessonId: lesson.id, clips: pool.clips }], LESSON_TEST.size, await metOf(learner.userId, [...pool.byId.keys()])),
				{ valid: (items) => items.every((it) => pool.byId.has(it.clip_id)) });
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Start lesson test', error);
		}
	});

	// ── The rule's test: skip it, or its final test ───────────────────────
	router.post('/listening-lab/skills/:slug/test', async (req: any, res: any) => {
		const slug = String(req.params.slug || '');
		if (badKey(slug)) return res.status(400).json({ success: false, message: 'Invalid skill' });
		const learner = learnerOf(req);
		if (!learner.userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const skill = g.skills.find((s) => s.slug === slug);
			if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });
			const open = (g.lessonsBySkill.get(skill.id) || []).filter((l) => !g.isLocked(l));
			if (!open.length) return res.status(403).json({ success: false, code: 'PREMIUM_REQUIRED' });
			// Skipping a rule is Premium; everyone takes the final test once every lesson is done
			const allDone = open.every((l) => g.done.has(l.id));
			if (!g.premium && !allDone) return res.status(403).json({ success: false, code: 'FINISH_LESSONS_FIRST' });

			const today = vnDay();
			const active = await database('listening_runs').where({ user_id: learner.userId, mode: 'skill_test', skill_id: skill.id, status: 'active' }).first('id');
			if (!active) {
				// One go a day is free; another costs Xu
				const dayStart = (await database.raw(`SELECT (?::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AS t`, [today])).rows[0].t;
				const goes = Number((await database('listening_runs')
					.where({ user_id: learner.userId, mode: 'skill_test', skill_id: skill.id }).where('started_at', '>=', dayStart)
					.count('* as n').first())?.n) || 0;
				if (goes > 0) {
					if (!req.body?.pay) return res.status(402).json({ success: false, code: 'RETEST_COSTS', price: COIN.retest });
					await payRetest(database, learner.userId, skill.id, goes, today);
				}
			}

			const settings = await database('listening_skills').select('test_size').where('id', skill.id).first();
			const pools = await poolsOf(database, g, open.map((l) => l.id));
			const allIds = [...pools.values()].flatMap((p) => [...p.byId.keys()]);
			const run = await openRun(learner, 'skill_test', { skill_id: skill.id, lesson_id: null },
				async () => drawTest([...pools.values()].map((p) => ({ lessonId: p.lesson.id, clips: p.clips })), Number(settings?.test_size) || 8, await metOf(learner.userId, allIds)));
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Start skill test', error);
		}
	});

	// ── Review ────────────────────────────────────────────────────────────
	/** Forms due for this learner that they can still open, most overdue first */
	async function dueForms(g: LessonGraph, userId: string) {
		const rows = await database('listening_review_cards').select('lesson_id', 'due').where('user_id', userId).where('due', '<=', database.fn.now()).orderBy('due');
		const open = rows.filter((r: any) => { const l = g.lessonById.get(r.lesson_id); return l && !g.isLocked(l); });
		const locked = rows.length - open.length;
		return { open: open.map((r: any) => r.lesson_id as string) as string[], locked };
	}
	async function reviewsToday(userId: string) {
		const row = await database('user_daily_stats').select('reviews').where({ user_id: userId, day: vnDay() }).first();
		return Number(row?.reviews) || 0;
	}

	router.get('/listening-lab/review', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const [due, done, next] = await Promise.all([
				dueForms(g, userId),
				reviewsToday(userId),
				database('listening_review_cards').where('user_id', userId).where('due', '>', database.fn.now()).min('due as d').first(),
			]);
			const left = g.premium ? REVIEW.session : Math.max(0, REVIEW.free - done);
			const active = await database('listening_runs').where({ user_id: userId, mode: 'review', status: 'active' }).first('id');
			return res.json({
				success: true,
				data: {
					due: due.open.length,
					// Forms of lessons no longer open (Premium ended): they wait for it
					locked: due.locked,
					premium: g.premium,
					done_today: done,
					left_today: left,
					free_per_day: REVIEW.free,
					next_due: next?.d || null,
					resume: !!active,
				},
			});
		} catch (error) {
			return fail(res, 'Review summary', error);
		}
	});

	router.post('/listening-lab/review/runs', async (req: any, res: any) => {
		const learner = learnerOf(req);
		if (!learner.userId) return res.status(401).json({ success: false, code: 'LOGIN_REQUIRED' });
		try {
			const g = await loadLessonGraph(req, context);
			const due = await dueForms(g, learner.userId);
			const left = g.premium ? REVIEW.session : Math.max(0, REVIEW.free - (await reviewsToday(learner.userId)));
			const active = await database('listening_runs').where({ user_id: learner.userId, mode: 'review', status: 'active' }).first('id');
			if (!active && !left) return res.status(402).json({ success: false, code: 'REVIEW_LIMIT', free_per_day: REVIEW.free });
			const ids = due.open.slice(0, left || REVIEW.session);
			const pools = await poolsOf(database, g, ids);
			const run = await openRun(learner, 'review', { lesson_id: null, skill_id: null },
				async () => drawReview(ids.filter((id: string) => pools.has(id)).map((id: string) => ({ lessonId: id, clips: pools.get(id)!.clips })), left,
					await metOf(learner.userId, [...pools.values()].flatMap((p) => [...p.byId.keys()]))));
			if (!run) return res.status(409).json({ success: false, code: 'NOTHING_DUE' });
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Start review', error);
		}
	});

	// ── A run ─────────────────────────────────────────────────────────────
	router.get('/listening-lab/runs/:id', async (req: any, res: any) => {
		try {
			const run = await loadRun(req);
			if (!run) return res.status(404).json({ success: false, message: 'Run not found' });
			const g = await loadLessonGraph(req, context);
			return res.json({ success: true, data: await runOut(database, g, run) });
		} catch (error) {
			return fail(res, 'Load run', error);
		}
	});

	router.post('/listening-lab/runs/:id/answer', async (req: any, res: any) => {
		const body = req.body || {};
		const learner = learnerOf(req);
		try {
			const out = await database.transaction(async (trx: any) => {
				const run = await loadRun(req, trx);
				if (!run) return { status: 404 as const };
				if (run.status !== 'active') return { status: 409 as const, code: 'RUN_CLOSED' };
				let items: RunItem[] = run.items || [];
				const position = Number(run.position) || 0;
				if (Number(body.position) !== position || !items[position] || items[position]!.result) {
					return { status: 409 as const, code: 'STALE_POSITION', position };
				}
				const item = items[position]!;
				const lessonId = item.lesson_id || run.lesson_id;
				const lessonRow = await trx('listening_lessons as l')
					.join('listening_skills as s', 's.id', 'l.skill_id')
					.join('listening_groups as g', 'g.id', 's.group_id')
					.select('l.id', 'l.text', 'g.answer_mode').where('l.id', lessonId).first();
				const clipRow = await trx('listening_clips').where('id', item.clip_id).first();
				if (!lessonRow || !clipRow) return { status: 409 as const, code: 'CLIP_GONE' };

				const answer = answerOf(clipRow, lessonRow.text, lessonRow.answer_mode);
				const clip: PoolClip = {
					id: clipRow.id, role: clipRow.role, answer, focus: String(clipRow.focus_text || '').trim() || null,
					difficulty: clipRow.difficulty, forced: clipRow.answer_format, hasChoices: true,
				};
				const given = String(body.answer ?? '').slice(0, 255);
				const hint = body.hint === true;
				const correct = !hint && isRight(clip, item.format, given);
				const listens = Math.max(1, Math.min(20, Math.round(Number(body.listens) || 1)));
				items[position] = { ...item, result: { correct, answer: given, listens, slow: body.slow === true, hint } };
				const before = items.length;
				// A missed practice item comes back once; tests and reviews count every answer as given
				if (!correct && run.mode === 'learn') items = withRetry(items, position);

				await trx('listening_runs').where('id', run.id).update({
					items: JSON.stringify(items), position: position + 1, date_updated: trx.fn.now(),
				});
				if (learner.userId) {
					await trx('listening_attempts').insert({
						id: trx.raw('gen_random_uuid()'), user_id: learner.userId, clip_id: item.clip_id, lesson_id: lessonId,
						answer: hint ? '[REVEALED]' : given, is_correct: correct, attempt_number: 1, listen_count: listens,
						mode: 'phrase', run_id: run.id, phase: item.phase, format: item.format,
						used_slow: body.slow === true, used_hint: hint,
						time_ms: Number.isFinite(body.time_ms) ? Math.max(0, Math.min(3_600_000, Math.round(body.time_ms))) : null,
						date_created: trx.fn.now(),
					});
					if (run.mode === 'learn') {
						await trx.raw(`
							INSERT INTO listening_progress (user_id, lesson_id, status, last_run_id) VALUES (?, ?, 'in_progress', ?)
							ON CONFLICT (user_id, lesson_id) DO UPDATE SET last_run_id = EXCLUDED.last_run_id, date_updated = now()
						`, [learner.userId, lessonId, run.id]);
					}
				}
				return {
					status: 200 as const, lessonId: lessonId as string, first: position === 0 && run.mode === 'learn',
					data: {
						correct,
						expected: answer,
						focus: clip.focus,
						position: position + 1,
						total: items.length,
						retry_added: items.length > before,
						done: position + 1 >= items.length,
					},
				};
			});
			if (out.status === 404) return res.status(404).json({ success: false, message: 'Run not found' });
			if (out.status === 409) return res.status(409).json({ success: false, code: out.code, position: (out as any).position });

			// A practice day (the streak); a learner counted once per lesson
			let rewards: any[] = [];
			if (learner.userId) {
				const won = await recordPractice(database, learner.userId, { attempts: 1 });
				rewards = won.rewards;
				await grantRewards(context, req.schema, learner.userId, won.rewards);
			}
			if (out.first && learner.key) await registerLearner(database, out.lessonId, learner.userId, learner.anonymousId).catch(() => false);
			return res.json({ success: true, data: { ...out.data, rewards } });
		} catch (error) {
			return fail(res, 'Answer', error);
		}
	});

	// ── Finish ────────────────────────────────────────────────────────────
	/** Lessons of a rule a learner has done or skipped, kept on their rule progress */
	const refreshSkillProgress = (trx: any, userId: string, skillId: string, patch: Record<string, any> = {}) => trx.raw(`
		INSERT INTO listening_skill_progress (user_id, skill_id, lessons_done, status, mastered_at, last_test_run_id, date_updated)
		SELECT ?, ?, COUNT(*), coalesce(?::varchar, 'learning'), ?::timestamptz, ?::uuid, now()
		FROM listening_progress p JOIN listening_lessons l ON l.id = p.lesson_id
		WHERE p.user_id = ? AND l.skill_id = ? AND p.status IN ('completed', 'tested_out')
		ON CONFLICT (user_id, skill_id) DO UPDATE SET
			lessons_done = EXCLUDED.lessons_done,
			status = CASE WHEN ?::varchar IS NULL THEN listening_skill_progress.status ELSE EXCLUDED.status END,
			mastered_at = coalesce(EXCLUDED.mastered_at, listening_skill_progress.mastered_at),
			last_test_run_id = coalesce(EXCLUDED.last_test_run_id, listening_skill_progress.last_test_run_id),
			date_updated = now()
	`, [userId, skillId, patch.status ?? null, patch.mastered_at ?? null, patch.last_test_run_id ?? null, userId, skillId, patch.status ?? null]);

	/** A lesson skipped by a test: tested out (a lesson already learned stays completed), reviewed in a week */
	const testOut = async (trx: any, userId: string, lessonId: string, runId: string) => {
		await trx.raw(`
			INSERT INTO listening_progress (user_id, lesson_id, status, completed_at, last_run_id, date_updated)
			VALUES (?, ?, 'tested_out', now(), ?, now())
			ON CONFLICT (user_id, lesson_id) DO UPDATE SET
				status = CASE WHEN listening_progress.status = 'completed' THEN 'completed' ELSE 'tested_out' END,
				completed_at = coalesce(listening_progress.completed_at, now()), last_run_id = EXCLUDED.last_run_id, date_updated = now()
		`, [userId, lessonId, runId]);
		await trx.raw(`
			INSERT INTO listening_review_cards (user_id, lesson_id, due, source) VALUES (?, ?, now() + (? || ' days')::interval, 'tested_out')
			ON CONFLICT (user_id, lesson_id) DO NOTHING
		`, [userId, lessonId, REVIEW.testedOutDays]);
	};

	router.post('/listening-lab/runs/:id/finish', async (req: any, res: any) => {
		const learner = learnerOf(req);
		try {
			const closed = await database.transaction(async (trx: any) => {
				const run = await loadRun(req, trx);
				if (!run) return { status: 404 as const };
				const summary = summaryOf(run.items || []);
				if (!summary.finished) return { status: 409 as const, code: 'NOT_FINISHED' };
				let ok = true;
				if (run.mode === 'lesson_test' || run.mode === 'skill_test') {
					const s = await trx('listening_skills').select('pass_ratio').where('id', run.skill_id).first();
					ok = passed(run.items, Number(s?.pass_ratio) || 0.8);
				}
				const first = run.status === 'active';
				if (first) await trx('listening_runs').where('id', run.id).update({ status: 'finished', passed: ok, finished_at: trx.fn.now(), date_updated: trx.fn.now() });
				return { status: 200 as const, run, summary, first, ok: first ? ok : !!run.passed };
			});
			if (closed.status === 404) return res.status(404).json({ success: false, message: 'Run not found' });
			if (closed.status === 409) return res.status(409).json({ success: false, code: closed.code });
			const { run, summary } = closed;
			const mode = run.mode as Mode;
			const items: RunItem[] = run.items || [];

			const xp = { total: 0, kind: null as string | null };
			const coins = { added: 0, missed: 0, balance: null as number | null };
			let rewards: any[] = [];
			const userId = learner.userId;
			const today = vnDay();
			const earn = async (reason: 'lesson' | 'perfect' | 'goal' | 'review', amount: number, dedupe: string, lessonId: string | null = null) => {
				if (!userId) return;
				const r = await earnCoins(database, userId, { reason, amount, dedupe, lessonId }, today);
				coins.added += r.added;
				if (r.wanted > r.added) coins.missed += r.wanted - r.added;
				coins.balance = r.coins;
			};
			const addXp = async (won: { xp: number; rewards: any[]; kind?: string | null }, kind: string | null = null) => {
				xp.total += won.xp;
				xp.kind = won.kind ?? (won.xp ? kind : xp.kind);
				rewards = [...rewards, ...won.rewards];
				if (userId) await grantRewards(context, req.schema, userId, won.rewards);
			};

			if (userId && closed.first) {
				if (mode === 'learn') {
					await database.transaction(async (trx: any) => {
						await trx.raw(`
							INSERT INTO listening_progress (user_id, lesson_id, status, score, completed_at, last_run_id, date_updated)
							VALUES (?, ?, 'completed', ?, now(), ?, now())
							ON CONFLICT (user_id, lesson_id) DO UPDATE SET
								status = 'completed', score = EXCLUDED.score, last_run_id = EXCLUDED.last_run_id,
								completed_at = COALESCE(listening_progress.completed_at, EXCLUDED.completed_at), date_updated = now()
						`, [userId, run.lesson_id, summary.total ? Math.round((summary.right / summary.total) * 100) : null, run.id]);
						// First review of this form tomorrow; a form already in review keeps its schedule
						await trx.raw(`
							INSERT INTO listening_review_cards (user_id, lesson_id, due, source) VALUES (?, ?, now() + interval '1 day', 'learned')
							ON CONFLICT (user_id, lesson_id) DO NOTHING
						`, [userId, run.lesson_id]);
						await refreshSkillProgress(trx, userId, run.skill_id);
					});
					await addXp(await lessonXp(database, userId, run.lesson_id, summary.hinted, today));
					await earn('lesson', COIN.earn.lesson, `lesson:${run.lesson_id}`, run.lesson_id);
					if (summary.perfect) await earn('perfect', COIN.earn.perfect, `perfect:${run.lesson_id}`, run.lesson_id);
				} else if (mode === 'lesson_test' && closed.ok) {
					await database.transaction(async (trx: any) => {
						await testOut(trx, userId, run.lesson_id, run.id);
						await refreshSkillProgress(trx, userId, run.skill_id);
					});
					await addXp(await recordPractice(database, userId, { xp: { reason: 'lesson_test', dedupe: `lesson_test:${run.lesson_id}`, lessonId: run.lesson_id } }, today), 'lesson_test');
				} else if (mode === 'skill_test' && closed.ok) {
					const g = await loadLessonGraph(req, context);
					const open = (g.lessonsBySkill.get(run.skill_id) || []).filter((l) => !g.isLocked(l));
					// Every lesson learned before: the final test makes the rule mastered; else it was skipped
					const learnedAll = open.every((l) => g.done.has(l.id) && !g.testedOut.has(l.id));
					await database.transaction(async (trx: any) => {
						for (const l of open) await testOut(trx, userId, l.id, run.id);
						await refreshSkillProgress(trx, userId, run.skill_id, { status: learnedAll ? 'mastered' : 'tested_out', mastered_at: new Date().toISOString(), last_test_run_id: run.id });
					});
					await addXp(await recordPractice(database, userId, { xp: { reason: 'skill_test', dedupe: `skill_test:${run.skill_id}` } }, today), 'skill_test');
				} else if (mode === 'review') {
					const answered = items.filter((it) => it.result && it.lesson_id);
					const skills = new Set<string>();
					await database.transaction(async (trx: any) => {
						for (const it of answered) {
							const card = await trx('listening_review_cards').where({ user_id: userId, lesson_id: it.lesson_id }).forUpdate().first();
							const next = cardColumns(schedule(card || null, gradeOf(it.result!)));
							await trx('listening_review_cards').insert({ user_id: userId, lesson_id: it.lesson_id, ...next, source: card?.source || 'learned' })
								.onConflict(['user_id', 'lesson_id']).merge(next);
							const l = await trx('listening_lessons').select('skill_id').where('id', it.lesson_id).first();
							if (l?.skill_id) skills.add(l.skill_id);
						}
						await trx.raw(`
							INSERT INTO user_daily_stats (user_id, day, reviews) VALUES (?, ?, ?)
							ON CONFLICT (user_id, day) DO UPDATE SET reviews = user_daily_stats.reviews + EXCLUDED.reviews
						`, [userId, today, answered.length]);
						// The rule's bar: how well its forms are held now
						for (const skillId of skills) {
							const cards = await trx('listening_review_cards as c').join('listening_lessons as l', 'l.id', 'c.lesson_id')
								.select('c.*').where({ 'c.user_id': userId, 'l.skill_id': skillId });
							await trx.raw(`
								INSERT INTO listening_skill_progress (user_id, skill_id, mastery, date_updated) VALUES (?, ?, ?, now())
								ON CONFLICT (user_id, skill_id) DO UPDATE SET mastery = EXCLUDED.mastery, date_updated = now()
							`, [userId, skillId, masteryOf(cards)]);
						}
					});
					for (const [i, it] of items.entries()) {
						if (it.result?.correct) await addXp(await recordPractice(database, userId, { xp: { reason: 'review', dedupe: `review:${run.id}:${i}` } }, today), 'review');
					}
					await earn('review', COIN.earn.review, `review:${run.id}`);
				}
				// Today's goal reached: a coin bonus once a day
				const [day, user] = await Promise.all([
					database('user_daily_stats').select('xp').where({ user_id: userId, day: today }).first(),
					database('directus_users').select('daily_goal').where('id', userId).first(),
				]);
				if ((Number(day?.xp) || 0) >= (Number(user?.daily_goal) || DEFAULT_GOAL)) await earn('goal', COIN.earn.goal, `goal:${today}`);
			}

			const g = await loadLessonGraph(req, context);
			// "Listen again to the first one you missed" (lessons); the forms to work on (failed tests)
			let firstWrong = null;
			if (mode === 'learn' && summary.first_wrong !== null) {
				const lesson = g.lessonById.get(run.lesson_id);
				if (lesson) firstWrong = (await poolOf(database, g, lesson)).payload(items[summary.first_wrong]!, summary.first_wrong);
			}
			let weakest: any[] = [];
			if ((mode === 'lesson_test' || mode === 'skill_test') && !closed.ok) {
				const trs = await lessonTranslations(database, weakestForms(items).map((w) => w.lessonId));
				weakest = weakestForms(items).slice(0, 3).flatMap((w) => {
					const l = g.lessonById.get(w.lessonId);
					if (!l) return [];
					const tr = (trs.get(l.id) || []).find((t: any) => t.title) as any;
					return [{ short_id: l.short_id, number: g.numberOf(l), title: tr?.title || null, missed: w.missed }];
				});
			}
			const skill = run.skill_id ? g.skillById.get(run.skill_id) : null;
			return res.json({
				success: true,
				data: {
					mode, summary, passed: closed.ok, first_wrong: firstWrong, weakest, xp, coins, rewards,
					skill: skill ? { slug: skill.slug, name: skill.name } : null,
				},
			});
		} catch (error) {
			return fail(res, 'Finish run', error);
		}
	});

	// ── Xu ────────────────────────────────────────────────────────────────
	router.get('/listening-lab/wallet', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.json({ success: true, data: null });
		try {
			return res.json({ success: true, data: await walletOf(database, userId, MAX_FREEZES) });
		} catch (error) {
			return fail(res, 'Wallet', error);
		}
	});

	router.post('/listening-lab/lessons/:key/unlock', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const key = String(req.params.key || '');
		if (badKey(key)) return res.status(400).json({ success: false, message: 'Invalid lesson key' });
		try {
			const g = await loadLessonGraph(req, context);
			const lesson = g.findLesson(key);
			if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
			if (!g.isLocked(lesson)) return res.status(409).json({ success: false, code: 'NOT_LOCKED' });
			const paid = await unlockLesson(database, userId, lesson);
			return res.json({ success: true, data: { price: paid.price, wallet: await walletOf(database, userId, MAX_FREEZES) } });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Unlock lesson', error);
		}
	});

	router.post('/listening-lab/wallet/freeze', async (req: any, res: any) => {
		const userId = req.accountability?.user ?? null;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		try {
			await buyFreeze(database, userId, MAX_FREEZES);
			return res.json({ success: true, data: await walletOf(database, userId, MAX_FREEZES) });
		} catch (error) {
			if (error instanceof CoinError) return coinFail(res, error);
			return fail(res, 'Buy freeze', error);
		}
	});
}

