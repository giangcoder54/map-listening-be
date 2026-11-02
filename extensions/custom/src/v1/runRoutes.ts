/**
 * Lesson runs and Xu (lib/runs.ts, lib/coins.ts, database/migrations/2026-11-02_rule_flow.sql).
 *
 *   POST /listening-lab/lessons/:key/runs     start a run of the lesson, or resume the one going on
 *                                             body: { anonymous_id?, restart? }
 *   POST /listening-lab/runs/:id/answer       answer the current item: the server checks it
 *                                             body: { position, answer, listens, slow, hint, time_ms, anonymous_id? }
 *   POST /listening-lab/runs/:id/finish       every item answered: progress, review card, XP and Xu
 *   GET  /listening-lab/wallet                Xu, freezes, unlocks left this week, prices
 *   POST /listening-lab/lessons/:key/unlock   buy a locked lesson with Xu (kept for good)
 *   POST /listening-lab/wallet/freeze         buy a streak freeze with Xu
 *
 * Guests play runs too (learner key a:<anonymous_id>): nothing is saved for them but the run.
 * Locked lesson: 403 PREMIUM_REQUIRED with its Xu price.
 */
import { UUID_RE, answerOf, loadLessonGraph, type LessonGraph, type LessonRow } from '../lib/lessons';
import { RUN, drawLesson, isRight, summaryOf, withRetry, type PoolClip, type RunItem } from '../lib/runs';
import { COIN, CoinError, buyFreeze, earnCoins, unlockLesson, walletOf } from '../lib/coins';
import { MAX_FREEZES, grantRewards, lessonXp, recordPractice, vnDay, DEFAULT_GOAL } from '../lib/xp';
import { choicesOf, clipOut, readClips, registerLearner } from './lessonRoutes';
import { normalizeAnswer } from './engagementRoutes';

const ANON_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const badKey = (key: string) => !key || key.length > 64;

function learnerOf(req: any) {
	const userId: string | null = req.accountability?.user ?? null;
	const raw = req.body?.anonymous_id ?? req.query?.anonymous_id;
	const anonymousId = typeof raw === 'string' && ANON_ID_RE.test(raw) ? raw : null;
	const key = userId ? `u:${userId}` : anonymousId ? `a:${anonymousId}` : null;
	return { userId, anonymousId, key };
}

/** The lesson's clips as drawing sees them, and the payload the page plays */
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
				// The part with the rule: blanked (gap) or tapped (tap), highlighted when missed
				focus: clip.focus,
			},
		};
	};
	return { byId, payload };
}

function runOut(run: any, payload: (item: RunItem, i: number) => any) {
	const items: RunItem[] = run.items || [];
	return {
		id: run.id,
		mode: run.mode,
		status: run.status,
		position: Number(run.position) || 0,
		max_listens: RUN.maxListens,
		items: items.map((it, i) => payload(it, i)).filter(Boolean),
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

	/** The run, its lesson and the lesson graph; null when it is not this learner's */
	async function loadRun(req: any, trx: any = database) {
		const id = String(req.params.id || '');
		if (!UUID_RE.test(id)) return null;
		const { key } = learnerOf(req);
		const run = await trx('listening_runs').where('id', id).forUpdate().first();
		if (!run || !key || run.learner_key !== key) return null;
		return run;
	}

	// ── Start or resume ───────────────────────────────────────────────────
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
			const { byId, payload } = await poolOf(database, g, lesson);

			const run = await database.transaction(async (trx: any) => {
				const active = await trx('listening_runs')
					.where({ learner_key: learner.key, lesson_id: lesson.id, status: 'active', mode: 'learn' })
					.orderBy('started_at', 'desc').forUpdate().first();
				// A run whose clips were since removed cannot go on: start again
				const stale = active && (active.items as RunItem[]).some((it) => !byId.has(it.clip_id));
				if (active && !req.body?.restart && !stale) return active;
				if (active) await trx('listening_runs').where('id', active.id).update({ status: 'abandoned', date_updated: trx.fn.now() });

				const met = new Set<string>();
				if (learner.userId && byId.size) {
					const rows = await trx('listening_attempts').distinct('clip_id').where('user_id', learner.userId).whereIn('clip_id', [...byId.keys()]);
					for (const r of rows) met.add(r.clip_id);
				}
				const items = drawLesson([...byId.values()].map((x) => x.clip), met);
				if (!items.length) return null;
				const [row] = await trx('listening_runs').insert({
					user_id: learner.userId, learner_key: learner.key, mode: 'learn',
					skill_id: lesson.skill_id, lesson_id: lesson.id, items: JSON.stringify(items),
				}).returning('*');
				return row;
			});
			if (!run) return res.status(409).json({ success: false, code: 'EMPTY_LESSON', message: 'This lesson has no clip to play yet' });
			return res.json({ success: true, data: runOut(run, payload) });
		} catch (error) {
			return fail(res, 'Start run', error);
		}
	});

	// ── Answer the current item ───────────────────────────────────────────
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
				const lessonRow = await trx('listening_lessons as l')
					.join('listening_skills as s', 's.id', 'l.skill_id')
					.join('listening_groups as g', 'g.id', 's.group_id')
					.select('l.id', 'l.text', 'g.answer_mode').where('l.id', run.lesson_id).first();
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
				if (!correct) items = withRetry(items, position);

				await trx('listening_runs').where('id', run.id).update({
					items: JSON.stringify(items), position: position + 1, date_updated: trx.fn.now(),
				});
				if (learner.userId) {
					await trx('listening_attempts').insert({
						id: trx.raw('gen_random_uuid()'), user_id: learner.userId, clip_id: item.clip_id, lesson_id: run.lesson_id,
						answer: hint ? '[REVEALED]' : given, is_correct: correct, attempt_number: 1, listen_count: listens,
						mode: 'phrase', run_id: run.id, phase: item.phase, format: item.format,
						used_slow: body.slow === true, used_hint: hint,
						time_ms: Number.isFinite(body.time_ms) ? Math.max(0, Math.min(3_600_000, Math.round(body.time_ms))) : null,
						date_created: trx.fn.now(),
					});
					await trx.raw(`
						INSERT INTO listening_progress (user_id, lesson_id, status, last_run_id) VALUES (?, ?, 'in_progress', ?)
						ON CONFLICT (user_id, lesson_id) DO UPDATE SET last_run_id = EXCLUDED.last_run_id, date_updated = now()
					`, [learner.userId, run.lesson_id, run.id]);
				}
				return {
					status: 200 as const, lessonId: run.lesson_id as string, first: position === 0,
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

			// A practice day (the streak); counted once per learner per lesson
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
	router.post('/listening-lab/runs/:id/finish', async (req: any, res: any) => {
		const learner = learnerOf(req);
		try {
			const closed = await database.transaction(async (trx: any) => {
				const run = await loadRun(req, trx);
				if (!run) return { status: 404 as const };
				const summary = summaryOf(run.items || []);
				if (!summary.finished) return { status: 409 as const, code: 'NOT_FINISHED' };
				const first = run.status === 'active';
				if (first) await trx('listening_runs').where('id', run.id).update({ status: 'finished', passed: true, finished_at: trx.fn.now(), date_updated: trx.fn.now() });
				return { status: 200 as const, run, summary, first };
			});
			if (closed.status === 404) return res.status(404).json({ success: false, message: 'Run not found' });
			if (closed.status === 409) return res.status(409).json({ success: false, code: closed.code });
			const { run, summary } = closed;

			const xp = { total: 0, kind: null as string | null };
			const coins = { added: 0, missed: 0, balance: null as number | null };
			let rewards: any[] = [];
			if (learner.userId && closed.first) {
				const userId = learner.userId;
				const today = vnDay();
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
					await trx.raw(`
						INSERT INTO listening_skill_progress (user_id, skill_id, lessons_done, date_updated)
						SELECT ?, ?, COUNT(*), now() FROM listening_progress p JOIN listening_lessons l ON l.id = p.lesson_id
						WHERE p.user_id = ? AND l.skill_id = ? AND p.status IN ('completed', 'tested_out')
						ON CONFLICT (user_id, skill_id) DO UPDATE SET lessons_done = EXCLUDED.lessons_done, date_updated = now()
					`, [userId, run.skill_id, userId, run.skill_id]);
				});

				const won = await lessonXp(database, userId, run.lesson_id, summary.hinted, today);
				xp.total = won.xp;
				xp.kind = won.kind;
				rewards = won.rewards;
				await grantRewards(context, req.schema, userId, won.rewards);

				const earn = async (reason: 'lesson' | 'perfect' | 'goal', amount: number, dedupe: string) => {
					const r = await earnCoins(database, userId, { reason, amount, dedupe, lessonId: run.lesson_id }, today);
					coins.added += r.added;
					if (r.wanted > r.added) coins.missed += r.wanted - r.added;
					coins.balance = r.coins;
				};
				await earn('lesson', COIN.earn.lesson, `lesson:${run.lesson_id}`);
				if (summary.perfect) await earn('perfect', COIN.earn.perfect, `perfect:${run.lesson_id}`);
				const [day, user] = await Promise.all([
					database('user_daily_stats').select('xp').where({ user_id: userId, day: today }).first(),
					database('directus_users').select('daily_goal').where('id', userId).first(),
				]);
				if ((Number(day?.xp) || 0) >= (Number(user?.daily_goal) || DEFAULT_GOAL)) await earn('goal', COIN.earn.goal, `goal:${today}`);
			}

			// "Listen again to the first one you missed"
			let firstWrong = null;
			if (summary.first_wrong !== null) {
				const g = await loadLessonGraph(req, context);
				const lesson = g.lessonById.get(run.lesson_id);
				if (lesson) firstWrong = (await poolOf(database, g, lesson)).payload(run.items[summary.first_wrong], summary.first_wrong);
			}
			return res.json({ success: true, data: { summary, first_wrong: firstWrong, xp, coins, rewards } });
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
