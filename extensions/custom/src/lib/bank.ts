/**
 * Practice bank, "Kho bài tập" (database/migrations/2026-11-13_practice_bank.sql, web docs/practice-bank-plan.md).
 *
 * One item per sentence: every published clip of a video in the bank (practice_videos), wherever the
 * clip was made (a lesson, a past challenge). A new clip joins the bank by itself. An item is one
 * question (a run of one), shown as a card; the learner may go on to the next one.
 *
 *   free video       its sentences are open to everyone, guests too
 *   Premium video    Xu to open the video's sentences for good (practice_video_unlocks), free with Premium
 *
 * A clip of a challenge still open (or not yet published) is kept out: a challenge may be made of
 * bank clips, and the bank must not give its answers away (CLIP_FILTER).
 */
import { MIXED_UP, mixUps } from './mixups';
import { supports, type Format, type PoolClip } from './runs';

export const BANK = {
	/** Xu to open a Premium video (all its sentences), when the row sets no price */
	price: 60,
	/** Xu for a sentence heard right the first time (once per sentence, ever) */
	earn: 2,
};

/**
 * Which clips are bank items (clip c, its lesson l, its rule s, its video sv). The same rule
 * seeds the videos (docs/giao-trinh/sql/practice-videos-seed.sql).
 */
export const CLIP_FILTER = `
	c.status = 'published' AND c.role IS NOT NULL AND c.role <> 'trap'
	AND c.start_time IS NOT NULL AND c.end_time IS NOT NULL AND sv.youtube_video_id IS NOT NULL
	AND (nullif(trim(c.answer), '') IS NOT NULL OR c.transcript ~ '\\[[^\\]]+\\]')
	AND l.status = 'published' AND (l.kind = 'challenge' OR s.status = 'published')
	AND NOT EXISTS (SELECT 1 FROM listening_challenges ch WHERE ch.lesson_id = l.id AND (ch.status <> 'published' OR ch.ends_at > now()))
	AND NOT EXISTS (SELECT 1 FROM listening_challenges ch JOIN listening_lessons cl ON cl.id = ch.lesson_id,
		jsonb_array_elements(CASE WHEN jsonb_typeof(cl.practice) = 'array' THEN cl.practice ELSE '[]'::jsonb END) st
		WHERE (ch.status <> 'published' OR ch.ends_at > now()) AND st->>'clip_id' = c.id::text)`;

export type BankItem = {
	id: string; n: number; lesson_id: string; difficulty: 1 | 2 | 3; skill_slug: string; skill_name: string;
	practice_id: string; video_short_id: string; video_title: string; youtube_video_id: string; thumbnail_url: string | null;
	is_premium: boolean; price_xu: number | null;
};

/**
 * Every sentence of the published videos, in the team's order of videos then the order they are said;
 * `n` is its place in that order ("Câu 12"). `clipId`: just that one.
 */
export async function loadBankItems(db: any, where: { clipId?: string } = {}): Promise<BankItem[]> {
	const { rows } = await db.raw(`
		SELECT c.id, c.lesson_id, c.difficulty, s.slug AS skill_slug, s.name AS skill_name,
			p.id AS practice_id, p.short_id AS video_short_id, p.title AS video_title, p.is_premium, p.price_xu,
			sv.youtube_video_id, sv.thumbnail_url
		FROM practice_videos p
		JOIN source_videos sv ON sv.id = p.source_video_id
		JOIN listening_clips c ON c.source_video_id = sv.id
		JOIN listening_lessons l ON l.id = c.lesson_id
		JOIN listening_skills s ON s.id = l.skill_id
		WHERE p.status = 'published' AND ${CLIP_FILTER}
		ORDER BY p.sort, p.id, c.start_time, c.id`);
	const all: BankItem[] = rows.map((r: any, i: number) => ({ ...r, n: i + 1, difficulty: Math.min(3, Math.max(1, Number(r.difficulty) || 2)) as 1 | 2 | 3 }));
	return where.clipId ? all.filter((it) => it.id === where.clipId) : all;
}

/** The price to open a Premium video (0 for a free one) */
export const bankPrice = (v: Pick<BankItem, 'is_premium' | 'price_xu'>) => (v.is_premium ? Math.max(0, v.price_xu ?? BANK.price) : 0);

const plain = (t: string) => t.toLowerCase().replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Wrong answers for a bank clip that has none of its own: the phrase with a small word swapped for
 * one it is heard as (any place, not only the last: lib/mixups.ts), else with its last word's
 * ending taken off or put on. Up to 3; none for a phrase with nothing to confuse.
 */
export function bankWrong(target: string): string[] {
	const words = target.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
	const out: string[] = [];
	const add = (text: string) => {
		const t = text.replace(/\s+/g, ' ').trim();
		if (t && plain(t) !== plain(target) && !out.some((o) => plain(o) === plain(t))) out.push(t);
	};
	for (const m of mixUps(target)) add(m);
	for (let i = words.length - 1; i >= 0 && out.length < 3; i--) {
		for (const alt of MIXED_UP[plain(words[i]!)] || []) {
			add(words.map((w, k) => (k === i ? alt : w)).join(' '));
			if (out.length >= 3) break;
		}
	}
	const last = words[words.length - 1] || '';
	const head = words.slice(0, -1);
	if (out.length < 3 && /^[A-Za-z]{3,}ed$/.test(last)) add([...head, last.slice(0, -2)].join(' '));
	if (out.length < 3 && /^[A-Za-z]{4,}[^s]s$/.test(last)) add([...head, last.slice(0, -1)].join(' '));
	if (out.length < 3 && /^[A-Za-z]{4,}[^s]$/.test(last) && !/ed$/.test(last)) add([...head, `${last}s`].join(' '));
	if (out.length < 3 && words.length >= 3 && /^(the|a|to|of|and|that)$/i.test(words[1] || '')) add([words[0], ...words.slice(2)].join(' '));
	return out.slice(0, 3);
}

/** The format the n-th item of a go is asked in: a choice, a word bank, a gap in turn (when the clip allows it), else typed */
export function bankFormat(c: PoolClip, n: number): Format {
	const order: Format[] = ['choice', 'bank', 'gap'];
	for (let k = 0; k < order.length; k++) {
		const f = order[(n + k) % order.length]!;
		if (supports(c, f)) return f;
	}
	return 'type';
}
