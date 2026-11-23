/**
 * Pushes a room's state to the browsers watching it, over Directus's own WebSocket (/websocket, already authenticated:
 * the session cookie signs the socket in, then the browser sends { type: 'coop.sub', room, since }). Each push is that
 * player's own getState(), so the hidden answer never reaches the wrong screen.
 *
 * Built to run on several Directus processes at once:
 *  - the registry of watchers is per process, so a change is announced to the others through Postgres LISTEN/NOTIFY
 *    (channel coop_room; no new service, the database is already shared). Each process pushes to its own watchers.
 *  - a duel's clock is not scanned every second: when a room's state says "ends in N ms", one timer is set for that
 *    moment (advanceDue is idempotent under the room's row lock, so two processes firing it is harmless). A slow
 *    safety scan (SAFETY_MS) only catches a timer that was lost.
 * The hook and the endpoints are separate bundles, so the registry lives on globalThis to be one for both.
 */
import { randomUUID } from 'node:crypto';
import { advanceDue, getState } from './coop';

type Sub = { client: any; user: string; since: number };
type Hub = { rooms: Map<string, Set<Sub>>; timers: Map<string, ReturnType<typeof setTimeout>>; started: boolean; id: string; safety: ReturnType<typeof setInterval> | null };
const g = globalThis as any;
const hub: Hub = (g.__coopHub ||= { rooms: new Map(), timers: new Map(), started: false, id: randomUUID(), safety: null });
const CHANNEL = 'coop_room';
const SAFETY_MS = 30_000;

const send = (client: any, payload: unknown) => { try { if (client.readyState === 1) client.send(JSON.stringify(payload)); } catch { /* socket gone */ } };

function schedule(db: any, roomId: string, inMs: number | null) {
	const old = hub.timers.get(roomId);
	if (old) clearTimeout(old);
	if (inMs == null) { hub.timers.delete(roomId); return; }
	hub.timers.set(roomId, setTimeout(async () => {
		hub.timers.delete(roomId);
		try { if (await advanceDue(db, roomId)) await notify(db, roomId); } catch { /* the safety scan will retry */ }
	}, Math.max(0, inMs) + 60));
}

async function push(db: any, roomId: string, sub: Sub) {
	try {
		const data = await getState(db, sub.user, roomId, sub.since);
		const last = data.messages?.length ? data.messages[data.messages.length - 1].id : 0;
		if (last > sub.since) sub.since = last;
		send(sub.client, { type: 'coop.state', data });
		schedule(db, roomId, data.ends_in);
	} catch (e: any) { send(sub.client, { type: 'coop.error', code: e?.code || 'ERROR' }); }
}

async function pushLocal(db: any, roomId: string) {
	const subs = hub.rooms.get(roomId);
	if (!subs) return;
	await Promise.all([...subs].map((s) => push(db, roomId, s)));
}

export async function subscribe(db: any, client: any, roomId: string, since: number) {
	const user = client.accountability?.user as string | undefined;
	if (!user) return send(client, { type: 'coop.error', code: 'UNAUTHORIZED' });
	drop(client);
	const sub: Sub = { client, user, since: Number(since) || 0 };
	if (!hub.rooms.has(roomId)) hub.rooms.set(roomId, new Set());
	hub.rooms.get(roomId)!.add(sub);
	await push(db, roomId, sub);
}

export function drop(client: any) {
	for (const [id, subs] of hub.rooms) {
		for (const s of subs) if (s.client === client) subs.delete(s);
		if (!subs.size) { hub.rooms.delete(id); const t = hub.timers.get(id); if (t) clearTimeout(t); hub.timers.delete(id); }
	}
}

/** Something changed in this room: push to the watchers on this process and tell the other processes */
export async function notify(db: any, roomId: string) {
	db.raw('select pg_notify(?, ?)', [CHANNEL, JSON.stringify({ room: roomId, from: hub.id })]).catch(() => null);
	await pushLocal(db, roomId);
}

/** Listen for the other processes' announcements (a dedicated connection outside the pool, re-opened if it drops) */
async function listen(db: any, logger?: any) {
	try {
		const conn = await db.client.acquireRawConnection();
		conn.on('notification', (m: any) => {
			try { const p = JSON.parse(m.payload); if (p.from !== hub.id) pushLocal(db, String(p.room)).catch(() => null); } catch { /* not ours */ }
		});
		conn.on('error', () => { try { conn.end(); } catch { /* closed */ } });
		conn.on('end', () => setTimeout(() => listen(db, logger), 5000));
		await conn.query(`LISTEN ${CHANNEL}`);
		logger?.info?.(`[coop] listening for room changes from other processes (${hub.id.slice(0, 8)})`);
	} catch (e: any) {
		logger?.warn?.(`[coop] cannot listen for room changes: ${String(e)}`);
		setTimeout(() => listen(db, logger), 5000);
	}
}

/** Start once per process: the Postgres listener and the slow safety scan */
export function startTicker(db: any, logger?: any) {
	if (hub.started) return;
	hub.started = true;
	listen(db, logger);
	hub.safety = setInterval(async () => {
		for (const id of [...hub.rooms.keys()]) {
			try { if (await advanceDue(db, id)) await notify(db, id); } catch (e: any) { logger?.warn?.(`[coop] safety scan failed: ${String(e)}`); }
		}
	}, SAFETY_MS);
}
