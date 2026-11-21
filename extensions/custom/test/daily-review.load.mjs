// Load test of GET /daily-review: N throw-away users, each with due cards of every kind, asking for their session together.
//   node extensions/custom/test/daily-review.load.mjs 100
import { execFileSync } from 'node:child_process';
const API='http://localhost:8081/api'; const N=Number(process.argv[2]||50);
const sql=(q)=>execFileSync('docker',['exec','-i','map-listening-db','psql','-U','postgres','-d','map-listening','-At','-F','\u001f','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8'}).trim();
const ids=Array.from({length:N},(_,i)=>`55555555-5555-4555-8555-${String(i).padStart(12,'0')}`);
sql(`delete from directus_users where email like 'load-%@test.local'`);
const role=sql(`select role from directus_users where role is not null limit 1`);
sql(ids.map((id,i)=>`insert into directus_users (id,email,status,role,token,first_name) values ('${id}','load-${i}@test.local','active','${role}','load-token-${i}','l${i}');`).join('\n'));
// every user: 6 words (mixed streaks), 4 il_cards, 5 sentence cards, all due
sql(`
insert into user_words (user_id, word, shown, meaning, source, video_id, start_ms, end_ms, example, due, right_streak)
select u.id, lower(w.w)||'', lower(w.w), 'x', 'intensive', w.vid, w.s, w.e, w.t, now()-interval '1 hour', (w.rn % 4)::int
from directus_users u cross join lateral (select * from (select (regexp_match(s.text,'[A-Za-z]{7,}'))[1] w, sv.youtube_video_id vid, s.start_ms s, s.end_ms e, s.text t, row_number() over () rn from il_sentences s join il_lessons l on l.id=s.lesson_id join source_videos sv on sv.id=l.source_video_id) q where q.w is not null limit 6) w
where u.email like 'load-%@test.local' on conflict do nothing;
insert into il_review_cards (user_id, sentence_id, due, right_streak) select u.id, s.id, now()-interval '1 hour', (row_number() over (partition by u.id))::int % 3 from directus_users u cross join (select id from il_sentences limit 5) s where u.email like 'load-%@test.local';`);
const hit=async(i)=>{const t=performance.now(); const r=await fetch(`${API}/v1/daily-review?size=25`,{headers:{Authorization:'Bearer load-token-'+i}}); const j=await r.json().catch(()=>null); return {ms:performance.now()-t,status:r.status,items:j?.data?.items?.length??-1};};
const pct=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b[Math.min(b.length-1,Math.floor(p/100*b.length))].toFixed(0)};
await Promise.all(ids.slice(0,3).map((_,i)=>hit(i)));   // warm caches
for (const conc of [10, 25, N]) {
  const t0=performance.now(); const rs=await Promise.all(Array.from({length:conc},(_,i)=>hit(i%N)));
  const ok=rs.filter(r=>r.status===200&&r.items>0).length; const ms=rs.map(r=>r.ms);
  console.log(`${conc} users at once: ${ok}/${conc} ok, p50 ${pct(ms,50)} ms, p95 ${pct(ms,95)} ms, max ${Math.max(...ms).toFixed(0)} ms, wall ${((performance.now()-t0)/1000).toFixed(1)}s, statuses ${[...new Set(rs.map(r=>r.status))]}`);
}
sql(`delete from directus_users where email like 'load-%@test.local'`);
