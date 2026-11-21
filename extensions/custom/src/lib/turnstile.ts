/**
 * Cloudflare Turnstile: the form sends the token the widget made, we ask Cloudflare if it is real.
 * Without TURNSTILE_SECRET the check is skipped (local work, or before the keys exist).
 */
export const turnstileOn = () => !!process.env.TURNSTILE_SECRET;

export async function verifyTurnstile(token: unknown, ip: string, logger?: any): Promise<boolean> {
	const secret = process.env.TURNSTILE_SECRET;
	if (!secret) return true;
	if (typeof token !== 'string' || !token || token.length > 2048) return false;
	try {
		const body = new URLSearchParams({ secret, response: token });
		if (ip && ip !== 'unknown') body.set('remoteip', ip);
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body,
			signal: AbortSignal.timeout(5000),
		});
		const json: any = await res.json();
		if (!json?.success) logger?.warn?.(`[turnstile] rejected: ${(json?.['error-codes'] || []).join(',')}`);
		return !!json?.success;
	} catch (e) {
		// Cloudflare unreachable: refuse (fail closed) rather than let every bot through
		logger?.error?.(`[turnstile] verify failed: ${String(e)}`);
		return false;
	}
}
