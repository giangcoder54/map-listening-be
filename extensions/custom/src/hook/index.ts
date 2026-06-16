import { defineHook } from '@directus/extensions-sdk';
import { registerCronjob } from './cronjob_check_transactions/cronjob_check_transactions';

export default defineHook((registerEvents, context) => {
	const { filter } = registerEvents;
	const { services } = context;
	const { ItemsService } = services;

	// Register cronjob check transactions
	registerCronjob(registerEvents, context);

	filter('items.create', async (payload: any, meta, context) => {
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
				schema: context.schema,
				accountability: context.accountability,
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
