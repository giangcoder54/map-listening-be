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
import { advanceDue, getState, sweepPresence } from './coop';
import { langOf } from './extensive';

type Sub = { client: any; user: string; since: number; lang: string };
type Hub = { rooms: Map<string, Set<Sub>>; timers: Map<string, ReturnType<typeof setTimeout>>; started: boolean; id: string; safety: ReturnType<typeof setInterval> | null; presence?: ReturnType<typeof setInterval> | null };
const g = globalThis as any;
const hub: Hub = (g.__coopHub ||= { rooms: new Map(), timers: new Map(), started: false, id: randomUUID(), safety: null });
const CHANNEL = 'coop_room';
const SAFETY_MS = 30_000;
const PRESENCE_SCAN_MS = 5_000;
const BOOT_GRACE_MS = 60_000;

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
		const data = await getState(db, sub.user, roomId, sub.since, sub.lang);
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

export async function subscribe(db: any, client: any, roomId: string, since: number, lang?: unknown) {
	const user = client.accountability?.user as string | undefined;
	if (!user) return send(client, { type: 'coop.error', code: 'UNAUTHORIZED' });
	drop(client);
	const sub: Sub = { client, user, since: Number(since) || 0, lang: langOf(lang) };
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

/**
 * A player with an open socket on this process is here, whatever the page's timers do (a tab hidden for minutes gets its
 * timers throttled by the browser, so its HTTP pings can be late). The ping stays for a page whose socket is not up.
 */
export async function touchWatchers(db: any) {
	const now = new Date();
	for (const [roomId, subs] of hub.rooms) {
		const users = [...subs].filter((s) => s.client.readyState === 1).map((s) => s.user);
		if (users.length) await db('coop_members').where('room_id', roomId).whereIn('user_id', users).update({ last_seen: now });
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
	// who went silent leaves the room; not in the first minute, so a restart does not drop players before their pages ping again
	const boot = Date.now();
	hub.presence = setInterval(async () => {
		try {
			await touchWatchers(db);
			if (Date.now() - boot < BOOT_GRACE_MS) return;
			for (const id of await sweepPresence(db)) await notify(db, id);
		} catch (e: any) { logger?.warn?.(`[coop] presence scan failed: ${String(e)}`); }
	}, PRESENCE_SCAN_MS);
}
