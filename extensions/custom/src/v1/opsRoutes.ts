/**
 * Ops: health check, error reports from the site, contact form.
 *
 *   GET  /health          Directus + database up? (uptime monitors)
 *   POST /client-errors   { message, stack?, url?, source? } -> Telegram, deduplicated
 *   POST /support         { email, name?, topic?, message, website (honeypot) }
 */
import { createHash } from 'node:crypto';
import { notifyAdmin } from '../lib/sepay';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Same error: one Telegram message per 30 minutes. At most 20 messages per hour overall.
const seen = new Map<string, number>();
let windowStart = Date.now();
let sentInWindow = 0;
function shouldReport(key: string) {
	const now = Date.now();
	if (now - windowStart > 3600000) {
		windowStart = now;
		sentInWindow = 0;
	}
	const last = seen.get(key);
	if (last && now - last < 1800000) return false;
	if (sentInWindow >= 20) return false;
	seen.set(key, now);
	if (seen.size > 2000) seen.clear();
	sentInWindow++;
	return true;
}

// Contact form: 3 messages per 10 minutes per IP
const contactHits = new Map<string, number[]>();
function contactLimited(ip: string) {
	const now = Date.now();
	const hits = (contactHits.get(ip) || []).filter((t) => now - t < 600000);
	if (hits.length >= 3) return true;
	hits.push(now);
	contactHits.set(ip, hits);
	if (contactHits.size > 5000) contactHits.clear();
	return false;
}

export function registerOpsRoutes(router: any, context: any) {
	const { database, logger } = context;

	router.get('/health', async (_req: any, res: any) => {
		try {
			await database.raw('SELECT 1');
			return res.json({ status: 'ok', time: new Date().toISOString() });
		} catch (error) {
			logger?.error?.(`[health] database: ${String(error)}`);
			return res.status(503).json({ status: 'error', database: false });
		}
	});

	router.post('/client-errors', async (req: any, res: any) => {
		const body = req.body || {};
		const message = str(body.message, 500);
		if (!message) return res.status(204).end();
		const source = body.source === 'ssr' ? 'ssr' : 'browser';
		const url = str(body.url, 300);
		const stack = str(body.stack, 1500);
		// Noise from browser extensions, old cached bundles and aborted loads
		if (/ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:|Failed to fetch dynamically imported module|Importing a module script failed|Load failed$/i.test(`${message} ${stack}`)) {
			return res.status(204).end();
		}
		const key = createHash('sha1').update(`${source}|${message}|${stack.split('\n')[1] || ''}`).digest('hex');
		logger?.warn?.(`[client-error] ${source} ${url} ${message}`);
		if (shouldReport(key)) {
			notifyAdmin(`🐞 Lỗi ${source === 'ssr' ? 'server (SSR)' : 'trình duyệt'}\n${message}\nTrang: ${url || '?'}\n${stack.split('\n').slice(0, 4).join('\n')}`);
		}
		return res.status(204).end();
	});

	router.post('/support', async (req: any, res: any) => {
		const body = req.body || {};
		if (str(body.website, 100)) return res.status(201).json({ success: true }); // honeypot
		const email = str(body.email, 255).toLowerCase();
		const message = str(body.message, 5000);
		if (!EMAIL_RE.test(email) || message.length < 5) {
			return res.status(400).json({ success: false, code: 'INVALID', message: 'Enter your email and a message.' });
		}
		const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0]!.trim();
		if (contactLimited(ip)) return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Please try again in a few minutes.' });
		const topic = ['account', 'payment', 'lesson', 'affiliate', 'other'].includes(body.topic) ? body.topic : 'other';
		try {
			await database('support_messages').insert({
				user_id: req.accountability?.user ?? null,
				email,
				name: str(body.name, 255) || null,
				topic,
				message,
			});
			notifyAdmin(`✉️ Liên hệ mới (${topic}) từ ${email}\n${message.slice(0, 600)}`);
			return res.status(201).json({ success: true });
		} catch (error) {
			logger?.error?.(`[support] save failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: 'Server error' });
		}
	});
}
