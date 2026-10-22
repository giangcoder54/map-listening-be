/**
 * A user created without a role gets "Free User". The Directus admin leaves the role empty
 * unless one is picked, and an account with no role can only read its own `id`: the site
 * shows it as a nameless "Free" account (and it stays so after buying Premium, until the
 * session is renewed). Sign-up (/v1/register) and Google sign-in already set a role.
 * A role picked in the admin (Administrator, Content Editor...) is kept.
 */
export function registerDefaultRole({ filter }: any, { database, logger }: any) {
	filter('users.create', async (payload: any) => {
		if (payload?.role) return payload;
		const free = await database('directus_roles').whereRaw("trim(name) = 'Free User'").first('id');
		if (!free) {
			logger?.warn?.('[users] No "Free User" role: new user left without a role');
			return payload;
		}
		return { ...payload, role: free.id };
	});
}
