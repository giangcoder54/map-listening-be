/**
 * Transcripts of library videos (source_videos.transcript), for the admin lesson editor.
 * Admin only.
 *
 *   POST /youtube/transcript           { youtube_video_id | url, refresh? }  stored one, else from YouTube
 *   POST /youtube/library/add          { url | urls[] }  add videos, no lesson needed (English transcript required)
 *   POST /youtube/transcripts/index    { limit? }  fetch the next videos never fetched yet
 *   GET  /youtube/transcripts/stats    how many library videos have one
 *   GET  /youtube/transcripts/search   ?q=let him   videos where it is said, with the lines
 *
 * A transcript is [{ text, start, end }] in ms; [] means YouTube has none for the video.
 */
import type { Router } from 'express';
import { extractVideoId, fetchPlayer, fetchTranscriptFromPlayer, getVideoMeta } from './youtube';

type Line = { text: string; start: number; end: number };

const adminOnly = (req: any, res: any) => {
	if (req.accountability?.admin) return false;
	res.status(403).json({ success: false, message: 'Admin only.' });
	return true;
};

/** Video details and transcript from YouTube; null when the video cannot be read */
async function fromYouTube(videoId: string, logger: any) {
	const { data } = await fetchPlayer(videoId, logger);
	const meta = data ? getVideoMeta(data, videoId) : null;
	if (!meta) return null;
	const transcript = ((await fetchTranscriptFromPlayer(data, logger, 'en')) || []) as Line[];
	return { meta, transcript };
}

const VIDEO_FIELDS = ['id', 'youtube_video_id', 'title', 'channel_name', 'thumbnail_url'];

export function handleVideoTranscripts(router: Router, context: any) {
	const { database, logger } = context;

	router.post('/youtube/transcript', async (req: any, res: any) => {
		if (adminOnly(req, res)) return;
		try {
			const body = req.body || {};
			const videoId = String(body.youtube_video_id || '') || extractVideoId(String(body.url || ''));
			if (!videoId || !/^[\w-]{11}$/.test(videoId)) return res.status(400).json({ success: false, message: 'Invalid YouTube URL.' });

			const row = await database('source_videos').select([...VIDEO_FIELDS, 'transcript', 'transcript_updated_at']).where('youtube_video_id', videoId).first();
			if (row?.transcript && !body.refresh) {
				const { transcript, transcript_updated_at, ...video } = row;
				return res.json({ success: true, data: { video, transcript, stored: true, fetched_at: transcript_updated_at } });
			}

			const yt = await fromYouTube(videoId, logger);
			if (!yt) {
				if (row) {
					const { transcript, transcript_updated_at, ...video } = row;
					return res.json({ success: true, data: { video, transcript: transcript || [], stored: !!transcript, fetched_at: transcript_updated_at, warning: 'YouTube could not be read.' } });
				}
				return res.status(404).json({ success: false, message: 'Video not found or unavailable.' });
			}
			const now = new Date();
			if (row) {
				await database('source_videos').where('id', row.id).update({ transcript: JSON.stringify(yt.transcript), transcript_updated_at: now });
			}
			return res.json({
				success: true,
				data: {
					video: { id: row?.id || null, ...yt.meta },
					transcript: yt.transcript,
					stored: !!row,
					fetched_at: now,
				},
			});
		} catch (error: any) {
			logger.error(`[youtube/transcript] ${error?.stack || error?.message}`);
			return res.status(500).json({ success: false, message: 'Failed to load the transcript.' });
		}
	});

	// Put videos in the library without a lesson: one row each, with its transcript, so the
	// video can be picked in the lesson editor and found by what is said.
	router.post('/youtube/library/add', async (req: any, res: any) => {
		if (adminOnly(req, res)) return;
		const body = req.body || {};
		const inputs = (Array.isArray(body.urls) ? body.urls : [body.url || body.youtube_video_id])
			.map((u: any) => String(u || '').trim())
			.filter(Boolean);
		if (!inputs.length) return res.status(400).json({ success: false, message: 'No YouTube link.' });
		if (inputs.length > 20) return res.status(400).json({ success: false, message: 'At most 20 links per call.' });

		const schema = await context.getSchema();
		const videos = new context.services.ItemsService('source_videos', { schema, accountability: req.accountability });
		const results: any[] = [];
		const seen = new Set<string>();
		for (const input of inputs) {
			const videoId = /^[\w-]{11}$/.test(input) ? input : extractVideoId(input);
			if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
				results.push({ input, status: 'invalid' });
				continue;
			}
			if (seen.has(videoId)) continue;
			seen.add(videoId);
			try {
				const row = await database('source_videos').select([...VIDEO_FIELDS, 'transcript_updated_at']).where('youtube_video_id', videoId).first();
				if (row?.transcript_updated_at) {
					const { transcript_updated_at, ...video } = row;
					results.push({ input, status: 'exists', video });
					continue;
				}
				const yt = await fromYouTube(videoId, logger);
				if (!yt) {
					results.push({ input, status: 'unavailable', youtube_video_id: videoId });
					continue;
				}
				// Only videos that can be searched by what is said
				if (!yt.transcript.length) {
					results.push({ input, status: 'no_transcript', video: { id: row?.id || null, ...yt.meta } });
					continue;
				}
				const now = new Date();
				const { duration, ...meta } = yt.meta;
				let id = row?.id;
				// Already in the library but never fetched: only its transcript is missing
				if (id) await database('source_videos').where('id', id).update({ transcript: JSON.stringify(yt.transcript), transcript_updated_at: now });
				else id = await videos.createOne({ ...meta, transcript: yt.transcript, transcript_updated_at: now });
				results.push({
					input,
					status: row ? 'transcript_added' : 'added',
					lines: yt.transcript.length,
					video: { id, ...yt.meta },
				});
			} catch (e: any) {
				logger.warn(`[youtube/library/add] ${videoId}: ${e?.message}`);
				results.push({ input, status: 'error', youtube_video_id: videoId, message: e?.message });
			}
		}
		return res.json({ success: true, data: results });
	});

	router.get('/youtube/transcripts/stats', async (req: any, res: any) => {
		if (adminOnly(req, res)) return;
		const row = await database('source_videos')
			.select(
				database.raw('COUNT(*)::int AS total'),
				database.raw('COUNT(*) FILTER (WHERE transcript_updated_at IS NOT NULL)::int AS fetched'),
				database.raw("COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) > 0)::int AS with_transcript"),
			)
			.first();
		return res.json({ success: true, data: row });
	});

	// A few videos per call: the page calls it again until nothing is left
	router.post('/youtube/transcripts/index', async (req: any, res: any) => {
		if (adminOnly(req, res)) return;
		const limit = Math.min(10, Math.max(1, Number(req.body?.limit) || 5));
		const rows = await database('source_videos').select('id', 'youtube_video_id').whereNull('transcript_updated_at').orderBy('date_created', 'desc').limit(limit);
		let ok = 0;
		let failed = 0;
		for (const row of rows) {
			try {
				const yt = await fromYouTube(row.youtube_video_id, logger);
				// Marked as fetched even without a transcript, so it is not tried again and again
				await database('source_videos').where('id', row.id).update({
					transcript: JSON.stringify(yt?.transcript || []),
					transcript_updated_at: new Date(),
				});
				if (yt?.transcript.length) ok++;
				else failed++;
			} catch (e: any) {
				failed++;
				logger.warn(`[youtube/transcripts/index] ${row.youtube_video_id}: ${e?.message}`);
			}
		}
		const left = await database('source_videos').whereNull('transcript_updated_at').count('* as n').first();
		return res.json({ success: true, data: { ok, failed, remaining: Number(left?.n) || 0 } });
	});

	router.get('/youtube/transcripts/search', async (req: any, res: any) => {
		if (adminOnly(req, res)) return;
		const q = String(req.query.q || '').trim().replace(/\s+/g, ' ');
		if (q.length < 2) return res.json({ success: true, data: [] });
		// Whole words, any case: "let him" matches "Let him go", not "outlet himself"
		const pattern = `\\m${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}\\M`;
		try {
			// A caption can cut the words in two ("…a lot" / "of people…"): a line also matches
			// joined with the next one, when the next one does not match by itself.
			const { rows } = await database.raw(
				`SELECT v.id, v.youtube_video_id, v.title, v.channel_name, v.thumbnail_url,
					m.lines, m.n
				FROM source_videos v
				CROSS JOIN LATERAL (
					SELECT json_agg(json_build_object('text', h.text, 'start', h.start, 'end', h."end") ORDER BY h.start) AS lines,
						COUNT(*)::int AS n
					FROM (
						SELECT
							CASE WHEN l.text ~* ? THEN l.text ELSE l.text || ' ' || l.next_text END AS text,
							l.start,
							CASE WHEN l.text ~* ? THEN l."end" ELSE l.next_end END AS "end"
						FROM (
							SELECT e->>'text' AS text, (e->>'start')::numeric AS start, (e->>'end')::numeric AS "end",
								lead(e->>'text') OVER (ORDER BY i) AS next_text,
								lead((e->>'end')::numeric) OVER (ORDER BY i) AS next_end
							FROM jsonb_array_elements(v.transcript) WITH ORDINALITY AS t(e, i)
						) l
						WHERE l.text ~* ?
							OR (l.next_text IS NOT NULL AND l.next_text !~* ? AND (l.text || ' ' || l.next_text) ~* ?)
					) h
				) m
				WHERE v.transcript IS NOT NULL AND m.n > 0
				ORDER BY m.n DESC, v.date_created DESC
				LIMIT 40`,
				[pattern, pattern, pattern, pattern, pattern],
			);
			return res.json({ success: true, data: rows.map((r: any) => ({ ...r, lines: (r.lines || []).slice(0, 6) })) });
		} catch (error: any) {
			logger.error(`[youtube/transcripts/search] ${error?.message}`);
			return res.status(500).json({ success: false, message: 'Search failed.' });
		}
	});
}
