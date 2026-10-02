/**
 * A published lesson needs at least one Step 1 clip (step = 'type'): without it the site
 * hides the lesson (see `playable` in lib/lessons.ts). Saving such a lesson as published
 * in Directus is refused with a message, instead of it silently disappearing.
 *
 * The clips of the lesson after the save are worked out from the database plus the
 * `clips` of the payload, in either form Directus sends: a full list, or
 * { create, update, delete }.
 */

const refused = (text: string) =>
	Object.assign(new Error(text), {
		name: 'DirectusError',
		code: 'INVALID_PAYLOAD',
		status: 400,
		extensions: { reason: text },
	});

const MESSAGE = 'A published lesson needs at least one clip in "1 · Type the phrase". Add one, or save the lesson as Draft.';

type ClipChange = { id?: string; step?: string | null };

/** Step of every clip of the lesson once `clips` (the payload field) is applied. */
function stepsAfter(existing: Map<string, string | null>, clips: any): (string | null)[] {
	if (clips == null) return [...existing.values()];

	const steps = new Map(existing);
	const upsert = (c: ClipChange | string, i: number) => {
		if (typeof c === 'string' || typeof c === 'number') return;
		if (c.id != null && steps.has(String(c.id))) {
			if ('step' in c) steps.set(String(c.id), c.step ?? null);
		} else {
			steps.set(c.id != null ? String(c.id) : `new-${i}`, c.step ?? null);
		}
	};

	if (Array.isArray(clips)) {
		// Full list: clips left out are removed from the lesson
		const kept = new Set(clips.map((c: any) => String(typeof c === 'object' ? c?.id ?? '' : c)));
		for (const id of [...steps.keys()]) if (!kept.has(id)) steps.delete(id);
		clips.forEach(upsert);
	} else {
		for (const id of clips.delete || []) steps.delete(String(typeof id === 'object' ? id?.id : id));
		(clips.update || []).forEach(upsert);
		(clips.create || []).forEach((c: ClipChange, i: number) => upsert({ ...c, id: undefined }, i));
	}
	return [...steps.values()];
}

async function clipSteps(db: any, lessonId: string) {
	const rows = await db('listening_clips').select('id', 'step').where('lesson_id', lessonId);
	return new Map<string, string | null>(rows.map((r: any) => [String(r.id), r.step]));
}

export function registerLessonStep1Check({ filter }: any) {
	filter('listening_lessons.items.create', async (payload: any) => {
		if (payload?.status !== 'published') return payload;
		if (!stepsAfter(new Map(), payload.clips).includes('type')) throw refused(MESSAGE);
		return payload;
	});

	filter('listening_lessons.items.update', async (payload: any, meta: any, { database }: any) => {
		if (!payload || (payload.status === undefined && payload.clips === undefined)) return payload;
		if (payload.status !== undefined && payload.status !== 'published') return payload;

		for (const key of meta.keys || []) {
			const lesson = await database('listening_lessons').select('status').where('id', key).first();
			const status = payload.status ?? lesson?.status;
			if (status !== 'published') continue;
			if (!stepsAfter(await clipSteps(database, key), payload.clips).includes('type')) throw refused(MESSAGE);
		}
		return payload;
	});
}
