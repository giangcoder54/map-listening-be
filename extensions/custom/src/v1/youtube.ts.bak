import type { Router } from 'express';

const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}&prettyPrint=false`;

const ANDROID_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 34,
  userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
};

const WEB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function innertubeContext(clientType: "WEB" | "ANDROID" = "WEB") {
  if (clientType === "ANDROID") {
    return {
      client: {
        clientName: ANDROID_CLIENT.clientName,
        clientVersion: ANDROID_CLIENT.clientVersion,
        androidSdkVersion: ANDROID_CLIENT.androidSdkVersion,
        hl: "en",
        gl: "US",
      },
    };
  }
  return {
    client: {
      clientName: "WEB",
      clientVersion: "2.20230810.05.00",
      hl: "en",
      gl: "US",
    },
  };
}

async function innertubePost(url: string, body: Record<string, unknown>, clientType: "WEB" | "ANDROID" = "WEB"): Promise<any> {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": clientType === "WEB" ? WEB_USER_AGENT : ANDROID_CLIENT.userAgent,
    "X-YouTube-Client-Name": clientType === "WEB" ? "1" : "3",
    "X-YouTube-Client-Version": clientType === "WEB" ? "2.20230810.05.00" : ANDROID_CLIENT.clientVersion,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`InnerTube API Error: ${res.status} ${res.statusText}`);
  }

  return await res.json();
}

function parseUploadDate(yyyymmdd: string): Date | undefined {
  if (!yyyymmdd || yyyymmdd.length !== 8) return undefined;
  return new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00Z`);
}

async function getVideoDetails(videoId: string) {
  try {
    const data = await innertubePost(
      INNERTUBE_PLAYER_URL,
      {
        context: innertubeContext("ANDROID"),
        videoId,
      },
      "ANDROID"
    );
    const details = data?.videoDetails;
    if (!details?.videoId) return null;

    return {
      youtube_video_id: videoId,
      title: details.title ?? videoId,
      channel_name: details.author,
      thumbnail_url: details.thumbnail?.thumbnails?.at(-1)?.url,
      duration: details.lengthSeconds ? parseInt(details.lengthSeconds) : undefined,
    };
  } catch (e) {
    console.error("Error fetching video details:", e);
    return null;
  }
}

const RE_AMP = /&amp;/g;
const RE_LT = /&lt;/g;
const RE_GT = /&gt;/g;
const RE_QUOT = /&quot;/g;
const RE_APOS39 = /&#39;/g;
const RE_APOS = /&apos;/g;
const RE_HEX = /&#x([0-9a-fA-F]+);/g;
const RE_DEC = /&#(\d+);/g;

function decodeHtml(text: string): string {
  return text
    .replace(RE_AMP, "&")
    .replace(RE_LT, "<")
    .replace(RE_GT, ">")
    .replace(RE_QUOT, '"')
    .replace(RE_APOS39, "'")
    .replace(RE_APOS, "'")
    .replace(RE_HEX, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(RE_DEC, (_m, code) => String.fromCodePoint(parseInt(code, 10)));
}

function parseTranscriptXml(xml: string) {
  const items: { text: string; start: number; end: number }[] = [];

  const pMatches = xml.matchAll(/<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g);
  for (const m of pMatches) {
    const offset = parseInt(m[1]!, 10);
    const duration = parseInt(m[2]!, 10);
    const inner = m[3]!;
    let text = "";
    for (const s of inner.matchAll(/<s[^>]*>([^<]*)<\/s>/g)) text += s[1]!;
    if (!text) text = inner.replace(/<[^>]+>/g, "");
    text = decodeHtml(text).trim();
    if (text) items.push({ text, start: offset, end: offset + duration });
  }
  if (items.length > 0) return items;

  for (const m of xml.matchAll(/<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g)) {
    const offset = Math.round(parseFloat(m[1]!) * 1000);
    const duration = Math.round(parseFloat(m[2]!) * 1000);
    items.push({
      text: decodeHtml(m[3]!).trim(),
      start: offset,
      end: offset + duration,
    });
  }
  return items;
}

async function getCaptionTracks(videoId: string) {
  const data = await innertubePost(
    INNERTUBE_PLAYER_URL,
    {
      context: innertubeContext("ANDROID"),
      videoId,
    },
    "ANDROID"
  );
  return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

async function fetchTranscript(videoId: string, lang = "en") {
  const tracks = await getCaptionTracks(videoId);
  if (!tracks.length) return null;

  const officialTrack = tracks.find((t: any) => t.languageCode === lang && t.kind !== "asr");
  const autoTrack = tracks.find((t: any) => t.languageCode === lang && t.kind === "asr");
  const track = officialTrack ?? autoTrack;

  if (!track?.baseUrl) return null;

  const res = await fetch(track.baseUrl, {
    headers: { "User-Agent": WEB_USER_AGENT }
  });
  if (!res.ok) return null;

  const xml = await res.text();
  return parseTranscriptXml(xml);
}

function extractVideoId(url: string) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

export function handleYoutubeCrawl(router: Router, context: any) {
  router.post('/youtube/crawl', async (req, res) => {
    try {
      const { url } = req.body;
      context.logger.info(`[youtube/crawl] Received URL: ${url}`);
      
      if (!url) {
        return res.status(400).json({ success: false, message: 'Missing "url" in payload.' });
      }

      const videoId = extractVideoId(url);
      context.logger.info(`[youtube/crawl] Extracted videoId: ${videoId}`);
      
      if (!videoId) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube URL.' });
      }

      const videoMeta = await getVideoDetails(videoId);
      context.logger.info(`[youtube/crawl] Video meta result: ${videoMeta ? 'success' : 'null'}`);
      
      if (!videoMeta) {
        return res.status(404).json({ success: false, message: 'Video not found or unavailable.' });
      }

      const transcript = await fetchTranscript(videoId, 'en');
      context.logger.info(`[youtube/crawl] Transcript result: ${transcript ? transcript.length + ' segments' : 'null'}`);

      return res.status(200).json({
        success: true,
        data: {
          video: videoMeta,
          transcript: transcript || []
        }
      });
    } catch (error: any) {
      context.logger.error(`YouTube Crawl Error: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: 'Failed to crawl YouTube video.',
        error: error.message
      });
    }
  });
}
