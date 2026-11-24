/**
 * Khoe thành tích: a share is a card made on the server from facts the server already has (a badge the
 * learner owns, a streak, the stars of a run). The client sends only what to share, never the numbers.
 *
 *   GET /share/:id.png   the picture (SVG drawn here, turned into PNG by sharp when it is there)
 *   GET /share/:id       a small page with Open Graph tags (Facebook, Zalo show the picture), then on to the site
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { engagementOf } from './xp';
import { starSummary } from './stars';
import { BASE_LANG } from './extensive';

/** Badge names in one language; a code with no row there is missing from the map (the caller falls back to badges.name_vi) */
export async function badgeNames(db: any, codes: string[], lang: string) {
	const out = new Map<string, string>();
	if (!codes.length || lang === BASE_LANG) return out;
	const rows = await db('badge_translations').select('code', 'name').where('lang', lang).whereIn('code', codes);
	for (const r of rows) if (r.name) out.set(r.code, r.name);
	return out;
}

export const SHARE_KINDS = ['badge', 'streak', 'stars', 'level'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newShareId = () => Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');

/** The facts of a share, read from the database; null when the learner has no such thing to share */
export async function shareFacts(db: any, userId: string, kind: ShareKind, ref: string | null) {
	if (kind === 'badge') {
		const row = await db('user_badges as ub').join('badges as b', 'b.code', 'ub.badge_code').where({ 'ub.user_id': userId, 'ub.badge_code': ref }).select('b.code', 'b.name_vi', 'b.rarity', 'ub.serial_no', 'b.serial_max').first();
		if (!row) return null;
		// every language the badge has, so the card can be drawn in the learner's language later
		const tr = await db('badge_translations').select('lang', 'name').where('code', row.code);
		const names: Record<string, string> = { [BASE_LANG]: row.name_vi };
		for (const t of tr) if (t.name) names[t.lang] = t.name;
		return { code: row.code, names, rarity: row.rarity, serial_no: row.serial_no, serial_max: row.serial_max };
	}
	if (kind === 'streak') {
		const e = await engagementOf(db, userId);
		return e.streak > 0 ? { streak: e.streak } : null;
	}
	if (kind === 'level') {
		const e = await engagementOf(db, userId);
		return { level: e.level, xp_total: e.xp_total };
	}
	if (kind === 'stars') {
		const run = ref ? await db('listening_runs').where({ id: ref, user_id: userId, status: 'finished' }).first('id') : null;
		if (!run) return null;
		const s = await starSummary(db, run.id);
		return s.used ? { used: s.used, right: s.right, wrong: s.wrong, delta: s.delta } : null;
	}
	return null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Title and the line under it, in the learner's language */
export function shareText(kind: ShareKind, data: any, lang: string, name: string) {
	const vi = lang.startsWith('vi');
	if (kind === 'badge') {
		// new shares keep `names` by language; old ones keep name_vi / name_en
		const nm = data.names ? data.names[lang] || data.names[BASE_LANG] : (vi ? data.name_vi : data.name_en || data.name_vi);
		return { title: nm, line: data.serial_no ? `${vi ? 'Số' : 'No.'} ${data.serial_no}/${data.serial_max}` : (vi ? 'Huy hiệu sưu tầm' : 'Collected badge'), who: name };
	}
	if (kind === 'streak') return { title: vi ? `${data.streak} ngày liên tiếp` : `${data.streak}-day streak`, line: vi ? 'Luyện nghe mỗi ngày' : 'Listening practice, every day', who: name };
	if (kind === 'level') return { title: `Level ${data.level}`, line: `${Number(data.xp_total).toLocaleString('en-US')} XP`, who: name };
	return { title: vi ? `${data.right}/${data.used} Ngôi sao đúng` : `${data.right}/${data.used} stars right`, line: `${data.delta >= 0 ? '+' : '−'}${Math.abs(data.delta)} ${vi ? 'Kim cương' : 'Gems'}`, who: name };
}

export function shareSvg(t: { title: string; line: string; who: string }) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0f172a"/>
<rect x="40" y="40" width="1120" height="550" fill="none" stroke="#38bdf8" stroke-width="6"/>
<polygon points="150,200 190,150 250,150 290,200 220,290" fill="#38bdf8"/>
<polygon points="150,200 290,200 220,290" fill="#0ea5e9"/>
<text x="360" y="230" font-family="Arial, Helvetica, sans-serif" font-size="84" font-weight="700" fill="#ffffff">${esc(t.title)}</text>
<text x="360" y="305" font-family="Arial, Helvetica, sans-serif" font-size="44" fill="#bae6fd">${esc(t.line)}</text>
<text x="150" y="470" font-family="Arial, Helvetica, sans-serif" font-size="40" fill="#e2e8f0">${esc(t.who)}</text>
<text x="150" y="540" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#38bdf8">GuideLingo</text>
</svg>`;
}

let sharpMod: any | undefined;
function sharp() {
	if (sharpMod !== undefined) return sharpMod;
	try {
		const base = '/directus/node_modules/.pnpm';
		const dir = readdirSync(base).find((d) => d.startsWith('sharp@'));
		sharpMod = dir ? createRequire(`${base}/${dir}/node_modules/sharp/package.json`)('sharp') : null;
	} catch { sharpMod = null; }
	return sharpMod;
}

/** PNG of the card; null when sharp is not there (the route then answers with the SVG) */
export async function sharePng(svg: string): Promise<Buffer | null> {
	const s = sharp();
	if (!s) return null;
	try { return await s(Buffer.from(svg)).png().toBuffer(); } catch { return null; }
}

export const ogPage = (o: { title: string; line: string; image: string; url: string; to: string }) => `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(o.title)} · GuideLingo</title>
<meta property="og:type" content="website"><meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.line)}">
<meta property="og:image" content="${esc(o.image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(o.url)}"><meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(o.to)}"></head><body><a href="${esc(o.to)}">GuideLingo</a></body></html>`;
