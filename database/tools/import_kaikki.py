#!/usr/bin/env python3
"""
Load the meanings of English words in one language into word_meanings, from a kaikki.org Wiktionary-edition extract
(https://kaikki.org/<edition>wiktionary/, "English" section: definitions of English words written in that edition's language).

  python import_kaikki.py vi                      # download the Vietnamese extract and load it
  python import_kaikki.py vi --file x.jsonl       # a file already downloaded
  python import_kaikki.py th --section อังกฤษ      # another edition (the name of its English section is the folder name on the site)

Needs a running Postgres: --psql "docker exec -i map-listening-db psql -U postgres -d map-listening" (the default).
Rows of the language with source 'kaikki' are replaced; rows from other sources (hand edits, translation runs) are kept.
Data: Wiktionary, CC BY-SA 4.0 -- credit it wherever the meanings are shown.
"""
import argparse, json, os, re, shlex, subprocess, sys, tempfile, urllib.parse, urllib.request

EDITION_SECTION = {  # the folder of the English section on kaikki.org/<edition>wiktionary/
    'vi': 'Tiếng Anh', 'th': 'อังกฤษ', 'fr': 'Anglais', 'de': 'Englisch', 'ru': 'Английский', 'ja': '英語', 'zh': '英語',
    'tr': 'İngilizce', 'it': 'Inglese', 'es': 'Inglés', 'pt': 'Inglês', 'ko': '영어', 'nl': 'Engels', 'el': 'English', 'ms': 'Bahasa Inggeris', 'id': 'Bahasa Inggris',
}
MAX_SENSES = 6
# Lines that only point to another word ("plural of x", "xem y"): the base word carries the meaning, so they are no meaning at all
SKIP_SEE = re.compile(r"xem [a-z' -]+\.?", re.I)   # "Xem baste": a pointer ("Xem xét kỹ", to consider, is a meaning)
SKIP_GLOSS = re.compile(r'^(động từ chia|quá khứ|phân từ|hiện tại phân từ|số nhiều|ngôi thứ|dạng|cách viết|viết tắt|từ viết tắt|biến thể|so sánh|cấp (so sánh|cao nhất)|danh động từ)\b', re.I)
WORD_LIST_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'extensions', 'custom', 'src', 'lib', 'wordRank.ts')
UA = {'User-Agent': 'guidelingo-import/1.0'}

def strip_leading_parens(s):
    """((thường) số nhiều) quân dự bị  ->  quân dự bị"""
    s = s.lstrip()
    while s.startswith('('):
        depth = 0
        for i, ch in enumerate(s):
            depth += ch == '('
            depth -= ch == ')'
            if depth == 0:
                s = s[i + 1:].lstrip()
                break
        else:
            break
    return s

def short(gloss, limit=60):
    s = strip_leading_parens(gloss) or gloss
    s = s.split(';')[0]
    plain = re.sub(r'\s*\([^)]*\)', '', s).strip()   # "Sĩ quan chỉ huy (pháo đài... )" -> "Sĩ quan chỉ huy"
    s = re.sub(r'\s+', ' ', plain if len(plain) >= 3 else s).strip(' .,;:)')
    if len(s) > limit:
        cut = s.rfind(',', 0, limit)
        s = s[:cut] if cut > 12 else s[:limit - 1].rstrip() + '…'
    return s

def clean(t):
    return re.sub(r'[\t\r\n\\]+', ' ', str(t or '')).strip()

def download(lang, section):
    ed = f'{lang}wiktionary'
    base = f'https://kaikki.org/{ed}/{urllib.parse.quote(section)}/'
    html = urllib.request.urlopen(urllib.request.Request(base + 'index.html', headers=UA)).read().decode('utf-8')
    m = re.search(r'href="([^"]+\.jsonl)"', html)
    if not m:
        sys.exit('no .jsonl link on ' + base)
    url = base + urllib.parse.quote(m.group(1))
    path = os.path.join(tempfile.gettempdir(), f'kaikki-{lang}.jsonl')
    print('downloading', url, '->', path)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r, open(path, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('lang')
    ap.add_argument('--file')
    ap.add_argument('--section')
    ap.add_argument('--psql', default='docker exec -i map-listening-db psql -U postgres -d map-listening')
    ap.add_argument('--out', help='only write the TSV here, do not load')
    a = ap.parse_args()
    section = a.section or EDITION_SECTION.get(a.lang)
    if not section:
        sys.exit('give --section (the folder name of the English section)')
    path = a.file or download(a.lang, section)

    common = set()
    try:   # the words of the library, most frequent first (the learner's vocabulary)
        common = set(re.search(r'WORD_LIST = "([^"]+)"', open(WORD_LIST_TS, encoding='utf-8').read()).group(1).split())
    except OSError:
        print('no word list: no word is marked common', file=sys.stderr)
    seen = {}   # word -> senses so far
    for line in open(path, encoding='utf-8'):
        d = json.loads(line)
        raw = str(d.get('word') or '').strip().replace('’', "'")
        w = raw.lower()
        if raw != w and raw[1:] != raw[1:].lower() or d.get('pos') in ('name', 'proper noun'):
            continue   # names ("Sean", "London"): not words to teach
        if d.get('lang_code') != 'en' or not re.fullmatch(r"[a-z][a-z' -]{0,59}", w):
            continue
        for s in d.get('senses', []):
            if s.get('form_of') or s.get('alt_of') or not s.get('glosses'):
                continue   # "plural of x": the lemma carries the meaning
            g = clean(s['glosses'][-1])
            sh = short(g)
            if not g or not sh or SKIP_GLOSS.match(g) or SKIP_SEE.fullmatch(g):
                continue
            ex = (s.get('examples') or [{}])[0]
            bucket = seen.setdefault(w, [])
            if len(bucket) < MAX_SENSES and not any(b[2] == g for b in bucket):
                bucket.append((d.get('pos'), len(bucket) + 1, g, sh, clean(ex.get('text')), clean(ex.get('translation'))))
    rows = [(w, a.lang, o, clean(p), g, sh, ex, tr, 't' if w in common else 'f') for w, bs in seen.items() for p, o, g, sh, ex, tr in bs]
    out = a.out or os.path.join(tempfile.gettempdir(), f'word_meanings-{a.lang}.tsv')
    with open(out, 'w', encoding='utf-8', newline='') as f:
        for r in rows:
            f.write('\t'.join(str(x) for x in r) + '\n')
    print(f'{len(seen)} words, {len(rows)} senses -> {out}')
    if a.out:
        return
    cmd = shlex.split(a.psql)
    with open(out, 'rb') as f:
        subprocess.run(cmd + ['-v', 'ON_ERROR_STOP=1', '-c', f"DELETE FROM word_meanings WHERE lang = '{a.lang}' AND source = 'kaikki'"], check=True)
        subprocess.run(cmd + ['-v', 'ON_ERROR_STOP=1', '-c', '\\copy word_meanings (word, lang, ord, pos, meaning, short, example, example_tr, common) FROM STDIN'], stdin=f, check=True)
    print('loaded')

if __name__ == '__main__':
    main()
