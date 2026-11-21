/**
 * "For you": which lessons to suggest on the Extensive / Intensive lobbies.
 *
 * Each learner has, per topic, a Beta(a, b) of "likes this topic":
 *   a = 1 + REC.pickPrior if the learner picked the topic + lessons of that topic finished
 *   b = 1 + lessons of that topic started and left (never finished)
 * Old events count less (half-life REC.halfLifeDays), so the picks are only a start and what the learner
 * does takes over. Extensive and Intensive feed the same interest.
 *
 * Each request draws one sample per topic (Thompson sampling): a topic with little data sometimes draws
 * high and gets a turn, a topic the learner keeps leaving sinks. The row is then
 *   - "interest": lessons of my topics, by the sample x Level fit x how often others finish the lesson
 *   - "explore":  about 1 in 4 cards from topics outside mine, the lessons others finish most (what is
 *                 good for most people, as TikTok's explore items are), one per topic
 * with at most REC.maxPerTopic cards of one topic. Guests send their picks (?topics=); nothing else is known.
 */
import { EFFECTIVE } from './videoTags';

export const REC = {
	pickPrior: 2,
	halfLifeDays: 30,
	/** An attempt not finished this long after it started counts as left */
	leftAfterHours: 2,
	/** Posterior mean that makes a topic "mine" without a pick, and the evidence it needs */
	mineMean: 0.6,
	mineMinA: 2.5,
	exploreShare: 0.25,
	maxPerTopic: 2,
};

export const TOPIC_RE = /^[a-z_]{2,40}$/;

/** The lesson's topic: the lesson's own, else its video's (manual -> ai -> channel), as in the video library */
export const lessonTopicSql = (alias = 'l') => `COALESCE(${alias}.topic, ${EFFECTIVE.topic})`;
/** Joins that lessonTopicSql needs (t = video_tags, ct = channel_tags), after a join on source_videos sv */
export const TOPIC_JOINS = 'LEFT JOIN video_tags t ON t.source_video_id = sv.id LEFT JOIN channel_tags ct ON ct.channel_name = sv.channel_name';

export type Interest = Map<string, { a: number; b: number; picked: boolean }>;

/** ?topics=a,b from a guest, only well-formed codes */
export const topicsParam = (v: unknown): string[] => String(v ?? '').split(',').map((s) => s.trim()).filter((s) => TOPIC_RE.test(s)).slice(0, 20);

export async function interestOf(database: any, userId: string | null, guestPicks: string[] = []): Promise<Interest> {
	const out: Interest = new Map();
	const at = (topic: string) => {
		if (!out.has(topic)) out.set(topic, { a: 1, b: 1, picked: false });
		return out.get(topic)!;
	};
	const picks = userId ? (await database('user_topic_prefs').where('user_id', userId).pluck('topic')) as string[] : guestPicks;
	for (const p of picks) { const x = at(p); x.picked = true; x.a += REC.pickPrior; }
	if (!userId) return out;

	const left = `${Number(REC.leftAfterHours)} hours`;
	const { rows } = await database.raw(`
		WITH ev AS (
			SELECT l.topic AS topic, a.finished_at IS NOT NULL AS fin, coalesce(a.finished_at, a.date_created) AS at
			FROM el_attempts a JOIN el_lessons l ON l.id = a.lesson_id
			WHERE a.user_id = ? AND (a.finished_at IS NOT NULL OR (a.date_created < now() - interval '${left}'
				AND NOT EXISTS (SELECT 1 FROM el_attempts b WHERE b.user_id = a.user_id AND b.lesson_id = a.lesson_id AND b.finished_at IS NOT NULL)))
			UNION ALL
			SELECT ${lessonTopicSql('l')}, a.finished_at IS NOT NULL, coalesce(a.finished_at, a.date_created)
			FROM il_attempts a JOIN il_lessons l ON l.id = a.lesson_id JOIN source_videos sv ON sv.id = l.source_video_id ${TOPIC_JOINS}
			WHERE a.user_id = ? AND (a.finished_at IS NOT NULL OR (a.date_created < now() - interval '${left}'
				AND NOT EXISTS (SELECT 1 FROM il_attempts b WHERE b.user_id = a.user_id AND b.lesson_id = a.lesson_id AND b.finished_at IS NOT NULL)))
		)
		SELECT topic,
			coalesce(sum(w) FILTER (WHERE fin), 0)::float AS pos,
			coalesce(sum(w) FILTER (WHERE NOT fin), 0)::float AS neg
		FROM (SELECT topic, fin, power(0.5, extract(epoch FROM now() - at) / 86400.0 / ${Number(REC.halfLifeDays)}) AS w FROM ev) x
		WHERE topic IS NOT NULL GROUP BY topic`, [userId, userId]);
	for (const r of rows) { const x = at(r.topic); x.a += Number(r.pos); x.b += Number(r.neg); }
	return out;
}

// ── Beta sampling (Marsaglia–Tsang gamma) ────────────────────────────────────────────────────
const normal = () => {
	let u = 0, v = 0;
	while (u === 0) u = rnd();
	while (v === 0) v = rnd();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const gamma = (k: number): number => {
	if (k < 1) return gamma(k + 1) * Math.pow(rnd(), 1 / k);
	const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
	for (;;) {
		let x: number, v: number;
		do { x = normal(); v = 1 + c * x; } while (v <= 0);
		v = v * v * v;
		const u = rnd();
		if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
};
/** Random source: Math.random, or a seeded one while a whole list is ranked (paging must not reshuffle) */
let rnd: () => number = Math.random;
const seeded = (seed: string) => {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
	let a = h >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
export const betaSample = (a: number, b: number) => { const x = gamma(a); return x / (x + gamma(b)); };

/** Topics that are "mine": picked, or liked by what the learner did */
export const mineOf = (interest: Interest) => new Set([...interest].filter(([, x]) => x.picked || (x.a >= REC.mineMinA && x.a / (x.a + x.b) >= REC.mineMean)).map(([t]) => t));

export type RecRow = { id: string; topic: string | null; done: boolean; locked: boolean; starts: number; plays: number };
/** interest: a topic I like; explore: another topic to try; open: nothing known about me yet (no label) */
export type Reason = 'interest' | 'explore' | 'open';

/**
 * The row of `n` suggestions from the candidate lessons. `fit` says how well a lesson's Level suits the
 * learner (0..1). Lessons done are left out; locked (Premium) ones count less.
 */
export function recommend<T extends RecRow>(rows: T[], interest: Interest, n: number, fit: (r: T) => number): (T & { reason: Reason })[] {
	const theta = new Map<string, number>();
	const th = (topic: string | null) => {
		const k = topic || '';
		if (!theta.has(k)) { const x = interest.get(k); theta.set(k, betaSample(x?.a ?? 1, x?.b ?? 1)); }
		return theta.get(k)!;
	};
	// How often others finish it, smoothed: a new lesson starts at 0.5
	const quality = (r: T) => (r.plays + 1) / (Math.max(r.starts, r.plays) + 2);
	const lockF = (r: T) => (r.locked ? 0.3 : 1);
	const mine = mineOf(interest);
	const open = rows.filter((r) => !r.done);

	const byScore = (score: (r: T) => number) => open.map((r) => ({ r, s: score(r) * (0.9 + 0.2 * rnd()) })).sort((x, y) => y.s - x.s).map((x) => x.r);
	const used = new Map<string, number>();
	const taken = new Set<string>();
	const take = (list: T[], max: number, perTopic: number, reason: Reason, into: (T & { reason: Reason })[]) => {
		for (const r of list) {
			if (into.length >= max) break;
			if (taken.has(r.id) || (used.get(r.topic || '') || 0) >= perTopic) continue;
			taken.add(r.id);
			used.set(r.topic || '', (used.get(r.topic || '') || 0) + 1);
			into.push({ ...r, reason });
		}
	};

	if (!mine.size) {
		// Nothing known yet: every topic draws from its Beta, the lessons others finish lead
		const out: (T & { reason: Reason })[] = [];
		take(byScore((r) => (0.5 + th(r.topic)) * quality(r) * fit(r) * lockF(r)), n, REC.maxPerTopic, 'open', out);
		return out;
	}
	const nExplore = Math.max(1, Math.round(n * REC.exploreShare));
	const interestRows = byScore((r) => th(r.topic) * fit(r) * lockF(r) * (0.8 + 0.4 * quality(r))).filter((r) => r.topic && mine.has(r.topic));
	const exploreRows = byScore((r) => quality(r) * fit(r) * lockF(r) * (0.5 + 0.5 * th(r.topic))).filter((r) => !r.topic || !mine.has(r.topic));

	const ex: (T & { reason: Reason })[] = [];
	take(exploreRows, nExplore, 1, 'explore', ex);
	const inn: (T & { reason: Reason })[] = [];
	take(interestRows, n - ex.length, REC.maxPerTopic, 'interest', inn);
	// Not enough of my topics: fill with more from the others
	if (inn.length + ex.length < n) take(exploreRows, n - inn.length, REC.maxPerTopic, 'explore', ex);

	// Interest first (the first card is the "go on" one), an explore card every few slots
	const out: (T & { reason: Reason })[] = [];
	while (inn.length || ex.length) {
		const slot = out.length;
		const wantExplore = ex.length && (slot % 4 === 2 || !inn.length);
		out.push((wantExplore ? ex.shift() : inn.shift())!);
	}
	return out.slice(0, n);
}

/**
 * The whole list in "For you" order: batches of 4 from recommend() (about one in four from another topic),
 * so every page has the same mix; lessons already done go last. The draw is seeded (learner + day + picks),
 * so page 2 continues page 1 and the list only changes when the learner's interest does.
 */
export function rankAll<T extends RecRow>(rows: T[], interest: Interest, fit: (r: T) => number, seed: string): (T & { reason?: Reason })[] {
	const prev = rnd;
	rnd = seeded(seed);
	try {
		let rest = rows.filter((r) => !r.done);
		const out: (T & { reason?: Reason })[] = [];
		while (rest.length) {
			const batch = recommend(rest, interest, 4, fit);
			if (!batch.length) break;
			const ids = new Set(batch.map((b) => b.id));
			out.push(...batch);
			rest = rest.filter((r) => !ids.has(r.id));
		}
		// What the topic and Level rules left out (a topic's third lesson in every batch is never refused for long, but be safe)
		out.push(...rest);
		return [...out, ...rows.filter((r) => r.done)];
	} finally { rnd = prev; }
}
