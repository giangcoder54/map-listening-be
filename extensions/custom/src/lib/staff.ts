/**
 * Who may use the admin panel.
 *
 *   admin   Directus admins: everything
 *   editor  role "Content Editor" (database/migrations/2026-10-15_content_editor.sql):
 *           lessons, video library, transcripts and blog. Never users, sales, growth
 *           numbers or settings: those routes keep checking `accountability.admin`.
 */
export const CONTENT_EDITOR_ROLE_ID = '6f1c2b3a-9d4e-4c5b-8a7f-3e2d1c0b9a01';

export type StaffRole = 'admin' | 'editor';

export function staffRole(accountability: any): StaffRole | null {
	if (!accountability?.user) return null;
	if (accountability.admin) return 'admin';
	const roles: string[] = accountability.roles || (accountability.role ? [accountability.role] : []);
	return roles.includes(CONTENT_EDITOR_ROLE_ID) ? 'editor' : null;
}

/** Admins and content editors */
export const isStaff = (accountability: any) => staffRole(accountability) !== null;
