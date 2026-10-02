/**
 * Lesson phrases start with a capital letter ("Tell him", not "tell him"), however they
 * are saved: Directus, the admin lesson editor or a script. Answers are graded without
 * case, so this changes only how the phrase looks.
 */

/** "tell him" -> "Tell him"; leading quotes or brackets are kept: "'cause" -> "'Cause" */
export const capitalizeFirst = (text: string) =>
	text.trim().replace(/^([\s"'“‘(\[]*)(\p{L})/u, (_m, lead: string, letter: string) => lead + letter.toUpperCase());

export function registerLessonTextCase({ filter }: any) {
	const fix = (payload: any) => {
		if (payload && typeof payload.text === 'string') payload.text = capitalizeFirst(payload.text);
		return payload;
	};
	filter('listening_lessons.items.create', fix);
	filter('listening_lessons.items.update', fix);
}
