#!/bin/sh
# Check or connect Tawny's SPIFF Mailer (the "Send to brand" sender). See tawny-mailer/README.md.
#   sh scripts/brand-mailer.sh                     what is connected now, and who it sends as
#   sh scripts/brand-mailer.sh <exec-url>          dry run of connecting that mailer
#   sh scripts/brand-mailer.sh <exec-url> apply    pair with it and save it
#   sh scripts/brand-mailer.sh clear apply         disconnect (Send to brand then refuses until reconnected)
# Reads the deploy secret from .gx_deploy_secret; never prints it.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC="https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec"
SECRET="$(tr -d '\r\n' < "$DIR/.gx_deploy_secret")"
URL=""; CLEAR=""; APPLY=""
[ "$1" = "clear" ] && CLEAR=1 || URL="$1"
[ "$2" = "apply" ] && APPLY=1
curl -sSL -G "$EXEC" \
  --data-urlencode "action=setBrandMailer" \
  --data-urlencode "secret=$SECRET" \
  --data-urlencode "url=$URL" \
  --data-urlencode "clear=$CLEAR" \
  --data-urlencode "apply=$APPLY"
echo
