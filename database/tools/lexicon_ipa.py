#!/usr/bin/env python3
"""
Fill lex_entries.ipa_us / ipa_uk from the English Wiktionary dump of kaikki.org.
Spec: MapListeningProject/docs/lexicon-spec.md section 8b.

  python lexicon_ipa.py kaikki.org-dictionary-English.jsonl                 # fill; entries that already have a value keep it
  python lexicon_ipa.py kaikki.org-dictionary-English.jsonl --dry           # counts only

Download: https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl  (~3.4 GB, CC BY-SA)

An entry's accents come from the `sounds` of its Wiktionary entry (the lemma, else the entry of its forms):
  US  = IPA with tag General-American (else US, else California / Midwestern ... as a fallback)
  UK  = IPA with tag Received-Pronunciation (else UK, else Southern-England / England)
A word with a single untagged IPA is read as the common one: it goes to US when the entry has no US yet.
Slashes are kept as Wiktionary writes them (/dɪˈmɑ.kɹə.si/). Phonetic [..] transcriptions are skipped.

An inflected form is pronounced differently from its lemma, so an entry takes the IPA of its own lemma only; "turn out" gets
the IPA of "turn out" (or stays empty), never that of "turns out" or of "turn".

Not done here: lex_senses.gloss_en. The senses we hold come from the Vietnamese Wiktionary and are not aligned with the
English senses; matching them needs its own pass.
"""
import argparse, json, re, shlex, subprocess, sys

US_TAGS = ('General-American', 'US', 'American', 'California', 'Midwestern', 'Canada')
UK_TAGS = ('Received-Pronunciation', 'UK', 'British', 'Southern-England', 'England', 'Standard-Southern-British')


def norm(s):
    s = (s or '').replace('’', "'").replace('‘', "'").lower()
    return re.sub(r'\s+', ' ', s).strip().strip(' .,!?;:"')


def pick(sounds):
    """(us, uk) IPA of one Wiktionary entry."""
    us = uk = None
    rest = []
    for s in sounds or []:
        ipa = s.get('ipa')
        if not ipa or not ipa.startswith('/'):
            continue
        tags = set(s.get('tags') or [])
        if us is None and tags & set(US_TAGS):
            us = ipa
        elif uk is None and tags & set(UK_TAGS):
            uk = ipa
        elif not tags:
            rest.append(ipa)
    if us is None and uk is None and rest:
        us = rest[0]                         # one untagged transcription: the common one
    return us, uk


def sql_lit(v):
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--psql', default='docker exec -i map-listening-db psql -U postgres -d map-listening')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    cmd = shlex.split(a.psql) + ['-v', 'ON_ERROR_STOP=1', '-q']

    def psql(sql):
        r = subprocess.run(cmd, input=sql.encode('utf-8'), capture_output=True)
        if r.returncode:
            sys.exit(r.stderr.decode('utf-8'))
        return r.stdout.decode('utf-8')

    lemmas = {}
    for line in psql("COPY (SELECT norm, id FROM lex_entries WHERE kind <> 'chunk') TO STDOUT").splitlines():
        n, eid = line.split('\t')
        lemmas[n] = eid
    want = lemmas
    print(f'looking for {len(want)} entries', file=sys.stderr)

    found = {}     # word -> (us, uk) from the dump
    seen = 0
    with open(a.file, encoding='utf-8') as fh:
        for line in fh:
            seen += 1
            if '"sounds"' not in line:
                continue
            # the key order of a line varies ("pos" first, "word" later), so the line is parsed; only lines with sounds are
            e = json.loads(line)
            if e.get('lang_code') != 'en':
                continue
            w = norm(e.get('word'))
            if w not in want:
                continue
            us, uk = pick(e.get('sounds'))
            if us or uk:
                cur = found.get(w, (None, None))
                found[w] = (cur[0] or us, cur[1] or uk)
    print(f'{seen} lines read, IPA found for {len(found)} of {len(want)} entries', file=sys.stderr)

    rows = {eid: found.get(n, (None, None)) for n, eid in lemmas.items()}
    have_us = sum(1 for v in rows.values() if v[0])
    have_uk = sum(1 for v in rows.values() if v[1])
    both = sum(1 for v in rows.values() if v[0] and v[1])
    print(f'entries {len(rows)}: US {have_us}, UK {have_uk}, both {both}, none {sum(1 for v in rows.values() if not (v[0] or v[1]))}')
    if a.dry:
        return
    stmts = ['BEGIN;', 'CREATE TEMP TABLE ipa_in (id uuid, us text, uk text) ON COMMIT DROP;']
    vals = [f"({sql_lit(eid)},{sql_lit(us) if us else 'NULL'},{sql_lit(uk) if uk else 'NULL'})" for eid, (us, uk) in rows.items() if us or uk]
    for i in range(0, len(vals), 2000):
        stmts.append('INSERT INTO ipa_in VALUES ' + ','.join(vals[i:i + 2000]) + ';')
    stmts.append("UPDATE lex_entries e SET ipa_us = COALESCE(e.ipa_us, i.us), ipa_uk = COALESCE(e.ipa_uk, i.uk), date_updated = now() FROM ipa_in i WHERE i.id = e.id;")
    stmts.append('COMMIT;')
    psql('\n'.join(stmts))
    print('written')


if __name__ == '__main__':
    main()
