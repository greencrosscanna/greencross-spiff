#!/bin/sh
# Preview (or run) the Marketing Calendar sync.
# Dry by default:   bash scripts/calendar-sync.sh
# To write:         bash scripts/calendar-sync.sh apply
# Needs .gx_deploy_secret in the repo root (gitignored). Remove a copy when done.
ENGINE="https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec"
SECRET=$(tr -d '\r\n' < .gx_deploy_secret)
APPLY=""
[ "$1" = "apply" ] && APPLY="1"
OUT="${TMPDIR:-/tmp}/spiff-calendar-sync.json"
curl -sL --max-time 120 -G "$ENGINE" --data-urlencode "action=calendarSync" --data-urlencode "secret=$SECRET" --data-urlencode "apply=$APPLY" > "$OUT"
python3 - "$OUT" <<'EOF'
import json, sys
raw = open(sys.argv[1]).read()
try:
    d = json.loads(raw)
except Exception:
    print('not JSON (consent page? run authorize()):', raw[:300]); sys.exit(1)
print('ok', d.get('ok'), '| apply', d.get('apply'), '| error', d.get('error'))
for k in ('created', 'updated', 'removed'):
    print(k.upper(), len(d.get(k) or []))
    for e in d.get(k) or []:
        print('   ', e['date'], '|', e['summary'], '|', e['key'])
print('unchanged', d.get('unchanged'), '| refused', d.get('refused'), '| failed', d.get('failed'))
print('SKIPPED, a hand-made one already covers it:', len(d.get('skipped_duplicates') or []))
for e in d.get('skipped_duplicates') or []:
    print('   ', e['date'], '| hand-made:', e['hand_made'], '| SPIFF:', e['spiff'])
EOF
