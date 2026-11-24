/**
 * Country of a learner, used by Tìm trận / Tìm bạn luyện (lib/match.ts) to pair people of the same country first.
 *
 * Taken from the IP of the request: the header set by the proxy in front of Directus (Cloudflare `CF-IPCountry`, or the
 * CloudFront / Vercel equivalents). It is saved on the learner at each visit, so a learner who moves follows. Without
 * such a header (local development, no proxy) the last saved value stays.
 */
const HEADERS = ['cf-ipcountry', 'cloudfront-viewer-country', 'x-vercel-ip-country'];
// Cloudflare: XX = unknown, T1 = Tor
const NOT_A_COUNTRY = new Set(['XX', 'T1']);

export const normCountry = (v: unknown): string | null => {
	const c = String(v ?? '').trim().toUpperCase();
	return /^[A-Z]{2}$/.test(c) && !NOT_A_COUNTRY.has(c) ? c : null;
};

export function guessCountry(req: any): string | null {
	for (const h of HEADERS) {
		const c = normCountry(req?.headers?.[h]);
		if (c) return c;
	}
	return null;
}

/** The learner's country: saved from the IP of this request when it has one, else the value saved before */
export async function getCountry(db: any, userId: string, req?: any) {
	const guess = guessCountry(req);
	const saved = normCountry((await db('directus_users').where('id', userId).first('country'))?.country);
	if (guess && guess !== saved) await db('directus_users').where('id', userId).update({ country: guess });
	return { country: guess ?? saved };
}

export const countryOf = async (db: any, userId: string): Promise<string | null> => normCountry((await db('directus_users').where('id', userId).first('country'))?.country);
