#!/bin/sh
# Which names and other spellings GX Core's brand registry holds for the given brands (default: the
# deals page's brands). Prints names only: the registry also carries rep contacts, never printed.
#   bash scripts/brand-names-check.sh                 # every deals-page brand
#   bash scripts/brand-names-check.sh bobsled "good tide"
# Needs .gx_deploy_secret in the repo root (gitignored).
CORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
SECRET=$(tr -d '\r\n' < .gx_deploy_secret)
OUT="${TMPDIR:-/tmp}/spiff-brand-names.json"
curl -sL --max-time 120 -G "$CORE" --data-urlencode "action=brands" --data-urlencode "all=1" --data-urlencode "secret=$SECRET" > "$OUT"
python3 - "$OUT" "$@" <<'EOF'
import json, sys, unicodedata
fold = lambda s: ''.join(c for c in unicodedata.normalize('NFD', str(s or '')) if unicodedata.category(c) != 'Mn').lower().replace(' ', '').replace('-', '')
raw = open(sys.argv[1]).read()
try: d = json.loads(raw)
except Exception: print('not JSON:', raw[:200]); sys.exit(1)
if d.get('ok') is False: print('error:', d.get('error')); sys.exit(1)
brands = d.get('brands') or d.get('items') or []
want = sys.argv[2:] or ['Bobsled', 'Hellavated', 'Grön', 'Freshy', 'Verdant Leaf', 'Mule Extracts', 'Good Tide', 'Wyld']
for w in want:
    hits = [b for b in brands if fold(w) in [fold(b.get('display_name'))] + [fold(a) for a in (b.get('aliases') or [])]]
    if not hits: print('NOT FOUND  ', w); continue
    for b in hits:
        print('found      ', w, '->', b.get('display_name'), '| other spellings:', ', '.join(b.get('aliases') or []) or '-', '| active' if str(b.get('active')).lower() in ('true', '1', 'yes') else '| inactive')
EOF
