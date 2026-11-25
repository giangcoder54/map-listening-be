/**
 * Voice for Luyện cùng (web repo docs/duel-and-coop-spec.md, section 3.3): LiveKit, an open-source WebRTC server (self-host or LiveKit Cloud).
 * The browser talks to LiveKit directly; this server only hands out a short token for the room's two players.
 * An access token is a signed JWT (HS256), so no SDK is needed. Off while LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set.
 * Not in a duel: the players must not talk about the answer.
 * 15 minutes of voice per room, counted from the first time either player joins the call (coop_rooms.voice_started_at);
 * the token expires then, so no one can join again after it. The browser ends the call itself at that moment.
 */
import { createHmac } from 'node:crypto';
import { CoopError } from './coop';

/** Voice time of one room, in seconds */
export const VOICE_SECONDS = 15 * 60;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export const voiceOn = () => !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

export function voiceToken(identity: string, name: string, room: string, ttlSeconds = 2 * 60 * 60) {
	const key = String(process.env.LIVEKIT_API_KEY), secret = String(process.env.LIVEKIT_API_SECRET);
	const now = Math.floor(Date.now() / 1000);
	const head = b64({ alg: 'HS256', typ: 'JWT' });
	const body = b64({ iss: key, sub: identity, name, nbf: now - 10, exp: now + ttlSeconds, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false } });
	return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

/**
 * A player of a practice room asks about voice. `start` (pressing the mic) starts the room's 15 minutes and gives a token
 * for that room only; without it the answer only says whether voice is on and how many seconds are left (no token).
 */
export async function joinVoice(db: any, userId: string, roomId: string, start = false) {
	if (!voiceOn()) return { on: false as const };
	const room = await db('coop_rooms').where('id', roomId).first('id', 'mode', 'status', 'voice_started_at');
	if (!room) throw new CoopError('NO_ROOM');
	if (!(await db('coop_members').where({ room_id: roomId, user_id: userId }).first('user_id'))) throw new CoopError('NOT_MEMBER');
	if (room.mode === 'duel' || !['waiting', 'playing'].includes(room.status)) throw new CoopError('NOT_PLAYING');
	let began = room.voice_started_at as Date | null;
	if (!began && start) {
		await db('coop_rooms').where('id', roomId).whereNull('voice_started_at').update({ voice_started_at: db.fn.now() });
		began = (await db('coop_rooms').where('id', roomId).first('voice_started_at')).voice_started_at;
	}
	const seconds = began ? Math.max(0, Math.floor((new Date(began).getTime() + VOICE_SECONDS * 1000 - Date.now()) / 1000)) : VOICE_SECONDS;
	if (!start || seconds <= 0) return { on: true as const, seconds };
	const u = await db('directus_users').where('id', userId).first('first_name', 'last_name');
	const name = [u?.first_name, String(u?.last_name || '').slice(0, 1)].filter(Boolean).join(' ') || 'Learner';
	return { on: true as const, seconds, url: String(process.env.LIVEKIT_URL), token: voiceToken(userId, name, `coop-${roomId}`, seconds) };
}
