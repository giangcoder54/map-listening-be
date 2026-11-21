import { defineEndpoint } from '@directus/extensions-sdk';
import { handleCheckout } from './checkout';
import { handleSepayWebhook } from './sepay';
import { handlePolar } from './polar';
import { handleYoutubeCrawl } from './youtube';
import { handleVideoTranscripts } from './videoTranscripts';
import { handleYoutubeChannel } from './youtubeChannel';
import { ensurePaymentSchema } from '../lib/paymentSchema';
import { registerLessonRoutes } from './lessonRoutes';
import { registerRunRoutes } from './runRoutes';
import { ensurePhraseRequestsTable, handlePhraseRequest } from '../lib/phraseRequests';
import { registerGrowthRoutes } from './growthRoutes';
import { registerEngagementRoutes } from './engagementRoutes';
import { registerPlacementRoutes } from './placementRoutes';
import { registerBlogRoutes } from './blogRoutes';
import { registerOpsRoutes } from './opsRoutes';
import { registerAdminGrowthRoutes } from './adminGrowthRoutes';
import { registerAdminDashboardRoutes } from './adminDashboardRoutes';
import { registerFeedbackRoutes } from './feedbackRoutes';
import { registerAdminLessonRoutes } from './adminLessonRoutes';
import { registerAdminVietsubRoutes } from './adminVietsubRoutes';
import { registerAdminRuleRoutes } from './adminRuleRoutes';
import { registerAdminPracticeRoutes } from './adminPracticeRoutes';
import { registerAdminDykRoutes } from './adminDykRoutes';
import { registerDykRoutes } from './dykRoutes';
import { registerEventRoutes } from './eventRoutes';
import { registerPhraseRoutes } from './phraseRoutes';
import { registerAdminPhraseRoutes } from './adminPhraseRoutes';
import { registerAdminLibraryRoutes } from './adminLibraryRoutes';
import { registerExtensiveRoutes } from './extensiveRoutes';
import { registerDictRoutes } from './dictRoutes';
import { registerAdminExtensiveRoutes } from './adminExtensiveRoutes';
import { registerIntensiveRoutes } from './intensiveRoutes';
import { registerWordsRoutes } from './wordsRoutes';
import { registerProfileRoutes } from './profileRoutes';
import { registerFriendsRoutes } from './friendsRoutes';
import { registerReviewRoutes } from './reviewRoutes';
import { registerInterestRoutes } from './interestRoutes';
import { registerAdminIntensiveRoutes } from './adminIntensiveRoutes';
import { staffRole } from '../lib/staff';
import { clientIp, isLimited } from '../lib/rateLimit';
import { verifyTurnstile } from '../lib/turnstile';


export default defineEndpoint((router, context) => {
	// Chuẩn bị bảng ngay khi Directus load extension
	ensurePaymentSchema(context.database, context.logger).catch(() => {});
	ensurePhraseRequestsTable(context.database, context.logger).catch(() => {});
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
	handlePolar(router, context);
	// Admin pages of the site: is the signed-in user an admin, a content editor (lib/staff.ts) or neither?
	router.get('/admin/me', (req: any, res: any) => {
		const role = staffRole(req.accountability);
		res.json({ success: true, data: { admin: role === 'admin', role } });
	});

	handleYoutubeCrawl(router, context);
	handleVideoTranscripts(router, context);
	handleYoutubeChannel(router, context);

	router.post('/register', async (req, res) => {
		try {
			const { email, password } = req.body || {};
			// Honeypot: a field people never see. A bot that fills it gets a fake success.
			if (typeof req.body?.website === 'string' && req.body.website.trim()) {
				return res.status(200).json({ success: true, message: 'User registered successfully' });
			}
			// 5 sign-ups per hour per IP (mass account creation)
			if (isLimited('register', clientIp(req), 5, 3600000)) {
				return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', error: 'Too many sign-ups. Please try again later.' });
			}
			// Cloudflare Turnstile: the token the sign-up form's widget made (skipped when no secret is set)
			if (!(await verifyTurnstile(req.body?.turnstile_token, clientIp(req), context.logger))) {
				return res.status(400).json({ success: false, code: 'CAPTCHA_FAILED', error: 'Captcha check failed' });
			}
			const name = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 80) : undefined) || undefined;
			const first_name = name(req.body?.first_name);
			const last_name = name(req.body?.last_name);

			if (!email || !password) {
				return res.status(400).json({
					success: false,
					code: 'MISSING_FIELDS',
					error: 'Email and password are required',
				});
			}
			// A malformed address used to reach Directus and come back as a 500 "server error"
			if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i.test(email.trim())) {
				return res.status(400).json({ success: false, code: 'INVALID_EMAIL', error: 'Invalid email address' });
			}
			if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
				return res.status(400).json({ success: false, code: 'WEAK_PASSWORD', error: 'Password must be 8 to 128 characters' });
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
					code: 'EMAIL_EXISTS',
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

			// Directus refused the payload (an address it does not accept, a password policy)
			const directusCode = error?.code || error?.errors?.[0]?.extensions?.code;
			if (directusCode === 'FAILED_VALIDATION' || directusCode === 'INVALID_PAYLOAD' || error?.status === 400) {
				const field = String(error?.extensions?.field || error?.errors?.[0]?.extensions?.field || error?.message || '');
				return res.status(400).json({
					success: false,
					code: /password/i.test(field) ? 'WEAK_PASSWORD' : 'INVALID_EMAIL',
					error: 'Invalid registration details',
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

	// Listening Lab: groups > skills > lessons (see ./lessonRoutes.ts)
	registerLessonRoutes(router, context);
	registerRunRoutes(router, context);

	// Growth: referral / affiliate / coupons, XP + review, placement test,
	// blog, ops (health, error reports, contact) and their admin. See docs/growth-roadmap.md (web repo).
	registerGrowthRoutes(router, context);
	registerEngagementRoutes(router, context);
	registerPlacementRoutes(router, context);
	registerBlogRoutes(router, context);
	registerOpsRoutes(router, context);
	registerAdminGrowthRoutes(router, context);
	registerAdminDashboardRoutes(router, context);
	registerFeedbackRoutes(router, context);
	registerAdminLessonRoutes(router, context);
	registerAdminVietsubRoutes(router, context);
	registerAdminRuleRoutes(router, context);
	registerAdminPracticeRoutes(router, context);
	registerEventRoutes(router, context);
	registerDykRoutes(router, context);
	registerAdminDykRoutes(router, context);
	registerPhraseRoutes(router, context);
	registerAdminPhraseRoutes(router, context);
	registerAdminLibraryRoutes(router, context);
	registerExtensiveRoutes(router, context);
	registerDictRoutes(router, context);
	registerAdminExtensiveRoutes(router, context);
	registerIntensiveRoutes(router, context);
	registerWordsRoutes(router, context);
	registerProfileRoutes(router, context);
	registerFriendsRoutes(router, context);
	registerReviewRoutes(router, context);
	registerInterestRoutes(router, context);
	registerAdminIntensiveRoutes(router, context);

	// =====================================================================
	// POST /phrase-requests -> gợi ý cụm từ muốn có bài luyện (phải đăng nhập, không lưu ai gửi)
	// body: { phrase: string, note?: string, website?: string (honeypot) }
	// =====================================================================
	router.post('/phrase-requests', (req, res) => handlePhraseRequest(req, res, context.database, context.logger));

	router.get('/', (_req, res) => res.send('v1 endpoint is up and running!'));
});
