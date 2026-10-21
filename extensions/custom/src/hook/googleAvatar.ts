/**
 * Google sign-in: keep the learner's Google profile picture in directus_users.avatar_url
 * (2026-10-21_google_avatar.sql), on sign-up and on every later sign-in, so a new picture
 * shows up the next time they sign in. Directus maps names and email itself, not the picture.
 *
 * The openid driver passes Google's userinfo as providerPayload.userInfo; whatever this
 * filter adds to the payload is saved on the user.
 */
const isGooglePicture = (v: unknown): v is string =>
	typeof v === 'string' && v.length <= 1000 && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(v);

/** Google sends a 96px picture ("=s96-c"): ask for one sharp enough for the profile page */
const sized = (url: string) => url.replace(/=s\d+-c$/, '=s256-c');

export function registerGoogleAvatar({ filter }: any) {
	const withPicture = (payload: any, meta: any) => {
		if (meta?.provider !== 'google') return payload;
		const picture = meta?.providerPayload?.userInfo?.picture;
		return isGooglePicture(picture) ? { ...payload, avatar_url: sized(picture) } : payload;
	};
	filter('auth.create', withPicture);
	filter('auth.update', withPicture);
}
