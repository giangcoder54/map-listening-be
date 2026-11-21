/**
 * Small in-memory rate limits for public forms (register, contact, error reports).
 * One Directus process, so a Map is enough; a restart clears them.
 */

/**
 * The visitor's IP. nginx sets X-Real-IP to the connecting address ($remote_addr), which a client
 * cannot fake. X-Forwarded-For is NOT used: nginx appends to what the client sent, so its first
 * entry is whatever the client wrote.
 */
export function clientIp(req: any): string {
	const real = String(req.headers?.['x-real-ip'] || '').trim();
	return real || String(req.ip || req.socket?.remoteAddress || 'unknown');
}

const buckets = new Map<string, Map<string, number[]>>();

/** true when `key` already made `max` calls in the last `windowMs` (the call is then not counted) */
export function isLimited(bucket: string, key: string, max: number, windowMs: number): boolean {
	let hits = buckets.get(bucket);
	if (!hits) buckets.set(bucket, (hits = new Map()));
	const now = Date.now();
	const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
	if (recent.length >= max) {
		hits.set(key, recent);
		return true;
	}
	recent.push(now);
	hits.set(key, recent);
	if (hits.size > 10000) hits.clear();
	return false;
}
