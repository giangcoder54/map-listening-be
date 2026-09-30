import { defineHook } from '@directus/extensions-sdk';
import { registerCronjob } from './cronjob_check_transactions/cronjob_check_transactions';
import { calculateEndDate, activatePremiumForUser } from '../utils';
import { registerSepayRawBody } from './sepayRawBody';

export default defineHook((registerEvents, context) => {
	const { filter, action } = registerEvents;
	const { services } = context;
	const { ItemsService } = services;

	// Giữ raw body cho webhook SePay (bắt buộc để xác thực HMAC-SHA256)
	registerSepayRawBody(registerEvents, context);

	// Register cronjob check transactions
	// registerCronjob(registerEvents, context);

	action('purchase_histories.items.update', async (meta, hookContext) => {
		if (meta.payload && meta.payload.status === 'published' && meta.keys && meta.keys.length > 0) {
			try {
				const purchaseHistoryService = new ItemsService('purchase_histories', {
					schema: hookContext.schema,
					accountability: { admin: true },
				});
				const usersService = new ItemsService('directus_users', {
					schema: hookContext.schema,
					accountability: { admin: true },
				});

				for (const id of meta.keys) {
					const purchase = await purchaseHistoryService.readOne(id, { fields: ['*', 'user.*'] });
					if (purchase && purchase.status === 'published') {
						const customerId = typeof purchase.user === 'object' ? purchase.user?.id : purchase.user;
						if (customerId) {
							const amount = purchase.amount || 0;
							const cycle = purchase.billing_cycle || (amount > 500000 ? 12 : 1);
							const endDate = calculateEndDate(new Date(), cycle);
							await activatePremiumForUser(
								customerId,
								endDate,
								purchase.type || 'pro',
								usersService,
								context.database,
								context.logger
							);
						}
					}
				}
			} catch (error: any) {
				context.logger?.error(`[Manual Update] Error processing premium activation: ${String(error)}`);
			}
		}
	});

	// New lesson: short_id (URL), a unique slug from its text, and last place in its skill
	filter('listening_lessons.items.create', async (payload: any, _meta, hookContext) => {
		const db = hookContext.database;
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

	// Tự động tạo slug từ title khi tạo mới listening_test
	filter('listening_tests.items.create', async (payload: any, _meta, hookContext) => {
		if (payload.title && !payload.slug) {
			const slug = payload.title
				.toLowerCase()
				.normalize('NFD')
				.replace(/[\u0300-\u036f]/g, '')
				.replace(/đ/g, 'd')
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-+|-+$/g, '');

			let uniqueSlug = slug || 'test';
			let counter = 1;

			const itemsService = new ItemsService('listening_tests', {
				schema: hookContext.schema,
				accountability: hookContext.accountability,
			});

			while (true) {
				const existing = await itemsService.readByQuery({
					filter: { slug: { _eq: uniqueSlug } },
					limit: 1,
				});

				if (existing && existing.length > 0) {
					uniqueSlug = `${slug}-${counter}`;
					counter++;
				} else {
					break;
				}
			}

			payload.slug = uniqueSlug;
		}
		return payload;
	});
});
