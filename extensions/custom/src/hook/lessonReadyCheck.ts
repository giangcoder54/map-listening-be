/**
 * A lesson goes from draft to published only once it is ready (lib/readiness.ts): its
 * pool, focus, choices, explanation and sounds. Saving it as published before that is
 * refused with the first thing missing, instead of the lesson playing half empty.
 * A lesson already published can still be edited (older lessons predate the checks).
 */
import { readinessOf } from '../lib/readiness';

const refused = (text: string) =>
	Object.assign(new Error(text), {
		name: 'DirectusError',
		code: 'INVALID_PAYLOAD',
		status: 400,
		extensions: { reason: text },
	});

export function registerLessonReadyCheck({ filter }: any) {
	filter('listening_lessons.items.create', async (payload: any) => {
		// A new lesson has no clip yet: it starts as a draft
		if (payload?.status === 'published') throw refused('A new lesson starts as a draft: add its clips, then publish it.');
		return payload;
	});

	filter('listening_lessons.items.update', async (payload: any, meta: any, { database }: any) => {
		if (payload?.status !== 'published') return payload;
		for (const key of meta.keys || []) {
			const lesson = await database('listening_lessons').select('status').where('id', key).first();
			if (lesson?.status === 'published') continue;
			const ready = await readinessOf(database, key);
			const missing = ready.checks.find((c) => !c.ok);
			if (missing) throw refused(`Not ready to publish: ${missing.text} (${missing.have}/${missing.need}). Save it as a draft until then.`);
		}
		return payload;
	});
}
