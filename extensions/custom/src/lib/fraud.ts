/**
 * Signs that a referral is really the referrer buying for themselves (self-referral), to
 * block at checkout (same mailbox) or to flag for the admin before paying (the rest).
 * Flags never block a payment: a shared IP is often a family, a school or a mobile network.
 */

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/**
 * One mailbox, one string: lower case, "+tag" dropped, and for Gmail the dots too
 * (an.b+1@gmail.com and anb@gmail.com reach the same inbox).
 */
export function normalizeEmail(email: string) {
	const [rawLocal = '', rawDomain = ''] = String(email || '').trim().toLowerCase().split('@');
	if (!rawLocal || !rawDomain) return '';
	const domain = GMAIL.has(rawDomain) ? 'gmail.com' : rawDomain;
	let local = rawLocal.split('+')[0] || '';
	if (domain === 'gmail.com') local = local.replace(/\./g, '');
	return `${local}@${domain}`;
}

export const sameMailbox = (a: string, b: string) => {
	const x = normalizeEmail(a);
	return !!x && x === normalizeEmail(b);
};

/** "Nguyễn Văn A" -> "NGUYEN VAN A" */
export const normalizeName = (name: string) =>
	String(name || '')
		.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'D')
		.toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Private / local addresses: the proxy, not the visitor, so they prove nothing */
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

export type FraudFlag = 'same_email' | 'same_ip' | 'same_name';

/** Flags for a paid order of `buyerId` credited to `referrerId` */
export async function fraudFlags(database: any, buyerId: string, referrerId: string): Promise<FraudFlag[]> {
	const flags: FraudFlag[] = [];
	const users = await database('directus_users').select('id', 'email', 'first_name', 'last_name').whereIn('id', [buyerId, referrerId]);
	const buyer = users.find((u: any) => u.id === buyerId);
	const referrer = users.find((u: any) => u.id === referrerId);
	if (!buyer || !referrer) return flags;

	if (sameMailbox(buyer.email, referrer.email)) flags.push('same_email');

	// Same public IP at login (Directus keeps every login in directus_activity)
	const ips = await database('directus_activity')
		.select('ip', 'user')
		.whereIn('user', [buyerId, referrerId])
		.where('action', 'login')
		.whereNotNull('ip')
		.where('timestamp', '>', database.raw("now() - interval '90 days'"));
	const of = (id: string) => new Set(ips.filter((r: any) => r.user === id && !PRIVATE_IP.test(String(r.ip))).map((r: any) => String(r.ip)));
	const buyerIps = of(buyerId);
	if ([...of(referrerId)].some((ip) => buyerIps.has(ip))) flags.push('same_ip');

	// Buyer's name = referrer's name, legal name or bank account holder
	const buyerName = normalizeName(`${buyer.first_name || ''} ${buyer.last_name || ''}`);
	if (buyerName.replace(/ /g, '').length >= 6) {
		const affiliate = await database('affiliates').select('legal_name', 'payout_account_name').where('user_id', referrerId).first();
		const names = [`${referrer.first_name || ''} ${referrer.last_name || ''}`, affiliate?.legal_name, affiliate?.payout_account_name]
			.map((n) => normalizeName(n || ''))
			.filter(Boolean);
		if (names.includes(buyerName)) flags.push('same_name');
	}
	return flags;
}
