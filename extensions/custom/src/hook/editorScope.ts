/**
 * What a content editor (lib/staff.ts) may change, where Directus permissions cannot say it
 * (database/migrations/2026-10-15_content_editor.sql has the rest):
 *
 *   - clips and lesson translations: only on their own lessons, also when creating one or
 *     moving a clip to another lesson (a create permission cannot look at the parent lesson)
 *   - a lesson's skill: not to a skill whose premium status differs (a lesson is premium when
 *     it, its skill or its group is), so moving a lesson never makes paid content free
 *
 * Admins are never limited here.
 */
import { staffRole } from '../lib/staff';

const forbidden = (text: string) =>
	Object.assign(new Error(text), {
		name: 'DirectusError',
		code: 'FORBIDDEN',
		status: 403,
		extensions: { reason: text },
	});

const idOf = (v: any): string | null => (v && typeof v === 'object' ? v.id ?? null : v ?? null);

export function registerEditorScope({ filter }: any) {
	const editorOf = (hookContext: any) => (staffRole(hookContext.accountability) === 'editor' ? hookContext.accountability.user : null);

	/** true when the lesson was made by `userId` (or does not exist yet: nested create, bad id) */
	const ownLesson = async (db: any, lessonId: string | null, userId: string) => {
		if (!lessonId) return true;
		const row = await db('listening_lessons').where('id', lessonId).first('user_created');
		return !row || row.user_created === userId;
	};

	/** Premium status a skill gives its lessons (the skill or its group) */
	const skillPremium = async (db: any, skillId: string | null) => {
		if (!skillId) return false;
		const row = await db('listening_skills as s')
			.leftJoin('listening_groups as g', 'g.id', 's.group_id')
			.where('s.id', skillId)
			.first(db.raw('(coalesce(s.is_premium, false) OR coalesce(g.is_premium, false)) AS premium'));
		return !!row?.premium;
	};

	filter('listening_clips.items.create', async (payload: any, _meta: any, hookContext: any) => {
		const me = editorOf(hookContext);
		if (me && !(await ownLesson(hookContext.database, idOf(payload?.lesson_id), me))) {
			throw forbidden('You can only add clips to your own lessons.');
		}
		return payload;
	});

	filter('listening_clips.items.update', async (payload: any, _meta: any, hookContext: any) => {
		const me = editorOf(hookContext);
		if (me && payload && 'lesson_id' in payload && !(await ownLesson(hookContext.database, idOf(payload.lesson_id), me))) {
			throw forbidden('You can only move clips to your own lessons.');
		}
		return payload;
	});

	filter('listening_lessons_translations.items.create', async (payload: any, _meta: any, hookContext: any) => {
		const me = editorOf(hookContext);
		if (me && !(await ownLesson(hookContext.database, idOf(payload?.listening_lessons_id), me))) {
			throw forbidden('You can only write the explanation of your own lessons.');
		}
		return payload;
	});

	filter('listening_lessons.items.update', async (payload: any, meta: any, hookContext: any) => {
		const me = editorOf(hookContext);
		if (!me || !payload || !('skill_id' in payload)) return payload;
		const db = hookContext.database;
		const target = await skillPremium(db, idOf(payload.skill_id));
		const lessons = await db('listening_lessons').whereIn('id', meta?.keys || []).select('skill_id');
		for (const l of lessons) {
			if ((await skillPremium(db, l.skill_id)) !== target) {
				throw forbidden('Moving a lesson between a free and a premium skill needs an admin.');
			}
		}
		return payload;
	});
}
