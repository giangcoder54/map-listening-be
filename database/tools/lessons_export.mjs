// Chosen Extensive / Intensive lessons on local -> one SQL file to run on the server (database/deploy/lessons.sql).
//
//   node database/tools/lessons_export.mjs --since 2026-11-25        every lesson made from that day on
//   node database/tools/lessons_export.mjs <lesson id> [<id> ...]    just these
//
// Only adds: a lesson the server already has (same id) is left exactly as it is, so running it twice is safe.
// A video the server already made a lesson of (same feature, e.g. one made in its admin) is skipped too, so no doubles.
// A video the server already holds (same YouTube id) is reused, whatever its id there.
// Needs the local map-listening-db container.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const query = sql => execFileSync('docker', ['exec', '-i', 'map-listening-db', 'sh', '-c', 'psql -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], { input: sql, encoding: 'utf8', maxBuffer: 1 << 30 }).split('\n').filter(Boolean)
const rows = (table, where) => query(`select to_jsonb(t) from ${table} t where ${where};`).map(l => JSON.parse(l))
const quote = s => `'${String(s).replace(/'/g, "''")}'`

const args = process.argv.slice(2)
const since = args[0] === '--since' ? args[1] : null
if (since ? !/^\d{4}-\d\d-\d\d$/.test(since) : !args.length || args.some(a => !/^[0-9a-f-]{36}$/.test(a))) throw new Error('Give --since YYYY-MM-DD, or lesson ids')
const where = since ? `date_created >= '${since}'` : `id in (${args.map(quote).join(',')})`

// Parents before children
const FEATURES = [
	{ table: 'el_lessons', children: ['el_segments', 'el_questions', 'el_spare_questions', 'el_vocab', 'el_notes', 'el_translations', 'el_line_subs'] },
	{ table: 'il_lessons', children: ['il_sentences', 'il_vocab', 'il_translations'] },
]

const literal = value => {
	const s = JSON.stringify(value)
	if (s.includes('$row$') || s.includes('$do$')) throw new Error('a row holds the quoting mark')
	return `$row$${s}$row$`
}
const insert = (table, list) => {
	if (!list.length) return ''
	const cols = Object.keys(list[0]).map(c => `"${c}"`).join(', ')
	return `insert into ${table} (${cols}) select ${cols} from jsonb_populate_recordset(null::${table}, ${literal(list)}::jsonb) on conflict do nothing;`
}

const out = ['-- Made by database/tools/lessons_export.mjs. Only adds rows; safe to run twice.', '\\set ON_ERROR_STOP on', "set client_encoding = 'UTF8';", 'begin;']
let total = 0
for (const { table, children } of FEATURES) {
	const chosen = rows(table, where)
	const ids = chosen.map(l => quote(l.id)).join(', ')
	for (const lesson of chosen) {
		const [video] = rows('source_videos', `id = ${quote(lesson.source_video_id)}`)
		const tags = rows('video_tags', `source_video_id = ${quote(video.id)}`)
		const kids = children.map(t => [t, rows(t, `lesson_id = ${quote(lesson.id)}`)])
		const yt = quote(video.youtube_video_id)
		out.push(`\n-- ${table} ${lesson.id}: ${String(lesson.title).replace(/\s+/g, ' ')}`)
		// The video first; its id on the server is looked up by YouTube id
		out.push(`insert into source_videos select * from jsonb_populate_record(null::source_videos, ${literal(video)}::jsonb) where not exists (select 1 from source_videos where youtube_video_id = ${yt}) on conflict do nothing;`)
		out.push(`do $do$
declare v uuid := (select id from source_videos where youtube_video_id = ${yt} limit 1);
begin
  if exists (select 1 from ${table} where id = ${quote(lesson.id)}) then
    raise notice 'already there: ${lesson.id}';
    return;
  end if;
  if exists (select 1 from ${table} where source_video_id = v and id not in (${ids})) then
    raise notice 'skipped, the server has its own lesson of this video: %', ${quote(lesson.title)};
    return;
  end if;
  ${tags.length ? `insert into video_tags select (jsonb_populate_record(null::video_tags, ${literal(tags[0])}::jsonb || jsonb_build_object('source_video_id', v))).* on conflict do nothing;` : ''}
  insert into ${table} select (jsonb_populate_record(null::${table}, ${literal(lesson)}::jsonb || jsonb_build_object('source_video_id', v))).*;
  ${kids.map(([t, list]) => insert(t, list)).filter(Boolean).join('\n  ')}
end $do$;`)
		console.log(`  ${table.slice(0, 2).toUpperCase()}  ${lesson.status.padEnd(9)} ${lesson.title}`)
		total++
	}
}
out.push('commit;', '')
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'lessons.sql')
writeFileSync(file, out.join('\n'))
console.log(`${total} lesson(s) -> ${file}`)
