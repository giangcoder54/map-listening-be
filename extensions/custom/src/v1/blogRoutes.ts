/**
 * Blog: posts with one translation per language (en-US, vi-VN), markdown content.
 *
 *   GET    /blog                   ?lang=en|vi&limit&offset&tag   published posts
 *   GET    /blog/sitemap           slugs + dates + languages written (sitemap.xml)
 *   GET    /blog/:slug             ?lang= one post (+ 3 related)
 *   GET    /admin/blog             ?q=&status=live|scheduled|draft&page=&limit=: posts, paged (admin)
 *   GET    /admin/blog/:id
 *   POST   /admin/blog             { slug, status, cover, author, tags, published_at, translations: [...] }
 *   PATCH  /admin/blog/:id
 *   DELETE /admin/blog/:id
 *
 * A post without a translation in the asked language falls back to English, then to the
 * language it has.
 * A saved cover is moved to the public "Blog" folder (migration 2026-10-06_growth.sql), so
 * visitors and link previews can load it; other files stay private.
 */
import { UUID_RE } from '../lib/lessons';

const LANG: Record<string, string> = { en: 'en-US', vi: 'vi-VN' };
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** directus_folders id of "Blog": anyone may read its files */
export const BLOG_FOLDER = 'a7c3e2d1-5b4f-4e8a-9c6d-2f1b0e9d8c7a';
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function registerBlogRoutes(router: any, context: any) {
	const { database, logger } = context;
	const fail = (res: any, what: string, error: any) => {
		logger?.error?.(`[blog] ${what} failed: ${String(error)}`);
		return res.status(500).json({ success: false, message: 'Server error' });
	};
	const isAdmin = (req: any, res: any) => {
		if (req.accountability?.admin) return true;
		res.status(403).json({ success: false, message: 'Admins only' });
		return false;
	};

	/** Published post rows with the best translation for `lang` */
	const publishedQuery = (lang: string) =>
		database('blog_posts as p')
			.join('blog_posts_translations as t', function (this: any) {
				this.on('t.blog_posts_id', 'p.id').andOn('t.languages_code', database.raw(`CASE
					WHEN EXISTS (SELECT 1 FROM blog_posts_translations x WHERE x.blog_posts_id = p.id AND x.languages_code = ?) THEN ?
					WHEN EXISTS (SELECT 1 FROM blog_posts_translations x WHERE x.blog_posts_id = p.id AND x.languages_code = 'en-US') THEN 'en-US'
					ELSE (SELECT MIN(x.languages_code) FROM blog_posts_translations x WHERE x.blog_posts_id = p.id)
				END`, [lang, lang]));
			})
			.where('p.status', 'published')
			.where('p.published_at', '<=', database.fn.now());

	const cardFields = ['p.id', 'p.slug', 'p.cover', 'p.author', 'p.tags', 'p.published_at', 'p.date_updated', 't.languages_code', 't.title', 't.excerpt'];

	router.get('/blog', async (req: any, res: any) => {
		const lang = LANG[String(req.query.lang)] || 'en-US';
		const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
		const offset = Math.max(0, Number(req.query.offset) || 0);
		const tag = str(req.query.tag, 50).toLowerCase();
		try {
			const base = publishedQuery(lang);
			if (tag) base.whereRaw(`? = ANY (string_to_array(lower(replace(coalesce(p.tags, ''), ' ', '')), ','))`, [tag.replace(/\s+/g, '')]);
			const [rows, count] = await Promise.all([
				base.clone().select(cardFields).orderBy('p.published_at', 'desc').limit(limit).offset(offset),
				base.clone().count('* as n').first(),
			]);
			return res.json({ success: true, data: rows, total: Number(count?.n) || 0 });
		} catch (error) {
			return fail(res, 'List posts', error);
		}
	});

	router.get('/blog/sitemap', async (_req: any, res: any) => {
		try {
			const rows = await database('blog_posts as p')
				.select('p.slug', 'p.published_at', 'p.date_updated',
					database.raw(`(SELECT array_agg(t.languages_code) FROM blog_posts_translations t WHERE t.blog_posts_id = p.id) AS languages`))
				.where('p.status', 'published').where('p.published_at', '<=', database.fn.now()).orderBy('p.published_at', 'desc');
			return res.json({ success: true, data: rows });
		} catch (error) {
			return fail(res, 'Blog sitemap', error);
		}
	});

	router.get('/blog/:slug', async (req: any, res: any) => {
		const slug = String(req.params.slug || '');
		if (!SLUG_RE.test(slug)) return res.status(404).json({ success: false, message: 'Not found' });
		const lang = LANG[String(req.query.lang)] || 'en-US';
		try {
			const post = await publishedQuery(lang)
				.select([...cardFields, 't.content', 't.seo_title', 't.seo_description'])
				.where('p.slug', slug)
				.first();
			if (!post) return res.status(404).json({ success: false, message: 'Not found' });
			const [languages, related] = await Promise.all([
				database('blog_posts_translations').where('blog_posts_id', post.id).pluck('languages_code'),
				publishedQuery(lang).select(cardFields).whereNot('p.id', post.id).orderBy('p.published_at', 'desc').limit(3),
			]);
			return res.json({ success: true, data: { ...post, languages, related } });
		} catch (error) {
			return fail(res, 'Read post', error);
		}
	});

	// ── Admin ─────────────────────────────────────────────────────────────
	/** live = published and its date has come, scheduled = published later, draft */
	const STATE_SQL = {
		live: `p.status = 'published' AND p.published_at <= now()`,
		scheduled: `p.status = 'published' AND (p.published_at IS NULL OR p.published_at > now())`,
		draft: `p.status <> 'published'`,
	} as const;

	router.get('/admin/blog', async (req: any, res: any) => {
		if (!isAdmin(req, res)) return;
		const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
		const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
		const state = Object.keys(STATE_SQL).includes(req.query.status) ? (req.query.status as keyof typeof STATE_SQL) : null;
		const q = str(req.query.q, 100);
		try {
			const filtered = () => {
				const query = database('blog_posts as p');
				if (q) {
					query.where((w: any) => w.whereILike('p.slug', `%${q}%`)
						.orWhereExists(database('blog_posts_translations as t').whereRaw('t.blog_posts_id = p.id').whereILike('t.title', `%${q}%`)));
				}
				return state ? query.whereRaw(STATE_SQL[state]) : query;
			};
			const [rows, count, counts] = await Promise.all([
				filtered()
					.select('p.*', database.raw(`(SELECT json_agg(json_build_object('languages_code', t.languages_code, 'title', t.title)) FROM blog_posts_translations t WHERE t.blog_posts_id = p.id) AS translations`))
					.orderBy([{ column: 'p.published_at', order: 'desc', nulls: 'first' }, { column: 'p.date_created', order: 'desc' }])
					.limit(limit)
					.offset((page - 1) * limit),
				filtered().count('* as n').first(),
				database('blog_posts as p').select(database.raw(`
					COUNT(*)::int AS all,
					COUNT(*) FILTER (WHERE ${STATE_SQL.live})::int AS live,
					COUNT(*) FILTER (WHERE ${STATE_SQL.scheduled})::int AS scheduled,
					COUNT(*) FILTER (WHERE ${STATE_SQL.draft})::int AS draft`)).first(),
			]);
			return res.json({ success: true, data: rows, total: Number(count?.n) || 0, page, limit, counts });
		} catch (error) {
			return fail(res, 'Admin list posts', error);
		}
	});

	router.get('/admin/blog/:id', async (req: any, res: any) => {
		if (!isAdmin(req, res)) return;
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(404).json({ success: false, message: 'Not found' });
		try {
			const post = await database('blog_posts').where('id', id).first();
			if (!post) return res.status(404).json({ success: false, message: 'Not found' });
			const translations = await database('blog_posts_translations').where('blog_posts_id', id).orderBy('languages_code');
			return res.json({ success: true, data: { ...post, translations } });
		} catch (error) {
			return fail(res, 'Admin read post', error);
		}
	});

	/** Validated post fields + translations from a request body */
	const readBody = (body: any, partial: boolean) => {
		const post: Record<string, any> = {};
		if (!partial || body.slug !== undefined) {
			const slug = str(body.slug, 255).toLowerCase();
			if (!SLUG_RE.test(slug)) throw Object.assign(new Error('Slug: lowercase letters, digits and dashes'), { status: 400 });
			post.slug = slug;
		}
		if (body.status !== undefined) post.status = body.status === 'published' ? 'published' : 'draft';
		for (const f of ['cover', 'author', 'tags'] as const) if (body[f] !== undefined) post[f] = str(body[f], f === 'cover' ? 500 : 255) || null;
		if (body.published_at !== undefined) {
			const d = body.published_at ? new Date(body.published_at) : null;
			post.published_at = d && !Number.isNaN(d.getTime()) ? d : null;
		}
		// Published without a date: it gets "now" (on update: only if it had none)
		const publishNow = post.status === 'published' && body.published_at === undefined;
		const translations = Array.isArray(body.translations)
			? body.translations
				.filter((t: any) => Object.values(LANG).includes(t?.languages_code))
				.map((t: any) => ({
					languages_code: t.languages_code,
					title: str(t.title, 255),
					excerpt: str(t.excerpt, 500) || null,
					content: typeof t.content === 'string' ? t.content.slice(0, 200000) : null,
					seo_title: str(t.seo_title, 255) || null,
					seo_description: str(t.seo_description, 500) || null,
				}))
			: null;
		if (translations?.some((t: any) => !t.title)) throw Object.assign(new Error('Every language needs a title'), { status: 400 });
		return { post, translations, publishNow };
	};

	const saveTranslations = async (trx: any, postId: string, translations: any[] | null) => {
		if (!translations) return;
		const keep = translations.map((t) => t.languages_code);
		await trx('blog_posts_translations').where('blog_posts_id', postId).whereNotIn('languages_code', keep.length ? keep : ['-']).delete();
		for (const t of translations) {
			await trx('blog_posts_translations').insert({ ...t, blog_posts_id: postId }).onConflict(['blog_posts_id', 'languages_code']).merge();
		}
	};

	/** The cover goes to the public "Blog" folder (a file id; a full URL is left alone) */
	const publishCover = async (cover: unknown) => {
		if (typeof cover !== 'string' || !UUID_RE.test(cover)) return;
		await database('directus_files').where('id', cover).update({ folder: BLOG_FOLDER })
			.catch((e: any) => logger?.warn?.(`[blog] cover folder: ${String(e)}`));
	};

	const sendError = (res: any, what: string, error: any) => {
		if (error?.status === 400) return res.status(400).json({ success: false, message: error.message });
		if (error?.code === '23505') return res.status(409).json({ success: false, message: 'This slug is already used' });
		return fail(res, what, error);
	};

	router.post('/admin/blog', async (req: any, res: any) => {
		if (!isAdmin(req, res)) return;
		try {
			const { post, translations, publishNow } = readBody(req.body || {}, false);
			if (!translations?.length) return res.status(400).json({ success: false, message: 'Add at least one language' });
			if (publishNow) post.published_at = new Date();
			const id = await database.transaction(async (trx: any) => {
				const [row] = await trx('blog_posts').insert(post).returning('id');
				const postId = row?.id || row;
				await saveTranslations(trx, postId, translations);
				return postId;
			});
			await publishCover(post.cover);
			return res.status(201).json({ success: true, data: { id } });
		} catch (error) {
			return sendError(res, 'Create post', error);
		}
	});

	router.patch('/admin/blog/:id', async (req: any, res: any) => {
		if (!isAdmin(req, res)) return;
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(404).json({ success: false, message: 'Not found' });
		try {
			const { post, translations, publishNow } = readBody(req.body || {}, true);
			if (publishNow) post.published_at = database.raw('COALESCE(published_at, now())');
			await database.transaction(async (trx: any) => {
				const updated = await trx('blog_posts').where('id', id).update({ ...post, date_updated: new Date() });
				if (!updated) throw Object.assign(new Error('Not found'), { status: 404 });
				await saveTranslations(trx, id, translations);
			});
			await publishCover(post.cover);
			return res.json({ success: true });
		} catch (error: any) {
			if (error?.status === 404) return res.status(404).json({ success: false, message: 'Not found' });
			return sendError(res, 'Update post', error);
		}
	});

	router.delete('/admin/blog/:id', async (req: any, res: any) => {
		if (!isAdmin(req, res)) return;
		const id = String(req.params.id);
		if (!UUID_RE.test(id)) return res.status(404).json({ success: false, message: 'Not found' });
		try {
			await database('blog_posts').where('id', id).delete();
			return res.json({ success: true });
		} catch (error) {
			return fail(res, 'Delete post', error);
		}
	});
}
