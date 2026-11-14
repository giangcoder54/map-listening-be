/**
 * Re-cut stored person-made transcripts into sentence lines (no YouTube calls, no AI).
 * Input: the stored cues [{text,start,end}] (ms). Output: one SQL file of UPDATEs.
 *
 *   npx tsx scripts/recut-manual.ts <input.psv> <out.sql> [--dry]
 *
 * input.psv rows: id|youtube_video_id|transcript-json  (from psql -At)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { sentenceLines } from '../src/lib/sentenceLines';

const [input, out, flag] = process.argv.slice(2);
const dry = flag === '--dry';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Cue = { text: string; start: number; end: number };
const rows = readFileSync(input!, 'utf8').split(/\r?\n/).filter(Boolean);
const sql: string[] = ['BEGIN;'];
let changed = 0, kept = 0, cuesTotal = 0, linesTotal = 0;
const stats: { id: string; cues: number; lines: number }[] = [];

for (const row of rows) {
	const [id, yt, json] = row.split('|') as [string, string, string];
	const cues = JSON.parse(json) as Cue[];
	cuesTotal += cues.length;
	// Cues as srv3 <p> elements: sentenceLines reads the same format YouTube sends
	const xml = `<timedtext>${cues
		.filter((c) => c.text && c.end > c.start)
		.map((c) => `<p t="${Math.round(c.start)}" d="${Math.round(c.end - c.start)}">${esc(c.text)}</p>`)
		.join('')}</timedtext>`;
	const lines = await sentenceLines(xml, 'manual');
	if (!lines || lines.length < 2) { kept++; continue; }
	changed++;
	linesTotal += lines.length;
	stats.push({ id: yt, cues: cues.length, lines: lines.length });
	const payload = JSON.stringify(lines.map((l) => ({ text: l.text, start: Math.round(l.start), end: Math.round(l.end) })));
	// dollar-quoted so quotes in the text need no escaping
	sql.push(`UPDATE source_videos SET transcript = $tr$${payload}$tr$::jsonb WHERE id = '${id}';`);
}
sql.push('COMMIT;');

const ratio = (linesTotal / Math.max(1, changed)).toFixed(2);
console.log(`videos: ${rows.length} | re-cut: ${changed} | kept (no punctuation): ${kept}`);
console.log(`cues ${cuesTotal} -> lines ${linesTotal} (avg lines per video ${ratio})`);
console.log('sample:', stats.slice(0, 3));
if (!dry) writeFileSync(out!, sql.join('\n'), 'utf8');
console.log(dry ? 'dry run: nothing written' : `wrote ${out}`);
