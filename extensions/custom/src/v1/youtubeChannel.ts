/**
 * Videos of a YouTube channel, to pick new videos for the library (admin "Add from a channel").
 * Admin only. No API key: the channel's Videos tab is read like a browser does (its page, then
 * YouTube's own "browse" calls for the next pages), through the same proxy as the rest.
 *
 *   POST /youtube/channel/videos     { url, sort?: 'latest' | 'popular', next?, client_version? }
 *        one page (about 30) of the channel's long videos (Shorts and lives are on other tabs),
 *        each with whether it is already in the library; `next` asks for the page after it
 *   POST /youtube/channel/subtitles  { ids: string[] }  (10 at most)
 *        which English subtitles each video has: 'manual' (made by a person), 'asr' (YouTube's
 *        automatic ones), 'none'; null when YouTube could not be read. Nothing is downloaded.
 *
 * Adding the chosen videos is POST /youtube/library/add (videoTranscripts.ts).
 */
import type { Router } from 'express';
import { isStaff } from '../lib/staff';
import { fetchPlayer, pickCaptionTrack, proxiedFetch } from './youtube';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// SOCS: skip the EU cookie page, which has no videos in it
const PAGE_HEADERS = { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI' };
const BROWSE_URL = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
const FALLBACK_CLIENT_VERSION = '2.20261105.05.01';
const SUBTITLE_CHECKS = 10;

export type ChannelVideo = {
	youtube_video_id: string;
	title: string;
	duration: number | null; // seconds; null for a live or upcoming one
	views: string | null; // as YouTube shows it ("42K views")
	published: string | null; // "3 days ago"
	thumbnail_url: string;
};

/**
 * The Videos tab of a channel from what the admin pasted: a channel link (/@name, /channel/UC…,
 * /c/…, /user/…), "@name", or a channel id. Null when it is none of those (a video link is not
 * a channel).
 */
export function channelVideosUrl(input: string): string | null {
	const s = String(input || '').trim();
	if (/^@[\w.-]{3,}$/.test(s)) return `https://www.youtube.com/${s}/videos`;
	if (/^UC[\w-]{22}$/.test(s)) return `https://www.youtube.com/channel/${s}/videos`;
	let url: URL;
	try {
		url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
	} catch {
		return null;
	}
	if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return null;
	const m = url.pathname.match(/^\/(@[^/]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)/);
	return m ? `https://www.youtube.com/${m[1]}/videos` : null;
}

/** "1:02:03" → 3723 */
const seconds = (t: string) => t.split(':').reduce((sum, p) => sum * 60 + Number(p), 0);

/**
 * The videos, the next page's token and the sort chips in a page or a browse response. Read by
 * walking the whole JSON, since YouTube moves things around: videos are lockupViewModel (now)
 * or videoRenderer (before); the next page is the first continuationItemRenderer of the grid.
 */
export function scanVideos(root: any): { videos: ChannelVideo[]; next: string | null; chips: { text: string; token: string }[] } {
	const videos: ChannelVideo[] = [];
	const chips: { text: string; token: string }[] = [];
	let next: string | null = null;
	const walk = (o: any): void => {
		if (!o || typeof o !== 'object') return;
		if (Array.isArray(o)) return o.forEach(walk);
		const lockup = o.lockupViewModel;
		if (lockup?.contentId && (!lockup.contentType || lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
			const md = lockup.metadata?.lockupMetadataViewModel;
			const parts: string[] = (md?.metadata?.contentMetadataViewModel?.metadataRows || [])
				.flatMap((r: any) => (r.metadataParts || []).map((p: any) => p?.text?.content))
				.filter(Boolean);
			let duration: number | null = null;
			const badges = (x: any): void => {
				if (!x || typeof x !== 'object') return;
				if (Array.isArray(x)) return x.forEach(badges);
				const text = x.thumbnailBadgeViewModel?.text;
				if (typeof text === 'string' && /^\d+(:\d{2})+$/.test(text)) duration = seconds(text);
				Object.values(x).forEach(badges);
			};
			badges(lockup.contentImage);
			videos.push({
				youtube_video_id: lockup.contentId,
				title: md?.title?.content || '',
				duration,
				views: parts.find((p) => /view|\d[KMB]?$/i.test(p) && !/ago/i.test(p)) || null,
				published: parts.find((p) => /ago|streamed|premiered/i.test(p)) || null,
				thumbnail_url: `https://i.ytimg.com/vi/${lockup.contentId}/mqdefault.jpg`,
			});
			return;
		}
		const vr = o.videoRenderer;
		if (vr?.videoId) {
			const len = vr.lengthText?.simpleText;
			videos.push({
				youtube_video_id: vr.videoId,
				title: vr.title?.runs?.map((r: any) => r.text).join('') || vr.title?.simpleText || '',
				duration: len && /^\d+(:\d{2})+$/.test(len) ? seconds(len) : null,
				views: vr.viewCountText?.simpleText || null,
				published: vr.publishedTimeText?.simpleText || null,
				thumbnail_url: `https://i.ytimg.com/vi/${vr.videoId}/mqdefault.jpg`,
			});
			return;
		}
		if (o.continuationItemRenderer) {
			next = next || o.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
			return;
		}
		const chip = o.chipViewModel;
		if (chip) {
			const token = chip.tapCommand?.innertubeCommand?.continuationCommand?.token;
			if (chip.text && token) chips.push({ text: chip.text, token });
			return;
		}
		for (const k of Object.keys(o)) if (k !== 'engagementPanels' && k !== 'frameworkUpdates') walk(o[k]);
	};
	walk(root);
	return { videos, next, chips };
}

async function browse(token: string, clientVersion: string) {
	const res = await proxiedFetch(BROWSE_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'User-Agent': WEB_UA },
		body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } }, continuation: token }),
	});
	if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
	return res.json();
}

export function handleYoutubeChannel(router: Router, context: any) {
	const { database, logger } = context;

	router.post('/youtube/channel/videos', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only.' });
		const { url, sort, next, client_version } = req.body || {};
		try {
			let channel: { id: string | null; title: string | null; url: string } | null = null;
			let page: ReturnType<typeof scanVideos>;
			let clientVersion = String(client_version || '') || FALLBACK_CLIENT_VERSION;
			if (next) {
				page = scanVideos(await browse(String(next), clientVersion));
			} else {
				const pageUrl = channelVideosUrl(url);
				if (!pageUrl) return res.status(400).json({ success: false, message: 'Not a YouTube channel link (e.g. https://www.youtube.com/@name).' });
				const r = await proxiedFetch(pageUrl, { headers: PAGE_HEADERS });
				if (r.status === 404) return res.status(404).json({ success: false, message: 'No such channel.' });
				if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
				const html = await r.text();
				const json = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
				if (!json) throw new Error('The channel page could not be read.');
				const data = JSON.parse(json);
				clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || clientVersion;
				const meta = data?.metadata?.channelMetadataRenderer;
				channel = { id: meta?.externalId || null, title: meta?.title || null, url: pageUrl.replace(/\/videos$/, '') };
				page = scanVideos(data);
				// Most watched first: the "Popular" chip reloads the grid
				if (sort === 'popular') {
					const chip = page.chips.find((c) => /popular/i.test(c.text));
					if (chip) page = scanVideos(await browse(chip.token, clientVersion));
				}
			}
			// Which are in the library already, and with which subtitles
			const ids = page.videos.map((v) => v.youtube_video_id);
			const known = ids.length
				? await database('source_videos').select('youtube_video_id', 'transcript_kind', 'transcript_updated_at').whereIn('youtube_video_id', ids)
				: [];
			const byId = new Map(known.map((k: any) => [k.youtube_video_id, k]));
			const videos = page.videos.map((v) => {
				const k: any = byId.get(v.youtube_video_id);
				return { ...v, in_library: !!k?.transcript_updated_at, subtitles: k?.transcript_kind ?? null };
			});
			return res.json({ success: true, data: { channel, videos, next: page.next, client_version: clientVersion } });
		} catch (e: any) {
			logger.warn(`[youtube/channel/videos] ${url || 'next page'}: ${e?.message}`);
			return res.status(502).json({ success: false, message: `Could not read the channel: ${e?.message}` });
		}
	});

	router.post('/youtube/channel/subtitles', async (req: any, res: any) => {
		if (!isStaff(req.accountability)) return res.status(403).json({ success: false, message: 'Admins and editors only.' });
		const ids: string[] = [...new Set<string>((req.body?.ids || []).map(String))].filter((id) => /^[\w-]{11}$/.test(id));
		if (!ids.length) return res.status(400).json({ success: false, message: 'No video ids.' });
		if (ids.length > SUBTITLE_CHECKS) return res.status(400).json({ success: false, message: `At most ${SUBTITLE_CHECKS} videos per call.` });
		// A few at a time: one player call each, the subtitles are not downloaded
		const out: { youtube_video_id: string; subtitles: string | null }[] = [];
		for (let i = 0; i < ids.length; i += 3) {
			out.push(...(await Promise.all(ids.slice(i, i + 3).map(async (id) => {
				try {
					const { data } = await fetchPlayer(id, logger);
					return { youtube_video_id: id, subtitles: data ? pickCaptionTrack(data, 'en').kind : null };
				} catch {
					return { youtube_video_id: id, subtitles: null };
				}
			}))));
		}
		return res.json({ success: true, data: out });
	});
}
