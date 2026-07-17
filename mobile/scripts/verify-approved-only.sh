#!/usr/bin/env bash
#
# End-to-end proof that customers only ever see APPROVED shops.
#
# Suspends EVERY approved shop, checks the customer app shows nothing at all,
# then restores exactly those shops and checks the pilot shop and its 20 products
# come back.
#
# Suspending every approved shop (not just the pilot) matters: if any other shop
# is approved — one left behind by another test, say — the customer would still
# see a shop and the "hidden" check would fail for the wrong reason.
#
# Shop status is changed directly in the database because the API deliberately
# offers no way for anyone to approve their own shop.
#
# Prerequisites: API on :3000, expo web on :8081, database seeded.
# Usage: bash scripts/verify-approved-only.sh
set -uo pipefail

PSQL="docker exec halfdinar-postgres psql -U halfdinar -d halfdinar"
SHOP="Al-Nus Dinar Shop"

# Remember exactly which shops were approved, so only those are restored.
APPROVED_IDS=$($PSQL -t -A -c "SELECT id FROM merchants WHERE status='approved';" | tr -d '\r' | paste -sd, -)

restore() {
  echo ""
  echo "--- restoring the shops that were approved before this run ---"
  if [ -n "$APPROVED_IDS" ]; then
    $PSQL -c "UPDATE merchants SET status='approved' WHERE id IN (${APPROVED_IDS//,/\',\'} );" >/dev/null 2>&1 \
      || $PSQL -c "UPDATE merchants SET status='approved' WHERE id::text = ANY(string_to_array('$APPROVED_IDS', ','));" >/dev/null
  fi
  $PSQL -t -c "SELECT shop_name || ' -> ' || status FROM merchants;"
}
trap restore EXIT

echo "=============================================================="
echo "STEP 1: suspend every approved shop"
echo "=============================================================="
$PSQL -c "UPDATE merchants SET status='suspended' WHERE status='approved';" >/dev/null
$PSQL -t -c "SELECT shop_name || ' -> ' || status FROM merchants;"

echo ""
echo "STEP 2: the customer must now see NOTHING"
echo "--------------------------------------------------------------"
npx playwright test --config playwright.approved-only.config.ts --grep "hidden" 2>&1 | tail -5
HIDDEN_RESULT=${PIPESTATUS[0]}

echo ""
echo "=============================================================="
echo "STEP 3: approve the shops again"
echo "=============================================================="
$PSQL -c "UPDATE merchants SET status='approved' WHERE id::text = ANY(string_to_array('$APPROVED_IDS', ','));" >/dev/null
$PSQL -t -c "SELECT shop_name || ' -> ' || status FROM merchants;"

echo ""
echo "STEP 4: '$SHOP' and its 20 products must come back"
echo "--------------------------------------------------------------"
npx playwright test --config playwright.approved-only.config.ts --grep "visible" 2>&1 | tail -5
VISIBLE_RESULT=${PIPESTATUS[0]}

echo ""
echo "=============================================================="
if [ "$HIDDEN_RESULT" -eq 0 ] && [ "$VISIBLE_RESULT" -eq 0 ]; then
  echo "PASS: customers see a shop ONLY when it is approved."
  exit 0
fi
echo "FAIL: hidden=$HIDDEN_RESULT visible=$VISIBLE_RESULT (0 = passed)"
exit 1
