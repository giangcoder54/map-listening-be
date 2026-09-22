import { defineEndpoint } from '@directus/extensions-sdk';
import { handleCheckout } from './checkout';
import { handleSepayWebhook } from './sepay';
import { handleYoutubeCrawl } from './youtube';
import { ensurePaymentSchema } from '../lib/paymentSchema';
import { consumeQuotaForClip, getQuotaStatus, publicQuota } from '../lib/quota';


const isValidUUID = (val: unknown): val is string =>
	typeof val === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

const normalizeAnswer = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());

function parseAnswerKey(raw: unknown): Record<string, unknown>[] {
	if (typeof raw === 'string') {
		try { raw = JSON.parse(raw); } catch (e) { return []; }
	}
	if (Array.isArray(raw)) return raw;
	if (raw && typeof raw === 'object') {
		if (Array.isArray((raw as any).answers)) {
			return (raw as any).answers;
		}
		return Object.entries(raw).map(([key, val]) =>
			val && typeof val === 'object' && !Array.isArray(val) ? { key, ...(val as object) } : { key, correct_answer: val }
		);
	}
	return [];
}

function parseUserAnswers(raw: unknown): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (Array.isArray(raw)) {
		for (const a of raw) {
			const key = a?.key ?? a?.question_key ?? a?.question ?? a?.id ?? a?.no;
			if (key !== undefined && key !== null) {
				result[String(key)] = a?.answer ?? a?.user_answer ?? a?.value;
			}
		}
	} else if (raw && typeof raw === 'object') {
		for (const [k, v] of Object.entries(raw)) result[k] = v;
	}
	return result;
}

function gradeAttempt(answerKeyArray: Record<string, unknown>[], userAnswers: Record<string, unknown>) {
	let correctCount = 0;
	let wrongCount = 0;
	let unansweredCount = 0;
	let score = 0;
	let maxScore = 0;

	const answersResultJson = answerKeyArray.map((q, index) => {
		let no = String(q.key ?? q.id ?? q.question_id ?? q.no ?? q.question_key ?? index + 1);
		if (/^q\d+$/i.test(no)) no = no.substring(1);

		const correctAnswer = q.correct_answer ?? q.answer ?? q.correct ?? q.value;
		const questionScore = typeof q.score === 'number' ? q.score : 1;
		maxScore += questionScore;

		const userAnswer = userAnswers[no];
		const answered = userAnswer !== undefined && userAnswer !== null && String(userAnswer).trim() !== '';

		const validAnswers = Array.isArray(q.acceptable_answers)
			? [correctAnswer, ...q.acceptable_answers]
			: [correctAnswer];

		const isCorrect = answered && validAnswers.some(ans =>
			ans != null && normalizeAnswer(userAnswer) === normalizeAnswer(ans)
		);

		if (!answered) unansweredCount++;
		else if (isCorrect) correctCount++;
		else wrongCount++;

		const awarded = isCorrect ? questionScore : 0;
		score += awarded;

		return {
			no,
			question_text: q.question_text ?? q.question ?? null,
			user_answer: answered ? String(userAnswer) : null,
			correct_answer: correctAnswer != null ? String(correctAnswer) : null,
			acceptable_answers: Array.isArray(q.acceptable_answers) ? q.acceptable_answers : [],
			is_correct: isCorrect,
			score: awarded,
			explanation: q.explanation ?? null,
			transcript_evidence: q.transcript_evidence ?? null,
		};
	});

	const totalQuestions = answerKeyArray.length;
	const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

	return {
		totalQuestions,
		correctCount,
		wrongCount,
		unansweredCount,
		score,
		maxScore,
		percentage,
		answersResultJson,
	};
}

// =====================================================================
// Listening Lab: đếm số người đã luyện mỗi challenge (listening_targets)
//
// Bảng listening_target_learners giữ đúng 1 dòng cho mỗi (challenge, người học).
// Người học = user đăng nhập ("u:<user_id>") hoặc khách ("a:<anonymous_id>" từ cookie).
// Ràng buộc UNIQUE(target_id, learner_key) đảm bảo bấm nhiều lần / F5 / request song song
// cũng chỉ +1 cho listening_targets.learners_count.
// =====================================================================
const LEARNERS_TABLE = 'listening_target_learners';

// Cách tính tiến độ của một challenge theo loại (listening_types):
// - 'per_clip'      : Similar Sound / Spelling Names / Numbers -> mỗi clip là một đáp án riêng,
//                     % = số clip đã làm đúng / tổng số clip.
// - 'single_answer' : các loại còn lại (Connected Speech, Single Word...) -> cả challenge chỉ có 1 đáp án,
//                     làm đúng 1 clip là hoàn thành 100%, các clip sau chỉ để nghe lại luyện mặt chữ.
// Giữ đồng bộ với src/utils/listeningLab.ts ở frontend.
const PER_CLIP_TYPE_REGEX = /similar|spelling|number/i;
type ProgressMode = 'per_clip' | 'single_answer';

function getProgressMode(types: { name?: string | null; slug?: string | null }[] | null | undefined): ProgressMode {
	return (types || []).some((t) => PER_CLIP_TYPE_REGEX.test(`${t?.name ?? ''} ${t?.slug ?? ''}`))
		? 'per_clip'
		: 'single_answer';
}
const ANON_ID_REGEX = /^[A-Za-z0-9-]{16,64}$/;
let learnersTableReady: Promise<void> | null = null;

function ensureLearnersTable(database: any, logger: any): Promise<void> {
	if (!learnersTableReady) {
		learnersTableReady = (async () => {
			if (await database.schema.hasTable(LEARNERS_TABLE)) return;

			await database.transaction(async (trx: any) => {
				await trx.schema.createTable(LEARNERS_TABLE, (t: any) => {
					t.uuid('id').primary().defaultTo(trx.raw('gen_random_uuid()'));
					t.uuid('target_id').notNullable().references('id').inTable('listening_targets').onDelete('CASCADE');
					t.uuid('user_id').nullable().references('id').inTable('directus_users').onDelete('SET NULL');
					t.string('anonymous_id', 64).nullable();
					t.string('learner_key', 80).notNullable();
					t.timestamp('date_created', { useTz: true }).notNullable().defaultTo(trx.fn.now());
					t.unique(['target_id', 'learner_key']);
				});

				// Backfill từ lịch sử cũ (chỉ user đăng nhập mới có trong listening_attempts)
				await trx.raw(`
					INSERT INTO ${LEARNERS_TABLE} (target_id, user_id, learner_key, date_created)
					SELECT c.target_id, a.user_id, 'u:' || a.user_id::text, MIN(a.date_created)
					FROM listening_attempts a
					JOIN listening_clips c ON c.id = a.clip_id
					WHERE a.user_id IS NOT NULL AND c.target_id IS NOT NULL
					GROUP BY c.target_id, a.user_id
					ON CONFLICT (target_id, learner_key) DO NOTHING
				`);

				// Đồng bộ lại learners_count (trước đây hook cộng theo từng lượt thử nên bị sai)
				await trx.raw(`
					UPDATE listening_targets t
					SET learners_count = (SELECT COUNT(*) FROM ${LEARNERS_TABLE} l WHERE l.target_id = t.id)
				`);
			});

			logger?.info?.(`[listening-lab] Created table ${LEARNERS_TABLE} and recalculated learners_count`);
		})().catch((error: any) => {
			learnersTableReady = null; // thử lại ở request sau
			logger?.error?.(`[listening-lab] Failed to prepare ${LEARNERS_TABLE}: ${String(error)}`);
			throw error;
		});
	}
	return learnersTableReady;
}

/**
 * Ghi nhận người học cho một challenge. Trả về true nếu đây là lần đầu (đã +1 learners_count).
 * Khi khách đăng nhập sau đó, dòng "a:<anon>" được chuyển thành "u:<user>" thay vì đếm thêm.
 */
async function registerLearner(
	database: any,
	targetId: string,
	userId: string | null,
	anonymousId: string | null,
): Promise<boolean> {
	if (!userId && !anonymousId) return false;

	return database.transaction(async (trx: any) => {
		if (userId) {
			const userKey = `u:${userId}`;
			const existingUser = await trx(LEARNERS_TABLE).where({ target_id: targetId, learner_key: userKey }).first('id');
			if (existingUser) return false;

			if (anonymousId) {
				const converted = await trx(LEARNERS_TABLE)
					.where({ target_id: targetId, learner_key: `a:${anonymousId}` })
					.update({ learner_key: userKey, user_id: userId });
				if (converted > 0) return false;
			}

			const inserted = await trx(LEARNERS_TABLE)
				.insert({ target_id: targetId, user_id: userId, anonymous_id: anonymousId, learner_key: userKey })
				.onConflict(['target_id', 'learner_key'])
				.ignore()
				.returning('id');
			if (inserted.length === 0) return false;
		} else {
			const inserted = await trx(LEARNERS_TABLE)
				.insert({ target_id: targetId, anonymous_id: anonymousId, learner_key: `a:${anonymousId}` })
				.onConflict(['target_id', 'learner_key'])
				.ignore()
				.returning('id');
			if (inserted.length === 0) return false;
		}

		await trx('listening_targets').where('id', targetId).increment('learners_count', 1);
		return true;
	});
}

export default defineEndpoint((router, context) => {
	// Chuẩn bị bảng ngay khi Directus load extension
	ensureLearnersTable(context.database, context.logger).catch(() => {});
	ensurePaymentSchema(context.database, context.logger).catch(() => {});
	router.post('/import', async (req, res) => {
		const { ItemsService } = context.services;

		try {
			const payload = req.body;

			if (!payload) {
				return res.status(400).json({
					success: false,
					message: 'Payload is empty',
				});
			}

			if (!payload.title || !payload.slug) {
				return res.status(400).json({
					success: false,
					message: 'Missing required fields: title and slug are required',
				});
			}

			// Helper to validate if a string is a valid UUID
			const isValidUUID = (val: any): boolean => {
				if (typeof val !== 'string') return false;
				const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
				return uuidRegex.test(val);
			};

			const mapImage = isValidUUID(payload.image_file) ? payload.image_file : null;
			const thumbnail = isValidUUID(payload.thumbnail) ? payload.thumbnail : null;

			// Construct the record for listening_tests
			const testData: any = {
				status: payload.status || 'draft',
				title: payload.title,
				slug: payload.slug,
				description: payload.description || null,
				type: payload.type || null,
				level: payload.level || null,
				accent: payload.accent || null,
				duration_seconds: payload.duration_seconds || null,
				question_count: payload.question_count || 0,
				is_free: typeof payload.is_free === 'boolean' ? payload.is_free : true,
				instruction_text: payload.instruction_text || null,
				transcript: payload.transcript || null,
				prosody_script: payload.prosody_script || null,
				questions_public_json: payload.questions_public_json || null,
				questions_answer_json: payload.questions_answer_json || null,
				metadata: payload.metadata || null,
				map_image: mapImage,
				thumbnail: thumbnail,
			};

			// Handle nested O2M/M2M audio files relation
			if (isValidUUID(payload.audio_file)) {
				testData.audio_file = [
					{
						directus_files_id: payload.audio_file,
					},
				];
			}

			// Create the record using ItemsService with administrative accountability to allow public access
			const listeningTestsService = new ItemsService('listening_tests', {
				schema: req.schema,
				accountability: { admin: true, role: null, user: null },
			});

			const record = await listeningTestsService.createOne(testData);

			return res.status(201).json({
				success: true,
				message: 'Listening test imported successfully',
				data: record,
			});
		} catch (error: any) {
			return res.status(500).json({
				success: false,
				message: error.message || 'An error occurred during import',
				error: error,
			});
		}
	});

	// =====================================================================
	// POST /submit  -> chấm điểm, lưu 1 record listening_attempts
	// body: {
	//   test: string (id hoặc slug),
	//   answers: { "1": "B", "2": "A" } | [{ key, answer }],
	//   duration_seconds?: number,
	//   started_at?: string
	// }
	// =====================================================================
	router.post('/submit', async (req, res) => {
		const { ItemsService } = context.services;

		try {
			const payload = req.body || {};
			const userId = (req as any).accountability?.user ?? null;

			if (!payload.test) {
				return res.status(400).json({ success: false, message: 'Missing required field: test' });
			}
			if (!payload.answers) {
				return res.status(400).json({ success: false, message: 'Missing required field: answers' });
			}

			const adminAccountability = { admin: true, role: null, user: null } as any;
			const schema = (req as any).schema;

			const testsService = new ItemsService('listening_tests', {
				schema,
				accountability: adminAccountability,
			});

			let test: any;
			if (isValidUUID(payload.test)) {
				test = await testsService.readOne(payload.test);
			} else {
				const found = await testsService.readByQuery({
					filter: { slug: { _eq: payload.test } },
					limit: 1,
				});
				test = found?.[0];
			}

			if (!test) {
				return res.status(404).json({ success: false, message: 'Test not found' });
			}

			const answerKeyArray = parseAnswerKey(test.questions_answer_json);
			if (answerKeyArray.length === 0) {
				return res.status(400).json({
					success: false,
					message: 'Test has no answer key (questions_answer_json is empty)',
				});
			}

			const userAnswers = parseUserAnswers(payload.answers);
			const graded = gradeAttempt(answerKeyArray, userAnswers);

			const attemptsService = new ItemsService('listening_attempts', {
				schema,
				accountability: adminAccountability,
			});

			const attemptId = await attemptsService.createOne({
				user: userId,
				test: test.id,
				status: 'submitted',
				started_at: payload.started_at ?? null,
				submitted_at: new Date().toISOString(),
				duration_seconds: payload.duration_seconds ?? null,
				total_questions: graded.totalQuestions,
				correct_count: graded.correctCount,
				wrong_count: graded.wrongCount,
				unanswered_count: graded.unansweredCount,
				score: graded.score,
				max_score: graded.maxScore,
				percentage: graded.percentage,
				answers_result_json: graded.answersResultJson,
			});

			return res.status(201).json({
				success: true,
				data: {
					id: attemptId,
					user: userId,
					test: test.id,
					status: 'submitted',
					started_at: payload.started_at ?? null,
					submitted_at: new Date().toISOString(),
					duration_seconds: payload.duration_seconds ?? null,
					total_questions: graded.totalQuestions,
					correct_count: graded.correctCount,
					wrong_count: graded.wrongCount,
					unanswered_count: graded.unansweredCount,
					score: graded.score,
					max_score: graded.maxScore,
					percentage: graded.percentage,
					answers_result_json: graded.answersResultJson,
					transcript: test.transcript ?? null,
				},
			});
		} catch (error: any) {
			return res.status(500).json({
				success: false,
				message: error.message || 'An error occurred during scoring',
			});
		}
	});

	router.post('/tests/:id/increment-taken', async (req, res) => {
		const testId = req.params.id;
		const { database } = context;

		try {
			if (isValidUUID(testId)) {
				await database('listening_tests')
					.where('id', testId)
					.increment('tests_taken', 1);
			} else {
				// If slug is passed
				await database('listening_tests')
					.where('slug', testId)
					.increment('tests_taken', 1);
			}

			return res.status(200).json({ success: true, message: "Incremented successfully" });
		} catch (error) {
			console.error("Error incrementing tests_taken:", error);
			return res.status(500).json({ success: false, error: "Internal Server Error" });
		}
	});

	router.get('/pricing', async (req, res) => {
		const { ItemsService } = context.services;
		const schema = (req as any).schema;

		try {
			const plansService = new ItemsService('plans', {
				schema,
				accountability: { admin: true },
			});
			const planPricesService = new ItemsService('plan_prices', {
				schema,
				accountability: { admin: true },
			});

			const plans = await plansService.readByQuery({
				filter: { status: { _eq: 'published' } },
			});

			const prices = await planPricesService.readByQuery({
				filter: { status: { _eq: 'published' } },
			});

			return res.status(200).json({
				success: true,
				plans,
				prices,
			});
		} catch (error: any) {
			return res.status(500).json({
				success: false,
				message: error.message || 'Failed to fetch pricing data',
			});
		}
	});

	handleCheckout(router, context);
	handleSepayWebhook(router, context);
	handleYoutubeCrawl(router, context);

	router.post('/register', async (req, res) => {
		try {
			const { email, password, first_name, last_name, verification_url } = req.body;

			if (!email || !password) {
				return res.status(400).json({
					success: false,
					error: 'Email and password are required',
				});
			}

			const { UsersService } = context.services;
			const schema = (req as any).schema;

			const userService = new UsersService({
				schema,
				accountability: { admin: true },
			});

			// Check if the email exists before attempting to register
			const existingUsers = await userService.readByQuery({
				filter: { email: { _eq: email } },
				limit: 1,
			});

			if (existingUsers && existingUsers.length > 0) {
				return res.status(409).json({
					success: false,
					error: 'Email already exists',
				});
			}

			// Register the user
			// Register the user
			// Using createOne instead of registerUser to match standard Directus service methods
			const targetRole = context.env?.AUTH_GOOGLE_DEFAULT_ROLE_ID || process.env.AUTH_GOOGLE_DEFAULT_ROLE_ID || 'a963ea32-f5a9-4c7c-a27e-e8983a972d00';
			console.log(`[Register Endpoint] Attempting to create user ${email} with role ${targetRole}`);

			try {
				const newUserId = await userService.createOne({
					email,
					password,
					first_name,
					last_name,
					role: targetRole,
				});
				console.log(`[Register Endpoint] Successfully created user ${email} with ID ${newUserId}`);
			} catch (creationError) {
				console.error(`[Register Endpoint] Error creating user:`, creationError);
				throw creationError;
			}

			return res.status(200).json({
				success: true,
				message: 'User registered successfully',
			});
		} catch (error: any) {
			context.logger.error(`Registration error: ${error}`);

			// Handle different types of errors
			if (
				error.message?.includes('Email address') &&
				error.message?.includes("hasn't been invited")
			) {
				return res.status(403).json({
					success: false,
					error: 'Registration requires an invitation',
				});
			}

			if (
				error.message?.includes('URL') &&
				error.message?.includes("can't be used to verify")
			) {
				return res.status(400).json({
					success: false,
					error: 'Invalid verification URL',
				});
			}

			return res.status(500).json({
				success: false,
				error: 'Registration failed',
				details: error.message || 'Unknown error',
			});
		}
	});

	router.get('/dashboard', async (req, res) => {
		const { ItemsService } = context.services;
		const userId = (req as any).accountability?.user ?? null;

		if (!userId) {
			return res.status(401).json({ success: false, message: 'Unauthorized' });
		}

		try {
			const schema = (req as any).schema;
			const adminAccountability = { admin: true, role: null, user: null } as any;

			const attemptsService = new ItemsService('listening_attempts', {
				schema,
				accountability: adminAccountability,
			});

			const attempts = await attemptsService.readByQuery({
				filter: { user: { _eq: userId } },
				fields: ['id', 'score', 'max_score', 'percentage', 'duration_seconds', 'submitted_at', 'test.title', 'test.type'],
				sort: ['-submitted_at'],
				limit: -1, // Get all to calculate stats
			});

			const testsCompleted = attempts.length;
			let totalDurationSeconds = 0;
			let totalPercentage = 0;

			for (const attempt of attempts) {
				totalDurationSeconds += attempt.duration_seconds || 0;
				totalPercentage += attempt.percentage || 0;
			}

			const accuracyRate = testsCompleted > 0 ? (totalPercentage / testsCompleted) : 0;
			const practiceDurationHours = testsCompleted > 0 ? (totalDurationSeconds / 3600).toFixed(1) : "0";

			// Simple mapping for IELTS Band Score based on accuracy rate (0-100)
			// Generally: 39-40 = 9.0, 37-38 = 8.5, 35-36 = 8.0, 32-34 = 7.5, 30-31 = 7.0, 26-29 = 6.5, 23-25 = 6.0
			// A rough formula based on percentage:
			let averageBandScore = 0;
			if (testsCompleted > 0) {
				const avgCorrect = (accuracyRate / 100) * 40;
				if (avgCorrect >= 39) averageBandScore = 9.0;
				else if (avgCorrect >= 37) averageBandScore = 8.5;
				else if (avgCorrect >= 35) averageBandScore = 8.0;
				else if (avgCorrect >= 32) averageBandScore = 7.5;
				else if (avgCorrect >= 30) averageBandScore = 7.0;
				else if (avgCorrect >= 26) averageBandScore = 6.5;
				else if (avgCorrect >= 23) averageBandScore = 6.0;
				else if (avgCorrect >= 18) averageBandScore = 5.5;
				else if (avgCorrect >= 16) averageBandScore = 5.0;
				else if (avgCorrect >= 13) averageBandScore = 4.5;
				else if (avgCorrect >= 10) averageBandScore = 4.0;
				else averageBandScore = Math.floor(avgCorrect / 4) * 0.5 + 2.5; // roughly for below 4.0

				averageBandScore = Math.min(Math.max(averageBandScore, 0), 9.0);
			}

			const recentPractices = attempts.slice(0, 5).map((a: any) => ({
				id: a.id,
				test_title: a.test?.title || 'Unknown Test',
				test_type: a.test?.type || 'Practice',
				score: a.score,
				max_score: a.max_score,
				percentage: a.percentage,
				submitted_at: a.submitted_at,
				status: (a.percentage >= 50) ? 'Passed' : 'Failed' // Just a dummy status based on score
			}));

			return res.status(200).json({
				success: true,
				data: {
					tests_completed: testsCompleted,
					average_band_score: averageBandScore,
					accuracy_rate: Math.round(accuracyRate),
					practice_duration: practiceDurationHours,
					recent_practices: recentPractices
				}
			});

		} catch (error: any) {
			console.error("Dashboard error:", error);
			return res.status(500).json({
				success: false,
				message: error.message || 'An error occurred fetching dashboard data',
			});
		}
	});

	// =====================================================================
	// POST /listening-lab/attempts -> lưu 1 lượt Check / Show answer của Listening Lab
	// body: {
	//   clip_id: string,
	//   type: 'check' | 'reveal',
	//   answer?: string,
	//   is_correct?: boolean,
	//   attempt_number?: number,
	//   anonymous_id?: string   // id ẩn danh trong cookie, dùng để đếm cả khách
	// }
	// - User đăng nhập: lưu lịch sử vào listening_attempts (dùng cho tiến độ / % hoàn thành)
	// - Lần "check" đầu tiên của mỗi người (user hoặc khách) ở challenge -> learners_count + 1
	// =====================================================================
	router.post('/listening-lab/attempts', async (req, res) => {
		const { database, logger } = context;
		const { ItemsService } = context.services;
		const userId = (req as any).accountability?.user ?? null;
		const body = req.body || {};

		const clipId = body.clip_id;
		const type = body.type === 'reveal' ? 'reveal' : 'check';
		const anonymousId = typeof body.anonymous_id === 'string' && ANON_ID_REGEX.test(body.anonymous_id)
			? body.anonymous_id
			: null;

		if (!isValidUUID(clipId)) {
			return res.status(400).json({ success: false, message: 'Invalid clip_id' });
		}

		// Chấm bài bắt buộc đăng nhập.
		//
		// Chặn ngay tại đây chứ không chỉ dựa vào tầng quota: khối quota bên dưới
		// cố tình fail-open (lỗi quota thì vẫn cho làm bài), nên nếu chỉ dựa vào nó
		// thì một sự cố ở bảng quota sẽ mở lại cửa cho khách.
		if (!userId) {
			return res.status(401).json({
				success: false,
				code: 'LOGIN_REQUIRED',
				message: 'Vui lòng đăng nhập để chấm bài.',
			});
		}

		try {
			await ensureLearnersTable(database, logger);

			const clip = await database('listening_clips').select('id', 'target_id').where('id', clipId).first();
			if (!clip) {
				return res.status(404).json({ success: false, message: 'Clip not found' });
			}

			// Quota gói Free: CHỈ áp cho 'check'. "Show answer" (reveal) không trừ lượt.
			// 1 lượt = lần Check đầu tiên ở mỗi clip trong tháng; thử lại cùng clip miễn phí.
			// Lỗi ở tầng quota thì cho qua (fail-open) và ghi log: chặn nhầm người đang
			// học thật tệ hơn nhiều so với lọt vài lượt miễn phí.
			let quotaState: any = null;
			try {
				quotaState = type === 'check'
					? await consumeQuotaForClip({ database, logger, userId, anonymousId, clipId: clip.id })
					: await getQuotaStatus({ database, logger, userId, anonymousId });
			} catch (quotaError: any) {
				logger?.error?.(`[quota] Bỏ qua kiểm tra lượt do lỗi: ${String(quotaError)}`);
			}

			// Hết lượt -> dừng hẳn: không ghi listening_attempts, không cộng learners_count.
			if (quotaState && !quotaState.allowed) {
				return res.status(402).json({
					success: false,
					code: 'QUOTA_EXCEEDED',
					message: quotaState.requires === 'signup'
						? 'Bạn đã dùng hết lượt luyện tập thử. Đăng ký tài khoản miễn phí để có thêm lượt.'
						: 'Bạn đã dùng hết lượt luyện tập miễn phí của tháng này.',
					data: { quota: publicQuota(quotaState) },
				});
			}

			let attemptId: string | number | null = null;
			if (userId) {
				const attemptsService = new ItemsService('listening_attempts', {
					schema: (req as any).schema,
					accountability: { admin: true, role: null, user: null } as any,
				});
				const attemptNumber = Number.isInteger(body.attempt_number) && body.attempt_number > 0 ? body.attempt_number : 1;
				attemptId = await attemptsService.createOne({
					user_id: userId,
					clip_id: clip.id,
					answer: type === 'reveal' ? '[REVEALED]' : String(body.answer ?? '').slice(0, 1000),
					is_correct: type === 'check' && body.is_correct === true,
					attempt_number: attemptNumber,
					listen_count: 1,
				});
			}

			let counted = false;
			if (type === 'check' && clip.target_id) {
				try {
					counted = await registerLearner(database, clip.target_id, userId, anonymousId);
				} catch (error: any) {
					// 23505 = unique_violation: request song song đã ghi nhận người học này
					if (error?.code !== '23505') throw error;
				}
			}

			const target = clip.target_id
				? await database('listening_targets').select('learners_count').where('id', clip.target_id).first()
				: null;

			return res.status(201).json({
				success: true,
				data: {
					attempt_id: attemptId,
					target_id: clip.target_id ?? null,
					counted,
					learners_count: target ? Number(target.learners_count) : null,
					quota: quotaState ? publicQuota(quotaState) : null,
				},
			});
		} catch (error: any) {
			logger?.error?.(`[listening-lab] Save attempt failed: ${String(error)}`);
			return res.status(500).json({ success: false, message: error.message || 'Server error' });
		}
	});

	// =====================================================================
	// GET /listening-lab/quota -> số lượt luyện tập còn lại trong tháng
	// Chỉ đọc, không trừ lượt. Khách truyền ?anonymous_id=<cookie gl_anon_id>
	// =====================================================================
	router.get('/listening-lab/quota', async (req, res) => {
		const { database, logger } = context;
		const userId = (req as any).accountability?.user ?? null;
		const rawAnon = (req.query as any)?.anonymous_id;
		const anonymousId = typeof rawAnon === 'string' && ANON_ID_REGEX.test(rawAnon) ? rawAnon : null;

		try {
			const state = await getQuotaStatus({ database, logger, userId, anonymousId });
			return res.json({ success: true, data: publicQuota(state) });
		} catch (error: any) {
			logger?.error?.(`[quota] Đọc quota thất bại: ${String(error)}`);
			return res.status(500).json({ success: false, message: error.message || 'Server error' });
		}
	});

	// =====================================================================
	// GET /listening-lab/my-progress -> các challenge user đã luyện + % hoàn thành
	// "Đã luyện"  = có ít nhất 1 lần Check hoặc Show answer ở một clip của challenge
	// percentage = theo progress_mode (xem getProgressMode):
	//   per_clip      -> số clip đã làm đúng / tổng số clip
	//   single_answer -> 100% khi đã làm đúng ít nhất 1 clip, ngược lại 0%
	// =====================================================================
	router.get('/listening-lab/my-progress', async (req, res) => {
		const userId = (req as any).accountability?.user ?? null;
		if (!userId) {
			return res.status(401).json({ success: false, message: 'Unauthorized' });
		}

		const { database } = context;
		try {
			const result = await database.raw(
				`
				WITH totals AS (
					SELECT target_id, COUNT(*)::int AS total_clips
					FROM listening_clips
					WHERE target_id IS NOT NULL
					GROUP BY target_id
				),
				mine AS (
					SELECT c.target_id,
						COUNT(DISTINCT c.id) FILTER (WHERE a.is_correct IS TRUE)::int AS completed_clips,
						COUNT(*) FILTER (WHERE a.answer IS DISTINCT FROM '[REVEALED]')::int AS checks,
						COUNT(*) FILTER (WHERE a.is_correct IS TRUE)::int AS correct_checks,
						COUNT(*) FILTER (WHERE a.answer = '[REVEALED]')::int AS reveals,
						MIN(a.date_created) AS first_practiced_at,
						MAX(a.date_created) AS last_practiced_at
					FROM listening_attempts a
					JOIN listening_clips c ON c.id = a.clip_id
					WHERE a.user_id = ? AND c.target_id IS NOT NULL
					GROUP BY c.target_id
				),
				thumbs AS (
					SELECT DISTINCT ON (c.target_id) c.target_id, sv.title AS video_title, sv.thumbnail_url
					FROM listening_clips c
					LEFT JOIN source_videos sv ON sv.id = c.source_video_id
					WHERE c.target_id IN (SELECT target_id FROM mine)
					ORDER BY c.target_id, c.date_created NULLS LAST, c.id
				),
				types AS (
					SELECT tt.listening_targets_id AS target_id,
						jsonb_agg(DISTINCT jsonb_build_object('id', lt.id, 'name', lt.name, 'slug', lt.slug)) AS types
					FROM listening_targets_listening_types tt
					JOIN listening_types lt ON lt.id = tt.listening_types_id
					WHERE tt.listening_targets_id IN (SELECT target_id FROM mine)
					GROUP BY tt.listening_targets_id
				)
				SELECT t.id AS target_id, t.text, t.difficulty, t.learners_count,
					COALESCE(totals.total_clips, 0) AS total_clips,
					mine.completed_clips, mine.checks, mine.correct_checks, mine.reveals,
					mine.first_practiced_at, mine.last_practiced_at,
					thumbs.video_title, thumbs.thumbnail_url,
					COALESCE(types.types, '[]'::jsonb) AS types
				FROM mine
				JOIN listening_targets t ON t.id = mine.target_id
				LEFT JOIN totals ON totals.target_id = mine.target_id
				LEFT JOIN thumbs ON thumbs.target_id = mine.target_id
				LEFT JOIN types ON types.target_id = mine.target_id
				ORDER BY mine.last_practiced_at DESC
				`,
				[userId],
			);

			const challenges = (result.rows || []).map((row: any) => {
				const types = row.types || [];
				const progressMode = getProgressMode(types);
				const totalClips = Number(row.total_clips) || 0;
				const completedClips = Math.min(Number(row.completed_clips) || 0, totalClips);

				let percentage: number;
				let isCompleted: boolean;
				if (progressMode === 'per_clip') {
					percentage = totalClips > 0 ? Math.round((completedClips / totalClips) * 100) : 0;
					isCompleted = totalClips > 0 && completedClips >= totalClips;
				} else {
					isCompleted = completedClips > 0;
					percentage = isCompleted ? 100 : 0;
				}

				return {
					target_id: row.target_id,
					text: row.text,
					difficulty: row.difficulty,
					types,
					progress_mode: progressMode,
					video_title: row.video_title,
					thumbnail_url: row.thumbnail_url,
					learners_count: Number(row.learners_count) || 0,
					total_clips: totalClips,
					completed_clips: completedClips,
					percentage,
					status: isCompleted ? 'completed' : 'in_progress',
					checks: Number(row.checks) || 0,
					correct_checks: Number(row.correct_checks) || 0,
					reveals: Number(row.reveals) || 0,
					first_practiced_at: row.first_practiced_at,
					last_practiced_at: row.last_practiced_at,
				};
			});

			const totalChecks = challenges.reduce((sum: number, c: any) => sum + c.checks, 0);
			const totalCorrect = challenges.reduce((sum: number, c: any) => sum + c.correct_checks, 0);
			const summary = {
				challenges_practiced: challenges.length,
				challenges_completed: challenges.filter((c: any) => c.status === 'completed').length,
				average_percentage: challenges.length > 0
					? Math.round(challenges.reduce((sum: number, c: any) => sum + c.percentage, 0) / challenges.length)
					: 0,
				clips_completed: challenges.reduce((sum: number, c: any) => sum + c.completed_clips, 0),
				accuracy_rate: totalChecks > 0 ? Math.round((totalCorrect / totalChecks) * 100) : 0,
				last_practiced_at: challenges[0]?.last_practiced_at ?? null,
			};

			return res.status(200).json({ success: true, data: { summary, challenges } });
		} catch (error: any) {
			console.error('Listening Lab my-progress error:', error);
			return res.status(500).json({ success: false, error: error.message || 'Server error' });
		}
	});

	router.get('/listening-lab/progress/clips', async (req, res) => {
		const userId = (req as any).accountability?.user ?? null;
		if (!userId) {
			return res.status(200).json({ success: true, data: [] });
		}
		
		const { database } = context;
		try {
			const completedClips = await database('listening_attempts')
				.select('clip_id')
				.where('user_id', userId)
				.andWhere('is_correct', true)
				.distinct();
				
			const result = completedClips.map((row: any) => row.clip_id).filter(Boolean);
			return res.status(200).json({ success: true, data: result });
		} catch (error: any) {
			console.error("Listening Lab progress error:", error);
			return res.status(500).json({ success: false, error: error.message || 'Server error' });
		}
	});

	router.get('/listening-lab/progress/targets', async (req, res) => {
		const userId = (req as any).accountability?.user ?? null;
		if (!userId) {
			return res.status(200).json({ success: true, data: {} });
		}

		const { database } = context;
		try {
			// Tổng số clips per target
			const totalRows = await database('listening_clips')
				.select('target_id')
				.count('id as total')
				.groupBy('target_id');

			// Số clips đã hoàn thành per target (distinct clip_id có is_correct = true)
			const completedRows = await database('listening_attempts')
				.join('listening_clips', 'listening_attempts.clip_id', 'listening_clips.id')
				.select('listening_clips.target_id')
				.countDistinct('listening_attempts.clip_id as completed')
				.where('listening_attempts.user_id', userId)
				.andWhere('listening_attempts.is_correct', true)
				.groupBy('listening_clips.target_id');

			const completedMap: Record<string, number> = {};
			for (const row of completedRows) {
				if (row.target_id) completedMap[row.target_id] = Number(row.completed);
			}

			const result: Record<string, { completed: number; total: number }> = {};
			for (const row of totalRows) {
				if (row.target_id) {
					result[row.target_id] = {
						completed: completedMap[row.target_id] || 0,
						total: Number(row.total),
					};
				}
			}

			return res.status(200).json({ success: true, data: result });
		} catch (error: any) {
			console.error("Listening Lab progress/targets error:", error);
			return res.status(500).json({ success: false, error: error.message || 'Server error' });
		}
	});

	// GET /listening-lab/stats -> { [target_id]: learners_count }
	router.get('/listening-lab/stats', async (_req, res) => {
		const { database, logger } = context;
		try {
			await ensureLearnersTable(database, logger);
			const rows = await database('listening_targets').select('id', 'learners_count');
			const result: Record<string, number> = {};
			for (const row of rows) {
				result[row.id] = Number(row.learners_count) || 0;
			}
			return res.status(200).json({ success: true, data: result });
		} catch (error: any) {
			console.error("Listening Lab stats error:", error);
			return res.status(500).json({ success: false, error: error.message || 'Server error' });
		}
	});

	router.get('/', (_req, res) => res.send('v1 endpoint is up and running!'));
});
