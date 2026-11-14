/**
 * Re-cut stored AUTOMATIC-caption transcripts into sentence lines, from the stored cues
 * (no YouTube call): the AI adds punctuation, the words keep the time of the cue they were in.
 * Videos are done in parallel. Output: one SQL file of UPDATEs, one JSON of what happened.
 *
 *   npx tsx scripts/recut-asr.ts <input.psv> <out.sql> [--limit N] [--only YTID,YTID] [--par N] [--dry]
 *
 * input.psv rows: id|youtube_video_id|transcript-json (psql -At)
 * The AI settings (AI_BASE_URL, AI_API_KEY, AI_MODEL) are read from ../../.env
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { sentenceLines } from '../src/lib/sentenceLines';

for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
	const m = /^(AI_BASE_URL|AI_API_KEY|AI_MODEL)=(.*)$/.exec(l);
	if (m) process.env[m[1]!] = m[2]!.trim();
}
const args = process.argv.slice(2);
const [input, out] = args as [string, string];
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const limit = Number(opt('--limit') || 0), par = Number(opt('--par') || 6), dry = args.includes('--dry');
const only = opt('--only')?.split(',');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Cue = { text: string; start: number; end: number };
let rows = readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((r) => r.split('|') as [string, string, string]);
if (only) rows = rows.filter((r) => only.includes(r[1]));
if (limit) rows = rows.slice(0, limit);

/** A cue lasts until the next one starts (rolling captions overlap), at most 8 s */
const toXml = (cues: Cue[]) => {
	const c = cues.filter((x) => x.text && x.end > x.start).sort((a, b) => a.start - b.start);
	return `<timedtext>${c.map((x, i) => {
		const next = c[i + 1]?.start ?? x.end;
		const d = Math.max(300, Math.min(x.end, next > x.start ? next : x.end, x.start + 8000) - x.start);
		return `<p t="${Math.round(x.start)}" d="${Math.round(d)}">${esc(x.text.replace(/\s+/g, ' '))}</p>`;
	}).join('')}</timedtext>`;
};

const results: { id: string; yt: string; cues: number; lines: number | null; error?: string }[] = [];
const sql: string[] = ['BEGIN;'];
let next = 0;
async function worker() {
	while (next < rows.length) {
		const [id, yt, json] = rows[next++]!;
		const cues = JSON.parse(json) as Cue[];
		try {
			const lines = await sentenceLines(toXml(cues), 'asr', args.includes('--debug') ? console : { warn: () => {}, info: () => {} });
			if (!lines || lines.length < 2) { results.push({ id, yt, cues: cues.length, lines: null, error: 'AI answer not usable or too many changes' }); continue; }
			const payload = JSON.stringify(lines.map((l) => ({ text: l.text, start: Math.round(l.start), end: Math.round(l.end) })));
			const stmt = `UPDATE source_videos SET transcript = $tr$${payload}$tr$::jsonb WHERE id = '${id}';`;
			sql.push(stmt);
			if (!dry) appendFileSync(out + '.parts', stmt + '\n', 'utf8');   // kept even if the run stops
			results.push({ id, yt, cues: cues.length, lines: lines.length });
		} catch (e: any) {
			results.push({ id, yt, cues: cues.length, lines: null, error: String(e?.message || e) });
		}
		if (results.length % 20 === 0) console.log(`${results.length}/${rows.length}  done ${results.filter((r) => r.lines).length}  failed ${results.filter((r) => !r.lines).length}`);
	}
}
const t0 = Date.now();
await Promise.all(Array.from({ length: par }, worker));
sql.push('COMMIT;');
const ok = results.filter((r) => r.lines);
console.log(`videos ${rows.length}: re-cut ${ok.length}, kept ${results.length - ok.length}  (${((Date.now() - t0) / 60000).toFixed(1)} min, ${par} at once)`);
console.log(`cues ${ok.reduce((n, r) => n + r.cues, 0)} -> lines ${ok.reduce((n, r) => n + (r.lines || 0), 0)}`);
if (!dry) writeFileSync(out, sql.join('\n'), 'utf8');
writeFileSync(out + '.json', JSON.stringify(results, null, 1), 'utf8');
console.log(dry ? 'dry run: no SQL written' : `wrote ${out}`);
