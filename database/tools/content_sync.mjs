// Content made on local since the last deploy -> one SQL file to run on the server (database/deploy/content-sync.sql).
//
// base    = what the server got at the last deploy (--base dump, then --cleanup, then deploy/migration-order.txt)
// local   = the local database
// The file holds only the rows local added or changed since base, and never deletes:
//   new row      INSERT ... ON CONFLICT DO NOTHING
//   changed row  UPDATE only while the server still holds the base values (an edit made on the server wins, with a warning)
// It is then rehearsed twice on a copy (--server dump, a fresh one from the server; default: the base).
//
//   node database/tools/content_sync.mjs --base D:/backup-server/to-upload/db-merged.dump \
//        --cleanup D:/backup-server/to-upload/cleanup-test-data.sql [--server D:/backup-server/<new>/db.dump]
//
// Needs the local map-listening-db container. Makes and drops the databases sync_base and sync_server.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Content only, parents before children. Never learner activity, accounts, orders or Kim cương.
// Left out on purpose: xu_packs (local holds Polar sandbox ids), dyk_schedule (the server picks its own days).
const TABLES = [
	'source_videos', 'video_tags', 'video_lines', 'video_line_translations',
	'listening_groups', 'listening_groups_translations', 'listening_skills', 'listening_skills_translations',
	'listening_lessons', 'listening_lessons_translations', 'listening_clips', 'listening_clip_lines',
	'el_lessons', 'el_segments', 'el_questions', 'el_notes', 'el_vocab', 'el_translations', 'el_line_subs',
	'il_lessons', 'il_sentences', 'il_translations', 'il_vocab',
	'phrases', 'phrases_translations', 'phrase_clips', 'practice_videos',
	'review_quotes', 'review_quote_translations', 'dyk_cards', 'dyk_translations',
]
// Counted from what learners do: the server keeps its own
const SKIP_COLUMNS = { listening_lessons: ['learners_count'] }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null }
if (!arg('base')) throw new Error('--base <dump> is required')

const CONTAINER = 'map-listening-db'
const sh = (script, input) => execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', script], { input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] })
const LOCAL = '"$POSTGRES_DB"'
const query = (db, sql) => sh(`psql -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ${db}`, sql).split('\n').filter(Boolean)
const run = (db, sql) => {
	const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', `psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ${db}`], { input: sql, encoding: 'utf8', maxBuffer: 1 << 30 })
	if (r.status !== 0) throw new Error(`${db}: ${r.stderr.split('\n').filter(l => /ERROR|DETAIL/.test(l)).join('\n')}`)
	return r.stderr.split('\n').filter(l => l.includes('WARNING'))
}
const drop = db => sh(`psql -q -U "$POSTGRES_USER" -d postgres -c "drop database if exists ${db}"`)

/** A server copy as it will be after the migrations: what the data file runs on */
function build(db, dump, cleanup) {
	drop(db)
	sh(`psql -q -U "$POSTGRES_USER" -d postgres -c "create database ${db}"`)
	sh(`pg_restore --no-owner -U "$POSTGRES_USER" -d ${db}`, readFileSync(dump))
	if (cleanup) run(db, readFileSync(cleanup, 'utf8'))
	for (const file of readFileSync(join(root, 'deploy/migration-order.txt'), 'utf8').split(/\r?\n/).filter(Boolean)) {
		// A fresh server dump may already have some of them: those files are written to run again or to fail whole
		try { run(db, readFileSync(join(root, 'migrations', file), 'utf8')) }
		catch (e) { console.log(`  migration ${file} not applied on ${db}: ${e.message.split('\n')[1] || e.message}`) }
	}
}

const primaryKey = (db, t) => query(db, `select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
	where i.indrelid='${t}'::regclass and i.indisprimary order by a.attnum;`)
const columns = (db, t) => query(db, `select column_name from information_schema.columns where table_schema='public' and table_name='${t}' and is_generated='NEVER' order by ordinal_position;`)
const rows = (db, t, key) => new Map(query(db, `select to_jsonb(t) from "${t}" t;`).map(line => { const r = JSON.parse(line); return [JSON.stringify(key.map(k => r[k])), r] }))

function diff(from, to) {
	const out = []
	for (const t of TABLES) {
		const key = primaryKey(to, t)
		if (!key.length) throw new Error(`${t} has no primary key`)
		const cols = columns(to, t)
		const missing = cols.filter(c => !columns(from, t).includes(c))
		if (missing.length) throw new Error(`${t}: the server copy lacks ${missing.join(', ')} (a migration is missing from migration-order.txt)`)
		const before = rows(from, t, key), after = rows(to, t, key)
		const added = [], changed = []
		for (const [id, row] of after) {
			const old = before.get(id)
			if (!old) { added.push(row); continue }
			const d = cols.filter(c => !(SKIP_COLUMNS[t] || []).includes(c) && JSON.stringify(row[c]) !== JSON.stringify(old[c]))
			if (d.length) changed.push({ row, old, cols: d })
		}
		const gone = [...before.keys()].filter(id => !after.has(id))
		if (added.length || changed.length || gone.length) out.push({ t, key, cols, added, changed, gone })
	}
	return out
}

const literal = value => {
	const s = JSON.stringify(value)
	if (s.includes('$sync$') || s.includes('$do$')) throw new Error('a row holds the quoting mark')
	return `$sync$${s}$sync$`
}
const names = list => list.map(c => `"${c}"`).join(', ')

function toSql(changes) {
	const out = ['-- Made by database/tools/content_sync.mjs. Content only; nothing is deleted; safe to run twice.', '\\set ON_ERROR_STOP on', "set client_encoding = 'UTF8';", 'begin;']
	for (const { t, key, cols, added, changed } of changes) {
		out.push(`\n-- ${t}: ${added.length} new, ${changed.length} changed`)
		for (let i = 0; i < added.length; i += 500) {
			out.push(`insert into "${t}" (${names(cols)}) select ${names(cols)} from jsonb_populate_recordset(null::"${t}", ${literal(added.slice(i, i + 500))}::jsonb) on conflict do nothing;`)
		}
		for (const c of changed) {
			const where = key.map(k => `t."${k}" = n."${k}"`).join(' and ')
			const same = rec => c.cols.map(k => `t."${k}"::text is not distinct from ${rec}."${k}"::text`).join(' and ')
			out.push(`do $do$ begin
  update "${t}" t set ${c.cols.map(k => `"${k}" = n."${k}"`).join(', ')}
    from jsonb_populate_record(null::"${t}", ${literal(c.row)}::jsonb) n, jsonb_populate_record(null::"${t}", ${literal(c.old)}::jsonb) o
    where ${where} and ${same('o')};
  if not found and not exists (select 1 from "${t}" t, jsonb_populate_record(null::"${t}", ${literal(c.row)}::jsonb) n where ${where} and ${same('n')}) then
    raise warning '${t} ${key.map(k => String(c.row[k]).replace(/'/g, "''")).join(' ')}: changed on the server (or gone), left as it is';
  end if;
end $do$;`)
		}
		// Numbered ids copied from local must not be handed out again
		for (const k of key) {
			out.push(`select setval(s, greatest((select max("${k}"::text::bigint) from "${t}"), 1)) from (select pg_get_serial_sequence('${t}', '${k}') s) x where s is not null;`)
		}
	}
	out.push('commit;', '')
	return out.join('\n')
}

try {
	console.log('Building the base (what the server got)...')
	build('sync_base', arg('base'), arg('cleanup'))
	const changes = diff('sync_base', LOCAL)
	console.log('\nChanged on local since then:')
	for (const c of changes) console.log(`  ${c.t.padEnd(28)} new ${c.added.length}, changed ${c.changed.length}${c.gone.length ? `, removed on local ${c.gone.length} (NOT removed on the server)` : ''}`)
	const sql = toSql(changes.filter(c => c.added.length || c.changed.length))
	const file = join(root, 'deploy/content-sync.sql')
	writeFileSync(file, sql)
	console.log(`\nWritten: ${file} (${(Buffer.byteLength(sql) / 1024).toFixed(0)} KB)`)

	console.log('\nRehearsal...')
	build('sync_server', arg('server') || arg('base'), arg('server') ? null : arg('cleanup'))
	for (const go of [1, 2]) {
		const warnings = run('sync_server', sql)
		console.log(`  run ${go}: OK, ${warnings.length} row(s) left as on the server`)
		for (const w of warnings) console.log('    ' + w.replace(/^.*WARNING:\s*/, ''))
	}
	// Every row the file carries is now on the server copy as it is on local
	let bad = 0
	for (const c of changes) {
		const server = rows('sync_server', c.t, c.key)
		const wrong = (row, cols) => { const s = server.get(JSON.stringify(c.key.map(k => row[k]))); return !s || cols.some(k => JSON.stringify(s[k]) !== JSON.stringify(row[k])) }
		const n = c.added.filter(r => wrong(r, c.cols)).length + c.changed.filter(x => wrong(x.row, x.cols)).length
		if (n) console.log(`  ${c.t}: ${n} row(s) differ from local`)
		bad += n
	}
	console.log(bad ? `  ${bad} row(s) differ` : '  every row sent now matches local')
}
finally {
	drop('sync_base')
	drop('sync_server')
}
