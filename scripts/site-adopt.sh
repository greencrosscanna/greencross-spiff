#!/bin/sh
# Take over the hand-made Weekly Deals and Vendors rows on greencrosscanna.com/deals (THE DEALS
# PAGE, PART 2 in Code.gs), and show what the hourly publish would send for them.
# Dry by default:   bash scripts/site-adopt.sh
# To adopt:         bash scripts/site-adopt.sh apply     (Sky's OK first: it stamps keys onto live Wix rows)
# Adopted rows come in UN-approved; nothing on the page changes until someone ticks them in SPIFF.
# Needs .gx_deploy_secret in the repo root (gitignored).
ENGINE="https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec"
SECRET=$(tr -d '\r\n' < .gx_deploy_secret)
APPLY=""
[ "$1" = "apply" ] && APPLY="1"
OUT="${TMPDIR:-/tmp}/spiff-site-adopt.json"
PUB="${TMPDIR:-/tmp}/spiff-site-publish.json"
curl -sL --max-time 300 -G "$ENGINE" --data-urlencode "action=adoptSite" --data-urlencode "secret=$SECRET" --data-urlencode "apply=$APPLY" > "$OUT"
curl -sL --max-time 300 -G "$ENGINE" --data-urlencode "action=publishToWix" --data-urlencode "secret=$SECRET" > "$PUB"
python3 - "$OUT" "$PUB" <<'EOF'
import json, sys
def load(p):
    raw = open(p).read()
    try: return json.loads(raw)
    except Exception: print('not JSON (consent page? run authorize()):', raw[:300]); sys.exit(1)
a, p = load(sys.argv[1]), load(sys.argv[2])
print('ADOPT  ok', a.get('ok'), '| apply', a.get('apply'), '| error', a.get('error'))
print('WEEKLY', len(a.get('week') or []))
for e in a.get('week') or []:
    print('   ', e['key'], '|', e['day'], e['row'], '|', e['brand'], '|', e['amount'], e['text'])
print('BRANDS', len(a.get('vendors') or []))
for e in a.get('vendors') or []:
    print('   ', e['key'], '|', e['brand'], '| logo', 'yes' if e.get('logo') else 'no', '| wide', 'yes' if e.get('logo_wide') else 'no', '| menu', e.get('menu_slug') or '-')
for x in a.get('problems') or []: print('PROBLEM', x.get('problem'))
s = p.get('site') or {}
print('PUBLISH (dry) ok', p.get('ok'), '| error', p.get('error'))
print('   weekly to send', len(s.get('send_week') or []), '| to remove', len(s.get('remove_week') or []),
      '| brands to send', len(s.get('send_vendors') or []), '| waiting for approval', len(s.get('waiting') or []),
      '| hand-made (no key)', s.get('hand_made'), '| refused', s.get('refused') or '-')
for f in p.get('failed') or []: print('   FAILED', f)
EOF
