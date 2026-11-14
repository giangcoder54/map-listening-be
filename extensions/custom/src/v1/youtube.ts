import type { Router } from 'express';
import { ProxyAgent } from 'undici';
import { isStaff } from '../lib/staff';
import { sentenceLines } from '../lib/sentenceLines';

const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}&prettyPrint=false`;

const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// ---- Proxy residential (đọc từ .env: YOUTUBE_PROXY_URL) --------------------
// Định dạng: http://user:pass@host:port  (ví dụ http://agYgKD:CPJlyfM9@snvt3.tunproxy.com:17386)
// YouTube chặn IP datacenter của server; đi qua proxy IP dân cư để vượt qua.
const YOUTUBE_PROXY_URL = process.env.YOUTUBE_PROXY_URL?.trim();
let proxyDispatcher: ProxyAgent | undefined;
if (YOUTUBE_PROXY_URL) {
  try {
    proxyDispatcher = new ProxyAgent(YOUTUBE_PROXY_URL);
  } catch (e: any) {
    // Không throw ở tầng module để tránh sập extension; sẽ log khi có request.
    proxyDispatcher = undefined;
  }
}

function maskProxy(url?: string): string {
  if (!url) return "(none)";
  return url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
}

// fetch có gắn proxy dispatcher (nếu có cấu hình). Node fetch chấp nhận option `dispatcher`.
export function proxiedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const opts: any = { ...init };
  if (proxyDispatcher) opts.dispatcher = proxyDispatcher;
  return fetch(url, opts);
}
// ---------------------------------------------------------------------------

type ClientType = "ANDROID" | "IOS" | "WEB";

// Mỗi client gồm: context gửi lên InnerTube + headers tương ứng.
// Thứ tự thử: ANDROID -> IOS -> WEB.
const CLIENTS: Record<ClientType, { context: any; headers: Record<string, string> }> = {
  ANDROID: {
    context: {
      client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en", gl: "US" },
    },
    headers: {
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
      "X-YouTube-Client-Name": "3",
      "X-YouTube-Client-Version": "20.10.38",
    },
  },
  IOS: {
    context: {
      client: { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2", hl: "en", gl: "US" },
    },
    headers: {
      "User-Agent": "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
      "X-YouTube-Client-Name": "5",
      "X-YouTube-Client-Version": "20.10.4",
    },
  },
  WEB: {
    context: {
      client: { clientName: "WEB", clientVersion: "2.20230810.05.00", hl: "en", gl: "US" },
    },
    headers: {
      "User-Agent": WEB_USER_AGENT,
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": "2.20230810.05.00",
    },
  },
};

/**
 * Gọi InnerTube player endpoint, thử lần lượt các client cho tới khi lấy được videoDetails.
 * Log chi tiết mọi bước để debug được trên server (docker logs map-listening-api).
 */
export async function fetchPlayer(videoId: string, logger: any): Promise<{ data: any; clientType: ClientType | null; reason: string }> {
  const order: ClientType[] = ["ANDROID", "IOS", "WEB"];
  let lastReason = "unknown";

  logger.info(`[youtube] proxy=${maskProxy(YOUTUBE_PROXY_URL)} enabled=${!!proxyDispatcher}`);
  if (YOUTUBE_PROXY_URL && !proxyDispatcher) {
    logger.error(`[youtube] YOUTUBE_PROXY_URL đã đặt nhưng không khởi tạo được ProxyAgent. Kiểm tra định dạng URL.`);
  }

  for (const clientType of order) {
    const client = CLIENTS[clientType];
    const started = Date.now();
    try {
      const res = await proxiedFetch(INNERTUBE_PLAYER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...client.headers },
        body: JSON.stringify({ context: client.context, videoId }),
      });

      const rawText = await res.text();

      if (!res.ok) {
        lastReason = `HTTP ${res.status} ${res.statusText}`;
        logger.warn(`[youtube] player client=${clientType} ${lastReason} (${Date.now() - started}ms) body=${rawText.slice(0, 500)}`);
        continue;
      }

      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        lastReason = "response is not JSON";
        logger.warn(`[youtube] player client=${clientType} non-JSON body=${rawText.slice(0, 300)}`);
        continue;
      }

      const ps = data?.playabilityStatus;
      const status: string = ps?.status ?? "UNKNOWN";
      const reason: string =
        ps?.reason ||
        ps?.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText ||
        ps?.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText ||
        "";
      const hasDetails = !!data?.videoDetails?.videoId;

      logger.info(
        `[youtube] player client=${clientType} playabilityStatus=${status} reason="${reason}" hasVideoDetails=${hasDetails} (${Date.now() - started}ms)`
      );

      if (hasDetails) {
        return { data, clientType, reason: "" };
      }

      lastReason = `${status}${reason ? ` - ${reason}` : ""}`;
    } catch (e: any) {
      const code = e?.cause?.code || e?.code || "";
      lastReason = `fetch error: ${e?.message}${code ? ` (${code})` : ""}`;
      logger.error(`[youtube] player client=${clientType} ${lastReason}`);
    }
  }

  logger.warn(`[youtube] all clients failed for videoId=${videoId}. lastReason=${lastReason}`);
  return { data: null, clientType: null, reason: lastReason };
}

export function getVideoMeta(data: any, videoId: string) {
  const details = data?.videoDetails;
  if (!details?.videoId) return null;
  return {
    youtube_video_id: videoId,
    title: details.title ?? videoId,
    channel_name: details.author,
    thumbnail_url: details.thumbnail?.thumbnails?.at(-1)?.url,
    duration: details.lengthSeconds ? parseInt(details.lengthSeconds) : undefined,
  };
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

/** Which subtitles a transcript came from (source_videos.transcript_kind) */
export type TranscriptKind = "manual" | "asr" | "none";

/**
 * The subtitle track to read: one made by a person in the language (en, then en-US, en-GB…),
 * else YouTube's automatic one. Never a track in another language: an English listening
 * transcript cannot come from Spanish subtitles, so such a video has none.
 */
export function pickCaptionTrack(data: any, lang = "en"): { track: any; kind: TranscriptKind; lang: string | null } {
  const tracks: any[] = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const inLang = (t: any) => {
    const code = String(t?.languageCode || "").toLowerCase();
    return code === lang || code.startsWith(`${lang}-`);
  };
  // The exact code first ("en" before "en-GB")
  const ranked = tracks.filter(inLang).sort((a, b) => Number(b.languageCode === lang) - Number(a.languageCode === lang));
  const track = ranked.find((t) => t.kind !== "asr") ?? ranked.find((t) => t.kind === "asr");
  if (!track) return { track: null, kind: "none", lang: null };
  return { track, kind: track.kind === "asr" ? "asr" : "manual", lang: track.languageCode || lang };
}

/**
 * Transcript with where it came from. `kind` is 'none' when the video has no subtitles in the
 * language; `items` is null when YouTube could not be read (try again later).
 */
export async function fetchCaptions(data: any, logger: any, lang = "en"): Promise<{ items: { text: string; start: number; end: number }[] | null; kind: TranscriptKind; lang: string | null }> {
  const tracks: any[] = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  logger.info(
    `[youtube] caption tracks=${tracks.length} langs=[${tracks.map((t) => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(", ")}]`
  );
  const picked = pickCaptionTrack(data, lang);
  if (!picked.track) return { items: [], kind: "none", lang: null };
  const items = await downloadTrack(picked.track, logger, picked.kind === "manual" ? "manual" : "asr");
  return { items, kind: picked.kind, lang: picked.lang };
}

/**
 * Lấy transcript từ chính response player đã fetch được (dùng lại data, không gọi thêm 1 lần).
 * Request tải phụ đề cũng đi qua proxy.
 */
export async function fetchTranscriptFromPlayer(data: any, logger: any, lang = "en") {
  const { items, kind } = await fetchCaptions(data, logger, lang);
  return kind === "none" ? null : items;
}

/**
 * The track as transcript lines: sentence lines (see lib/sentenceLines) when they can be made,
 * else YouTube's cues as they are.
 */
async function downloadTrack(track: any, logger: any, kind: "manual" | "asr") {
  if (!track?.baseUrl) {
    logger.warn(`[youtube] no baseUrl on selected caption track`);
    return null;
  }

  try {
    // srv3: the format with a time for every word of an automatic track
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "srv3");
    const res = await proxiedFetch(url.toString(), { headers: { "User-Agent": WEB_USER_AGENT } });
    if (!res.ok) {
      logger.warn(`[youtube] transcript fetch HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const xml = await res.text();
    const items = parseTranscriptXml(xml);
    logger.info(`[youtube] transcript parsed ${items.length} segments (lang=${track.languageCode})`);
    if (!items.length) return items;
    const lines = await sentenceLines(xml, kind, logger).catch((e) => {
      logger.warn(`[youtube] sentence lines failed: ${e?.message}`);
      return null;
    });
    if (lines?.length) {
      logger.info(`[youtube] ${items.length} cues -> ${lines.length} sentence lines (${kind})`);
      return lines;
    }
    return items;
  } catch (e: any) {
    logger.error(`[youtube] transcript fetch error: ${e?.message}`);
    return null;
  }
}

export function extractVideoId(url: string) {
  const regex =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

export function handleYoutubeCrawl(router: Router, context: any) {
  router.post('/youtube/crawl', async (req, res) => {
    const logger = context.logger;
    // Used by the admin lesson editor only (admins and content editors)
    if (!isStaff((req as any).accountability)) {
      return res.status(403).json({ success: false, message: 'Admins and editors only.' });
    }
    try {
      const { url } = req.body;
      logger.info(`[youtube/crawl] Received URL: ${url}`);

      if (!url) {
        return res.status(400).json({ success: false, message: 'Missing "url" in payload.' });
      }

      const videoId = extractVideoId(url);
      logger.info(`[youtube/crawl] Extracted videoId: ${videoId}`);

      if (!videoId) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube URL.' });
      }

      const { data, clientType, reason } = await fetchPlayer(videoId, logger);

      if (!data) {
        logger.warn(`[youtube/crawl] No player data for ${videoId}. reason=${reason}`);
        return res.status(404).json({
          success: false,
          message: 'Video not found or unavailable.',
          reason,
        });
      }

      logger.info(`[youtube/crawl] Player OK via client=${clientType} for ${videoId}`);

      const videoMeta = getVideoMeta(data, videoId);
      if (!videoMeta) {
        logger.warn(`[youtube/crawl] Player data present but videoDetails missing for ${videoId}`);
        return res.status(404).json({ success: false, message: 'Video not found or unavailable.' });
      }

      const captions = await fetchCaptions(data, logger, 'en');
      logger.info(`[youtube/crawl] Transcript result: ${captions.items ? captions.items.length + ' segments' : 'null'} kind=${captions.kind}`);

      return res.status(200).json({
        success: true,
        data: {
          video: videoMeta,
          transcript: captions.items || [],
          transcript_kind: captions.kind,
          transcript_lang: captions.lang,
        },
      });
    } catch (error: any) {
      logger.error(`[youtube/crawl] Crawl Error: ${error?.stack || error?.message}`);
      return res.status(500).json({
        success: false,
        message: 'Failed to crawl YouTube video.',
        error: error?.message,
      });
    }
  });
}
