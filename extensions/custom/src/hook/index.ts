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

	// learners_count của listening_targets được cập nhật trong endpoint POST /v1/listening-lab/attempts
	// (chỉ +1 cho lần Check đầu tiên của mỗi người), không cộng theo từng attempt nữa.

	// Tự động tạo short_id, slug, và name khi tạo mới listening_target
	filter('listening_targets.items.create', async (payload: any, _meta, hookContext) => {
		const itemsService = new ItemsService('listening_targets', {
			schema: hookContext.schema,
			accountability: { admin: true },
		});

		// Viết hoa chữ cái đầu tiên của text
		if (typeof payload.text === 'string' && payload.text.length > 0) {
			payload.text = payload.text.charAt(0).toUpperCase() + payload.text.slice(1);
		}

		// Tạo short_id ngẫu nhiên 8 ký tự
		if (!payload.short_id) {
			const { nanoid } = await import('nanoid');
			payload.short_id = nanoid(8);
		}

		// Tạo slug từ text (từ cần nghe)
		if (payload.text && !payload.slug) {
			const baseSlug = payload.text
				.toLowerCase()
				.normalize('NFD')
				.replace(/[\u0300-\u036f]/g, '')
				.replace(/đ/g, 'd')
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-+|-+$/g, '');

			let uniqueSlug = baseSlug || 'target';
			let counter = 1;

			while (true) {
				const existing = await itemsService.readByQuery({
					filter: { slug: { _eq: uniqueSlug } },
					limit: 1,
				});

				if (existing && existing.length > 0) {
					uniqueSlug = `${baseSlug}-${counter}`;
					counter++;
				} else {
					break;
				}
			}

			payload.slug = uniqueSlug;
		}

		// Tự động đặt name theo thứ tự "Challenge N" trong cùng type
		if (!payload.name) {
			// Lấy type đầu tiên từ payload (M2M qua junction table)
			let typeId: string | null = null;
			if (Array.isArray(payload.types) && payload.types.length > 0) {
				const firstType = payload.types[0];
				if (typeof firstType === 'string') {
					typeId = firstType;
				} else if (firstType?.listening_types_id) {
					typeId = typeof firstType.listening_types_id === 'string'
						? firstType.listening_types_id
						: firstType.listening_types_id?.id ?? null;
				}
			}

			let count = 0;
			if (typeId) {
				// Đếm số targets đã có trong cùng type qua junction table
				const junctionService = new ItemsService('listening_targets_listening_types', {
					schema: hookContext.schema,
					accountability: { admin: true },
				});
				const result = await junctionService.readByQuery({
					filter: { listening_types_id: { _eq: typeId } },
					aggregate: { count: ['id'] },
				});
				count = Number(result?.[0]?.count?.id ?? 0);
			} else {
				// Fallback: không có type thì đếm tổng
				const result = await itemsService.readByQuery({
					aggregate: { count: ['id'] },
				});
				count = Number(result?.[0]?.count?.id ?? 0);
			}

			payload.name = `Challenge ${count + 1}`;
		}

		return payload;
	});

	// Viết hoa chữ cái đầu tiên của text khi cập nhật listening_target
	filter('listening_targets.items.update', async (payload: any) => {
		if (typeof payload.text === 'string' && payload.text.length > 0) {
			payload.text = payload.text.charAt(0).toUpperCase() + payload.text.slice(1);
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
