import { defineEndpoint } from '@directus/extensions-sdk';
import { handleCheckout } from './checkout';


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

export default defineEndpoint((router, context) => {
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

	router.get('/', (_req, res) => res.send('v1 endpoint is up and running!'));
});
