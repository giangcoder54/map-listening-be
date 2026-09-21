import { Buffer } from 'node:buffer';

/**
 * Giữ lại RAW BODY của webhook SePay để xác thực HMAC-SHA256.
 *
 * Vì sao cần: SePay ký trên ĐÚNG TỪNG BYTE của body. Directus lại chạy
 * express.json() cho mọi request trước khi tới endpoint của extension — nó đọc
 * hết luồng dữ liệu, parse thành object rồi bỏ bytes gốc đi. Dựng lại bằng
 * JSON.stringify(req.body) không dùng được: chỉ cần lệch thứ tự khoá, khoảng
 * trắng hay cách escape unicode là hash ra khác hoàn toàn.
 *
 * Cách làm: gắn một middleware CHỈ cho đường dẫn webhook, chạy TRƯỚC bộ parse
 * của Directus. Nó tự đọc luồng, giữ nguyên bytes vào req.rawBody, tự parse JSON
 * vào req.body, rồi đánh dấu req._body = true để body-parser phía sau bỏ qua
 * (nếu không nó sẽ chờ đọc một luồng đã cạn).
 *
 * Không đụng tới bất kỳ route nào khác của Directus.
 */
export const SEPAY_WEBHOOK_PATH = '/v1/sepay-webhook';

function captureRawBody(req: any, _res: any, next: any) {
	// Đã có ai đọc trước rồi thì thôi, tránh treo vì đọc luồng đã cạn.
	if (req.rawBody || req._body) return next();

	const chunks: Buffer[] = [];
	req.on('data', (chunk: Buffer) => chunks.push(chunk));
	req.on('end', () => {
		const raw = Buffer.concat(chunks);
		req.rawBody = raw;
		req._body = true;
		try {
			req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
		} catch {
			// Body không phải JSON hợp lệ -> để rỗng, phần xác thực chữ ký sẽ
			// tự từ chối; không ném lỗi ở đây để tránh 500 khó lần.
			req.body = {};
		}
		next();
	});
	req.on('error', next);
}

export function registerSepayRawBody(registerEvents: any, context: any) {
	const { init } = registerEvents;
	const logger = context?.logger;

	const attach = (payload: any) => {
		const app = payload?.app;
		// Gắn một lần duy nhất, ở sự kiện sớm nhất bắt được.
		if (!app || app.__sepayRawBodyAttached) return;
		app.__sepayRawBodyAttached = true;
		app.use(SEPAY_WEBHOOK_PATH, captureRawBody);
		logger?.info?.(`[SePay] Đã gắn middleware giữ raw body cho ${SEPAY_WEBHOOK_PATH}`);
	};

	// Đăng ký ở cả hai mốc: mốc nào chạy trước thì gắn, mốc sau tự bỏ qua nhờ cờ.
	// Phải chạy trước express.json() của Directus mới có tác dụng.
	init('app.before', attach);
	init('middlewares.before', attach);
}
