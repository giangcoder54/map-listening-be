import { defineHook } from '@directus/extensions-sdk';
import { registerCronjob } from './cronjob_check_transactions/cronjob_check_transactions';
import { calculateEndDate, activatePremiumForUser, purchaseCycle } from '../utils';
import { registerSepayRawBody } from './sepayRawBody';
import { downgradeExpiredPremium } from '../lib/premium';
import { registerLessonStep1Check } from './lessonStep1Check';
import { registerLessonTextCase } from './lessonTextCase';
import { registerEditorScope } from './editorScope';
import { registerGoogleAvatar } from './googleAvatar';
import { registerDefaultRole } from './defaultRole';
import { recordConversion, voidConversion } from '../lib/referrals';
import { refreshGrowthConfig } from '../lib/growthConfig';

export default defineHook((registerEvents, context) => {
	const { filter, action } = registerEvents;
	const { services } = context;
	const { ItemsService } = services;

	// Giữ raw body cho webhook SePay (bắt buộc để xác thực HMAC-SHA256)
	registerSepayRawBody(registerEvents, context);

	// Google sign-in: keep their Google profile picture (avatar_url)
	registerGoogleAvatar(registerEvents);

	// User made without a role (e.g. in the Directus admin): Free User
	registerDefaultRole(registerEvents, context);

	// Mỗi giờ: Premium hết hạn -> role Free User
	registerEvents.schedule('15 * * * *', async () => { await downgradeExpiredPremium(context); });

	// Referral / affiliate numbers edited in Directus (growth_settings): no restart needed
	refreshGrowthConfig(context.database, context.logger);
	registerEvents.schedule('* * * * *', () => refreshGrowthConfig(context.database, context.logger));
	action('growth_settings.items.create', () => refreshGrowthConfig(context.database, context.logger));
	action('growth_settings.items.update', () => refreshGrowthConfig(context.database, context.logger));

	// Register cronjob check transactions
	// registerCronjob(registerEvents, context);

	action('purchase_histories.items.update', async (meta, hookContext) => {
		if (meta.payload && meta.payload.status === 'published' && meta.keys && meta.keys.length > 0) {
			try {
				const purchaseHistoryService = new ItemsService('purchase_histories', {
					schema: hookContext.schema,
					accountability: { admin: true },
				});
				// UsersService: the role change clears the permission cache (see utils.ts)
				const usersService = new services.UsersService({
					schema: hookContext.schema,
					accountability: { admin: true },
				});

				for (const id of meta.keys) {
					const purchase = await purchaseHistoryService.readOne(id, { fields: ['*', 'user.*'] });
					if (purchase && purchase.status === 'published') {
						const customerId = typeof purchase.user === 'object' ? purchase.user?.id : purchase.user;
						if (customerId) {
							const amount = purchase.amount || 0;
							const cycle = purchaseCycle(purchase.billing_cycle, amount);
							const endDate = calculateEndDate(new Date(), cycle);
							await activatePremiumForUser(
								customerId,
								endDate,
								purchase.type || 'pro',
								usersService,
								context.database,
								context.logger
							);
							// Referred buyer: reward the inviter / commission for the affiliate
							await recordConversion(id, context, hookContext.schema).catch((error: any) =>
								context.logger?.error(`[referral] Conversion of order ${id} failed: ${String(error)}`));
						}
					}
				}
			} catch (error: any) {
				context.logger?.error(`[Manual Update] Error processing premium activation: ${String(error)}`);
			}
		}
		// Order refunded by hand (bank transfer): its commission no longer counts
		if (meta.payload && meta.payload.status === 'refunded' && meta.keys?.length) {
			await voidConversion(context.database, meta.keys.map(String)).catch(() => {});
		}
	});

	// A published lesson must keep a Step 1 clip, else the site hides it
	registerLessonStep1Check(registerEvents);
	registerLessonTextCase(registerEvents);
	// Content editors: own lessons only, never the premium status (see the migration too)
	registerEditorScope(registerEvents);

	// The author of a lesson never changes (editors' numbers on /admin/lessons count on it)
	filter('listening_lessons.items.update', (payload: any) => {
		if (payload && typeof payload === 'object') delete payload.user_created;
		return payload;
	});

	// New lesson: short_id (URL), a unique slug from its text, last place in its skill, and
	// who made it (the signed-in account, whatever the request says)
	filter('listening_lessons.items.create', async (payload: any, _meta, hookContext) => {
		const db = hookContext.database;
		payload.user_created = hookContext.accountability?.user ?? null;
		if (!payload.short_id) {
			const { nanoid } = await import('nanoid');
			payload.short_id = nanoid(8);
		}
		if (typeof payload.text === 'string' && payload.text.trim() && !payload.slug) {
			const base = payload.text.trim().toLowerCase()
				.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
				.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lesson';
			let slug = base;
			for (let n = 1; await db('listening_lessons').where('slug', slug).first('id'); n++) slug = `${base}-${n}`;
			payload.slug = slug;
		}
		const skillId = typeof payload.skill_id === 'object' ? payload.skill_id?.id : payload.skill_id;
		if (payload.sort == null && skillId) {
			const row = await db('listening_lessons').where('skill_id', skillId).max('sort as max').first();
			payload.sort = (Number(row?.max) || 0) + 1;
		}
		return payload;
	});
});
