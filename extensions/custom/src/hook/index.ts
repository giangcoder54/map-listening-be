import { defineHook } from '@directus/extensions-sdk';
import { registerCronjob } from './cronjob_check_transactions/cronjob_check_transactions';
import { calculateEndDate, activatePremiumForUser } from '../utils';

export default defineHook((registerEvents, context) => {
	const { filter, action } = registerEvents;
	const { services } = context;
	const { ItemsService } = services;

	// Register cronjob check transactions
	registerCronjob(registerEvents, context);

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

	filter('items.create', async (payload: any, meta, hookContext) => {
		if (meta.collection === 'listening_tests' && payload.title && !payload.slug) {
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
