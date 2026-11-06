#!/bin/sh
# Run every tests/*_test.js with node; print only failures and a final count.
# Usage: bash scripts/run-tests.sh
cd "$(dirname "$0")/.." || exit 1
pass=0; failed=""
for t in tests/*_test.js; do
  if node "$t" > /tmp/spiff-test-out.txt 2>&1; then
    pass=$((pass + 1))
  else
    failed="$failed $t"
    echo "=== FAIL: $t"
    grep -E "✗|Error|FAIL" /tmp/spiff-test-out.txt | head -20
  fi
done
echo "passed: $pass"
[ -z "$failed" ] && echo "all green" && exit 0
echo "failed:$failed"
exit 1
