#!/usr/bin/env python3
"""
Build the lexicon (lex_* tables, migration 2026-12-04_lexicon.sql) from what the site already has.
Spec: MapListeningProject/docs/lexicon-spec.md.

  python lexicon_build.py                 # trial: the words and phrases learners meet now (Extensive vocab, clip targets,
                                          # Phrase Lab, saved words, Intensive chunks); empties the lex_* tables first
  python lexicon_build.py --dry           # print the counts, write nothing

Sources and what each gives:
  el_vocab            entry, forms, a sense with the lesson's own meaning, an occurrence (lesson, n, time)
  word_meanings       senses with Vietnamese meanings (kaikki = Vietnamese Wiktionary; ai / el_vocab = phrases added 2026-11-19)
  phrases             Phrase Lab phrases (dropped feature): entry, IPA is not taken (accent unknown), Vietnamese meaning
  user_words          saved words -> user_lex
  el_saved_words      saved Extensive vocab -> user_lex with its occurrence
  il_chunks           Intensive connected-speech chunks: the entry only
  wiktionary_en       inflected form -> lemma ("turns out" -> "turn out", "resides" -> "reside")

Not filled yet: gloss_en (base English text) and ipa_us / ipa_uk -- they need a new pass over the English Wiktionary
dump with the accent tags kept (wiktionary_extract.py keeps one IPA of either accent).

Needs a running Postgres: --psql "docker exec -i map-listening-db psql -U <user> -d <db>".
"""
import argparse, csv, io, re, shlex, subprocess, sys, uuid
from collections import defaultdict

AI_POS = {'n': 'noun', 'v': 'verb', 'adj': 'adj', 'adv': 'adv', 'prep': 'prep', 'phr.v': 'verb', 'idiom': 'phrase', 'phrase': 'phrase'}


def norm(s):
    s = (s or '').replace('’', "'").replace('‘', "'").lower()
    s = re.sub(r'\s+', ' ', s).strip()
    return s.strip(' .,!?;:"')


def key(s):
    """Two meanings are the same when they read the same without case, spaces and punctuation."""
    return re.sub(r'[\W_]+', '', (s or '').lower())


class Db:
    def __init__(self, cmd):
        self.cmd = shlex.split(cmd)

    def rows(self, sql):
        # through stdin: the word lists in the SQL are longer than a Windows command line
        r = subprocess.run(self.cmd + ['-v', 'ON_ERROR_STOP=1', '-q'], input=f'COPY ({sql}) TO STDOUT WITH CSV HEADER;'.encode('utf-8'), capture_output=True)
        if r.returncode:
            sys.exit(r.stderr.decode('utf-8'))
        out = r.stdout.decode('utf-8')
        return list(csv.DictReader(io.StringIO(out)))

    def run(self, sql):
        r = subprocess.run(self.cmd + ['-v', 'ON_ERROR_STOP=1', '-q'], input=sql.encode('utf-8'), capture_output=True)
        if r.returncode:
            sys.exit(r.stderr.decode('utf-8'))


def lit(v):
    if v is None or v == '':
        return 'NULL'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def arr(items):
    return 'ARRAY[' + ','.join(lit(i) for i in items) + ']::text[]' if items else "'{}'::text[]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--psql', default='docker exec -i map-listening-db psql -U postgres -d map-listening')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    db = Db(a.psql)

    vocab = db.rows("SELECT id, lesson_id, n, term, array_to_string(forms, '|') AS forms, kind, meaning, at_start, at_end FROM el_vocab")
    added = db.rows("SELECT word, pos, short, meaning, example, source FROM word_meanings WHERE source IN ('ai', 'el_vocab') AND lang = 'vi'")
    phrases = db.rows("SELECT p.text, t.meaning FROM phrases p LEFT JOIN phrases_translations t ON t.phrases_id = p.id AND t.languages_code = 'vi-VN'")
    uwords = db.rows("SELECT user_id, word, shown, array_to_string(forms, '|') AS forms, date_created FROM user_words")
    saved = db.rows("SELECT user_id, vocab_id, date_created FROM el_saved_words")
    chunks = db.rows("SELECT text FROM il_chunks")

    # Every surface we start from, with the source that brought it
    surfaces = defaultdict(set)   # norm(surface) -> sources
    for v in vocab:
        surfaces[norm(v['term'])].add('el_vocab')
    for r in added:
        surfaces[norm(r['word'])].add('clip_target' if r['source'] == 'ai' else 'el_vocab')
    for p in phrases:
        surfaces[norm(p['text'])].add('phrase_lab')
    for u in uwords:
        surfaces[norm(u['word'])].add('user_words')
    for c in chunks:
        surfaces[norm(c['text'])].add('il_chunks')
    surfaces.pop('', None)

    # Inflected form -> lemma, only for a surface that is not a headword of its own in the Vietnamese dictionary
    # ("the" is a form of "thee" in Wiktionary, but it is a word of its own)
    names = list(surfaces)
    heads = {r['word'] for r in db.rows(f"SELECT DISTINCT word FROM word_meanings WHERE lang = 'vi' AND source = 'kaikki' AND word = ANY({arr(names)})")}
    # Only a true inflection ("form-of": plural, past, -ing, 3rd person) with no sense of its own goes to its lemma.
    # Not: spelling variants ("catch up" alt-of "catch-up"), clippings ("told you" -> "i told you so"), words with their own
    # senses ("rebound", "cheers"), adjectives ("devastated", "overwhelmed" are taught as adjectives).
    lemma_of = {r['w']: norm(r['lemma']) for r in db.rows(
        f"SELECT w, doc->'form_of'->>'lemma' AS lemma FROM wiktionary_en WHERE w = ANY({arr(names)}) AND doc->'form_of'->>'lemma' IS NOT NULL"
        " AND (doc->'form_of'->'tags') ? 'form-of' AND jsonb_array_length(COALESCE(doc->'senses', '[]'::jsonb)) = 0"
        " AND NOT (doc->'pos') ? 'adj'")}
    to_lemma = {s: (lemma_of[s] if s in lemma_of and s not in heads and lemma_of[s] else s) for s in surfaces}

    # Entries
    entries = {}  # lemma -> dict
    def entry(lemma):
        if lemma not in entries:
            entries[lemma] = {'id': str(uuid.uuid4()), 'lemma': lemma, 'forms': {lemma}, 'sources': set(), 'kinds': set(), 'senses': []}
        return entries[lemma]
    for s, srcs in surfaces.items():
        e = entry(to_lemma[s])
        e['forms'].add(s)
        e['sources'] |= srcs
    for v in vocab:
        e = entries[to_lemma[norm(v['term'])]]
        e['forms'] |= {norm(f) for f in v['forms'].split('|') if f.strip()}
        e['kinds'].add('phrase' if v['kind'] == 'phrase' else 'word')
    for r in added:
        e = entries[to_lemma[norm(r['word'])]]
        e['kinds'].add({'chunk': 'chunk', 'phr.v': 'phrasal_verb', 'idiom': 'idiom'}.get(r['pos'], 'phrase'))
    for p in phrases:
        entries[to_lemma[norm(p['text'])]]['kinds'].add('phrase')
    for e in entries.values():
        k = e['kinds'] - {'chunk'}
        if not e['kinds']:
            e['kind'] = 'phrase' if ' ' in e['lemma'] else 'word'
        elif not k:
            e['kind'] = 'chunk'                      # chunk only when nothing else says it is a real phrase
        else:
            e['kind'] = next(x for x in ('phrasal_verb', 'idiom', 'phrase', 'word') if x in k)
        if e['kind'] == 'word' and ' ' in e['lemma']:
            e['kind'] = 'phrase'
        e['source'] = next(x for x in ('el_vocab', 'clip_target', 'phrase_lab', 'il_chunks', 'user_words') if x in e['sources'])

    # Senses: the Vietnamese dictionary first, then the meanings our own content wrote
    def add_sense(e, pos, short, meaning, source, example=None, example_tr=None):
        if e['kind'] == 'chunk' or not (short or meaning):
            return None
        k = key(short or meaning)
        for s in e['senses']:
            if k and (k == key(s['short']) or k == key(s['meaning'])):
                return s
        s = {'id': str(uuid.uuid4()), 'ord': len(e['senses']) + 1, 'pos': pos, 'short': short or meaning, 'meaning': meaning or short,
             'source': source, 'example': example, 'example_tr': example_tr}
        e['senses'].append(s)
        return s

    lemmas = list(entries)
    for r in db.rows(f"SELECT word, ord, pos, short, meaning, example, example_tr FROM word_meanings WHERE lang = 'vi' AND source = 'kaikki' AND word = ANY({arr(lemmas)}) ORDER BY word, ord"):
        add_sense(entries[r['word']], r['pos'] or None, r['short'], r['meaning'], 'kaikki', r['example'] or None, r['example_tr'] or None)
    for r in added:
        e = entries[to_lemma[norm(r['word'])]]
        add_sense(e, AI_POS.get(r['pos']), r['short'], r['meaning'], r['source'], r['example'] or None)
    for p in phrases:
        if p['meaning']:
            add_sense(entries[to_lemma[norm(p['text'])]], 'phrase', p['meaning'], p['meaning'], 'phrase_lab')
    # A lesson's own meaning of a single word takes the part of speech of the dictionary's first sense, else Wiktionary's first
    wpos = {r['w']: r['pos'] for r in db.rows(f"SELECT w, doc->'pos'->>0 AS pos FROM wiktionary_en WHERE w = ANY({arr(lemmas)})")}
    vocab_sense = {}
    for v in vocab:
        e = entries[to_lemma[norm(v['term'])]]
        pos = 'phrase' if v['kind'] == 'phrase' else next((s['pos'] for s in e['senses'] if s['pos']), None) or wpos.get(e['lemma']) or None
        s = add_sense(e, pos, v['meaning'], v['meaning'], 'el_vocab')
        vocab_sense[v['id']] = (e, s)

    # Occurrences (Extensive word lists) and the learners' saved words
    occ = []
    occ_of_vocab = {}
    for v in vocab:
        e, s = vocab_sense[v['id']]
        oid = str(uuid.uuid4())
        occ_of_vocab[v['id']] = oid
        occ.append((oid, e['id'], s['id'] if s else None, 'el_lesson', v['lesson_id'], int(v['n']), v['term'],
                    int(v['at_start']) if v['at_start'] else None, int(v['at_end']) if v['at_end'] else None))
    ulex = {}
    for u in uwords:
        e = entries[to_lemma[norm(u['word'])]]
        ulex[(u['user_id'], e['id'])] = (e['senses'][0]['id'] if e['senses'] else None, None, u['date_created'])
    vocab_by_id = {v['id']: v for v in vocab}
    for sv in saved:
        if sv['vocab_id'] in vocab_by_id:
            e, s = vocab_sense[sv['vocab_id']]
            ulex[(sv['user_id'], e['id'])] = (s['id'] if s else None, occ_of_vocab[sv['vocab_id']], sv['date_created'])

    # Report
    by_kind = defaultdict(int)
    for e in entries.values():
        by_kind[e['kind']] += 1
    n_senses = sum(len(e['senses']) for e in entries.values())
    no_sense = [e['lemma'] for e in entries.values() if not e['senses'] and e['kind'] != 'chunk']
    merged = [(s, l) for s, l in to_lemma.items() if s != l]
    print(f"surfaces {len(surfaces)} -> entries {len(entries)} ({dict(by_kind)})")
    print(f"merged into a lemma: {len(merged)}: {merged}")
    print(f"senses {n_senses}; entries (not chunk) with no meaning: {len(no_sense)}, e.g. {no_sense[:10]}")
    print(f"occurrences {len(occ)}; user_lex {len(ulex)}")
    if a.dry:
        return

    out = ['BEGIN;', 'TRUNCATE lex_suggestions, user_lex, lex_occurrences, lex_sense_translations, lex_senses, lex_forms, lex_entries;']
    rows = [f"({lit(e['id'])},{lit(e['lemma'])},{lit(e['lemma'])},{lit(e['kind'])},{lit(e['source'])})" for e in entries.values()]
    out.append('INSERT INTO lex_entries (id, lemma, norm, kind, source) VALUES\n' + ',\n'.join(rows) + ';')
    # A phrase's forms keep all its words ("bounce" is not a form of "bounce back": it would catch every "bounce")
    rows = [f"({lit(e['id'])},{lit(f)})" for e in entries.values() for f in sorted(e['forms'])
            if f and len(f.split()) >= len(e['lemma'].split())]
    out.append('INSERT INTO lex_forms (entry_id, form) VALUES\n' + ',\n'.join(rows) + ';')
    srows, trows = [], []
    for e in entries.values():
        for s in e['senses']:
            srows.append(f"({lit(s['id'])},{lit(e['id'])},{s['ord']},{lit(s['pos'])},{lit(s['example'])},{lit(s['source'])})")
            trows.append(f"({lit(s['id'])},'vi-VN',{lit(s['short'])},{lit(s['meaning'])},{lit(s['example_tr'])},{lit(s['source'])})")
    if srows:
        out.append('INSERT INTO lex_senses (id, entry_id, ord, pos, example_en, source) VALUES\n' + ',\n'.join(srows) + ';')
        out.append('INSERT INTO lex_sense_translations (sense_id, lang, short, meaning, example_tr, source) VALUES\n' + ',\n'.join(trows) + ';')
    if occ:
        out.append('INSERT INTO lex_occurrences (id, entry_id, sense_id, owner_type, owner_id, n, surface, start_ms, end_ms) VALUES\n'
                   + ',\n'.join('(' + ','.join(lit(x) for x in o) + ')' for o in occ) + ';')
    if ulex:
        out.append('INSERT INTO user_lex (user_id, entry_id, sense_id, occurrence_id, saved_at) VALUES\n'
                   + ',\n'.join(f"({lit(u)},{lit(eid)},{lit(sid)},{lit(oid)},{lit(at)})" for (u, eid), (sid, oid, at) in ulex.items()) + ';')
    out.append('COMMIT;')
    db.run('\n'.join(out))
    print('written')


if __name__ == '__main__':
    main()
