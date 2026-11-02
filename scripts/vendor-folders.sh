#!/bin/sh
# Give every known vendor an upload folder under Marketing > Vendors and link it on open programs.
# Dry by default:   bash scripts/vendor-folders.sh
# To write:         bash scripts/vendor-folders.sh apply
ENGINE="https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec"
SECRET=$(cat .gx_deploy_secret)
APPLY=""
[ "$1" = "apply" ] && APPLY="1"
OUT="${TMPDIR:-/tmp}/spiff-vendor-folders.json"
curl -sL --max-time 300 -G "$ENGINE" --data-urlencode "action=vendorFolders" --data-urlencode "secret=$SECRET" --data-urlencode "apply=$APPLY" > "$OUT"
python3 - "$OUT" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
print('ok', d.get('ok'), 'dry', d.get('dry'), 'brands_read', d.get('brands_read'), 'error', d.get('error'))
for f in d.get('folders') or []:
    print(' ', f['name'], '| new' if f['created'] else '| exists', '| shared now' if f['shared'] else '| already shared', '|', f['url'])
print('programs linked:', d.get('linked'))
print('errors:', d.get('errors'))
EOF
