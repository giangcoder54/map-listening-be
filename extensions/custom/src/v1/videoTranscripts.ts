/**
 * Transcripts of library videos (source_videos.transcript), for the admin lesson editor.
 * Admin only.
 *
 *   POST /youtube/transcript           { youtube_video_id | url, refresh? }  stored one, else from YouTube
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
			const { rows } = await database.raw(
				`SELECT v.id, v.youtube_video_id, v.title, v.channel_name, v.thumbnail_url,
					m.lines, m.n
				FROM source_videos v
				CROSS JOIN LATERAL (
					SELECT json_agg(json_build_object('text', l->>'text', 'start', (l->>'start')::numeric, 'end', (l->>'end')::numeric)
						ORDER BY (l->>'start')::numeric) AS lines,
						COUNT(*)::int AS n
					FROM jsonb_array_elements(v.transcript) l
					WHERE l->>'text' ~* ?
				) m
				WHERE v.transcript IS NOT NULL AND m.n > 0
				ORDER BY m.n DESC, v.date_created DESC
				LIMIT 40`,
				[pattern],
			);
			return res.json({ success: true, data: rows.map((r: any) => ({ ...r, lines: (r.lines || []).slice(0, 6) })) });
		} catch (error: any) {
			logger.error(`[youtube/transcripts/search] ${error?.message}`);
			return res.status(500).json({ success: false, message: 'Search failed.' });
		}
	});
}
