/**
 * Sự thật hay Thử thách: one card a day (web repo docs/xu-v2-backend.md mục 5).
 *
 * The rules are the database's: card_draws has one row per learner per day, and one open row per
 * learner (a dare not done), so two requests at once cannot draw twice. pickCard / matches are pure.
 *
 *   truth  a question made from the library, graded by the server, one try, pays when right
 *   dare   a goal over many answers (50 right, 10 hard ones...), no expiry; while one is open there is no new card
 */
import { COIN, CoinError, earnCoins, lockPurse, spend } from './coins';
import { giveItem, openChest, secureRand, type Rand } from './chests';
import { vnDay } from './days';
import { levelOf } from './xp';
import { BASE_LANG } from './extensive';

export const SLOTS = 3;
/** Difficulty rolled: easy 45%, medium 30%, hard 20%, very hard 5% */
export const DIFFICULTY_WEIGHTS = [45, 30, 20, 5];
const HIDDEN_ONE_IN = 100;
const RECENT_TYPES = 5;

export type CardRow = { id: string; kind: 'truth' | 'dare'; type: string; difficulty: number; level_min: number | null; level_max: number | null; weight: number; hidden: boolean; source?: any; goal?: any; reward: any };

export function pickDifficulty(rand: Rand) {
	const total = DIFFICULTY_WEIGHTS.reduce((a, b) => a + b, 0);
	let at = rand(total);
	for (let i = 0; i < DIFFICULTY_WEIGHTS.length; i++) {
		if (at < DIFFICULTY_WEIGHTS[i]!) return i + 1;
		at -= DIFFICULTY_WEIGHTS[i]!;
	}
	return 1;
}

/**
 * Which card: only those whose level range fits the learner, a hidden card about 1 time in 100, the
 * difficulty rolled (the nearest one that has cards when none does), types seen in the last draws left
 * out while others remain, then by weight.
 */
export function pickCard(a: { cards: CardRow[]; level: number; recentTypes: string[]; rand: Rand }): CardRow | null {
	let pool = a.cards.filter((c) => (c.level_min == null || a.level >= c.level_min) && (c.level_max == null || a.level <= c.level_max));
	if (!pool.length) pool = a.cards;
	const hidden = pool.filter((c) => c.hidden);
	pool = hidden.length && a.rand(HIDDEN_ONE_IN) === 0 ? hidden : pool.filter((c) => !c.hidden);
	if (!pool.length) return null;
	const want = pickDifficulty(a.rand);
	const nearest = [...new Set(pool.map((c) => c.difficulty))].sort((x, y) => Math.abs(x - want) - Math.abs(y - want) || x - y)[0]!;
	let level = pool.filter((c) => c.difficulty === nearest);
	const fresh = level.filter((c) => !a.recentTypes.includes(c.type));
	if (fresh.length) level = fresh;
	else {
		const anyFresh = pool.filter((c) => !a.recentTypes.includes(c.type));
		if (anyFresh.length) level = anyFresh;
	}
	const total = level.reduce((n, c) => n + Math.max(1, c.weight), 0);
	let at = a.rand(total);
	for (const c of level) {
		if (at < Math.max(1, c.weight)) return c;
		at -= Math.max(1, c.weight);
	}
	return level[0] || null;
}

// ── Thử thách: what counts toward the goal ─────────────────────────────────────────────────────
export type AnswerEv = { correct: boolean; hint: boolean; phase: string; difficulty: number | null; listens: number; star: 'right' | 'wrong' | 'void' | null };
type Filter = { difficulty?: number; listens?: number } | undefined;
const filterOk = (f: Filter, ev: AnswerEv) => !f || ((!f.difficulty || ev.difficulty === f.difficulty) && (!f.listens || ev.listens <= f.listens));
/** One function per goal metric: add a metric by adding one here */
export const METRICS: Record<string, (goal: any, ev: AnswerEv) => boolean> = {
	correct: (g, ev) => ev.correct && !ev.hint && filterOk(g.filter, ev),
	star_right: (_g, ev) => ev.star === 'right',
};
export const matches = (goal: any, ev: AnswerEv) => !!goal && !!METRICS[goal.metric] && METRICS[goal.metric]!(goal, ev);

// ── Sự thật: questions made from the library ───────────────────────────────────────────────────
const WORD = /[A-Za-z']{5,}/g;
function shuffle<T>(list: T[], rand: Rand) {
	const a = [...list];
	for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
	return a;
}

/** "gap_pick": a sentence with one word hidden, three words to pick from; made from a published clip */
export type GapOpts = { difficulty?: [number, number]; exclude?: string[]; ruled?: boolean; maxSeconds?: number };
export async function buildGap(db: any, rand: Rand = secureRand, opts: GapOpts = {}) {
	const base = () => {
		const q = db('listening_clips as c').join('source_videos as sv', 'sv.id', 'c.source_video_id')
			.where('c.status', 'published').whereNotNull('c.transcript').whereNotNull('c.start_time').whereNotNull('c.end_time').whereNotNull('sv.youtube_video_id')
			.whereRaw('char_length(c.transcript) BETWEEN 30 AND 140').whereRaw('(c.end_time - c.start_time) BETWEEN 1.5 AND ?', [opts.maxSeconds ?? 14]);
		return q;
	};
	/** The wanted clips (level, rule clips, not seen); when too few, the same without the narrowing */
	const pool = (strict: boolean) => {
		const q = base();
		if (strict && opts.difficulty) q.whereBetween('c.difficulty', opts.difficulty);
		if (strict && opts.ruled) q.whereNotNull('c.difficulty');
		if (strict && opts.exclude?.length) q.whereNotIn('c.id', opts.exclude);
		return q;
	};
	const narrow = !!(opts.difficulty || opts.ruled || opts.exclude?.length) && Number((await pool(true).count('* as n').first())?.n) >= 5;
	for (let i = 0; i < 6; i++) {
		const clip = await pool(narrow).select('c.id', 'c.transcript', 'c.start_time', 'c.end_time', 'sv.youtube_video_id').orderByRaw('random()').first();
		if (!clip) return null;
		const words: string[] = String(clip.transcript).match(WORD) || [];
		if (!words.length) continue;
		const target = words[rand(words.length)]!;
		const others = await base().whereNot('c.id', clip.id).select('c.transcript').orderByRaw('random()').limit(40);
		const near = new Set<string>();
		for (const o of others) for (const w of (String(o.transcript).match(WORD) || [])) {
			if (w.toLowerCase() !== target.toLowerCase() && Math.abs(w.length - target.length) <= 2) near.add(w);
		}
		const picks = shuffle([...near], rand).slice(0, 2);
		if (picks.length < 2) continue;
		const options = shuffle([target, ...picks], rand);
		const at = String(clip.transcript).indexOf(target);
		const blank = String(clip.transcript).slice(0, at) + '_____' + String(clip.transcript).slice(at + target.length);
		return { clip_id: clip.id as string, blank, options, correct: options.indexOf(target), word: target, video_id: clip.youtube_video_id as string, start: Number(clip.start_time), end: Number(clip.end_time) };
	}
	return null;
}

export class CardError extends Error {
	constructor(public code: 'CARDS_OFF' | 'CARD_OPEN' | 'DRAWN_TODAY' | 'NO_CARD' | 'NO_OPEN' | 'NOT_ENOUGH' | 'BAD_REQUEST' | 'NOT_READY' | 'ALREADY') { super(code); }
}

const rewardView = (r: any) => (r && typeof r === 'object' ? r : {});

/**
 * Pay a card's reward once (the draw id is the key): { coins }, { item } (into the bag) or { chest } (opened
 * for free). Returns what was given.
 */
export async function payReward(trx: any, userId: string, drawId: string, reward: any, o: { today: string }) {
	const out: { coins: number; item: string | null; chest: any | null } = { coins: 0, item: null, chest: null };
	if (reward?.coins) {
		const r = await earnCoins(trx, userId, { reason: 'card', amount: Number(reward.coins), dedupe: `card:${drawId}`, meta: { card_draw_id: drawId } }, o.today);
		out.coins = r.added;
	}
	if (reward?.item) {
		const it = await trx('items').where('code', reward.item).first();
		if (it) { await giveItem(trx, userId, it, { source: 'card', sourceId: drawId, key: `card:${drawId}`, today: o.today }); out.item = it.code; }
	}
	if (reward?.chest) {
		out.chest = await openChest(trx, userId, String(reward.chest), drawId, { free: true, today: o.today });
	}
	return out;
}

/** What the learner sees of a draw: a truth without its answer until it is answered */
export async function drawView(db: any, d: any, lang: string) {
	const card = await db('cards').where('id', d.card_id).first();
	const reward = rewardView(card?.reward);
	const base: any = { id: d.id, day: typeof d.day === 'string' ? d.day : new Date(d.day).toISOString().slice(0, 10), kind: d.kind, type: card?.type, difficulty: card?.difficulty, status: d.status, reward };
	if (d.kind === 'dare') {
		const tr = (await db('card_translations').where('card_id', d.card_id).whereIn('lang', [lang, BASE_LANG]).select('lang', 'title', 'body')) as any[];
		const t = tr.find((x) => x.lang === lang) || tr.find((x) => x.lang === BASE_LANG);
		return { ...base, title: t?.title || '', body: t?.body || '', progress: Number(d.progress) || 0, goal_n: Number(d.goal_n) || 0 };
	}
	const answered = d.status === 'done' || d.correct !== null;
	if (card?.type === 'explore') {
		const dyk = await db('dyk_cards').where('id', card.source?.dyk_card_id).first();
		if (!dyk) return { ...base, broken: true };
		const tr = lang === BASE_LANG ? new Map() : new Map<string, string>((await db('dyk_translations').select('key', 'text').where({ card_id: dyk.id, lang })).map((r: any) => [r.key, r.text]));
		const say = (k: string, b: string) => tr.get(k) || b;
		return {
			...base, hook: say('hook', dyk.hook), question: say('question', dyk.question), options: (dyk.options as string[]).map((o, i) => say(`option${i}`, o)),
			video: { id: dyk.youtube_video_id, start: Number(dyk.clip_start), end: Number(dyk.clip_end) },
			answered, correct: answered ? d.correct : null, ...(answered ? { correct_index: dyk.correct, answer: say('answer', dyk.answer) } : {}),
		};
	}
	const p = d.payload || {};
	return {
		...base, question: p.blank, options: p.options, video: { id: p.video_id, start: p.start, end: p.end },
		answered, correct: answered ? d.correct : null, ...(answered ? { correct_index: p.correct, answer: p.word } : {}),
	};
}

/** The block on the Listening Lab page: today's draw, an open dare, whether a card can be drawn, the way back */
export async function cardsState(db: any, userId: string, lang: string, today = vnDay()) {
	await db('card_draws').where({ user_id: userId, kind: 'truth', status: 'open' }).where('day', '<', today).update({ status: 'skipped' });
	const open = await db('card_draws').where({ user_id: userId, status: 'open' }).first();
	const todays = await db('card_draws').where({ user_id: userId, day: today }).first();
	const draw = open || todays || null;
	const purse = await db('user_xp').select('coins').where('user_id', userId).first();
	const rec = await db('recovery_progress').where({ user_id: userId, day: today }).first();
	const coins = Number(purse?.coins) || 0;
	return {
		slots: SLOTS,
		can_draw: !open && !todays,
		draw: draw ? await drawView(db, draw, lang) : null,
		skip_price: COIN.card.skip,
		recovery: { low: coins < COIN.recovery.below, below: COIN.recovery.below, need: COIN.recovery.need, prize: COIN.recovery.prize, n: Number(rec?.n) || 0, claimed: !!rec?.claimed },
	};
}

export async function drawCard(db: any, userId: string, o: { kind: 'truth' | 'dare'; pick: number; lang: string; rand?: Rand; today?: string }) {
	if (o.kind !== 'truth' && o.kind !== 'dare') throw new CardError('BAD_REQUEST');
	if (!Number.isInteger(o.pick) || o.pick < 0 || o.pick >= SLOTS) throw new CardError('BAD_REQUEST');
	const rand = o.rand || secureRand;
	const today = o.today || vnDay();
	const id = await db.transaction(async (trx: any) => {
		const purse = await lockPurse(trx, userId);
		await trx('card_draws').where({ user_id: userId, kind: 'truth', status: 'open' }).where('day', '<', today).update({ status: 'skipped' });
		if (await trx('card_draws').where({ user_id: userId, status: 'open' }).first('id')) throw new CardError('CARD_OPEN');
		if (await trx('card_draws').where({ user_id: userId, day: today }).first('id')) throw new CardError('DRAWN_TODAY');
		const recent = await trx('card_draws as d').join('cards as c', 'c.id', 'd.card_id').where('d.user_id', userId).orderBy('d.created_at', 'desc').limit(RECENT_TYPES).pluck('c.type');
		const cards: CardRow[] = await trx('cards').where({ kind: o.kind, status: 'approved' }).select('id', 'kind', 'type', 'difficulty', 'level_min', 'level_max', 'weight', 'hidden', 'source', 'goal', 'reward');
		const level = levelOf(Number(purse.xp_total) || 0).level;
		const card = pickCard({ cards, level, recentTypes: recent, rand });
		if (!card) throw new CardError('NO_CARD');
		let payload: any = null;
		if (card.type === 'gap_pick') {
			payload = await buildGap(trx, rand);
			if (!payload) throw new CardError('NO_CARD');
		} else if (card.type === 'explore') {
			const dyk = card.source?.dyk_card_id ? await trx('dyk_cards').where({ id: card.source.dyk_card_id, status: 'approved' }).first('id') : null;
			if (!dyk) throw new CardError('NO_CARD');
		}
		const [row] = await trx('card_draws').insert({ user_id: userId, day: today, card_id: card.id, kind: card.kind, goal_n: card.kind === 'dare' ? Number(card.goal?.n) || null : null, payload: payload ? JSON.stringify(payload) : null }).returning('id');
		return row.id ?? row;
	});
	const d = await db('card_draws').where('id', id).first();
	return drawView(db, d, o.lang);
}

export async function answerTruth(db: any, userId: string, o: { choice: number; lang: string; today?: string }) {
	const today = o.today || vnDay();
	const done = await db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		const d = await trx('card_draws').where({ user_id: userId, kind: 'truth', day: today }).forUpdate().first();
		if (!d || d.status !== 'open') throw new CardError(d ? 'ALREADY' : 'NO_OPEN');
		const card = await trx('cards').where('id', d.card_id).first();
		let right = -1;
		if (card.type === 'explore') right = Number((await trx('dyk_cards').where('id', card.source?.dyk_card_id).first('correct'))?.correct);
		else right = Number(d.payload?.correct);
		if (!Number.isInteger(o.choice) || o.choice < 0 || o.choice > 2) throw new CardError('BAD_REQUEST');
		const correct = o.choice === right;
		await trx('card_draws').where('id', d.id).update({ status: 'done', correct, done_at: trx.fn.now() });
		const paid = correct ? await payReward(trx, userId, d.id, card.reward, { today }) : null;
		return { id: d.id as string, correct, paid };
	});
	return { ...done, view: await drawView(db, await db('card_draws').where('id', done.id).first(), o.lang) };
}

/** Leave a dare for Kim cương (the price is COIN.card.skip): it is closed, the day's draw stays used */
export async function skipDare(db: any, userId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		const d = await trx('card_draws').where({ user_id: userId, kind: 'dare', status: 'open' }).forUpdate().first();
		if (!d) throw new CardError('NO_OPEN');
		const price = COIN.card.skip;
		if (price > 0) {
			try { await spend(trx, userId, price, 'card_skip', `card_skip:${d.id}`, null, today, { card_draw_id: d.id }); }
			catch (e) { if (e instanceof CoinError && e.code === 'NOT_ENOUGH') throw new CardError('NOT_ENOUGH'); throw e; }
		}
		await trx('card_draws').where('id', d.id).update({ status: 'skipped', done_at: trx.fn.now() });
		return { price };
	});
}

/**
 * Every answer of the Listening Lab goes through here (after the answer is saved): a dare open counts it when it
 * fits the goal, and a learner low on Kim cương counts toward the way back (right answers in a free lesson).
 */
export async function onAnswer(db: any, userId: string, ev: AnswerEv, ctx: { freeLesson: boolean }, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		const result: { dare: null | { progress: number; goal_n: number; done: boolean; paid?: any } } = { dare: null };
		const d = await trx('card_draws as d').join('cards as c', 'c.id', 'd.card_id')
			.where({ 'd.user_id': userId, 'd.status': 'open', 'd.kind': 'dare' }).select('d.id', 'd.progress', 'd.goal_n', 'c.goal', 'c.reward').forUpdate('d').first();
		if (d && matches(d.goal, ev)) {
			const progress = Number(d.progress) + 1;
			const goal = Number(d.goal_n) || Number(d.goal?.n) || 1;
			const done = progress >= goal;
			await trx('card_draws').where('id', d.id).update(done ? { progress, status: 'done', correct: true, done_at: trx.fn.now() } : { progress });
			const paid = done ? await payReward(trx, userId, d.id, d.reward, { today }) : undefined;
			result.dare = { progress, goal_n: goal, done, paid };
		}
		if (ev.correct && !ev.hint && ctx.freeLesson) {
			const purse = await trx('user_xp').select('coins').where('user_id', userId).first();
			if ((Number(purse?.coins) || 0) < COIN.recovery.below) {
				await trx('recovery_progress').insert({ user_id: userId, day: today, n: 1 }).onConflict(['user_id', 'day']).merge({ n: trx.raw('LEAST(recovery_progress.n + 1, ?)', [COIN.recovery.need]) });
			}
		}
		return result;
	});
}

/** Take the prize of the way back: enough right answers in free lessons today, once a day */
export async function claimRecovery(db: any, userId: string, today = vnDay()) {
	return db.transaction(async (trx: any) => {
		await lockPurse(trx, userId);
		const r = await trx('recovery_progress').where({ user_id: userId, day: today }).forUpdate().first();
		if (!r || Number(r.n) < COIN.recovery.need) throw new CardError('NOT_READY');
		if (r.claimed) throw new CardError('ALREADY');
		const paid = await earnCoins(trx, userId, { reason: 'recovery', amount: COIN.recovery.prize, dedupe: `recovery:${today}` }, today);
		await trx('recovery_progress').where({ user_id: userId, day: today }).update({ claimed: true });
		return { added: paid.added, balance: paid.coins };
	});
}
