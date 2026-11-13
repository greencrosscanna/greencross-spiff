#!/bin/sh
# Re-measure a running program from Dutchie now, store by store, then republish to GX Core.
# No argument:   bash scripts/refresh-program.sh            -> lists active programs and their stores, pulls nothing
# One program:   bash scripts/refresh-program.sh <program_id>  -> re-pulls every store of that program
# Uses ?action=refreshProgress (deploy-secret gated). One store per call because /exec dies at 60s.
# Needs .gx_deploy_secret in the repo root (gitignored).
ENGINE="https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec"
SECRET=$(tr -d '\r\n' < .gx_deploy_secret)
OUT="${TMPDIR:-/tmp}/spiff-refresh-plan.json"
curl -sL --max-time 120 -G "$ENGINE" --data-urlencode "action=refreshProgress" --data-urlencode "secret=$SECRET" --data-urlencode "program=$1" > "$OUT"
STORES=$(python3 - "$OUT" "$1" <<'EOF'
import json, sys
raw = open(sys.argv[1]).read()
try:
    d = json.loads(raw)
except Exception:
    sys.stderr.write('not JSON (consent page? run authorize()): ' + raw[:300] + '\n'); sys.exit(1)
if not d.get('ok'):
    sys.stderr.write('error: %s\n' % d.get('error')); sys.exit(1)
plan = d.get('plan') or []
if not sys.argv[2]:
    seen = {}
    for e in plan:
        seen.setdefault(e['program'], []).append(e['store'])
    for k, v in seen.items():
        sys.stderr.write('%s: %s\n' % (k, ', '.join(v)))
    sys.exit(0)
if not plan:
    sys.stderr.write('no active program with id %s\n' % sys.argv[2]); sys.exit(1)
print(' '.join(e['store'] for e in plan))
EOF
)
[ -z "$1" ] && exit 0
[ -z "$STORES" ] && exit 1
for S in $STORES; do
  R=$(curl -sL --max-time 120 -G "$ENGINE" --data-urlencode "action=refreshProgress" --data-urlencode "secret=$SECRET" --data-urlencode "program=$1" --data-urlencode "store=$S")
  echo "$S: $(printf '%s' "$R" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
except Exception:
  print("not JSON"); sys.exit()
print("ok" if d.get("ok") else "FAILED", "| units", d.get("units", d.get("total_units")), "| error", d.get("error"), "| published", bool(d.get("published")))')"
done
