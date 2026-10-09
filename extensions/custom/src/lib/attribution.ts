/**
 * Where a learner came from (first touch before sign-up). The web app collects it on the
 * first visit (UTM tags, fbclid/ttclid/gclid, in-app browser, referrer) and sends it once
 * after sign-up; it is stored on directus_users (migration 2026-10-06_attribution.sql).
 *
 * Names are normalised so one channel is one row in the report, whatever the link said:
 * "FB", "facebook.com", "m.facebook.com" -> facebook; "threads.net" -> threads...
 */

/** Only a new account (this many days old at most) gets its traffic source saved */
const ATTRIBUTION_DAYS = 7;

/** Host or alias (lower case) -> channel name */
const SOURCE_ALIASES: [RegExp, string][] = [
	[/^(fb|facebook|(.+\.)?facebook\.com|fb\.me|(.+\.)?fb\.com|messenger(\.com)?|m\.me)$/, 'facebook'],
	[/^(ig|insta|instagram|(.+\.)?instagram\.com)$/, 'instagram'],
	[/^(tt|tiktok|(.+\.)?tiktok\.com|(.+\.)?tiktokv\.com)$/, 'tiktok'],
	[/^(threads|(.+\.)?threads\.(net|com))$/, 'threads'],
	[/^(yt|youtube|(.+\.)?youtube\.com|youtu\.be)$/, 'youtube'],
	[/^(zalo|(.+\.)?zalo\.(me|vn))$/, 'zalo'],
	[/^(x|twitter|(.+\.)?twitter\.com|x\.com|t\.co)$/, 'x'],
	[/^(linkedin|(.+\.)?linkedin\.com|lnkd\.in)$/, 'linkedin'],
	[/^(reddit|(.+\.)?reddit\.com)$/, 'reddit'],
	[/^(telegram|tg|t\.me|(.+\.)?telegram\.org)$/, 'telegram'],
	[/^(pinterest|(.+\.)?pinterest\.[a-z.]+|pin\.it)$/, 'pinterest'],
	[/^(google|(www\.)?google\.[a-z.]+)$/, 'google'],
	[/^(bing|(www\.)?bing\.com)$/, 'bing'],
	[/^(coccoc|coccoc\.com)$/, 'coccoc'],
	[/^(duckduckgo|duckduckgo\.com)$/, 'duckduckgo'],
	[/^(yahoo|(.+\.)?yahoo\.com)$/, 'yahoo'],
	[/^(chatgpt|chatgpt\.com|chat\.openai\.com)$/, 'chatgpt'],
	[/^(perplexity|(www\.)?perplexity\.ai)$/, 'perplexity'],
];
const SOCIAL = new Set(['facebook', 'instagram', 'tiktok', 'threads', 'youtube', 'zalo', 'x', 'linkedin', 'reddit', 'telegram', 'pinterest']);
const SEARCH = new Set(['google', 'bing', 'coccoc', 'duckduckgo', 'yahoo']);

/** Lower case, spaces -> "_", only [a-z0-9._+-] and the "(direct)" marker */
const clean = (v: unknown, max: number) => {
	if (typeof v !== 'string') return '';
	const s = v.trim().toLowerCase().replace(/\s+/g, '_');
	if (s === '(direct)' || s === '(none)') return s;
	return s.replace(/[^a-z0-9._+-]/g, '').slice(0, max);
};

export function normalizeSource(v: unknown) {
	const s = clean(v, 100).replace(/^www\./, '');
	if (!s) return '';
	for (const [re, name] of SOURCE_ALIASES) if (re.test(s)) return name;
	return s;
}

/** Medium when the link did not say: social network, search engine or other site */
export function defaultMedium(source: string) {
	if (source === '(direct)') return '(none)';
	if (SOCIAL.has(source)) return 'social';
	if (SEARCH.has(source)) return 'organic';
	return 'referral';
}

export type Attribution = {
	utm_source: string
	utm_medium: string
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	signup_referrer: string | null
	signup_landing: string | null
	first_seen_at: Date | null
};

/** Body from the web app -> clean row, or null when there is no source */
export function parseAttribution(body: any): Attribution | null {
	const source = normalizeSource(body?.source);
	if (!source) return null;
	const medium = clean(body?.medium, 100) || defaultMedium(source);
	const host = clean(body?.referrer, 255).replace(/^www\./, '');
	const landing = typeof body?.landing === 'string' && body.landing.startsWith('/') ? body.landing.slice(0, 500) : '';
	const seen = body?.first_seen ? new Date(body.first_seen) : null;
	const seenOk = seen && !Number.isNaN(seen.getTime()) && seen.getTime() <= Date.now() + 60000;
	return {
		utm_source: source,
		utm_medium: medium,
		utm_campaign: clean(body?.campaign, 150) || null,
		utm_content: clean(body?.content, 150) || null,
		utm_term: clean(body?.term, 150) || null,
		signup_referrer: host || null,
		signup_landing: landing || null,
		first_seen_at: seenOk ? seen : null,
	};
}

export type AttachAttributionResult = 'attached' | 'already' | 'too-late' | 'invalid';

/**
 * Saves the source of a new account, once. Accounts older than ATTRIBUTION_DAYS keep
 * NULL: a visit long after sign-up says nothing about how they found the site.
 */
export async function attachAttribution(database: any, userId: string, body: any, logger?: any): Promise<AttachAttributionResult> {
	const row = parseAttribution(body);
	if (!row) return 'invalid';
	const user = await database('directus_users').select('utm_source', 'gl_created_at').where('id', userId).first();
	if (!user) return 'invalid';
	if (user.utm_source) return 'already';
	const createdAt = user.gl_created_at ? new Date(user.gl_created_at).getTime() : Date.now();
	if (Date.now() - createdAt > ATTRIBUTION_DAYS * 86400000) return 'too-late';
	const updated = await database('directus_users').where('id', userId).whereNull('utm_source').update(row);
	if (updated) logger?.info?.(`[attribution] ${userId} came from ${row.utm_source} / ${row.utm_medium}${row.utm_campaign ? ` / ${row.utm_campaign}` : ''}`);
	return updated ? 'attached' : 'already';
}
