/**
 * Voice for Luyện cùng (web repo docs/duel-and-coop-spec.md, section 3.3): LiveKit, an open-source WebRTC server (self-host or LiveKit Cloud).
 * The browser talks to LiveKit directly; this server only hands out a short token for the room's two players.
 * An access token is a signed JWT (HS256), so no SDK is needed. Off while LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set.
 * Not in a duel: the players must not talk about the answer.
 */
import { createHmac } from 'node:crypto';
import { CoopError } from './coop';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export const voiceOn = () => !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

export function voiceToken(identity: string, name: string, room: string, ttlSeconds = 2 * 60 * 60) {
	const key = String(process.env.LIVEKIT_API_KEY), secret = String(process.env.LIVEKIT_API_SECRET);
	const now = Math.floor(Date.now() / 1000);
	const head = b64({ alg: 'HS256', typ: 'JWT' });
	const body = b64({ iss: key, sub: identity, name, nbf: now - 10, exp: now + ttlSeconds, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false } });
	return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

/** A player of a practice room asks to talk: the server address and a token for that room only */
export async function joinVoice(db: any, userId: string, roomId: string) {
	if (!voiceOn()) return { on: false as const };
	const room = await db('coop_rooms').where('id', roomId).first('id', 'mode', 'status');
	if (!room) throw new CoopError('NO_ROOM');
	if (!(await db('coop_members').where({ room_id: roomId, user_id: userId }).first('user_id'))) throw new CoopError('NOT_MEMBER');
	if (room.mode === 'duel' || !['waiting', 'playing'].includes(room.status)) throw new CoopError('NOT_PLAYING');
	const u = await db('directus_users').where('id', userId).first('first_name', 'last_name');
	const name = [u?.first_name, String(u?.last_name || '').slice(0, 1)].filter(Boolean).join(' ') || 'Learner';
	return { on: true as const, url: String(process.env.LIVEKIT_URL), token: voiceToken(userId, name, `coop-${roomId}`) };
}
