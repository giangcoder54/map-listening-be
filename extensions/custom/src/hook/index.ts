import { defineHook } from '@directus/extensions-sdk';
import { registerSepayRawBody } from './sepayRawBody';
import { registerLessonReadyCheck } from './lessonReadyCheck';
import { registerLessonTextCase } from './lessonTextCase';
import { registerEditorScope } from './editorScope';
import { registerGoogleAvatar } from './googleAvatar';
import { registerDefaultRole } from './defaultRole';
import { recordConversion, voidConversion } from '../lib/referrals';
import { refreshGrowthConfig } from '../lib/growthConfig';
import { creditCoinOrder } from '../lib/gemOrders';
import { sweepRooms } from '../lib/rooms';
import { sweepCoop } from '../lib/coop';
import { drop as coopDrop, startTicker as startCoopTicker, subscribe as coopSubscribe } from '../lib/coopHub';
import { nightlyCoinJob } from '../lib/coinLedger';
import { notifyAdmin } from '../lib/telegram';

export default defineHook((registerEvents, context) => {
	const { filter, action } = registerEvents;

	// Giữ raw body cho webhook SePay (bắt buộc để xác thực HMAC-SHA256)
	registerSepayRawBody(registerEvents, context);

	// Google sign-in: keep their Google profile picture (avatar_url)
	registerGoogleAvatar(registerEvents);

	// User made without a role (e.g. in the Directus admin): Free User
	registerDefaultRole(registerEvents, context);

	// Referral / affiliate numbers edited in Directus (growth_settings): no restart needed
	refreshGrowthConfig(context.database, context.logger);
	registerEvents.schedule('* * * * *', () => refreshGrowthConfig(context.database, context.logger));
	action('growth_settings.items.create', () => refreshGrowthConfig(context.database, context.logger));
	action('growth_settings.items.update', () => refreshGrowthConfig(context.database, context.logger));

	// Kim cương: totals per day for the admin stats + ledger check, at 03:00 Vietnam time (lib/coinLedger.ts)
	registerEvents.schedule('40 * * * *', async () => { await nightlyCoinJob(context.database, notifyAdmin, context.logger); });

	// Phong Dau: rooms past their deadline give the fees back or pay out, every 10 minutes (lib/rooms.ts)
	// Luyện cùng: rooms push their state over Directus's WebSocket (the browser sends { type: 'coop.sub', room })
	startCoopTicker(context.database, context.logger);
	action('websocket.message', ({ message, client }: any) => {
		if (message?.type === 'coop.sub' && /^[0-9a-f-]{36}$/i.test(String(message.room || ''))) coopSubscribe(context.database, client, String(message.room), Number(message.since) || 0, message.lang).catch(() => null);
		else if (message?.type === 'coop.unsub') coopDrop(client);
	});
	action('websocket.close', ({ client }: any) => coopDrop(client));
	registerEvents.schedule('*/10 * * * *', async () => { await sweepCoop(context.database).catch(() => 0); await sweepRooms(context.database).catch((e: any) => context.logger?.warn?.(`[rooms] sweep failed: ${String(e)}`)); });

	// An order marked paid (by hand in the admin, or by a webhook): its Kim cương are paid once
	action('purchase_histories.items.update', async (meta) => {
		if (meta.payload && meta.payload.status === 'published' && meta.keys?.length) {
			for (const id of meta.keys.map(String)) {
				await creditCoinOrder(context.database, id).catch((error: any) =>
					context.logger?.error(`[gems] Credit of order ${id} failed: ${String(error)}`));
				await recordConversion(id, context).catch((error: any) =>
					context.logger?.error(`[referral] Conversion of order ${id} failed: ${String(error)}`));
			}
		}
		// Order refunded by hand (bank transfer): its commission no longer counts
		if (meta.payload && meta.payload.status === 'refunded' && meta.keys?.length) {
			await voidConversion(context.database, meta.keys.map(String)).catch(() => {});
		}
	});

	// A published lesson must keep a Step 1 clip, else the site hides it
	registerLessonReadyCheck(registerEvents);
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
