import { defineEndpoint } from '@directus/extensions-sdk';
import { handleCheckout } from './checkout';
import { handleSepayWebhook } from './sepay';
import { handlePolar } from './polar';
import { handleYoutubeCrawl } from './youtube';
import { handleVideoTranscripts } from './videoTranscripts';
import { ensurePaymentSchema } from '../lib/paymentSchema';
import { registerLessonRoutes } from './lessonRoutes';
import { ensurePhraseRequestsTable, handlePhraseRequest } from '../lib/phraseRequests';
import { registerGrowthRoutes } from './growthRoutes';
import { registerEngagementRoutes } from './engagementRoutes';
import { registerPlacementRoutes } from './placementRoutes';
import { registerBlogRoutes } from './blogRoutes';
import { registerOpsRoutes } from './opsRoutes';
import { registerAdminGrowthRoutes } from './adminGrowthRoutes';


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
	// Admin pages of the site: is the signed-in user a Directus admin?
	router.get('/admin/me', (req: any, res: any) => res.json({ success: true, data: { admin: !!req.accountability?.admin } }));

	handleYoutubeCrawl(router, context);
	handleVideoTranscripts(router, context);

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

	// Listening Lab: groups > skills > lessons (see ./lessonRoutes.ts)
	registerLessonRoutes(router, context);

	// Growth: referral / affiliate / coupons, XP + review, placement test,
	// blog, ops (health, error reports, contact) and their admin. See docs/growth-roadmap.md (web repo).
	registerGrowthRoutes(router, context);
	registerEngagementRoutes(router, context);
	registerPlacementRoutes(router, context);
	registerBlogRoutes(router, context);
	registerOpsRoutes(router, context);
	registerAdminGrowthRoutes(router, context);

	// =====================================================================
	// POST /phrase-requests -> gợi ý cụm từ muốn có bài luyện (phải đăng nhập, không lưu ai gửi)
	// body: { phrase: string, note?: string, website?: string (honeypot) }
	// =====================================================================
	router.post('/phrase-requests', (req, res) => handlePhraseRequest(req, res, context.database, context.logger));

	router.get('/', (_req, res) => res.send('v1 endpoint is up and running!'));
});
